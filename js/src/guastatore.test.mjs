// @ts-check
/**
 * The saboteur's list for the JavaScript SDK: the ways this package could charge twice, leak the key, accept a
 * forged webhook, or run for ever, each tried from a road the other suites do not take. Every test here is
 * written against an invariant, not against a line of code:
 *
 *  - one intention, one charge: the Idempotency-Key is born once per call and travels on every attempt and
 *    every wait, a lost answer is asked for again with that key, and no refusal ever makes a second one;
 *  - the key goes nowhere but the Authorization header of a request to the base URL;
 *  - a webhook is accepted only when its bytes were signed with the secret, within the tolerance;
 *  - a call, a wait and a list all end: on a repeated cursor, an unreadable Retry-After, a status nobody knows.
 */
import { createHmac } from "node:crypto";
import { inspect } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GptVideo } from "./client.mjs";
import { download } from "./download.mjs";
import { GptVideoApiError, GptVideoError, GptVideoJobError, GptVideoNetworkError, MESSAGES } from "./errors.mjs";
import { paginate } from "./paginate.mjs";
import { DEFAULTS, RETRY_AFTER_MAX_SEC } from "./retry.mjs";
import { Transport, resolveSettings } from "./transport.mjs";
import { WAITS_PER_CLIENT, WaitSlots, waitOn } from "./wait.mjs";
import { Webhook, WebhookVerificationError, constructEvent, verifyWebhook } from "./webhooks.mjs";
import { drive, useClock } from "./testing/clock.js";
import { scriptedFetch } from "./testing/fake-fetch.js";
import { OPERATIONS } from "./operations.generated.mjs";
import { FIXTURE_INDEX, FIXTURE_RETRYABLE_CODES, fixtureOp as op } from "./testing/operations.fixture.js";

// every key-shaped value is built at run time, so no file of the package holds a string shaped like a real key
const API_KEY = `gvk_${"G".repeat(43)}`;
const NOW = Date.parse("2026-10-11T12:00:00.000Z");
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const PROJECT = { projectId: "prj_7c2e9a4f1b3d4e8096a5" };

/** @param {Record<string, unknown>} [options] */
function transportWith(options = {}) {
  return new Transport(resolveSettings(/** @type {any} */ ({ apiKey: API_KEY, ...options })), FIXTURE_RETRYABLE_CODES);
}

/** @param {import("./testing/fake-fetch.js").Scripted[] | ((r: import("./testing/fake-fetch.js").Recorded, i: number) => any)} script @param {Record<string, unknown>} [options] */
function setup(script, options = {}) {
  const fake = scriptedFetch(script);
  const transport = transportWith({ fetch: fake.fetch, ...options });
  return { fake, transport, ctx: { transport, index: FIXTURE_INDEX, slots: new WaitSlots(WAITS_PER_CLIENT) } };
}

/** @param {string} code @param {number} status @param {Record<string, string>} [headers] @param {Record<string, unknown>} [more] */
const apiError = (code, status, headers = {}, more = {}) => ({ status, headers, json: { error: { code, message: `${code} happened.`, ...more } } });
/** @param {boolean} [replayed] @returns {import("./testing/fake-fetch.js").Scripted} */
const accepted = (replayed = false) => {
  /** @type {Record<string, string>} */
  const headers = replayed ? { "Idempotent-Replayed": "true" } : {};
  return { status: 202, headers, json: { job: { id: "job_1", status: "queued", finishedAt: null } } };
};

/**
 * drive, with the outcome typed loosely: every test reads fields of the value or of the error.
 * @param {Promise<unknown>} promise
 * @returns {Promise<{ value?: any, error?: any, at: number }>}
 */
const run = (promise) => drive(promise);

/** When request number i left, in milliseconds of the fake clock. @param {ReturnType<typeof scriptedFetch>} fake @param {number} i */
const at = (fake, i) => fake.calls[i]?.at ?? Number.NaN;

/** @param {Promise<unknown>} promise @returns {Promise<any>} */
async function rejected(promise) {
  try {
    await promise;
  } catch (e) {
    return e;
  }
  throw new Error("the promise did not reject");
}

/** @param {() => unknown} fn @returns {any} */
function thrown(fn) {
  try {
    fn();
  } catch (e) {
    return e;
  }
  throw new Error("nothing was thrown");
}

/** The keys a script saw, one entry per request, undefined where none was sent. @param {ReturnType<typeof scriptedFetch>} fake */
const keysSent = (fake) => fake.calls.map((c) => c.headers["idempotency-key"]);

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ------------------------------------------------------------------------------- G1. one intention, one charge

describe("G1. a spend is charged at most once per intention", () => {
  it("sends one key on every attempt and on every wait for IDEMPOTENCY_IN_PROGRESS, and the wait never uses up a retry", async () => {
    useClock(NOW);
    const { fake, transport } = setup([
      apiError("INTERNAL", 500),
      apiError("IDEMPOTENCY_IN_PROGRESS", 409, { "Retry-After": "2" }),
      apiError("IDEMPOTENCY_IN_PROGRESS", 409, { "Retry-After": "2" }),
      apiError("UPSTREAM_FAILED", 502),
      accepted(true),
    ]);
    const got = await run(transport.send(op("analyze_project"), PROJECT));
    expect(got.error).toBeUndefined();
    const keys = keysSent(fake);
    expect(keys).toHaveLength(5);
    expect(keys[0]).toMatch(UUID);
    expect(new Set(keys).size, "one key for the whole call").toBe(1);
    // two failures used up the two retries; the two waits did not count, or the call would have stopped at the 502
    expect(DEFAULTS.maxRetries).toBe(2);
    for (const call of fake.calls) expect([call.method, call.url, call.body]).toEqual(["POST", "https://api.gpt-video.com/v1/projects/prj_7c2e9a4f1b3d4e8096a5/analyze", null]);
  });

  it("a handler slower than the attempt: the SDK times out, waits for the server, and takes the stored answer with the same key", async () => {
    useClock(NOW);
    const { fake, transport } = setup([
      { ...accepted(), afterMs: DEFAULTS.timeoutMs + 1 },
      apiError("IDEMPOTENCY_IN_PROGRESS", 409, { "Retry-After": "5" }),
      accepted(true),
    ]);
    const got = await run(transport.send(op("create_export"), { compositionId: "cmp_1" }));
    expect(got.error).toBeUndefined();
    expect(got.value.job.id).toBe("job_1");
    expect(new Set(keysSent(fake)).size).toBe(1);
    expect(at(fake, 2) - at(fake, 1), "the wait follows Retry-After").toBe(5000);
  });

  it("an abort while the spend runs: the error says it may have charged and carries the key, and that key brings the answer back", async () => {
    useClock(NOW);
    const first = setup([{ network: "hang" }]);
    const controller = new AbortController();
    const pending = first.transport.send(op("analyze_project"), PROJECT, { signal: controller.signal });
    setTimeout(() => controller.abort(), 1000);
    const err = (await run(pending)).error;
    expect(err).toBeInstanceOf(GptVideoNetworkError);
    expect([err.code, err.mayHaveSpent, err.retryable]).toEqual(["ABORTED", true, false]);
    expect(err.idempotencyKey).toBe(first.fake.calls[0]?.headers["idempotency-key"]);
    expect(err.message).toContain(MESSAGES.mayHaveSpent);

    // what the caller does after a crash: the same call with the key of the error, from a new client
    const second = setup([accepted(true)]);
    const got = await run(second.transport.send(op("analyze_project"), PROJECT, { idempotencyKey: err.idempotencyKey }));
    expect(got.error).toBeUndefined();
    expect(second.fake.calls[0]?.headers["idempotency-key"]).toBe(err.idempotencyKey);
  });

  it("a key the API says was reused is a refusal sent once, never a call with a fresh key", async () => {
    const { fake, transport } = setup([apiError("IDEMPOTENCY_KEY_REUSED", 422)]);
    const err = await rejected(transport.send(op("analyze_project"), PROJECT, { idempotencyKey: "order-42" }));
    expect(err).toBeInstanceOf(GptVideoApiError);
    expect([err.code, err.status, err.retryable, err.mayHaveSpent, err.idempotencyKey]).toEqual(["IDEMPOTENCY_KEY_REUSED", 422, false, false, "order-42"]);
    expect(keysSent(fake)).toEqual(["order-42"]);
  });

  it("a POST that carries no key is never sent twice, except on RATE_LIMITED, which the API refuses before running anything", async () => {
    useClock(NOW);
    // today every POST of the API either carries a key or is idempotent, so the rule is proved on a row of tomorrow
    expect(OPERATIONS.filter((row) => row.method === "POST" && row.idempotencyKey === "none" && !row.retrySafe)).toEqual([]);
    const estimate = Object.freeze({ ...op("estimate_analysis"), retrySafe: false });
    const lost = setup([{ network: "connection_failed" }, accepted()]);
    const err = (await run(lost.transport.send(estimate, PROJECT))).error;
    expect(err.code).toBe("CONNECTION_FAILED");
    expect(lost.fake.calls).toHaveLength(1);
    expect(keysSent(lost.fake)).toEqual([undefined]);
    const slow = setup([apiError("INTERNAL", 500), accepted()]);
    expect((await run(slow.transport.send(estimate, PROJECT))).error.code).toBe("INTERNAL");
    expect(slow.fake.calls).toHaveLength(1);
    const braked = setup([apiError("RATE_LIMITED", 429, { "Retry-After": "1" }), { status: 200, json: { estimate: {} } }]);
    expect((await run(braked.transport.send(estimate, PROJECT))).error).toBeUndefined();
    expect(braked.fake.calls).toHaveLength(2);
  });

  it("a key of the caller that the API would refuse stops the call before anything is sent", async () => {
    const { fake, transport } = setup([accepted()]);
    for (const key of ["", "k".repeat(256), "order 42", "order-42\n", 42, null]) {
      const err = await rejected(transport.send(op("analyze_project"), PROJECT, /** @type {any} */ ({ idempotencyKey: key })));
      expect(err.code, JSON.stringify(key)).toBe("INVALID_ARGUMENT");
      expect(err.message).toContain(MESSAGES.badIdempotencyKey);
    }
    expect(fake.calls).toHaveLength(0);
    // the longest key the API takes goes through as it is
    await transport.send(op("analyze_project"), PROJECT, { idempotencyKey: "k".repeat(255) });
    expect(keysSent(fake)).toEqual(["k".repeat(255)]);
  });

  it("two calls are two intentions: the SDK remembers no key between them", async () => {
    const { fake, transport } = setup([accepted(), accepted()]);
    await transport.send(op("analyze_project"), PROJECT);
    await transport.send(op("analyze_project"), PROJECT);
    const [a, b] = keysSent(fake);
    expect(a).toMatch(UUID);
    expect(b).toMatch(UUID);
    expect(a).not.toBe(b);
  });
});

// ------------------------------------------------------------------------------------ G2. the key stays home

describe("G2. the key leaves the client only in the Authorization header", () => {
  const echoing = () => ({
    status: 500,
    headers: { "X-Request-Id": `req_${API_KEY}` },
    json: { error: { code: "INTERNAL", message: `Bad key ${API_KEY}.`, hint: `Try ${API_KEY} again.`, details: { token: API_KEY, [API_KEY]: [API_KEY, { deep: API_KEY }] } } },
  });

  it("is in no field, text or printed form of an error, even when the server sends it back in every field", async () => {
    useClock(NOW);
    /** @type {unknown[]} */
    const seen = [];
    const { transport } = setup([echoing(), echoing(), echoing()], { onResponse: (/** @type {unknown} */ e) => seen.push(e), onRetry: (/** @type {unknown} */ e) => seen.push(e) });
    const err = (await run(transport.send(op("analyze_project"), PROJECT))).error;
    expect(err).toBeInstanceOf(GptVideoApiError);
    const everything = [err.message, err.stack, err.hint, err.requestId, String(err), JSON.stringify(err), inspect(err, { depth: 20 }), JSON.stringify(err.details), JSON.stringify(seen), inspect(seen, { depth: 20 })];
    for (const text of everything) {
      expect(text).toBeTypeOf("string");
      expect(text).not.toContain(API_KEY);
      expect(text).not.toContain(API_KEY.slice(4));
    }
    expect(err.details.token).toBe("[redacted]");
    expect(Object.keys(err.details)).toEqual(["token", "[redacted]"]);
    expect(seen).toHaveLength(5);
  });

  it("is in no printed form of a client, and never in a URL or a body", async () => {
    const { fake } = setup([{ status: 200, json: {} }]);
    const gv = new GptVideo({ apiKey: API_KEY, fetch: fake.fetch });
    await gv.updateProject({ ...PROJECT, title: "x" });
    for (const text of [inspect(gv), String(gv), JSON.stringify(gv), inspect(gv, { showHidden: true, depth: 20 }), Object.keys(gv).join(",")]) {
      expect(text).not.toContain(API_KEY.slice(4));
    }
    const [call] = fake.calls;
    expect(call?.url).not.toContain(API_KEY.slice(4));
    expect(String(call?.body)).not.toContain(API_KEY.slice(4));
    expect(call?.headers.authorization).toBe(`Bearer ${API_KEY}`);
  });

  it("goes over plain http only to this machine", () => {
    const { fake } = setup([]);
    for (const baseUrl of ["http://api.gpt-video.com/v1", "http://example.com", "http://127.0.0.1.example.com/v1", "http://localhost.example.com"]) {
      expect(thrown(() => new GptVideo({ apiKey: API_KEY, baseUrl, fetch: fake.fetch })).message, baseUrl).toContain(MESSAGES.insecureBaseUrl);
    }
    for (const baseUrl of ["http://localhost:3000/v1", "http://127.0.0.1:3000", "http://[::1]:3000/v1", "http://app.localhost/v1", "https://api.gpt-video.com/v1"]) {
      expect(() => new GptVideo({ apiKey: API_KEY, baseUrl, fetch: fake.fetch }), baseUrl).not.toThrow();
    }
    expect(fake.calls).toHaveLength(0);
  });

  it("never follows a redirect, and treats an answer that a fetch fetched from elsewhere as a possible charge", async () => {
    const { fake, transport } = setup([{ status: 307, headers: { Location: "https://evil.example.com/v1/projects/x/analyze" }, text: "" }]);
    const err = await rejected(transport.send(op("analyze_project"), PROJECT));
    expect([err.code, err.status, err.mayHaveSpent, err.retryable]).toEqual(["BAD_RESPONSE", 307, false, false]);
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]?.redirect).toBe("manual");

    const followed = setup([{ status: 200, json: { job: {} }, redirectedTo: "https://evil.example.com/v1/projects/x/analyze" }]);
    const e = await rejected(followed.transport.send(op("analyze_project"), PROJECT));
    expect([e.code, e.mayHaveSpent]).toEqual(["BAD_RESPONSE", true]);
    expect(e.message).toContain(MESSAGES.redirectFollowed);
    expect(e.idempotencyKey).toBe(followed.fake.calls[0]?.headers["idempotency-key"]);
  });

  it("downloads without the key, even from the host of the API, and never over plain http to another host", async () => {
    const { fake, ctx } = setup([{ status: 200, text: "bytes" }]);
    const res = await download(ctx, "https://api.gpt-video.com/v1/exports/exp_1/file?sig=abc");
    expect(await res.text()).toBe("bytes");
    expect(Object.keys(fake.calls[0]?.headers ?? {})).not.toContain("authorization");
    expect(JSON.stringify(fake.calls[0]?.headers)).not.toContain(API_KEY.slice(4));
    const err = await rejected(download(ctx, "http://cdn.example.com/file.mp4"));
    expect(err.code).toBe("INVALID_ARGUMENT");
    expect(fake.calls).toHaveLength(1);
  });

  it("in a web page without the flag, no request leaves", () => {
    vi.stubGlobal("window", {});
    vi.stubGlobal("document", {});
    const fake = scriptedFetch([{ status: 200, json: {} }]);
    const err = thrown(() => new GptVideo({ apiKey: API_KEY, fetch: fake.fetch }));
    expect(err).toBeInstanceOf(GptVideoError);
    expect(err.message).toContain(MESSAGES.browser);
    expect(fake.calls).toHaveLength(0);
  });
});

// ------------------------------------------------------------------------------- G3. the signature of a webhook

describe("G3. a webhook is accepted only when its bytes were signed with the secret", () => {
  const secretBytes = Buffer.from("abcdefghijklmnopqrstuvwxyz012345");
  const secret = `whsec_${secretBytes.toString("base64")}`;
  const other = `whsec_${Buffer.from("ABCDEFGHIJKLMNOPQRSTUVWXYZ543210").toString("base64")}`;
  const id = "wev_32aeca77d094a0e08a11";
  const timestamp = 1767225600;
  const now = timestamp * 1000;
  /** @param {string} content @param {string} [withSecret] */
  const sign = (content, withSecret = secret) => createHmac("sha256", Buffer.from(withSecret.slice(6), "base64")).update(content).digest("base64");
  // a body whose signature holds a + or a /, so its base64url form differs from the standard one beyond the padding
  const bodyOf = (/** @type {number} */ n) => `{"type":"job.completed","data":{"jobId":"job_${n}"}}`;
  let nonce = 0;
  while (!/[+/]/.test(sign(`${id}.${timestamp}.${bodyOf(nonce)}`))) nonce++;
  const body = bodyOf(nonce);
  const good = sign(`${id}.${timestamp}.${body}`);
  /** @param {Record<string, unknown>} [over] */
  const headersOf = (over = {}) => ({ "webhook-id": id, "webhook-timestamp": String(timestamp), "webhook-signature": `v1,${good}`, ...over });
  /** @param {Record<string, unknown>} [over] @param {Partial<{ body: unknown, now: number, secret: string }>} [extra] */
  const verify = (over = {}, extra = {}) => verifyWebhook(/** @type {any} */ ({ secret: extra.secret ?? secret, headers: headersOf(over), body: extra.body ?? body, now: extra.now ?? now }));

  it("accepts the delivery, several signatures with one right, header names in any case or as arrays, and a signature without padding", async () => {
    expect(good.endsWith("=")).toBe(true);
    expect(await verify()).toEqual({ id, timestamp });
    expect(await verify({ "webhook-signature": `v1,${sign("x")} v2,${good} v1,${good} v1,${sign("y")}` })).toEqual({ id, timestamp });
    const shouting = { "WEBHOOK-ID": id, "Webhook-Timestamp": String(timestamp), "WEBHOOK-SIGNATURE": [`v1,${sign("x")}`, `v1,${good}`] };
    expect(await verifyWebhook({ secret, headers: shouting, body, now })).toEqual({ id, timestamp });
    expect(await verify({ "webhook-signature": `v1,${good.replace(/=+$/, "")}` })).toEqual({ id, timestamp });
    expect(await verify({}, { body: Buffer.from(body) })).toEqual({ id, timestamp });
    expect((await constructEvent({ secret, headers: headersOf(), body, now })).type).toBe("job.completed");
    vi.spyOn(Date, "now").mockReturnValue(now);
    expect(/** @type {any} */ (await new Webhook(secret).verify(body, headersOf())).data.jobId, "the Standard Webhooks form reads the clock").toBe(`job_${nonce}`);
  });

  it("refuses what was not signed with this secret over these bytes, with the reason", async () => {
    /** @type {[string, () => Promise<unknown>, string][]} */
    const cases = [
      ["another secret", () => verify({}, { secret: other }), "no_matching_signature"],
      ["one byte of the body", () => verify({}, { body: body.replace("job_", "jb_") }), "no_matching_signature"],
      ["one byte of the id", () => verify({ "webhook-id": id.replace("3", "4") }), "no_matching_signature"],
      ["one byte of the timestamp", () => verify({ "webhook-timestamp": String(timestamp + 1) }), "no_matching_signature"],
      ["301 seconds later", () => verify({}, { now: now + 301_000 }), "timestamp_outside_tolerance"],
      ["301 seconds earlier", () => verify({}, { now: now - 301_000 }), "timestamp_outside_tolerance"],
      ["a timestamp that is not a number", () => verify({ "webhook-timestamp": "soon" }), "bad_timestamp"],
      ["a timestamp with a space", () => verify({ "webhook-timestamp": ` ${timestamp}` }), "bad_timestamp"],
      ["a timestamp with decimals", () => verify({ "webhook-timestamp": `${timestamp}.0` }), "bad_timestamp"],
      ["no signature header", () => verify({ "webhook-signature": undefined }), "missing_headers"],
      ["no id header", () => verify({ "webhook-id": "" }), "missing_headers"],
      ["the v1a scheme", () => verify({ "webhook-signature": `v1a,${good}` }), "no_matching_signature"],
      ["the v2 scheme", () => verify({ "webhook-signature": `v2,${good}` }), "no_matching_signature"],
      ["an empty signature", () => verify({ "webhook-signature": "v1," }), "no_matching_signature"],
      ["a truncated signature", () => verify({ "webhook-signature": `v1,${good.slice(0, 20)}` }), "no_matching_signature"],
      ["31 bytes", () => verify({ "webhook-signature": `v1,${Buffer.from(good, "base64").subarray(0, 31).toString("base64")}` }), "no_matching_signature"],
      ["33 bytes", () => verify({ "webhook-signature": `v1,${Buffer.concat([Buffer.from(good, "base64"), Buffer.from([0])]).toString("base64")}` }), "no_matching_signature"],
      ["several signatures, none right", () => verify({ "webhook-signature": `v1,${sign("a")} v1,${sign("b")} v1,${sign("c")}` }), "no_matching_signature"],
      ["base64url", () => verify({ "webhook-signature": `v1,${Buffer.from(good, "base64").toString("base64url")}` }), "no_matching_signature"],
    ];
    for (const [name, run, reason] of cases) {
      const err = await rejected(run());
      expect(err, name).toBeInstanceOf(WebhookVerificationError);
      expect(err.reason, name).toBe(reason);
      expect(err.message, name).not.toContain(good);
    }
    // the base64url form differs from the standard one beyond the padding, or the case above proves nothing
    expect(good).toMatch(/[+/]/);
  });

  it("stops on a parsed body, on a secret without whsec_, and on an API key passed as the secret", async () => {
    /** @type {[string, () => Promise<unknown>, string, string][]} */
    const cases = [
      ["a parsed body", () => verify({}, { body: JSON.parse(body) }), "body_not_raw", MESSAGES.webhookBodyNotRaw],
      ["a bare secret", () => verify({}, { secret: secretBytes.toString("base64") }), "bad_secret", MESSAGES.badWebhookSecret],
      ["an API key", () => verify({}, { secret: API_KEY }), "bad_secret", MESSAGES.apiKeyAsWebhookSecret],
    ];
    for (const [name, run, reason, sentence] of cases) {
      const err = await rejected(run());
      expect(err.reason, name).toBe(reason);
      expect(err.message, name).toContain(sentence);
      expect(err.message, name).not.toContain(API_KEY.slice(4));
    }
    expect(thrown(() => new Webhook(API_KEY)).reason).toBe("bad_secret");
  });
});

// ------------------------------------------------------------------------------------------- G8. everything ends

describe("G8. every call, wait and list ends", () => {
  it("a list whose cursor comes back stops with BAD_RESPONSE after the items it has", async () => {
    const page = (/** @type {string[]} */ ids, /** @type {string | null} */ next) => ({ status: 200, json: { data: ids.map((id) => ({ id })), hasMore: next !== null, nextCursor: next } });
    const { ctx } = setup([page(["a"], "c1"), page(["b"], "c2"), page(["c"], "c1")]);
    /** @type {string[]} */
    const got = [];
    const err = await rejected(
      (async () => {
        for await (const item of paginate(ctx, "listProjects")) got.push(item.id);
      })(),
    );
    expect(got).toEqual(["a", "b", "c"]);
    expect(err).toBeInstanceOf(GptVideoNetworkError);
    expect(err.code).toBe("BAD_RESPONSE");
    expect(err.message).toContain(MESSAGES.repeatedCursor);
  });

  it("a proxy's HTML page with a Retry-After date is waited out on a read, and a 4xx page is not", async () => {
    useClock(NOW);
    const page = (/** @type {number} */ status, /** @type {string} */ retryAfter) => ({ status, headers: { "Content-Type": "text/html", "Retry-After": retryAfter }, text: "<html>busy</html>" });
    const later = new Date(NOW + 7000).toUTCString();
    const { fake, transport } = setup([page(503, later), { status: 200, json: { key: {} } }]);
    const got = await run(transport.send(op("get_me"), undefined));
    expect(got.error).toBeUndefined();
    expect(at(fake, 1) - at(fake, 0)).toBe(7000);
    const refused = setup([page(403, "5")]);
    const err = (await run(refused.transport.send(op("get_me"), undefined))).error;
    expect([err.code, err.status, err.retryable]).toEqual(["BAD_RESPONSE", 403, false]);
    expect(err.message).not.toContain("<html>");
    expect(refused.fake.calls).toHaveLength(1);
  });

  it("an unreadable Retry-After is a backoff, and one past the ceiling ends the call with retryAfterSec", async () => {
    useClock(NOW);
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    for (const raw of ["-1", "abc", "1e9", "1.5", "", new Date(NOW - 1000).toUTCString()]) {
      const { fake, transport } = setup([apiError("UNAVAILABLE", 503, { "Retry-After": raw }), { status: 200, json: { key: {} } }]);
      const got = await run(transport.send(op("get_me"), undefined));
      expect(got.error, raw).toBeUndefined();
      expect(at(fake, 1) - at(fake, 0), raw).toBe(250);
    }
    for (const far of [() => String(RETRY_AFTER_MAX_SEC + 1), () => "9".repeat(400), () => new Date(Date.now() + 61_000).toUTCString()]) {
      const raw = far();
      const { fake, transport } = setup([apiError("UNAVAILABLE", 503, { "Retry-After": raw })]);
      const err = (await run(transport.send(op("get_me"), undefined))).error;
      expect([err.code, err.retryable], raw).toEqual(["UNAVAILABLE", true]);
      expect(err.retryAfterSec, raw).toBeGreaterThan(RETRY_AFTER_MAX_SEC);
      expect(fake.calls, raw).toHaveLength(1);
    }
  });

  it("a status nobody knows ends the wait when finishedAt is set, and at the end of the time when it is not", async () => {
    useClock(NOW);
    const read = (/** @type {Record<string, unknown>} */ job) => ({ status: 200, json: { job: { id: "job_1", errorMessage: null, ...job } } });
    const settled = setup([read({ status: "archived", finishedAt: "2026-10-11T12:00:30.000Z" })]);
    const got = await run(waitOn(settled.ctx, { job: { id: "job_1", status: "queued" } }));
    expect(got.value.status).toBe("archived");
    expect(settled.fake.calls).toHaveLength(1);

    const endless = setup(() => ({ ...read({ status: "archived", finishedAt: null }), afterMs: 25_000 }));
    const err = (await run(waitOn(endless.ctx, { job: { id: "job_1", status: "queued" } }, { timeoutMs: 100_000 }))).error;
    expect(err).toBeInstanceOf(GptVideoJobError);
    expect([err.code, err.retryable, err.handle.status]).toEqual(["WAIT_TIMEOUT", true, "archived"]);
    expect(err.message).toContain("Its last status is archived.");
    expect(endless.fake.calls.length).toBe(4);
    // an export that is rendering is still working: a wait on it goes on
    const rendering = setup([{ status: 200, json: { export: { id: "exp_1", status: "rendering", finishedAt: null } }, afterMs: 25_000 }, { status: 200, json: { export: { id: "exp_1", status: "done", finishedAt: "2026-10-11T12:00:30.000Z", downloadUrl: "https://x/y" } } }]);
    expect((await run(waitOn(rendering.ctx, { export: { id: "exp_1", status: "rendering" } }))).value.status).toBe("done");
    expect(rendering.fake.calls).toHaveLength(2);
  });

  it("a base URL written with or without /v1 sends one and the same request", async () => {
    for (const baseUrl of ["https://api.gpt-video.com/v1", "https://api.gpt-video.com", "https://api.gpt-video.com/v1/", "https://api.gpt-video.com/"]) {
      const { fake, transport } = setup([{ status: 200, json: { key: {} } }], { baseUrl });
      await transport.send(op("get_me"), undefined);
      expect(fake.calls[0]?.url, baseUrl).toBe("https://api.gpt-video.com/v1/me");
      expect(transport.baseUrl, baseUrl).toBe("https://api.gpt-video.com/v1");
    }
    const { fake, transport } = setup([{ status: 200, json: { key: {} } }], { baseUrl: "https://example.com/api/v1" });
    await transport.send(op("get_me"), undefined);
    expect(fake.calls[0]?.url).toBe("https://example.com/api/v1/me");
  });
});
