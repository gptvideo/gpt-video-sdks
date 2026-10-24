// @ts-check
// Every scenario of retry.json, the shared retry vectors, run on the real Transport with a scripted fetch and fake
// timers: the requests sent, the Idempotency-Key of each, every pause (through onRetry), the time the call
// took, and the result or the error, field by field. Each scenario runs three times, with the random draw
// of the backoff at 0, 0.5 and just under 1, so a backoff is checked at both ends of its range.
import { readVectors } from "./testing/data.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GptVideoApiError, GptVideoError, GptVideoNetworkError, MESSAGES } from "./errors.mjs";
import { Transport, resolveSettings } from "./transport.mjs";
import { expand, scriptedFetch } from "./testing/fake-fetch.js";
import { RETRYABLE_CODES } from "./client.mjs";
import { drive, useClock } from "./testing/clock.js";

/** @typedef {import("./table.mjs").OperationSpec} OperationSpec */

const RETRY = readVectors("retry.json");
const KEYS = readVectors("keys.json");
const GENERATED_KEY = new RegExp(KEYS.generators.js.pattern);
// built at run time, so that no file of the package holds a string shaped like a real key
const API_KEY = `gvk_${"T".repeat(43)}`;
const RANDOMS = [0, 0.5, 0.999999];

/** @param {string} name @returns {OperationSpec} */
function specOf(name) {
  const op = RETRY.operations[name];
  return {
    id: `${name}_call`,
    name: `${name}Call`,
    method: op.method,
    path: "/v1/things/{thingId}",
    pathParams: ["thingId"],
    inQuery: op.method === "GET",
    binary: null,
    effect: op.effect,
    idempotencyKey: op.idempotencyKey,
    retrySafe: op.retrySafe,
    async: null,
    paginated: false,
    successStatus: 200,
  };
}

/**
 * @param {any} sc
 * @param {number} random
 */
async function run(sc, random) {
  useClock(Date.parse(sc.now ?? RETRY.defaults.now));
  vi.spyOn(Math, "random").mockReturnValue(random);
  const script = scriptedFetch(expand(sc.responses));
  /** @type {import("./transport.mjs").RetryEvent[]} */
  const retries = [];
  /** @type {import("./transport.mjs").ResponseEvent[]} */
  const answers = [];
  const transport = new Transport(
    resolveSettings({ apiKey: API_KEY, fetch: script.fetch, onRetry: (e) => retries.push(e), onResponse: (e) => answers.push(e) }),
    RETRYABLE_CODES,
  );
  const o = sc.options ?? {};
  const controller = new AbortController();
  if (o.abortedBeforeStart) controller.abort();
  if (o.abortAfterMs !== undefined) setTimeout(() => controller.abort(), o.abortAfterMs);
  /** @type {Record<string, unknown>} */
  const options = { signal: controller.signal };
  for (const name of ["maxRetries", "timeoutMs", "deadlineMs", "idempotencyKey"]) if (o[name] !== undefined) options[name] = o[name];
  const start = Date.now();
  const outcome = await drive(transport.send(specOf(sc.operation), { thingId: "thing_1" }, options));
  return { script, retries, answers, ...outcome, elapsed: outcome.at - start };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("retry.json", () => {
  it("has the scenarios this runner expects", () => {
    expect(RETRY.version).toBe(1);
    expect(RETRY.scenarios.length).toBeGreaterThanOrEqual(40);
  });

  for (const sc of RETRY.scenarios) {
    for (const random of RANDOMS) {
      it(`${sc.name} (random ${random})`, async () => {
        const got = await run(sc, random);
        const want = sc.expect;
        const o = sc.options ?? {};

        expect(got.script.calls.length, "requests").toBe(want.requests);
        expect(got.script.left, "answers left unused").toBe(0);
        for (const call of got.script.calls) expect(call.redirect, "redirect").toBe("manual");

        const keys = got.script.calls.map((c) => c.headers["idempotency-key"]);
        if (want.requests > 0) {
          if (want.key === "none") expect(keys.every((k) => k === undefined), "no key on any request").toBe(true);
          else {
            expect(new Set(keys).size, "one key on every request").toBe(1);
            if (want.key === "caller") expect(keys[0]).toBe(o.idempotencyKey);
            else expect(keys[0]).toMatch(GENERATED_KEY);
          }
        }

        expect(got.retries.map((r) => r.code), "pauses").toEqual(want.sleeps.map((/** @type {any} */ s) => s.after));
        want.sleeps.forEach((/** @type {any} */ s, /** @type {number} */ i) => {
          const pause = got.retries[i];
          expect(pause?.attempt, `pause ${i + 1} follows attempt ${i + 1}`).toBe(i + 1);
          const ms = "ms" in s ? s.ms : Math.floor(random * Math.min(RETRY.defaults.backoff.capMs, RETRY.defaults.backoff.baseMs * 2 ** s.backoff));
          expect(pause?.delayMs, `pause ${i + 1}`).toBe(ms);
          expect(pause?.operation).toBe(`${sc.operation}_call`);
        });
        if ("elapsedMs" in want) expect(got.elapsed, "elapsedMs").toBe(want.elapsedMs);

        if ("result" in want) {
          expect(got.error, "no error").toBeUndefined();
          expect(got.answers.at(-1)?.status, "status of the answer").toBe(want.result.status);
          const last = expand(sc.responses).at(-1);
          expect(got.value).toEqual(last?.json);
          return;
        }

        const e = want.error;
        const err = /** @type {any} */ (got.error);
        expect(err, "an error").toBeInstanceOf(GptVideoError);
        if (e.class === "api") expect(err).toBeInstanceOf(GptVideoApiError);
        if (e.class === "network") expect(err).toBeInstanceOf(GptVideoNetworkError);
        if (e.class === "local") {
          expect(err).not.toBeInstanceOf(GptVideoApiError);
          expect(err).not.toBeInstanceOf(GptVideoNetworkError);
        }
        expect(err.code).toBe(e.code);
        expect(err.status ?? null, "status").toBe(e.status);
        expect(err.retryable, "retryable").toBe(e.retryable);
        expect(err.mayHaveSpent, "mayHaveSpent").toBe(e.mayHaveSpent);
        expect(err.retryAfterSec ?? null, "retryAfterSec").toBe(e.retryAfterSec);
        if ("requestId" in e) expect(err.requestId).toBe(e.requestId);
        if (e.key === null) expect(err.idempotencyKey).toBeNull();
        else if (e.key === "caller") expect(err.idempotencyKey).toBe(o.idempotencyKey);
        else if (want.requests > 0) expect(err.idempotencyKey).toBe(keys[0]);
        else expect(err.idempotencyKey).toMatch(GENERATED_KEY);
        expect(err.message.startsWith(`${e.code}`), err.message).toBe(true);
        expect(err.message.includes(MESSAGES.mayHaveSpent), "the charge sentence goes with mayHaveSpent").toBe(e.mayHaveSpent);
        expect(err.message).not.toContain(API_KEY);
      });
    }
  }
});
