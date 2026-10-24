/**
 * One call of the API: the request built once, then attempts until one succeeds or the rules of rules.ts stop
 * the call. What holds on every path through this file:
 *  - the Idempotency-Key is given to the call, made before the first attempt, and sent unchanged on every
 *    attempt and every wait; this file never makes one;
 *  - every attempt ends by its own timeout and every call by its deadline, even when the helper ignores the
 *    abort signal: the call stops waiting for it;
 *  - a redirect is never followed, because it would carry the API key to another address;
 *  - an error is built only from the answer: never from what the HTTP helper threw.
 */

import { type CallError, GptVideoCallError, MESSAGES, TEXTS, formatMessage } from './errors.ts';
import { type HttpAnswer, type Io, anySignal, headerOf, isSendFailure, whenAborted } from './io.ts';
import type { HttpRequest } from './request.ts';
import {
	DEFAULTS,
	RETRY_AFTER_MAX_SEC,
	type Answer,
	type Failure,
	type NetworkFailure,
	type Outcome,
	backoffMs,
	mayHaveSpent,
	policyOf,
	retryAfterSec,
} from './rules.ts';
import type { Conventions, OperationRow } from './table.ts';

/** The shape of an error code the API sends; anything else is not the API's error body. */
const ERROR_CODE = /^[A-Z][A-Z0-9_]{0,63}$/;

/** A system error code worth repeating (ECONNREFUSED, ENOTFOUND). */
const SYSTEM_CODE = /^[A-Z][A-Z0-9_]{1,40}$/;

export type CallLimits = { readonly maxRetries: number; readonly timeoutMs: number; readonly deadlineMs: number };

export const DEFAULT_LIMITS: CallLimits = DEFAULTS;

/** What a call told the caller about each pause, so a long run can be explained. */
export type RetryEvent = { readonly operation: string; readonly attempt: number; readonly code: string; readonly delayMs: number };

export type CallContext = {
	readonly io: Io;
	readonly conventions: Conventions;
	readonly retryable: ReadonlySet<string>;
	readonly onRetry?: (event: RetryEvent) => void;
	readonly onAnswer?: (answer: Answer, attempt: number) => void;
};

/** The answer of a call that succeeded. */
export type CallResult = { readonly body: unknown; readonly answer: Answer };

function networkFailure(code: NetworkFailure['code'], status: number | null, text: string, answer: Answer | null): NetworkFailure {
	return { kind: 'network', code, status, text, answer };
}

function answerOf(res: HttpAnswer, conventions: Conventions): Answer {
	const replayed = headerOf(res, conventions.headers.replayed);
	return {
		status: res.status,
		retryAfter: headerOf(res, conventions.headers.retryAfter),
		requestId: headerOf(res, conventions.headers.requestId),
		replayed: replayed !== null && replayed.trim().toLowerCase() === 'true',
	};
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseJson(bytes: Uint8Array): { ok: true; value: unknown } | { ok: false } {
	if (bytes.byteLength === 0) return { ok: false };
	try {
		return { ok: true, value: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) };
	} catch {
		return { ok: false };
	}
}

/**
 * What an answer means: a 2xx with a JSON body is a success; a JSON body with `error.code` is an API error;
 * anything else, a 3xx included, is BAD_RESPONSE, and its body is never repeated.
 */
export function classifyAnswer(res: HttpAnswer, conventions: Conventions): Outcome {
	const answer = answerOf(res, conventions);
	const { status } = res;
	if (status >= 300 && status < 400) return networkFailure('BAD_RESPONSE', status, MESSAGES.redirect, answer);
	const parsed = parseJson(res.body);
	if (status >= 200 && status < 300) {
		return parsed.ok ? { kind: 'success', status, body: parsed.value, answer } : networkFailure('BAD_RESPONSE', status, MESSAGES.notJson, answer);
	}
	if (!parsed.ok) return networkFailure('BAD_RESPONSE', status, MESSAGES.notJson, answer);
	const error = isObject(parsed.value) ? parsed.value.error : undefined;
	if (!isObject(error) || typeof error.code !== 'string' || !ERROR_CODE.test(error.code)) {
		return networkFailure('BAD_RESPONSE', status, MESSAGES.notApiError, answer);
	}
	return {
		kind: 'api',
		code: error.code,
		status,
		message: typeof error.message === 'string' && error.message.length > 0 ? error.message : MESSAGES.noServerMessage,
		hint: typeof error.hint === 'string' && error.hint.length > 0 ? error.hint : null,
		details: error.details === undefined ? null : error.details,
		requestId: typeof error.requestId === 'string' && error.requestId.length > 0 ? error.requestId : answer.requestId,
		answer,
	};
}

/**
 * One attempt within `timeoutMs`. The helper's own abort is asked for, and the attempt also stops waiting for
 * it, so a helper that ignores its signal cannot hold a call past its time.
 */
async function attempt(ctx: CallContext, request: HttpRequest, timeoutMs: number, callerSignal: AbortSignal | undefined): Promise<Outcome> {
	const { io } = ctx;
	const timer = io.timeoutSignal(timeoutMs);
	const signal = anySignal([timer, callerSignal]);
	if (callerSignal?.aborted) return networkFailure('ABORTED', null, MESSAGES.aborted, null);
	const startedAt = io.now();
	const sending = io.send(request, signal);
	const stopped = whenAborted(signal).then(() => 'stopped' as const);
	const result = await Promise.race([sending, stopped]);
	if (result === 'stopped' || io.now() - startedAt >= timeoutMs) {
		// an answer that arrives at or after the end of the attempt is a TIMEOUT, as the rules say
		if (callerSignal?.aborted) return networkFailure('ABORTED', null, MESSAGES.aborted, null);
		return networkFailure('TIMEOUT', null, TEXTS.timeout(timeoutMs), null);
	}
	if (isSendFailure(result)) {
		if (callerSignal?.aborted) return networkFailure('ABORTED', null, MESSAGES.aborted, null);
		const code = result.systemCode !== null && SYSTEM_CODE.test(result.systemCode) ? result.systemCode : null;
		return networkFailure('CONNECTION_FAILED', null, code ? TEXTS.connectionFailed(code) : MESSAGES.connectionFailed, null);
	}
	return classifyAnswer(result, ctx.conventions);
}

/** The error a call stops with: its last outcome, the key, and what the rules say about them. */
function errorOf(
	ctx: CallContext,
	row: OperationRow,
	outcome: Failure,
	key: string | null,
	sent: boolean,
	ra: number | null,
	retryable: boolean,
	unknownBefore: boolean,
	note: string | null,
): GptVideoCallError {
	const spent = mayHaveSpent(outcome, row.effect, sent, ctx.conventions.switchedOffReason, unknownBefore);
	const spentKey = spent && key !== null ? key : null;
	const detail: CallError =
		outcome.kind === 'api'
			? {
					kind: 'api',
					code: outcome.code,
					status: outcome.status,
					message: formatMessage({ code: outcome.code, status: outcome.status, message: outcome.message, hint: outcome.hint, requestId: outcome.requestId, mayHaveSpentWithKey: spentKey, note }),
					hint: outcome.hint,
					requestId: outcome.requestId,
					details: outcome.details,
					retryable,
					mayHaveSpent: spent,
					idempotencyKey: key,
					retryAfterSec: ra,
					operation: row.id,
				}
			: {
					kind: 'network',
					code: outcome.code,
					status: outcome.status,
					message: formatMessage({ code: outcome.code, status: outcome.status, message: outcome.text, requestId: outcome.answer?.requestId ?? null, mayHaveSpentWithKey: spentKey, note }),
					hint: null,
					requestId: outcome.answer?.requestId ?? null,
					details: null,
					retryable,
					mayHaveSpent: spent,
					idempotencyKey: key,
					retryAfterSec: outcome.code === 'BAD_RESPONSE' ? ra : null,
					operation: row.id,
				};
	return new GptVideoCallError(detail);
}

export type CallOptions = {
	readonly limits?: Partial<CallLimits>;
	/** the key of the call, made by the caller before this function runs; null for an operation that takes none */
	readonly idempotencyKey: string | null;
	/** a sentence to add to the message of the error, when the caller can do something the API's words do not say */
	readonly explain?: (outcome: Failure) => string | null;
};

/**
 * Sends one call: attempts until one succeeds or the rules stop it. Resolves to the body of the answer, as it
 * is; rejects with a GptVideoCallError.
 */
export async function send(ctx: CallContext, row: OperationRow, request: HttpRequest, options: CallOptions): Promise<CallResult> {
	const { io } = ctx;
	const limits: CallLimits = { ...DEFAULT_LIMITS, ...options.limits };
	const key = options.idempotencyKey;
	const sentKey = request.headers[ctx.conventions.headers.idempotencyKey] ?? null;
	if (sentKey !== key) throw new Error(`the request of ${row.id} does not carry the key of the call`);

	let unknown = false;
	const stop = (outcome: Failure, sent: boolean, ra: number | null, retry: boolean) =>
		errorOf(ctx, row, outcome, key, sent, ra, retry, unknown, explainOf(options, outcome));
	const aborted = networkFailure('ABORTED', null, MESSAGES.aborted, null);
	if (io.cancel?.aborted) throw stop(aborted, false, null, false);

	const deadlineAt = io.now() + limits.deadlineMs;
	let failures = 0;
	let last: { outcome: Failure; ra: number | null; retry: boolean } | null = null;
	for (let n = 1; ; n++) {
		const left = deadlineAt - io.now();
		if (left <= 0 && last) throw stop(last.outcome, true, last.ra, last.retry);
		const outcome = await attempt(ctx, request, Math.min(limits.timeoutMs, left), io.cancel);
		if (outcome.answer) ctx.onAnswer?.(outcome.answer, n);
		if (outcome.kind === 'success') return { body: outcome.body, answer: outcome.answer };

		const ra = outcome.answer ? retryAfterSec(outcome.answer.retryAfter, io.wallNow()) : null;
		const { retry, consumes } = policyOf(outcome, row.retrySafe, ctx.retryable, ctx.conventions.switchedOffReason);
		unknown = unknown || mayHaveSpent(outcome, row.effect, true, ctx.conventions.switchedOffReason, unknown);
		last = { outcome, ra, retry };
		if (!retry) throw stop(outcome, true, ra, retry);
		if (consumes && ++failures > limits.maxRetries) throw stop(outcome, true, ra, retry);
		let delayMs: number;
		if (ra !== null) {
			if (ra > RETRY_AFTER_MAX_SEC) throw stop(outcome, true, ra, retry);
			delayMs = ra * 1000;
		} else {
			delayMs = backoffMs(n, io.random);
		}
		if (io.now() + delayMs >= deadlineAt) throw stop(outcome, true, ra, retry);
		ctx.onRetry?.({ operation: row.id, attempt: n, code: outcome.code, delayMs });
		if (!(await io.sleep(delayMs, io.cancel))) throw stop(aborted, true, null, false);
	}
}

function explainOf(options: CallOptions, outcome: Failure): string | null {
	if (!options.explain) return null;
	try {
		return options.explain(outcome);
	} catch {
		// a sentence that cannot be written is left out
		return null;
	}
}
