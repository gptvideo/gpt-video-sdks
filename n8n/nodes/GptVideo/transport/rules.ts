/**
 * The rules of one call, as retry.json of the shared SDK vectors writes them: which outcomes are retried,
 * which count against maxRetries, how long to pause, whether a spend may have been charged, and what an
 * Idempotency-Key looks like. Pure functions over plain values: the clock and the network belong to call.ts.
 */

import type { Effect } from './table.ts';

/** The defaults of a call, the `defaults` of retry.json. */
export const DEFAULTS = Object.freeze({
	/** failures retried after the first attempt; IDEMPOTENCY_IN_PROGRESS is a wait and never counts */
	maxRetries: 2,
	/** the time of one attempt, longer than a read that waits 25 seconds */
	timeoutMs: 60_000,
	/** the time of a whole call, pauses included: the idempotency lease of 120 seconds plus one attempt */
	deadlineMs: 180_000,
});

/** A Retry-After longer than this stops the call instead of being waited. */
export const RETRY_AFTER_MAX_SEC = 60;

/** The backoff after attempt a is drawn from [0, min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2^(a-1))). */
export const BACKOFF_BASE_MS = 500;
export const BACKOFF_CAP_MS = 8000;

export const IN_PROGRESS = 'IDEMPOTENCY_IN_PROGRESS';
export const RATE_LIMITED = 'RATE_LIMITED';
export const UNAVAILABLE = 'UNAVAILABLE';

/** The codes of a request that never got a readable answer from the API. */
export type NetworkCode = 'CONNECTION_FAILED' | 'TIMEOUT' | 'ABORTED' | 'BAD_RESPONSE';

/** What an HTTP answer said in its headers. */
export type Answer = {
	readonly status: number;
	readonly retryAfter: string | null;
	readonly requestId: string | null;
	readonly replayed: boolean;
};

export type Success = { readonly kind: 'success'; readonly status: number; readonly body: unknown; readonly answer: Answer };
export type ApiFailure = {
	readonly kind: 'api';
	readonly code: string;
	readonly status: number;
	readonly message: string;
	readonly hint: string | null;
	readonly details: unknown;
	readonly requestId: string | null;
	readonly answer: Answer;
};
export type NetworkFailure = {
	readonly kind: 'network';
	readonly code: NetworkCode;
	readonly status: number | null;
	readonly text: string;
	readonly answer: Answer | null;
};
export type Failure = ApiFailure | NetworkFailure;
export type Outcome = Success | Failure;

/** The Idempotency-Key the API accepts: 1 to 255 visible ASCII characters, no spaces (keys.json). */
const ACCEPTED_KEY = /^[\x21-\x7E]{1,255}$/;

/** Whether the API would take this Idempotency-Key. `$` matches only at the very end in JavaScript. */
export function isIdempotencyKey(key: unknown): key is string {
	return typeof key === 'string' && ACCEPTED_KEY.test(key);
}

const DIGITS = /^[0-9]+$/;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const IMF_FIXDATE =
	/^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), ([0-9]{2}) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) ([0-9]{4}) ([0-9]{2}):([0-9]{2}):([0-9]{2}) GMT$/;

/**
 * Retry-After in whole seconds, or null when it cannot be read: ASCII digits after trimming spaces and tabs,
 * or an IMF-fixdate that is a real calendar time and not in the past. Everything else (-1, abc, 1e9, 1.5, an
 * older date format, a past date) counts as absent. Digits past the largest safe integer read as that integer,
 * which stops the call like any value over RETRY_AFTER_MAX_SEC.
 */
export function retryAfterSec(raw: string | null | undefined, nowMs: number): number | null {
	if (typeof raw !== 'string') return null;
	const value = raw.replace(/^[ \t]+|[ \t]+$/g, '');
	if (DIGITS.test(value)) return Math.min(Number(value), Number.MAX_SAFE_INTEGER);
	const m = IMF_FIXDATE.exec(value);
	if (!m) return null;
	const parts = [Number(m[3]), MONTHS.indexOf(m[2] ?? ''), Number(m[1]), Number(m[4]), Number(m[5]), Number(m[6])];
	const [year = 0, month = 0, day = 0, hour = 0, minute = 0, second = 0] = parts;
	const at = Date.UTC(year, month, day, hour, minute, second);
	const back = new Date(at);
	// a time that does not exist (31 November, 24:00) does not roll over to the next day: it is unreadable
	const real = [back.getUTCFullYear(), back.getUTCMonth(), back.getUTCDate(), back.getUTCHours(), back.getUTCMinutes(), back.getUTCSeconds()];
	if (real.some((v, i) => v !== parts[i])) return null;
	const delta = at - nowMs;
	return delta < 0 ? null : Math.ceil(delta / 1000);
}

/** The pause after attempt number `attempt` (1, 2, 3...) without a readable Retry-After. */
export function backoffMs(attempt: number, random: () => number): number {
	const cap = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** (attempt - 1));
	return Math.floor(random() * cap);
}

function switchedOff(details: unknown, reason: string): boolean {
	return typeof details === 'object' && details !== null && (details as { reason?: unknown }).reason === reason;
}

/**
 * Whether a failure is retried, and whether it uses up one of maxRetries. Retried when the call is retry-safe:
 * CONNECTION_FAILED, TIMEOUT, BAD_RESPONSE with a 5xx status, and the API's retryable codes, except an
 * UNAVAILABLE that says switched_off. Retried whatever the call: RATE_LIMITED, which the API refuses before
 * running anything. IDEMPOTENCY_IN_PROGRESS is the first attempt still running on the server: it is waited
 * for and never uses up maxRetries.
 */
export function policyOf(
	outcome: Failure,
	retrySafe: boolean,
	retryable: ReadonlySet<string>,
	switchedOffReason: string,
): { retry: boolean; consumes: boolean } {
	if (outcome.kind === 'network') {
		if (outcome.code === 'ABORTED') return { retry: false, consumes: false };
		if (outcome.code === 'BAD_RESPONSE') return { retry: outcome.status !== null && outcome.status >= 500 && retrySafe, consumes: true };
		return { retry: retrySafe, consumes: true };
	}
	if (!retryable.has(outcome.code)) return { retry: false, consumes: false };
	if (outcome.code === RATE_LIMITED) return { retry: true, consumes: true };
	if (outcome.code === UNAVAILABLE && switchedOff(outcome.details, switchedOffReason)) return { retry: false, consumes: false };
	return { retry: retrySafe, consumes: outcome.code !== IN_PROGRESS };
}

/**
 * Whether a spend may have been charged when the call stops on this outcome: only for a spend, only once a
 * request left, and only when the outcome leaves the charge unknown. A RATE_LIMITED after an outcome that left
 * the charge unknown leaves it unknown too, because the API refuses it before it looks at the key.
 */
export function mayHaveSpent(outcome: Failure, effect: Effect, sent: boolean, switchedOffReason: string, unknownBefore = false): boolean {
	if (effect !== 'spend' || !sent) return false;
	if (outcome.kind === 'network') {
		if (outcome.code !== 'BAD_RESPONSE') return true;
		const status = outcome.status;
		return status !== null && ((status >= 200 && status < 300) || status >= 500);
	}
	if (outcome.code === IN_PROGRESS) return true;
	if (outcome.code === RATE_LIMITED) return unknownBefore;
	return outcome.status >= 500 && !(outcome.code === UNAVAILABLE && switchedOff(outcome.details, switchedOffReason));
}
