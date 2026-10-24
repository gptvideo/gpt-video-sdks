/**
 * The engine of the node: a client of the GPT-Video API over the generated table, with the helpers written by
 * hand on top of one call: following work that finishes later, reading a list page after page. Uploads and
 * downloads are in upload.ts and download.ts.
 */

import { type CallError, GptVideoCallError, GptVideoInputError, MESSAGES, TEXTS, formatMessage } from './errors.ts';
import { type CallContext, type CallLimits, type CallResult, type RetryEvent, DEFAULT_LIMITS, send } from './call.ts';
import type { Io } from './io.ts';
import { type BaseUrl, buildRequest } from './request.ts';
import type { Failure } from './rules.ts';
import type { AsyncHandle, Conventions, OperationRow } from './table.ts';

/** The pause after a read that came back early without a final status: 3 seconds and up to 2 more. */
export const EARLY_ANSWER_PAUSE = Object.freeze({ minMs: 3000, spreadMs: 2000 });

/** The time a read of a wait has beyond the seconds the API holds it. */
export const READ_GRACE_MS = 10_000;

/** The largest page the API answers. */
export const PAGE_MAX = 100;

export type EngineSettings = {
	readonly io: Io;
	readonly base: BaseUrl;
	readonly conventions: Conventions;
	readonly operations: readonly OperationRow[];
	readonly retryable: readonly string[];
	readonly userAgent: string;
	readonly onRetry?: (event: RetryEvent) => void;
};

export type Call = {
	readonly input: Readonly<Record<string, unknown>>;
	/** the key of the call, made before the first attempt; null for an operation that takes none */
	readonly idempotencyKey: string | null;
	readonly bytes?: Uint8Array;
	readonly limits?: Partial<CallLimits>;
	readonly explain?: (outcome: Failure) => string | null;
};

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A failure the engine finds in an answer that is not what the API promises, as a BAD_RESPONSE. */
export function badResponse(operation: string, text: string): GptVideoCallError {
	return new GptVideoCallError({
		kind: 'network',
		code: 'BAD_RESPONSE',
		status: null,
		message: formatMessage({ code: 'BAD_RESPONSE', message: text }),
		hint: null,
		requestId: null,
		details: null,
		retryable: false,
		mayHaveSpent: false,
		idempotencyKey: null,
		retryAfterSec: null,
		operation,
	});
}

export class Engine {
	readonly settings: EngineSettings;
	readonly #byId = new Map<string, OperationRow>();
	readonly #reads = new Map<AsyncHandle, OperationRow>();
	readonly #ctx: CallContext;

	constructor(settings: EngineSettings) {
		this.settings = settings;
		for (const row of settings.operations) this.#byId.set(row.id, row);
		for (const row of settings.operations) {
			if (!row.async) continue;
			const read = this.#byId.get(row.async.waitWith);
			if (!read || read.method !== 'GET' || read.pathParams.length !== 1 || !read.inQuery) {
				throw new Error(`The operation table follows ${row.async.handle} with ${row.async.waitWith}, which is not a GET of one id.`);
			}
			this.#reads.set(row.async.handle, read);
		}
		this.#ctx = { io: settings.io, conventions: settings.conventions, retryable: new Set(settings.retryable), onRetry: settings.onRetry };
	}

	/** A row of the table. */
	operation(id: string): OperationRow {
		const row = this.#byId.get(id);
		if (!row) throw new GptVideoInputError(`This version of the node has no operation ${id}.`);
		return row;
	}

	/** The read that follows a kind of work: job → get_job. */
	readFor(handle: AsyncHandle): OperationRow {
		const read = this.#reads.get(handle);
		if (!read) throw new GptVideoInputError(`There is no way to follow ${handle} in this version of the node.`);
		return read;
	}

	/** One call: the request built once, then the attempts. A key is required exactly when the row sends one. */
	async call(id: string, call: Call): Promise<CallResult> {
		const row = this.operation(id);
		if ((row.idempotencyKey === 'none') !== (call.idempotencyKey === null)) {
			throw new Error(`${id}: the key of the call does not match the rule of the operation (${row.idempotencyKey})`);
		}
		const { base, conventions, userAgent } = this.settings;
		const request = buildRequest(base, conventions, row, call.input, call.bytes, call.idempotencyKey, userAgent);
		return send(this.#ctx, row, request, { idempotencyKey: call.idempotencyKey, limits: call.limits, explain: call.explain });
	}

	/** Whether a piece of work is over: a final status, or a finishedAt the API set. */
	isFinal(current: Record<string, unknown>): boolean {
		return this.settings.conventions.finalStatuses.includes(current.status as string) || (current.finishedAt !== null && current.finishedAt !== undefined);
	}

	/**
	 * Follows a piece of work until it is over or `timeoutMs` passes. Each read asks the API to hold it up to
	 * 25 seconds; a read that comes back early without a final status is followed by a pause of 3 to 5
	 * seconds, because the waits of the account are full. Work that failed or was cancelled throws JOB_FAILED
	 * or JOB_CANCELLED, with the object; the end of the time throws WAIT_TIMEOUT with the last object read.
	 * The work itself goes on in every case.
	 */
	async waitFor(handle: AsyncHandle, id: string, timeoutMs: number): Promise<Record<string, unknown>> {
		const { io, conventions } = this.settings;
		const read = this.readFor(handle);
		const param = read.pathParams[0]!;
		const endAt = io.now() + timeoutMs;
		let last: Record<string, unknown> | null = null;
		for (;;) {
			const left = endAt - io.now();
			if (left <= 0) throw this.#waitError(read, 'WAIT_TIMEOUT', id, last, timeoutMs);
			const startedAt = io.now();
			const waitSec = Math.max(0, Math.min(conventions.waitMaxSec, Math.floor(left / 1000)));
			const readTimeoutMs = Math.max(DEFAULT_LIMITS.timeoutMs, waitSec * 1000 + READ_GRACE_MS);
			const readDeadlineMs = Math.min(Math.max(DEFAULT_LIMITS.deadlineMs, readTimeoutMs), Math.max(1, left) + READ_GRACE_MS);
			const { body } = await this.call(read.id, {
				input: { [param]: id, wait: waitSec },
				idempotencyKey: null,
				limits: { timeoutMs: readTimeoutMs, deadlineMs: readDeadlineMs },
			});
			const current = isObject(body) ? body[handle] : undefined;
			if (!isObject(current) || typeof current.status !== 'string') throw badResponse(read.id, TEXTS.missingHandle(handle));
			last = current;
			if (this.isFinal(current)) {
				if (current.status === 'failed') throw this.#waitError(read, 'JOB_FAILED', id, current, timeoutMs);
				if (current.status === 'cancelled') throw this.#waitError(read, 'JOB_CANCELLED', id, current, timeoutMs);
				return current;
			}
			if (waitSec === 0 || io.now() - startedAt < waitSec * 1000) {
				const pauseMs = EARLY_ANSWER_PAUSE.minMs + Math.floor(io.random() * EARLY_ANSWER_PAUSE.spreadMs);
				if (io.now() + pauseMs >= endAt) throw this.#waitError(read, 'WAIT_TIMEOUT', id, last, timeoutMs);
				if (!(await io.sleep(pauseMs, io.cancel))) throw this.#aborted(read);
			}
		}
	}

	#waitError(read: OperationRow, code: 'JOB_FAILED' | 'JOB_CANCELLED' | 'WAIT_TIMEOUT', id: string, last: Record<string, unknown> | null, timeoutMs: number) {
		const said = last && typeof last.errorMessage === 'string' && last.errorMessage.length > 0 ? last.errorMessage : null;
		const status = last && typeof last.status === 'string' ? last.status.slice(0, 64) : null;
		const text = code === 'JOB_FAILED' ? TEXTS.jobFailed(id) : code === 'JOB_CANCELLED' ? TEXTS.jobCancelled(id) : TEXTS.waitTimeout(id, status, timeoutMs);
		const detail: CallError = {
			kind: 'job',
			code,
			status: null,
			message: formatMessage({ code, message: said && code !== 'WAIT_TIMEOUT' ? `${text} ${said}` : text }),
			hint: null,
			requestId: null,
			details: null,
			// waiting again can still see the work end; a failed job stays failed
			retryable: code === 'WAIT_TIMEOUT',
			mayHaveSpent: false,
			idempotencyKey: null,
			retryAfterSec: null,
			operation: read.id,
			object: last,
		};
		return new GptVideoCallError(detail);
	}

	#aborted(read: OperationRow) {
		return new GptVideoCallError({
			kind: 'network',
			code: 'ABORTED',
			status: null,
			message: formatMessage({ code: 'ABORTED', message: MESSAGES.aborted }),
			hint: null,
			requestId: null,
			details: null,
			retryable: false,
			mayHaveSpent: false,
			idempotencyKey: null,
			retryAfterSec: null,
			operation: read.id,
		});
	}

	/**
	 * The items of a list, page after page, until `limit` items (all of them when it is null). The page size
	 * asked of the API is what is still missing, at most 100. A cursor seen before, or hasMore without a
	 * cursor, stops the list with BAD_RESPONSE: it would never end.
	 */
	async list(id: string, input: Readonly<Record<string, unknown>>, limit: number | null): Promise<unknown[]> {
		const row = this.operation(id);
		if (!row.paginated) throw new Error(`${id} is not a list`);
		const items: unknown[] = [];
		const seen = new Set<string>();
		let cursor = typeof input.cursor === 'string' && input.cursor !== '' ? input.cursor : undefined;
		if (cursor !== undefined) seen.add(cursor);
		for (;;) {
			const want = limit === null ? PAGE_MAX : Math.min(PAGE_MAX, limit - items.length);
			if (want <= 0) return items;
			const { body } = await this.call(id, { input: { ...input, limit: want, cursor }, idempotencyKey: null });
			if (!isObject(body) || !Array.isArray(body.data) || typeof body.hasMore !== 'boolean') throw badResponse(id, MESSAGES.notAPage);
			items.push(...(limit === null ? body.data : body.data.slice(0, limit - items.length)));
			if (!body.hasMore) return items;
			const next = body.nextCursor;
			if (typeof next !== 'string' || next === '') throw badResponse(id, MESSAGES.missingCursor);
			if (seen.has(next)) throw badResponse(id, MESSAGES.repeatedCursor);
			seen.add(next);
			cursor = next;
		}
	}
}
