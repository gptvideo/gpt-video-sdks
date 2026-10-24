// @ts-check
// Every vector of requests.generated.json, one of the shared vectors, run on the real client: one example of the
// API reference each, generated from the catalogue. The request the client sends must be the one the vector
// writes (method, path segment by segment, query parameter by parameter, JSON body, Idempotency-Key, bytes), and
// the one response must become the result, or the error, the vector says.
import { describe, expect, it } from "vitest";
import { GptVideo, OPERATION_INDEX } from "./client.mjs";
import { GptVideoApiError, GptVideoError, GptVideoNetworkError } from "./errors.mjs";
import { API_CONTRACT } from "./operations.generated.mjs";
import { readVectors } from "./testing/data.js";
import { scriptedFetch } from "./testing/fake-fetch.js";

const REQUESTS = readVectors("requests.generated.json");
const KEYS = readVectors("keys.json");
const GENERATED_KEY = new RegExp(KEYS.generators.js.pattern);
// built at run time, so that no file of the package holds a string shaped like a real key
const API_KEY = `gvk_${"V".repeat(43)}`;

/**
 * Sends the call of a vector and says what went out and what came back.
 * @param {any} vector
 * @param {any} [response] the answer to give, the vector's own when there is one
 */
async function run(vector, response = vector.response) {
  const spec = OPERATION_INDEX.byId(vector.operation);
  if (!spec) throw new Error(`no operation ${vector.operation}`);
  const script = scriptedFetch([{ status: response.status, headers: response.headers ?? {}, json: response.body }]);
  const gv = new GptVideo({ apiKey: API_KEY, baseUrl: REQUESTS.baseUrl, fetch: script.fetch, maxRetries: 0 });
  const method = /** @type {Record<string, Function>} */ (/** @type {unknown} */ (gv))[spec.name];
  if (typeof method !== "function") throw new Error(`no method ${spec.name}`);
  const bytes = vector.bodyBytes === null || vector.bodyBytes === undefined ? undefined : new Uint8Array(vector.bodyBytes);
  const args = spec.binary ? [vector.input, bytes, vector.options] : [vector.input, vector.options];
  /** @type {{ value?: unknown, error?: any }} */
  let outcome;
  try {
    outcome = { value: await method.apply(gv, args) };
  } catch (error) {
    outcome = { error };
  }
  return { call: script.calls[0], calls: script.calls, ...outcome };
}

/**
 * The request against what the vector writes, compared as its rules say.
 * @param {import("./testing/fake-fetch.js").Recorded | undefined} call
 * @param {any} want
 * @param {any} vector
 */
function checkRequest(call, want, vector) {
  expect(call, "a request went out").toBeDefined();
  if (!call) return;
  expect(call.method).toBe(want.method);
  const url = new URL(call.url);
  const base = new URL(REQUESTS.baseUrl);
  expect(url.origin).toBe(base.origin);
  expect(url.pathname.startsWith(`${base.pathname}/`), url.pathname).toBe(true);
  const segments = url.pathname.slice(base.pathname.length + 1).split("/").map(decodeURIComponent);
  expect(segments, "path, segment by segment").toEqual(want.segments);
  expect(Object.fromEntries(url.searchParams), "query, parameter by parameter").toEqual(want.query);
  expect(url.searchParams.size, "no query parameter twice").toBe(Object.keys(want.query).length);
  if (!("contentType" in want)) return;

  if (want.contentType === null) expect(call.headers).not.toHaveProperty("content-type");
  else expect(call.headers["content-type"]).toBe(want.contentType);
  if (want.json !== null) expect(JSON.parse(String(call.body))).toEqual(want.json);
  if (want.bytes !== null) {
    expect(call.body).toBeInstanceOf(Uint8Array);
    expect(/** @type {Uint8Array} */ (call.body).byteLength).toBe(want.bytes);
  }
  if (want.json === null && want.bytes === null) expect(call.body, "no body").toBeNull();

  const key = call.headers["idempotency-key"];
  if (want.idempotencyKey === "none") expect(key).toBeUndefined();
  else if (want.idempotencyKey === "caller") expect(key).toBe(vector.options.idempotencyKey);
  else expect(key).toMatch(GENERATED_KEY);
}

describe("requests.generated.json", () => {
  it("was generated from the same contract as this client", () => {
    expect(REQUESTS.contract).toEqual({ ...API_CONTRACT });
    expect(REQUESTS.vectors.length).toBeGreaterThanOrEqual(OPERATION_INDEX.listNames.length);
    expect(new Set(REQUESTS.vectors.map((/** @type {any} */ v) => v.operation)).size, "every operation has an example").toBeGreaterThanOrEqual(60);
  });

  for (const vector of REQUESTS.vectors) {
    it(vector.name, async () => {
      const got = await run(vector);
      expect(got.calls, "one request: maxRetries is 0").toHaveLength(1);
      checkRequest(got.call, vector.request, vector);

      const want = vector.outcome;
      if (want.kind === "result") {
        expect(got.error, "no error").toBeUndefined();
        expect(got.value, "the body of the answer, unchanged").toEqual(vector.response.body);
        return;
      }
      const err = got.error;
      const e = want.error;
      expect(err).toBeInstanceOf(GptVideoError);
      if (e.class === "api") expect(err).toBeInstanceOf(GptVideoApiError);
      if (e.class === "network") expect(err).toBeInstanceOf(GptVideoNetworkError);
      expect(err.code).toBe(e.code);
      expect(err.status).toBe(e.status);
      expect(err.retryable, "retryable").toBe(e.retryable);
      expect(err.mayHaveSpent, "mayHaveSpent").toBe(e.mayHaveSpent);
      expect(err.retryAfterSec, "retryAfterSec").toBe(e.retryAfterSec);
      expect(err.operation).toBe(vector.operation);
      if ("requestId" in e) expect(err.requestId).toBe(e.requestId);
      if ("hint" in e) expect(err.hint).toBe(e.hint);
      if ("details" in e) expect(err.details).toEqual(e.details);
      const key = got.call?.headers["idempotency-key"];
      expect(err.idempotencyKey, "the key of the call, to send again").toBe(key ?? null);
    });
  }

  for (const vector of REQUESTS.encoding) {
    it(`encoding: ${vector.name}`, async () => {
      const got = await run(vector, { status: 200, body: {} });
      checkRequest(got.call, vector.request, vector);
    });
  }
});
