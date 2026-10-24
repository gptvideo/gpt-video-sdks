// @ts-check
// The transport beyond the retry vectors: the settings of a client, the request built from a row of the
// table, the browser, a fetch that ignores its signal, redirects, the key kept out of everything the SDK
// hands back, and hooks that throw.
import { inspect } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GptVideoApiError, GptVideoError, GptVideoNetworkError, MESSAGES } from "./errors.mjs";
import {
  CLIENT_OPTIONS,
  DEFAULT_BASE_URL,
  MAX_TIMER_MS,
  OperationIndex,
  Transport,
  USER_AGENT_PRODUCT,
  VERSION,
  resolveBaseUrl,
  resolveSettings,
} from "./transport.mjs";
import { drive, useClock } from "./testing/clock.js";
import { scriptedFetch } from "./testing/fake-fetch.js";
import { FIXTURE_INDEX, FIXTURE_OPERATIONS, FIXTURE_RETRYABLE_CODES, fixtureOp as op } from "./testing/operations.fixture.js";

/** @typedef {import("./table.mjs").OperationSpec} OperationSpec */

// built at run time, so that no file of the package holds a string shaped like a real key
const API_KEY = `gvk_${"K".repeat(43)}`;
const OTHER_KEY = `gvk_${"Z".repeat(43)}`;

/** @param {Record<string, unknown>} [options] */
function transportWith(options = {}) {
  return new Transport(resolveSettings(/** @type {any} */ ({ apiKey: API_KEY, ...options })), FIXTURE_RETRYABLE_CODES);
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

/** @param {Promise<unknown>} promise @returns {Promise<any>} */
async function rejected(promise) {
  try {
    await promise;
  } catch (e) {
    return e;
  }
  throw new Error("the promise did not reject");
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("the settings of a client", () => {
  it("refuses to start in a web page without dangerouslyAllowBrowser, before reading anything else", () => {
    vi.stubGlobal("window", {});
    vi.stubGlobal("document", {});
    const err = thrown(() => resolveSettings({ apiKey: API_KEY }));
    expect(err).toBeInstanceOf(GptVideoError);
    expect(err.code).toBe("INVALID_ARGUMENT");
    expect(err.message).toBe(`INVALID_ARGUMENT: ${MESSAGES.browser}`);
    // the browser comes first: even a bad key gets the browser's answer
    expect(thrown(() => resolveSettings({ apiKey: "nope" })).message).toContain(MESSAGES.browser);
    expect(thrown(() => resolveSettings({ apiKey: API_KEY, dangerouslyAllowBrowser: false })).message).toContain(MESSAGES.browser);
  });

  it("starts in a web page with the flag, and sends no User-Agent there", async () => {
    vi.stubGlobal("window", {});
    vi.stubGlobal("document", {});
    const script = scriptedFetch([{ json: { key: {}, account: {} } }]);
    const settings = resolveSettings({ apiKey: API_KEY, dangerouslyAllowBrowser: true, fetch: script.fetch });
    expect(settings.userAgent).toBeNull();
    await new Transport(settings, FIXTURE_RETRYABLE_CODES).send(op("get_me"), undefined);
    expect(script.calls[0]?.headers).not.toHaveProperty("user-agent");
    expect(script.calls[0]?.headers.authorization).toBe(`Bearer ${API_KEY}`);
  });

  it("starts without the flag where there is no document: a worker, Deno, Bun", () => {
    vi.stubGlobal("window", {});
    expect(resolveSettings({ apiKey: API_KEY }).userAgent).toBe(`${USER_AGENT_PRODUCT}/${VERSION}`);
  });

  it("reads the key from GPT_VIDEO_API_KEY when apiKey is not given", () => {
    vi.stubEnv("GPT_VIDEO_API_KEY", API_KEY);
    expect(resolveSettings({}).apiKey).toBe(API_KEY);
    expect(resolveSettings(undefined).apiKey).toBe(API_KEY);
    expect(resolveSettings({ apiKey: OTHER_KEY }).apiKey, "the option wins").toBe(OTHER_KEY);
  });

  it("says where keys come from when there is none", () => {
    vi.stubEnv("GPT_VIDEO_API_KEY", "");
    for (const options of [{}, { apiKey: "" }, { apiKey: null }, { apiKey: undefined }]) {
      expect(thrown(() => resolveSettings(/** @type {any} */ (options))).message).toBe(`INVALID_ARGUMENT: ${MESSAGES.missingApiKey}`);
    }
  });

  it("reads no environment when the key is passed, and treats a guarded environment as one without a key", () => {
    const real = globalThis.process;
    const guarded = new Proxy(real, {
      get(target, name) {
        if (name === "env") throw new Error("reading the environment is not allowed here");
        return Reflect.get(target, name);
      },
    });
    /** @type {any} */
    let withKey;
    /** @type {any} */
    let withoutKey;
    // swapped and put back in the same synchronous run, so nothing else ever sees the guarded object
    globalThis.process = guarded;
    try {
      withKey = resolveSettings({ apiKey: API_KEY });
      withoutKey = thrown(() => resolveSettings({}));
    } finally {
      globalThis.process = real;
    }
    expect(withKey.apiKey).toBe(API_KEY);
    expect(withoutKey.message).toBe(`INVALID_ARGUMENT: ${MESSAGES.missingApiKey}`);
  });

  it("refuses a value that is not a GPT-Video key, and never repeats it", () => {
    for (const apiKey of ["sk-abcdef0123456789", 42, { key: API_KEY }, `whsec_${"A".repeat(32)}`]) {
      const err = thrown(() => resolveSettings(/** @type {any} */ ({ apiKey })));
      expect(err.message).toBe(`INVALID_ARGUMENT: ${MESSAGES.badApiKeyPrefix}`);
    }
  });

  it("refuses a key with a space or a line break, which a header cannot carry, and never repeats it", () => {
    for (const apiKey of [`${API_KEY}\n`, ` ${API_KEY}`, `${API_KEY} `, `gvk_${"A".repeat(20)} ${"A".repeat(20)}`, `${API_KEY}é`]) {
      const err = thrown(() => resolveSettings({ apiKey }));
      expect(err.message).toBe(`INVALID_ARGUMENT: ${MESSAGES.badApiKeyCharacters}`);
      expect(err.message).not.toContain("K".repeat(43));
    }
  });

  it("refuses an option it does not have, so a misspelling is never a setting that silently does nothing", () => {
    const err = thrown(() => resolveSettings(/** @type {any} */ ({ apiKey: API_KEY, timeout: 5000 })));
    expect(err.message).toBe(`INVALID_ARGUMENT: new GptVideo() has no option timeout. Its options are: ${CLIENT_OPTIONS.join(", ")}.`);
    expect(thrown(() => resolveSettings(/** @type {any} */ ("gvk_x"))).message).toContain("must be an object");
  });

  it("checks every number against what a timer can hold", () => {
    for (const [name, value] of /** @type {[string, unknown][]} */ ([
      ["timeoutMs", 0],
      ["timeoutMs", -1],
      ["timeoutMs", Number.NaN],
      ["timeoutMs", Number.POSITIVE_INFINITY],
      ["timeoutMs", MAX_TIMER_MS + 1],
      ["deadlineMs", "60000"],
      ["maxRetries", -1],
      ["maxRetries", 1.5],
      ["maxRetries", Number.POSITIVE_INFINITY],
    ])) {
      expect(thrown(() => resolveSettings(/** @type {any} */ ({ apiKey: API_KEY, [name]: value }))).code, `${name}: ${String(value)}`).toBe("INVALID_ARGUMENT");
    }
    const s = resolveSettings({ apiKey: API_KEY, timeoutMs: MAX_TIMER_MS, deadlineMs: 1, maxRetries: 0 });
    expect([s.timeoutMs, s.deadlineMs, s.maxRetries]).toEqual([MAX_TIMER_MS, 1, 0]);
  });

  it("has the defaults of retry.json and the base URL of the documentation", () => {
    const s = resolveSettings({ apiKey: API_KEY });
    expect([s.maxRetries, s.timeoutMs, s.deadlineMs]).toEqual([2, 60_000, 180_000]);
    expect(s.baseUrl).toBe(DEFAULT_BASE_URL);
    expect(s.root).toBe("https://api.gpt-video.com");
  });

  it("refuses a fetch that is not a function, and a runtime without one", () => {
    expect(thrown(() => resolveSettings(/** @type {any} */ ({ apiKey: API_KEY, fetch: "fetch" }))).message).toContain("fetch must be a function");
    vi.stubGlobal("fetch", undefined);
    expect(thrown(() => resolveSettings({ apiKey: API_KEY })).message).toBe(`INVALID_ARGUMENT: ${MESSAGES.noFetch}`);
  });

  it("adds a suffix to the User-Agent only in visible ASCII", () => {
    expect(resolveSettings({ apiKey: API_KEY, userAgentSuffix: "my-app/2.1 (ops)" }).userAgent).toBe(`gpt-video-js/${VERSION} my-app/2.1 (ops)`);
    for (const suffix of ["", " x", "x ", "a\nb", "café", "x".repeat(257)]) {
      expect(thrown(() => resolveSettings({ apiKey: API_KEY, userAgentSuffix: suffix })).code, JSON.stringify(suffix)).toBe("INVALID_ARGUMENT");
    }
  });
});

describe("the base URL", () => {
  it("sends the same request with or without its final /v1", () => {
    const forms = [
      "https://api.gpt-video.com/v1",
      "https://api.gpt-video.com/v1/",
      "https://api.gpt-video.com",
      "https://api.gpt-video.com/",
    ];
    for (const form of forms) expect(resolveBaseUrl(form), form).toEqual({ root: "https://api.gpt-video.com", baseUrl: "https://api.gpt-video.com/v1" });
    expect(resolveBaseUrl("https://www.gpt-video.com/api/v1")).toEqual({ root: "https://www.gpt-video.com/api", baseUrl: "https://www.gpt-video.com/api/v1" });
    expect(resolveBaseUrl("https://www.gpt-video.com/api")).toEqual({ root: "https://www.gpt-video.com/api", baseUrl: "https://www.gpt-video.com/api/v1" });
  });

  it("never doubles /v1 in the request", async () => {
    for (const baseUrl of ["https://api.gpt-video.com/v1", "https://api.gpt-video.com", "http://localhost:3000/api/v1", "http://localhost:3000/api"]) {
      const script = scriptedFetch([{ json: { project: {} } }]);
      await transportWith({ baseUrl, fetch: script.fetch }).send(op("get_project"), { projectId: "prj_1" });
      const url = new URL(script.calls[0]?.url ?? "");
      expect(url.pathname, baseUrl).toMatch(/^(?:\/api)?\/v1\/projects\/prj_1$/);
      expect(url.pathname).not.toContain("/v1/v1");
    }
  });

  it("takes http:// only for this machine", () => {
    for (const ok of ["http://localhost:3000/api/v1", "http://127.0.0.1/v1", "http://127.1.2.3/v1", "http://[::1]:8080/v1", "http://app.localhost/v1", "http://LOCALHOST/v1"]) {
      expect(() => resolveBaseUrl(ok), ok).not.toThrow();
    }
    for (const bad of ["http://api.gpt-video.com/v1", "http://10.0.0.5/v1", "http://localhost.example.com/v1", "http://0.0.0.0/v1", "ftp://api.gpt-video.com/v1"]) {
      expect(thrown(() => resolveBaseUrl(bad)).message, bad).toBe(`INVALID_ARGUMENT: ${MESSAGES.insecureBaseUrl}`);
    }
  });

  it("refuses what is not a plain base URL", () => {
    for (const bad of ["api.gpt-video.com/v1", "/v1", "", "https://user:pass@api.gpt-video.com/v1", "https://api.gpt-video.com/v1?x=1", "https://api.gpt-video.com/v1#a", 42]) {
      expect(thrown(() => resolveBaseUrl(bad)).code, String(bad)).toBe("INVALID_ARGUMENT");
    }
  });
});

describe("the request of a call", () => {
  it("carries the key in Authorization, JSON in Accept, the SDK in User-Agent, and nothing else on a read", async () => {
    const script = scriptedFetch([{ json: { project: { id: "prj_1" } } }]);
    const body = await transportWith({ fetch: script.fetch }).send(op("get_project"), { projectId: "prj_1" });
    expect(body).toEqual({ project: { id: "prj_1" } });
    const call = script.calls[0];
    expect(call?.method).toBe("GET");
    expect(call?.url).toBe("https://api.gpt-video.com/v1/projects/prj_1");
    expect(call?.headers).toEqual({ accept: "application/json", "user-agent": `gpt-video-js/${VERSION}`, authorization: `Bearer ${API_KEY}` });
    expect(call?.body).toBeNull();
    expect(call?.redirect).toBe("manual");
  });

  it("puts a spend's fields in the JSON body and its key in Idempotency-Key", async () => {
    const script = scriptedFetch([{ status: 202, json: { job: { id: "job_1", status: "queued", finishedAt: null } } }]);
    await transportWith({ fetch: script.fetch }).send(op("analyze_project"), { projectId: "prj_1", clipCount: 5 }, { idempotencyKey: "order-42" });
    const call = script.calls[0];
    expect(call?.url).toBe("https://api.gpt-video.com/v1/projects/prj_1/analyze");
    expect(call?.headers["idempotency-key"]).toBe("order-42");
    expect(call?.headers["content-type"]).toBe("application/json");
    expect(JSON.parse(String(call?.body))).toEqual({ clipCount: 5 });
  });

  it("sends no body at all when there is no field for it", async () => {
    const script = scriptedFetch([{ status: 202, json: { job: { id: "job_1", status: "queued", finishedAt: null } } }]);
    await transportWith({ fetch: script.fetch }).send(op("analyze_project"), { projectId: "prj_1", clipCount: undefined });
    expect(script.calls[0]?.body).toBeNull();
    expect(script.calls[0]?.headers).not.toHaveProperty("content-type");
  });

  it("makes a key for a POST that writes, and never sends one where the API does not read it", async () => {
    const script = scriptedFetch([{ json: { clip: {} } }, { json: { project: {} } }, { json: { estimate: {} } }, { json: { uploadId: "u", cancelled: true } }]);
    const t = transportWith({ fetch: script.fetch });
    await t.send(op("accept_clip"), { clipId: "cnd_1" });
    await t.send(op("update_project"), { projectId: "prj_1", title: "x" });
    await t.send(op("estimate_analysis"), { projectId: "prj_1" });
    await t.send(op("cancel_upload"), { uploadId: "upl_1" });
    expect(script.calls[0]?.headers["idempotency-key"]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    for (const call of script.calls.slice(1)) expect(call.headers).not.toHaveProperty("idempotency-key");
    expect(script.calls[1]?.method).toBe("PATCH");
    expect(JSON.parse(String(script.calls[1]?.body))).toEqual({ title: "x" });
  });

  it("refuses an idempotencyKey where the API does not read one, and a malformed one, before sending", async () => {
    const script = scriptedFetch([]);
    const t = transportWith({ fetch: script.fetch });
    const none = await rejected(t.send(op("get_project"), { projectId: "prj_1" }, { idempotencyKey: "order-42" }));
    expect(none.code).toBe("INVALID_ARGUMENT");
    expect(none.message).toBe("INVALID_ARGUMENT: getProject takes no idempotencyKey: the API does not read one for it.");
    const bad = await rejected(t.send(op("analyze_project"), { projectId: "prj_1" }, { idempotencyKey: "order 42" }));
    expect(bad.message).toBe(`INVALID_ARGUMENT: ${MESSAGES.badIdempotencyKey}`);
    expect(bad.idempotencyKey).toBeNull();
    expect(script.calls).toHaveLength(0);
  });

  it("writes query values in the forms the API reads, and refuses what it cannot write", async () => {
    const script = scriptedFetch([{ json: { data: [], hasMore: false, nextCursor: null } }]);
    const t = transportWith({ fetch: script.fetch });
    await t.send(op("list_clips"), { projectId: "prj_1", limit: 20, status: "accepted", cursor: "a b+c/=", extra: true, off: false, zero: 0, skipped: undefined });
    const url = new URL(script.calls[0]?.url ?? "");
    expect(url.pathname).toBe("/v1/projects/prj_1/clips");
    expect([...url.searchParams]).toEqual([
      ["limit", "20"],
      ["status", "accepted"],
      ["cursor", "a b+c/="],
      ["extra", "true"],
      ["off", "false"],
      ["zero", "0"],
    ]);
    // no number the API reads from a URL is negative, so a sign is never written
    for (const value of [1.5, Number.NaN, null, [1, 2], { a: 1 }, 2n ** 64n, -1, Number.MAX_SAFE_INTEGER + 1, Number.POSITIVE_INFINITY]) {
      const err = await rejected(t.send(op("list_clips"), { projectId: "prj_1", limit: value }));
      expect(err.code, String(value)).toBe("INVALID_ARGUMENT");
    }
    expect((await rejected(t.send(op("list_clips"), { projectId: "prj_1", limit: -5 }))).message).toBe(
      "INVALID_ARGUMENT: limit must be a string, true or false, or a whole number 0 or more: listClips sends it in the URL.",
    );
    expect(script.calls).toHaveLength(1);
  });

  it("percent-encodes a query value whole, a space as %20 and a plus as %2B, so no server reads them as each other", async () => {
    const script = scriptedFetch([{ json: { data: [], hasMore: false, nextCursor: null } }]);
    await transportWith({ fetch: script.fetch }).send(op("list_projects"), { cursor: "a b+c&d=e/f?g#h%i caffè 🎬 -_.!~*'()" });
    expect(script.calls[0]?.url).toBe(
      "https://api.gpt-video.com/v1/projects?cursor=a%20b%2Bc%26d%3De%2Ff%3Fg%23h%25i%20caff%C3%A8%20%F0%9F%8E%AC%20-_.!~*'()",
    );
  });

  it("encodes path values and refuses the two that a URL parser would walk with", async () => {
    const script = scriptedFetch([{ json: { project: {} } }]);
    const t = transportWith({ fetch: script.fetch });
    await t.send(op("get_project"), { projectId: "a/b?c#d%2e" });
    expect(script.calls[0]?.url).toBe("https://api.gpt-video.com/v1/projects/a%2Fb%3Fc%23d%252e");
    for (const projectId of [".", "..", "", undefined, null, 3.5, -1, {}]) {
      const err = await rejected(t.send(op("get_project"), { projectId }));
      expect(err.code, String(projectId)).toBe("INVALID_ARGUMENT");
    }
    expect((await rejected(t.send(op("get_project"), {}))).message).toBe("INVALID_ARGUMENT: getProject needs projectId.");
    expect(script.calls).toHaveLength(1);
  });

  it("refuses text with a lone surrogate, which has no UTF-8 form, in the path and in the query, before sending", async () => {
    const script = scriptedFetch([]);
    const t = transportWith({ fetch: script.fetch });
    const inPath = await rejected(t.send(op("get_project"), { projectId: "prj_\uD800" }));
    expect(inPath).toBeInstanceOf(GptVideoError);
    expect(inPath.message).toBe("INVALID_ARGUMENT: projectId is not well-formed text: it has a lone surrogate.");
    const inQuery = await rejected(t.send(op("list_projects"), { cursor: "x\uDC00" }));
    expect(inQuery.message).toBe("INVALID_ARGUMENT: cursor is not well-formed text: it has a lone surrogate.");
    expect(script.calls).toHaveLength(0);
  });

  it("refuses an input that is not an object, and a body JSON cannot write", async () => {
    const t = transportWith({ fetch: scriptedFetch([]).fetch });
    for (const input of ["prj_1", 42, ["prj_1"]]) expect((await rejected(t.send(op("get_project"), input))).code).toBe("INVALID_ARGUMENT");
    const cycle = /** @type {Record<string, unknown>} */ ({ projectId: "prj_1" });
    cycle.self = { cycle };
    const err = await rejected(t.send(op("update_project"), { projectId: "prj_1", settings: cycle }));
    expect(err.code).toBe("INVALID_ARGUMENT");
    expect(err.message).toContain("cannot be written as JSON");
  });

  it("sends the bytes of an operation that sends bytes, with its content type, and checks their size", async () => {
    const script = scriptedFetch([{ json: { upload: {} } }]);
    const t = transportWith({ fetch: script.fetch });
    const bytes = new Uint8Array([1, 2, 3]);
    await t.send(op("upload_part"), { uploadId: "upl_1", partNumber: 2 }, undefined, bytes);
    const call = script.calls[0];
    expect(call?.method).toBe("PUT");
    expect(call?.url).toBe("https://api.gpt-video.com/v1/uploads/upl_1/parts/2");
    expect(call?.headers["content-type"]).toBe("application/octet-stream");
    expect(call?.headers).not.toHaveProperty("idempotency-key");
    expect(call?.body).toBe(bytes);
    expect((await rejected(t.send(op("upload_part"), { uploadId: "upl_1", partNumber: 2 }))).message).toBe(
      "INVALID_ARGUMENT: uploadPart sends bytes: pass a Blob, an ArrayBuffer or a Uint8Array.",
    );
    expect((await rejected(t.send(op("upload_part"), { uploadId: "upl_1", partNumber: 2 }, undefined, "bytes"))).code).toBe("INVALID_ARGUMENT");
    const tooBig = await rejected(t.send(op("upload_part"), { uploadId: "upl_1", partNumber: 2 }, undefined, new Uint8Array(8_388_609)));
    expect(tooBig.message).toBe("INVALID_ARGUMENT: uploadPart sends at most 8388608 bytes.");
    const elsewhere = await rejected(t.send(op("get_project"), { projectId: "prj_1" }, undefined, bytes));
    expect(elsewhere.message).toBe("INVALID_ARGUMENT: getProject sends no bytes.");
    const inOptions = await rejected(t.send(op("upload_part"), { uploadId: "upl_1", partNumber: 2 }, /** @type {any} */ ({ body: bytes }), bytes));
    expect(inOptions.message, "the bytes never travel inside the options").toContain("uploadPart has no option body");
  });

  it("refuses call options it does not have", async () => {
    const t = transportWith({ fetch: scriptedFetch([]).fetch });
    const err = await rejected(t.send(op("get_me"), undefined, /** @type {any} */ ({ retries: 3 })));
    expect(err.message).toBe("INVALID_ARGUMENT: getMe has no option retries. Its options are: idempotencyKey, signal, timeoutMs, deadlineMs, maxRetries.");
    expect((await rejected(t.send(op("get_me"), undefined, /** @type {any} */ ({ signal: {} })))).message).toContain("signal must be an AbortSignal");
  });

  it("never sends a call that needs a key it cannot make, and never makes one from Math.random", async () => {
    const script = scriptedFetch([{ status: 202, json: { job: { id: "job_1" } } }, { json: { key: {} } }]);
    const t = transportWith({ fetch: script.fetch });
    const random = vi.spyOn(Math, "random");
    vi.stubGlobal("crypto", undefined);
    const err = await rejected(t.send(op("analyze_project"), { projectId: "prj_1" }));
    expect(err.message).toBe(`INVALID_ARGUMENT: ${MESSAGES.noCrypto}`);
    expect(script.calls).toHaveLength(0);
    expect(random).not.toHaveBeenCalled();
    // the caller's own key needs no randomness, and a read needs no key
    await t.send(op("analyze_project"), { projectId: "prj_1" }, { idempotencyKey: "order-42" });
    await t.send(op("get_me"), undefined);
    expect(script.calls.map((c) => c.headers["idempotency-key"])).toEqual(["order-42", undefined]);
  });
});

describe("an answer", () => {
  it("is never followed when it is a redirect, whatever form the runtime gives it", async () => {
    const script = scriptedFetch([{ opaqueRedirect: true }]);
    const err = await rejected(transportWith({ fetch: script.fetch }).send(op("get_me"), undefined));
    expect(err).toBeInstanceOf(GptVideoNetworkError);
    expect(err.code).toBe("BAD_RESPONSE");
    expect(err.status).toBeNull();
    expect(err.message).toBe(`BAD_RESPONSE: ${MESSAGES.redirect}`);
    expect(script.calls).toHaveLength(1);
    expect(script.calls[0]?.redirect).toBe("manual");

    for (const status of [301, 302, 303, 307, 308]) {
      const node = scriptedFetch([{ status, headers: { Location: "https://elsewhere.example.com/v1/me" }, text: "" }]);
      const e = await rejected(transportWith({ fetch: node.fetch }).send(op("get_me"), undefined));
      expect(e.code, String(status)).toBe("BAD_RESPONSE");
      expect(e.status).toBe(status);
      expect(e.message).toBe(`BAD_RESPONSE (${status}): ${MESSAGES.redirect}`);
      expect(node.calls, "never followed").toHaveLength(1);
    }
  });

  it("from a fetch passed in that followed a redirect anyway is not the API's answer, and is never read", async () => {
    /** @type {unknown[]} */
    const seen = [];
    const script = scriptedFetch([{ redirectedTo: "https://elsewhere.example.com/v1/projects/prj_1/analyze", status: 202, json: { job: { id: "job_1" } } }]);
    const t = transportWith({ fetch: script.fetch, onResponse: (/** @type {unknown} */ e) => seen.push(e) });
    const err = await rejected(t.send(op("analyze_project"), { projectId: "prj_1" }, { idempotencyKey: "order-42" }));
    expect(err).toBeInstanceOf(GptVideoNetworkError);
    expect(err.code).toBe("BAD_RESPONSE");
    expect(err.status).toBeNull();
    expect(err.retryable).toBe(false);
    // the request went on to another address, which may have run it: the charge is unknown, and the key says how to ask
    expect(err.mayHaveSpent).toBe(true);
    expect(err.idempotencyKey).toBe("order-42");
    // the message says what happened: the caller's fetch followed, not that the SDK refused to
    expect(err.message).toBe(`BAD_RESPONSE: ${MESSAGES.redirectFollowed} ${MESSAGES.mayHaveSpent}`);
    expect(MESSAGES.redirectFollowed).not.toBe(MESSAGES.redirect);
    expect(script.calls, "not sent again").toHaveLength(1);
    expect(seen, "an answer from another address is not told as the API's").toEqual([]);

    const read = scriptedFetch([{ redirectedTo: "https://elsewhere.example.com/v1/me", json: {} }]);
    const readErr = await rejected(transportWith({ fetch: read.fetch }).send(op("get_me"), undefined));
    expect([readErr.code, readErr.mayHaveSpent, read.calls.length]).toEqual(["BAD_RESPONSE", false, 1]);
  });

  it("is the API's error only with an error code in the API's form", async () => {
    const script = scriptedFetch([{ status: 400, json: { error: { code: "bad request", message: "x" } } }]);
    const err = await rejected(transportWith({ fetch: script.fetch }).send(op("get_me"), undefined));
    expect(err.code).toBe("BAD_RESPONSE");
    expect(err.message).toBe(`BAD_RESPONSE (400): ${MESSAGES.notApiError}`);
  });

  it("takes the request id from X-Request-Id when the body has none", async () => {
    const script = scriptedFetch([{ status: 404, headers: { "X-Request-Id": "req_head" }, json: { error: { code: "NOT_FOUND", message: "Project prj_1 not found." } } }]);
    const err = await rejected(transportWith({ fetch: script.fetch }).send(op("get_project"), { projectId: "prj_1" }));
    expect(err).toBeInstanceOf(GptVideoApiError);
    expect(err.requestId).toBe("req_head");
    expect(err.message).toBe("NOT_FOUND (404): Project prj_1 not found. [request req_head]");
  });

  it("is told to onResponse with its status, request id, replay and rate limit, and no header", async () => {
    /** @type {any[]} */
    const events = [];
    const script = scriptedFetch([
      {
        status: 202,
        headers: { "X-Request-Id": "req_9", "Idempotent-Replayed": "true", "RateLimit-Limit": "10", "RateLimit-Remaining": "9", "RateLimit-Reset": "42" },
        json: { job: { id: "job_1", status: "queued", finishedAt: null } },
      },
    ]);
    await transportWith({ fetch: script.fetch, onResponse: (/** @type {any} */ e) => events.push(e) }).send(op("analyze_project"), { projectId: "prj_1" });
    expect(events).toEqual([{ operation: "analyze_project", status: 202, requestId: "req_9", attempt: 1, replayed: true, rateLimit: { limit: 10, remaining: 9, resetSec: 42 } }]);
  });

  it("says the system code of a failed connection, when it has a clean one", async () => {
    const failing = (/** @type {unknown} */ error) => () => Promise.reject(error);
    for (const [error, text] of /** @type {[unknown, string][]} */ ([
      [Object.assign(new TypeError("fetch failed"), { cause: { code: "ENOTFOUND" } }), "The connection to the API failed (ENOTFOUND)."],
      [Object.assign(new Error("x"), { code: "ECONNRESET" }), "The connection to the API failed (ECONNRESET)."],
      [Object.assign(new TypeError("fetch failed"), { cause: { code: "bad code; Authorization: Bearer x" } }), MESSAGES.connectionFailed],
      ["a string", MESSAGES.connectionFailed],
    ])) {
      const err = await rejected(transportWith({ fetch: failing(error), maxRetries: 0 }).send(op("get_me"), undefined));
      expect(err.code).toBe("CONNECTION_FAILED");
      expect(err.message).toBe(`CONNECTION_FAILED: ${text}`);
    }
  });

  it("from a fetch that ignores its signal never holds a call past its timeout", async () => {
    useClock(Date.parse("2026-10-11T12:00:00.000Z"));
    const script = scriptedFetch([{ network: "deaf" }, { network: "deaf" }, { network: "deaf" }]);
    const start = Date.now();
    const got = await drive(transportWith({ fetch: script.fetch, timeoutMs: 10_000 }).send(op("get_me"), undefined));
    const err = /** @type {any} */ (got.error);
    expect(err.code).toBe("TIMEOUT");
    expect(err.message).toBe("TIMEOUT: No answer within 10 seconds.");
    expect(script.calls).toHaveLength(3);
    expect(got.at - start).toBeGreaterThanOrEqual(30_000);
    expect(got.at - start).toBeLessThan(30_000 + 500 + 1000);
  });

  it("that arrives after a caller's abort is not read, and its body is cancelled", async () => {
    useClock(Date.parse("2026-10-11T12:00:00.000Z"));
    let cancelled = false;
    const late = new Response(new ReadableStream({ cancel: () => void (cancelled = true) }), { status: 200 });
    /** @type {(r: Response) => void} */
    let answer = () => {};
    const fetch = () => new Promise((resolve) => (answer = /** @type {any} */ (resolve)));
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 1000);
    const got = await drive(transportWith({ fetch }).send(op("get_me"), undefined, { signal: controller.signal }));
    expect(/** @type {any} */ (got.error).code).toBe("ABORTED");
    answer(late);
    await new Promise((resolve) => setImmediate(resolve));
    expect(cancelled).toBe(true);
  });
});

describe("the key", () => {
  const leakyBody = {
    error: {
      code: "UNAUTHORIZED",
      message: `The key ${API_KEY} is not valid; neither is ${OTHER_KEY}.`,
      hint: `Send Authorization: Bearer ${API_KEY}`,
      requestId: `req_${API_KEY}`,
      // a key nested past the depth the SDK copies is cut, never walked
      details: { echoed: { [API_KEY]: [`x ${API_KEY} y`, 1, null] }, deep: Array.from({ length: 20 }).reduce((inner) => ({ inner }), API_KEY) },
    },
  };

  it("never comes back in an error, even when the server sends it back", async () => {
    const script = scriptedFetch([{ status: 401, json: leakyBody }]);
    const err = await rejected(transportWith({ fetch: script.fetch }).send(op("get_me"), undefined));
    expect(err).toBeInstanceOf(GptVideoApiError);
    for (const text of [err.message, String(err.stack), JSON.stringify(err), inspect(err, { depth: null }), String(err), JSON.stringify(err.details)]) {
      expect(text).not.toContain(API_KEY);
      expect(text).not.toContain(OTHER_KEY);
      expect(text).not.toMatch(/gvk_[A-Za-z0-9_-]{16,}/);
    }
    expect(err.message).toContain("[redacted]");
    expect(err.hint).toBe("Send Authorization: Bearer [redacted]");
  });

  it("never comes back in onResponse or onRetry", async () => {
    /** @type {unknown[]} */
    const seen = [];
    const script = scriptedFetch([{ status: 500, headers: { "X-Request-Id": `req_${API_KEY}` }, json: { error: { ...leakyBody.error, code: "INTERNAL" } } }, { json: {} }]);
    await transportWith({ fetch: script.fetch, onResponse: (/** @type {unknown} */ e) => seen.push(e), onRetry: (/** @type {unknown} */ e) => seen.push(e) }).send(op("get_me"), undefined);
    expect(JSON.stringify(seen)).not.toContain(API_KEY);
    expect(seen).toHaveLength(3);
  });

  it("is printed as [redacted] by a transport", () => {
    const t = transportWith({ fetch: scriptedFetch([]).fetch });
    expect(inspect(t)).toBe("Transport { baseUrl: 'https://api.gpt-video.com/v1', apiKey: '[redacted]' }");
    expect(JSON.stringify(t)).toBe("{}");
    expect(inspect(t, { showHidden: true, depth: null })).not.toContain(API_KEY);
  });
});

describe("a hook of the caller", () => {
  it("that throws never changes the outcome of a call", async () => {
    const script = scriptedFetch([{ status: 500, json: { error: { code: "INTERNAL", message: "x", requestId: "req_1" } } }, { status: 202, json: { job: { id: "job_1" } } }]);
    const boom = () => {
      throw new Error("a logging bug");
    };
    const body = await transportWith({ fetch: script.fetch, onResponse: boom, onRetry: boom }).send(op("analyze_project"), { projectId: "prj_1" });
    expect(body).toEqual({ job: { id: "job_1" } });
    expect(script.calls).toHaveLength(2);
  });

  it("that rejects leaves no unhandled rejection", async () => {
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      const script = scriptedFetch([{ json: {} }]);
      await transportWith({ fetch: script.fetch, onResponse: async () => Promise.reject(new Error("async bug")) }).send(op("get_me"), undefined);
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });
});

describe("the operation index", () => {
  it("finds rows by id and name, and the read that follows each kind of work", () => {
    const index = FIXTURE_INDEX;
    expect(index.byId("analyze_project")?.name).toBe("analyzeProject");
    expect(index.byName("analyzeProject")?.id).toBe("analyze_project");
    expect(index.byId("analyzeProject"), "an id is not a name").toBeUndefined();
    expect(index.handles).toEqual(["job", "export", "toolRun", "turn"]);
    expect(index.readFor("export")?.id).toBe("get_export");
    expect(index.listNames).toEqual(["listProjects", "listClips"]);
    expect(index.operation("create_upload").method).toBe("POST");
    expect(() => index.operation("nope")).toThrow("The operation table has no nope.");
  });

  it("refuses a table the engine could not trust", () => {
    const rows = [...FIXTURE_OPERATIONS];
    const job = /** @type {OperationSpec} */ (rows.find((r) => r.id === "analyze_project"));
    expect(() => new OperationIndex([...rows, job])).toThrow("two rows");
    expect(() => new OperationIndex([...rows, { ...job, id: "analyze_again" }]), "two rows with one method name").toThrow("two rows");
    expect(() => new OperationIndex([...rows, { ...job, id: "analyze_again", name: "analyzeAgain", async: { handle: "job", waitWith: "get_export" } }])).toThrow("two reads");
    expect(() => new OperationIndex([...rows, { ...job, id: "analyze_again", name: "analyzeAgain", async: { handle: "job", waitWith: "analyze_project" } }])).toThrow("not a GET of one id");
    expect(() => new OperationIndex([...rows, { ...job, id: "analyze_again", name: "analyzeAgain", async: { handle: "job", waitWith: "list_projects" } }])).toThrow("not a GET of one id");
  });
});
