// @ts-check
/**
 * The rules of one call, as retry.json of the shared vectors writes them: which outcomes are retried, which count
 * against maxRetries, how long to pause, whether a spend may have been charged, and what an
 * Idempotency-Key looks like. Pure functions over plain values: the clock, the network and the timers
 * belong to transport.mjs, which applies these rules in order.
 */

import { CONVENTIONS } from "./operations.generated.mjs";

/** @typedef {import("./table.mjs").OperationSpec} OperationSpec */

/** The defaults of a call. A test ties them to the `defaults` of retry.json. */
export const DEFAULTS = Object.freeze({
  /** failures retried after the first attempt; IDEMPOTENCY_IN_PROGRESS is a wait and never counts */
  maxRetries: 2,
  /** the time one attempt has, longer than a `?wait=25` read */
  timeoutMs: 60_000,
  /** the time the whole call has, pauses included: the idempotency lease of 120 s plus one attempt */
  deadlineMs: 180_000,
});

/** A Retry-After longer than this stops the call instead of being waited. */
export const RETRY_AFTER_MAX_SEC = 60;

/** The backoff after attempt a is drawn from [0, min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2^(a-1))). */
export const BACKOFF_BASE_MS = 500;
export const BACKOFF_CAP_MS = 8000;

/** The reason of an UNAVAILABLE that comes from an operation turned off: sending it again does not help. */
export const SWITCHED_OFF = CONVENTIONS.switchedOffReason;

const IN_PROGRESS = "IDEMPOTENCY_IN_PROGRESS";
const RATE_LIMITED = "RATE_LIMITED";
const UNAVAILABLE = "UNAVAILABLE";

/**
 * What an attempt ended with, once the answer is read. `answer` is there whenever an HTTP answer arrived.
 *
 * @typedef {object} Answer
 * @property {number} status the HTTP status, 0 for a redirect the runtime hides
 * @property {string | null} retryAfter the raw Retry-After header
 * @property {string | null} requestId the X-Request-Id header
 * @property {boolean} replayed true with Idempotent-Replayed: true
 * @property {{ limit: number | null, remaining: number | null, resetSec: number | null }} rateLimit
 */

/**
 * `followed` marks the answer of a fetch passed in by the caller that followed a redirect although the SDK
 * asked it not to: the request went on to another address, and what happened there is unknown.
 *
 * @typedef {{ kind: "success", status: number, body: unknown, answer: Answer }} Success
 * @typedef {{ kind: "api", code: string, status: number, message: string, hint: string | null, details: unknown, requestId: string | null, answer: Answer }} ApiFailure
 * @typedef {{ kind: "network", code: "CONNECTION_FAILED" | "TIMEOUT" | "ABORTED" | "BAD_RESPONSE", status: number | null, text: string, answer: Answer | null, followed?: true }} NetworkFailure
 * @typedef {Success | ApiFailure | NetworkFailure} Outcome
 * @typedef {ApiFailure | NetworkFailure} Failure
 */

/** The Idempotency-Key the API accepts: 1 to 255 visible ASCII characters, no spaces (keys.json). */
const ACCEPTED_KEY = /^[\x21-\x7E]{1,255}$/;

/**
 * Whether the API would take this Idempotency-Key. In JavaScript `$` matches only at the very end, so a
 * final newline is refused too.
 *
 * @param {unknown} key
 * @returns {key is string}
 */
export function isIdempotencyKey(key) {
  return typeof key === "string" && ACCEPTED_KEY.test(key);
}

/**
 * A new Idempotency-Key: a random UUID, from `crypto.randomUUID` or, where it is missing (a page served
 * over plain http), from `crypto.getRandomValues`. Never from Math.random: two calls that drew the same key
 * would receive each other's answer. Returns null when the runtime has neither.
 *
 * @returns {string | null}
 */
export function newIdempotencyKey() {
  const crypto = globalThis.crypto;
  if (typeof crypto?.randomUUID === "function") return crypto.randomUUID();
  if (typeof crypto?.getRandomValues !== "function") return null;
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const DIGITS = /^[0-9]+$/;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const IMF_FIXDATE = /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), ([0-9]{2}) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) ([0-9]{4}) ([0-9]{2}):([0-9]{2}):([0-9]{2}) GMT$/;

/**
 * Retry-After in whole seconds, or null when it cannot be read. Readable is: ASCII digits after trimming
 * spaces and tabs, or an IMF-fixdate (`Sun, 11 Oct 2026 12:00:07 GMT`) that is a real calendar time and not
 * in the past, which becomes ceil((date - now) / 1000). Everything else (-1, abc, 1e9, 1.5, an older date
 * format, a past date) counts as absent. The weekday name is not checked. Digits past the largest safe
 * integer still say "not before a very long time": they read as Number.MAX_SAFE_INTEGER, which stops the call
 * like any value over RETRY_AFTER_MAX_SEC, and never as absent, which would retry at once.
 *
 * @param {string | null | undefined} raw
 * @param {number} nowMs the wall-clock time the answer arrived
 * @returns {number | null}
 */
export function retryAfterSec(raw, nowMs) {
  if (typeof raw !== "string") return null;
  const value = raw.replace(/^[ \t]+|[ \t]+$/g, "");
  if (DIGITS.test(value)) return Math.min(Number(value), Number.MAX_SAFE_INTEGER);
  const m = IMF_FIXDATE.exec(value);
  if (!m) return null;
  const parts = [Number(m[3]), MONTHS.indexOf(m[2] ?? ""), Number(m[1]), Number(m[4]), Number(m[5]), Number(m[6])];
  const [year = 0, month = 0, day = 0, hour = 0, minute = 0, second = 0] = parts;
  const at = Date.UTC(year, month, day, hour, minute, second);
  const back = new Date(at);
  // a time that does not exist (31 November, 24:00) does not roll over to the next day: it is unreadable
  const real = [back.getUTCFullYear(), back.getUTCMonth(), back.getUTCDate(), back.getUTCHours(), back.getUTCMinutes(), back.getUTCSeconds()];
  if (real.some((v, i) => v !== parts[i])) return null;
  const delta = at - nowMs;
  return delta < 0 ? null : Math.ceil(delta / 1000);
}

/**
 * The pause after attempt number `attempt` (1, 2, 3...) when there is no readable Retry-After: a whole
 * number of milliseconds drawn uniformly from [0, min(8000, 500 * 2^(attempt-1))).
 *
 * @param {number} attempt
 * @param {() => number} random a number in [0, 1)
 * @returns {number}
 */
export function backoffMs(attempt, random) {
  const cap = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** (attempt - 1));
  return Math.floor(random() * cap);
}

/**
 * @param {unknown} details
 * @returns {boolean}
 */
function switchedOff(details) {
  return typeof details === "object" && details !== null && /** @type {{ reason?: unknown }} */ (details).reason === SWITCHED_OFF;
}

/**
 * Whether a failure is retried, and whether it uses up one of maxRetries.
 *
 * Retried when the call is retry-safe: CONNECTION_FAILED, TIMEOUT, BAD_RESPONSE with a 5xx status, and the
 * API's retryable codes, except an UNAVAILABLE that says switched_off. Retried even when the call is not
 * retry-safe: RATE_LIMITED, which the API refuses before running anything. IDEMPOTENCY_IN_PROGRESS is the
 * first attempt still running on the server: it is waited for and never uses up maxRetries. Everything
 * else stops the call, a code this SDK does not know included.
 *
 * @param {Failure} outcome
 * @param {Pick<OperationSpec, "retrySafe">} spec
 * @param {ReadonlySet<string>} retryable the API's retryable codes
 * @returns {{ retry: boolean, consumes: boolean }}
 */
export function policyOf(outcome, spec, retryable) {
  if (outcome.kind === "network") {
    if (outcome.code === "ABORTED") return { retry: false, consumes: false };
    if (outcome.code === "BAD_RESPONSE") return { retry: outcome.status !== null && outcome.status >= 500 && spec.retrySafe, consumes: true };
    return { retry: spec.retrySafe, consumes: true };
  }
  if (!retryable.has(outcome.code)) return { retry: false, consumes: false };
  if (outcome.code === RATE_LIMITED) return { retry: true, consumes: true };
  if (outcome.code === UNAVAILABLE && switchedOff(outcome.details)) return { retry: false, consumes: false };
  return { retry: spec.retrySafe, consumes: outcome.code !== IN_PROGRESS };
}

/**
 * Whether a spend may have been charged when the call stops on this outcome: only for an operation whose
 * effect is spend, only once a request left the client, and only when the outcome leaves the charge
 * unknown. A definite refusal (a 4xx with the API's error body) never may have spent; a redirect that a fetch
 * passed in by the caller followed anyway always may, because the request was sent on and its answer is not read.
 *
 * One refusal is not an answer about the charge: RATE_LIMITED. The API refuses a rate-limited request before it
 * looks at the Idempotency-Key, so when an earlier attempt of the same call left the charge unknown (`unknownBefore`:
 * it timed out, or the API said IDEMPOTENCY_IN_PROGRESS), a RATE_LIMITED that ends the call leaves it unknown too.
 * Without that, a spend still running on the server would be reported as not charged.
 *
 * @param {Failure} outcome
 * @param {Pick<OperationSpec, "effect">} spec
 * @param {boolean} sent
 * @param {boolean} [unknownBefore] whether an earlier attempt of the same call already left the charge unknown
 * @returns {boolean}
 */
export function mayHaveSpent(outcome, spec, sent, unknownBefore = false) {
  if (spec.effect !== "spend" || !sent) return false;
  if (outcome.kind === "network") {
    if (outcome.code !== "BAD_RESPONSE" || outcome.followed === true) return true;
    const status = outcome.status;
    return status !== null && ((status >= 200 && status < 300) || status >= 500);
  }
  if (outcome.code === IN_PROGRESS) return true;
  if (outcome.code === RATE_LIMITED) return unknownBefore;
  return outcome.status >= 500 && !(outcome.code === UNAVAILABLE && switchedOff(outcome.details));
}
