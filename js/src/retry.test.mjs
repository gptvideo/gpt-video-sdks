// @ts-check
// The pure rules of a call, against the shared vectors: the defaults of retry.json, the keys of keys.json,
// Retry-After as rule 6 reads it, and the key generator.
import { readVectors } from "./testing/data.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BACKOFF_BASE_MS,
  BACKOFF_CAP_MS,
  DEFAULTS,
  RETRY_AFTER_MAX_SEC,
  SWITCHED_OFF,
  backoffMs,
  isIdempotencyKey,
  mayHaveSpent,
  newIdempotencyKey,
  policyOf,
  retryAfterSec,
} from "./retry.mjs";

const RETRY = readVectors("retry.json");
const KEYS = readVectors("keys.json");

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the defaults", () => {
  it("are the ones retry.json writes", () => {
    expect(DEFAULTS).toEqual({ maxRetries: RETRY.defaults.maxRetries, timeoutMs: RETRY.defaults.timeoutMs, deadlineMs: RETRY.defaults.deadlineMs });
    expect(RETRY_AFTER_MAX_SEC).toBe(RETRY.defaults.retryAfterMaxSec);
    expect({ baseMs: BACKOFF_BASE_MS, capMs: BACKOFF_CAP_MS }).toEqual(RETRY.defaults.backoff);
  });

  it("are frozen", () => {
    expect(Object.isFrozen(DEFAULTS)).toBe(true);
  });
});

describe("the Idempotency-Key", () => {
  it("accepts every valid key of keys.json and refuses every invalid one", () => {
    for (const { key, why } of KEYS.valid) expect(isIdempotencyKey(key), why).toBe(true);
    for (const { key, why } of KEYS.invalid) expect(isIdempotencyKey(key), why).toBe(false);
    for (const value of [undefined, null, 42, ["a"], { key: "a" }]) expect(isIdempotencyKey(value)).toBe(false);
  });

  it("is made as keys.json says for JavaScript, and never twice the same", () => {
    const pattern = new RegExp(KEYS.generators.js.pattern);
    const made = Array.from({ length: 200 }, () => newIdempotencyKey());
    for (const key of made) {
      expect(key).toMatch(pattern);
      expect(isIdempotencyKey(key)).toBe(true);
    }
    expect(new Set(made).size).toBe(made.length);
  });

  it("is made from getRandomValues where randomUUID is missing, as on a page served over http", () => {
    const real = globalThis.crypto;
    vi.stubGlobal("crypto", { getRandomValues: (/** @type {Uint8Array} */ bytes) => real.getRandomValues(bytes) });
    const pattern = new RegExp(KEYS.generators.js.pattern);
    const made = Array.from({ length: 50 }, () => newIdempotencyKey());
    for (const key of made) expect(key).toMatch(pattern);
    expect(new Set(made).size).toBe(made.length);
  });

  it("is never made from Math.random: without crypto there is no key", () => {
    vi.stubGlobal("crypto", undefined);
    const random = vi.spyOn(Math, "random");
    expect(newIdempotencyKey()).toBeNull();
    expect(random).not.toHaveBeenCalled();
    random.mockRestore();
  });
});

describe("Retry-After", () => {
  const now = Date.parse("2026-10-11T12:00:00.000Z");

  it("reads seconds and IMF-fixdates", () => {
    expect(retryAfterSec("5", now)).toBe(5);
    expect(retryAfterSec(" \t5\t ", now)).toBe(5);
    expect(retryAfterSec("0", now)).toBe(0);
    expect(retryAfterSec("007", now)).toBe(7);
    expect(retryAfterSec("Sun, 11 Oct 2026 12:00:07 GMT", now)).toBe(7);
    expect(retryAfterSec("Mon, 11 Oct 2026 12:00:07 GMT", now), "the weekday name is not checked").toBe(7);
    expect(retryAfterSec("Sun, 11 Oct 2026 12:00:00 GMT", now)).toBe(0);
    expect(retryAfterSec("Sun, 11 Oct 2026 12:00:07 GMT", now + 400), "rounded up, never early").toBe(7);
    expect(retryAfterSec("1000000000", now)).toBe(1_000_000_000);
    expect(retryAfterSec("Fri, 31 Dec 9999 23:59:59 GMT", now), "a date far away is a long wait, not an absent one").toBeGreaterThan(RETRY_AFTER_MAX_SEC);
  });

  it("reads digits too many to count as the largest safe number of seconds, never as absent", () => {
    // absent would mean "retry after a backoff", the opposite of what the server asked
    expect(retryAfterSec("9".repeat(400), now)).toBe(Number.MAX_SAFE_INTEGER);
    expect(retryAfterSec(`${"0".repeat(50)}12`, now), "leading zeros are still digits").toBe(12);
    expect(retryAfterSec("9007199254740993", now)).toBe(Number.MAX_SAFE_INTEGER);
  });

  it("counts everything else as absent", () => {
    for (const bad of [
      null,
      undefined,
      "-1",
      "abc",
      "1e9",
      "1.5",
      "+5",
      "5s",
      "",
      " ",
      "Sun, 11 Oct 2026 11:59:59 GMT",
      "Sun, 31 Nov 2026 12:00:00 GMT",
      "Sun, 11 Oct 2026 24:00:00 GMT",
      "Sunday, 11-Oct-26 12:00:07 GMT",
      "Sun Oct 11 12:00:07 2026",
      "Sun, 11 Oct 2026 12:00:07 UTC",
      "٥",
      "5\n",
      " 5",
    ]) {
      expect(retryAfterSec(bad, now), JSON.stringify(bad)).toBeNull();
    }
  });
});

describe("the backoff", () => {
  it("is drawn from [0, min(8000, 500 * 2^(a-1))) and is whole milliseconds", () => {
    for (let attempt = 1; attempt <= 12; attempt++) {
      const cap = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** (attempt - 1));
      expect(backoffMs(attempt, () => 0)).toBe(0);
      expect(backoffMs(attempt, () => 0.999999)).toBe(Math.floor(0.999999 * cap));
      expect(backoffMs(attempt, () => 0.999999)).toBeLessThan(cap);
      expect(Number.isInteger(backoffMs(attempt, Math.random))).toBe(true);
    }
    expect(backoffMs(2000, () => 0.5), "a huge attempt number stays under the cap").toBe(BACKOFF_CAP_MS / 2);
  });
});

describe("the policy", () => {
  const retryable = new Set(["NOT_READY", "IDEMPOTENCY_IN_PROGRESS", "RATE_LIMITED", "INTERNAL", "UPSTREAM_FAILED", "UNAVAILABLE"]);
  const safe = { retrySafe: true };
  const unsafe = { retrySafe: false };
  /** @param {string} code @param {number} status @param {unknown} [details] @returns {import("./retry.mjs").ApiFailure} */
  const api = (code, status, details = null) => ({ kind: "api", code, status, message: "m", hint: null, details, requestId: null, answer: /** @type {any} */ (null) });
  /** @param {any} code @param {number | null} [status] @returns {import("./retry.mjs").NetworkFailure} */
  const net = (code, status = null) => ({ kind: "network", code, status, text: "t", answer: null });

  it("waits for IDEMPOTENCY_IN_PROGRESS without using up a retry, and counts every other failure", () => {
    expect(policyOf(api("IDEMPOTENCY_IN_PROGRESS", 409), safe, retryable)).toEqual({ retry: true, consumes: false });
    expect(policyOf(api("INTERNAL", 500), safe, retryable)).toEqual({ retry: true, consumes: true });
    expect(policyOf(api("NOT_READY", 409), safe, retryable)).toEqual({ retry: true, consumes: true });
    expect(policyOf(net("TIMEOUT"), safe, retryable)).toEqual({ retry: true, consumes: true });
  });

  it("never retries CONFLICT, a switched-off operation, an abort, or a code it does not know", () => {
    expect(policyOf(api("CONFLICT", 409), safe, retryable).retry).toBe(false);
    expect(policyOf(api("UNAVAILABLE", 503, { reason: SWITCHED_OFF }), safe, retryable).retry).toBe(false);
    expect(policyOf(api("UNAVAILABLE", 503, { reason: "busy" }), safe, retryable).retry).toBe(true);
    expect(policyOf(net("ABORTED"), safe, retryable).retry).toBe(false);
    expect(policyOf(api("SOMETHING_NEW", 500), safe, retryable).retry).toBe(false);
  });

  it("retries a call that is not retry-safe only on RATE_LIMITED", () => {
    expect(policyOf(api("RATE_LIMITED", 429), unsafe, retryable).retry).toBe(true);
    for (const outcome of [api("INTERNAL", 500), api("IDEMPOTENCY_IN_PROGRESS", 409), net("TIMEOUT"), net("CONNECTION_FAILED"), net("BAD_RESPONSE", 502)]) {
      expect(policyOf(outcome, unsafe, retryable).retry, outcome.code).toBe(false);
    }
  });

  it("says a spend may have been charged only when the outcome leaves it unknown", () => {
    const spend = { effect: /** @type {const} */ ("spend") };
    expect(mayHaveSpent(net("TIMEOUT"), spend, true)).toBe(true);
    expect(mayHaveSpent(net("TIMEOUT"), spend, false), "nothing left the client").toBe(false);
    expect(mayHaveSpent(net("TIMEOUT"), { effect: "write" }, true), "only a spend").toBe(false);
    expect(mayHaveSpent(net("BAD_RESPONSE", 200), spend, true)).toBe(true);
    expect(mayHaveSpent(net("BAD_RESPONSE", 403), spend, true)).toBe(false);
    expect(mayHaveSpent(net("BAD_RESPONSE", null), spend, true), "a redirect the runtime hid").toBe(false);
    expect(mayHaveSpent(net("BAD_RESPONSE", 307), spend, true), "a redirect the runtime handed back").toBe(false);
    expect(mayHaveSpent({ ...net("BAD_RESPONSE", null), followed: true }, spend, true), "a redirect a fetch followed anyway").toBe(true);
    expect(policyOf({ ...net("BAD_RESPONSE", null), followed: true }, safe, retryable).retry, "and it is never sent again").toBe(false);
    expect(mayHaveSpent(api("INSUFFICIENT_CREDITS", 402), spend, true)).toBe(false);
    expect(mayHaveSpent(api("INSUFFICIENT_CREDITS", 402), spend, true, true), "the key's own request answered: definite").toBe(false);
    // the API refuses a rate-limited request before it looks at the key: a 429 says nothing about an earlier attempt
    expect(mayHaveSpent(api("RATE_LIMITED", 429), spend, true)).toBe(false);
    expect(mayHaveSpent(api("RATE_LIMITED", 429), spend, true, true), "after an attempt that left the charge unknown").toBe(true);
    expect(mayHaveSpent(api("RATE_LIMITED", 429), { effect: "write" }, true, true), "only a spend").toBe(false);
    expect(mayHaveSpent(api("IDEMPOTENCY_IN_PROGRESS", 409), spend, true)).toBe(true);
    expect(mayHaveSpent(api("UNAVAILABLE", 503), spend, true)).toBe(true);
    expect(mayHaveSpent(api("UNAVAILABLE", 503, { reason: SWITCHED_OFF }), spend, true)).toBe(false);
  });
});
