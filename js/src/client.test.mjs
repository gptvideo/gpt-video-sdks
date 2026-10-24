// @ts-check
// The client as a program uses it: the generated table it runs on (tied to the stand-in the engine tests use),
// one generated method for every row, sent the way its row says, the helpers wired to the same transport, and
// the key out of everything that prints a client.
import { inspect } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GptVideo, OPERATION_INDEX, RETRYABLE_CODES } from "./client.mjs";
import { GptVideoError, MESSAGES } from "./errors.mjs";
import { API_ERRORS } from "./errors.generated.mjs";
import { API_CONTRACT, CONVENTIONS, OPERATIONS } from "./operations.generated.mjs";
import { DEFAULT_BASE_URL, VERSION } from "./transport.mjs";
import { FIXTURE_OPERATIONS, FIXTURE_RETRYABLE } from "./testing/operations.fixture.js";
import { scriptedFetch } from "./testing/fake-fetch.js";

/** @typedef {import("./table.mjs").OperationSpec} OperationSpec */

// built at run time, so that no file of the package holds a string shaped like a real key
const API_KEY = `gvk_${"C".repeat(43)}`;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** @param {() => unknown} fn @returns {any} */
function thrown(fn) {
  try {
    fn();
  } catch (e) {
    return e;
  }
  throw new Error("nothing was thrown");
}

/** @param {OperationSpec} row */
function inputFor(row) {
  /** @type {Record<string, unknown>} */
  const input = {};
  for (const name of row.pathParams) input[name] = name === "partNumber" ? 2 : `${name}_1`;
  return input;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("the generated table", () => {
  it("has every row of the stand-in the engine tests run on, field for field", () => {
    for (const row of FIXTURE_OPERATIONS) {
      expect(
        OPERATIONS.find((r) => r.id === row.id),
        row.id,
      ).toEqual(row);
    }
  });

  it("has the retryable codes of the stand-in, and they are the API's", () => {
    expect([...RETRYABLE_CODES].sort()).toEqual([...FIXTURE_RETRYABLE].sort());
    expect(Object.entries(API_ERRORS).filter(([, e]) => e.retryable).map(([code]) => code).sort()).toEqual([...FIXTURE_RETRYABLE].sort());
  });

  it("has what the engine composes calls from, and a read with ?wait= for each kind of work", () => {
    expect(OPERATION_INDEX.handles).toEqual(["job", "export", "toolRun", "turn"]);
    for (const handle of OPERATION_INDEX.handles) {
      const read = OPERATION_INDEX.readFor(handle);
      expect(read?.method, handle).toBe("GET");
      expect(read?.pathParams, handle).toHaveLength(1);
      expect(read?.idempotencyKey, handle).toBe("none");
    }
    for (const id of ["create_upload", "upload_part", "get_upload", "complete_upload", "cancel_upload"]) expect(OPERATION_INDEX.operation(id).id).toBe(id);
    expect(OPERATION_INDEX.operation("upload_part").binary?.contentType).toBe("application/octet-stream");
    expect(OPERATION_INDEX.operation("complete_upload").idempotencyKey, "a complete is asked again with the same key").not.toBe("none");
    expect(OPERATION_INDEX.listNames.length).toBeGreaterThan(0);
  });

  it("keeps the rules the engine relies on: a spend always sends a key and is retry-safe; a GET never sends one", () => {
    for (const row of OPERATIONS) {
      if (row.effect === "spend") {
        expect(row.idempotencyKey, row.id).toBe("required");
        expect(row.method, row.id).toBe("POST");
      }
      if (row.method !== "POST") expect(row.idempotencyKey, row.id).toBe("none");
      if (row.idempotencyKey !== "none") expect(row.retrySafe, row.id).toBe(true);
      expect(row.path.startsWith("/v1/"), row.id).toBe(true);
      for (const name of row.pathParams) expect(row.path, row.id).toContain(`{${name}}`);
    }
  });

  it("says which contract it was made from, and which conventions", () => {
    expect(API_CONTRACT.apiVersion).toBe("1");
    expect(API_CONTRACT.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(CONVENTIONS.baseUrl).toBe(DEFAULT_BASE_URL);
    expect(Object.isFrozen(OPERATIONS) && OPERATIONS.every((row) => Object.isFrozen(row) && Object.isFrozen(row.pathParams))).toBe(true);
  });
});

describe("a generated method", () => {
  it("exists for every row, and sends the method, the path and the key its row says", async () => {
    for (const row of OPERATIONS) {
      const script = scriptedFetch([{ status: row.successStatus, json: { ok: row.id } }]);
      const gv = new GptVideo({ apiKey: API_KEY, fetch: script.fetch });
      const method = /** @type {Record<string, Function | undefined>} */ (/** @type {unknown} */ (gv))[row.name];
      if (typeof method !== "function") throw new Error(`the client has no method ${row.name}`);
      const input = inputFor(row);
      const body = row.binary ? await method.call(gv, input, new Uint8Array([1, 2, 3])) : await method.call(gv, input);
      expect(body, row.id).toEqual({ ok: row.id });

      const call = script.calls[0];
      expect(call?.method, row.id).toBe(row.method);
      let path = row.path;
      for (const name of row.pathParams) path = path.replace(`{${name}}`, String(input[name]));
      expect(new URL(call?.url ?? "").pathname, row.id).toBe(path);
      if (row.idempotencyKey === "none") expect(call?.headers, row.id).not.toHaveProperty("idempotency-key");
      else expect(call?.headers["idempotency-key"], row.id).toMatch(UUID);
      expect(call?.headers.authorization, row.id).toBe(`Bearer ${API_KEY}`);
      expect(call?.redirect, row.id).toBe("manual");
    }
  });

  it("passes the caller's key and options through, and refuses an option the call does not have", async () => {
    const script = scriptedFetch([{ status: 202, json: { job: { id: "job_1" } } }]);
    const gv = new GptVideo({ apiKey: API_KEY, fetch: script.fetch });
    await gv.analyzeProject({ projectId: "prj_1" }, { idempotencyKey: "order-42", timeoutMs: 5000 });
    expect(script.calls[0]?.headers["idempotency-key"]).toBe("order-42");
    const err = await gv.getMe(undefined, /** @type {any} */ ({ idempotencyKey: "order-42" })).catch((e) => e);
    expect(err.message).toBe("INVALID_ARGUMENT: getMe takes no idempotencyKey: the API does not read one for it.");
    expect(script.calls).toHaveLength(1);
  });
});

describe("the client", () => {
  it("refuses to start in a web page without dangerouslyAllowBrowser, and sends nothing", () => {
    vi.stubGlobal("window", {});
    vi.stubGlobal("document", {});
    const script = scriptedFetch([]);
    const err = thrown(() => new GptVideo({ apiKey: API_KEY, fetch: script.fetch }));
    expect(err).toBeInstanceOf(GptVideoError);
    expect(err.message).toBe(`INVALID_ARGUMENT: ${MESSAGES.browser}`);
    expect(script.calls).toHaveLength(0);
    expect(new GptVideo({ apiKey: API_KEY, fetch: script.fetch, dangerouslyAllowBrowser: true })).toBeInstanceOf(GptVideo);
  });

  it("reads GPT_VIDEO_API_KEY, and says where keys come from without one", async () => {
    vi.stubEnv("GPT_VIDEO_API_KEY", API_KEY);
    const script = scriptedFetch([{ json: { key: {}, account: {} } }]);
    await new GptVideo({ fetch: script.fetch }).getMe();
    expect(script.calls[0]?.headers.authorization).toBe(`Bearer ${API_KEY}`);
    vi.stubEnv("GPT_VIDEO_API_KEY", "");
    expect(thrown(() => new GptVideo()).message).toBe(`INVALID_ARGUMENT: ${MESSAGES.missingApiKey}`);
  });

  it("sends with the global fetch of the moment of the call when none is passed", async () => {
    const script = scriptedFetch([{ json: { key: {}, account: {} } }]);
    const gv = new GptVideo({ apiKey: API_KEY });
    vi.stubGlobal("fetch", script.fetch);
    await gv.getMe();
    expect(script.calls).toHaveLength(1);
    expect(script.calls[0]?.headers["user-agent"]).toBe(`gpt-video-js/${VERSION}`);
  });

  it("is printed without its key, by util.inspect, JSON and String", () => {
    const gv = new GptVideo({ apiKey: API_KEY, baseUrl: "https://www.gpt-video.com/api" });
    expect(inspect(gv)).toBe("GptVideo { baseUrl: 'https://www.gpt-video.com/api/v1', apiKey: '[redacted]' }");
    expect(inspect(gv, { showHidden: true, depth: null, getters: true })).not.toContain(API_KEY);
    expect(inspect({ client: gv }, { depth: 4 })).not.toContain(API_KEY);
    expect(JSON.stringify(gv)).toBe("{}");
    expect(String(gv)).not.toContain(API_KEY);
    expect(Object.keys(gv)).toEqual([]);
    expect(Object.getOwnPropertyNames(gv)).toEqual([]);
  });

  it("runs wait, paginate, uploadFile and download on its own transport", async () => {
    const script = scriptedFetch((request) => {
      const url = new URL(request.url);
      if (url.pathname === "/v1/jobs/job_1") return { json: { job: { id: "job_1", status: "done", finishedAt: "2026-10-11T12:00:00.000Z" } } };
      if (url.pathname === "/v1/projects") return { json: { data: [{ id: "prj_1" }], hasMore: false, nextCursor: null } };
      if (url.pathname === "/v1/uploads" && request.method === "POST") return { status: 201, json: { upload: { id: "upl_1", partSizeBytes: 4, partCount: 1, receivedParts: [] } } };
      if (url.pathname === "/v1/uploads/upl_1/parts/1") return { json: { upload: { id: "upl_1", receivedParts: [1] } } };
      if (url.pathname === "/v1/uploads/upl_1/complete") return { status: 201, json: { asset: { id: "ast_1" } } };
      if (url.hostname === "files.example.com") return { text: "MP4" };
      throw new Error(`unexpected ${request.method} ${request.url}`);
    });
    const gv = new GptVideo({ apiKey: API_KEY, fetch: script.fetch });
    expect(await gv.wait({ job: /** @type {any} */ ({ id: "job_1", status: "queued" }) })).toMatchObject({ status: "done" });
    expect(await gv.waitForJob("job_1")).toMatchObject({ status: "done" });
    /** @type {unknown[]} */
    const projects = [];
    for await (const project of gv.paginate("listProjects")) projects.push(project);
    expect(projects).toEqual([{ id: "prj_1" }]);
    expect(await gv.uploadFile(new Uint8Array([1, 2, 3]), { filename: "a.mp4" })).toEqual({ asset: { id: "ast_1" } });
    const res = await gv.download("https://files.example.com/a.mp4?token=x");
    expect(await res.text()).toBe("MP4");
    const download = script.calls.find((c) => c.url.startsWith("https://files.example.com/"));
    expect(download?.headers).not.toHaveProperty("authorization");
    for (const call of script.calls.filter((c) => c !== download)) expect(call.headers.authorization).toBe(`Bearer ${API_KEY}`);
  });

  it("gives each client its own four slots for reads with ?wait=", async () => {
    let open = 0;
    let most = 0;
    /** @type {Array<() => void>} */
    const answers = [];
    const fetch = (/** @type {string} */ url) =>
      new Promise((resolve) => {
        open++;
        most = Math.max(most, open);
        const id = new URL(url).pathname.split("/").pop();
        answers.push(() => {
          open--;
          resolve(new Response(JSON.stringify({ job: { id, status: "done", finishedAt: "x" } }), { status: 200 }));
        });
      });
    const a = new GptVideo({ apiKey: API_KEY, fetch: /** @type {any} */ (fetch) });
    const b = new GptVideo({ apiKey: API_KEY, fetch: /** @type {any} */ (fetch) });
    const waits = [...[1, 2, 3, 4, 5].map((n) => a.waitForJob(`job_a${n}`)), ...[1, 2, 3, 4, 5].map((n) => b.waitForJob(`job_b${n}`))];
    for (let i = 0; i < 50 && answers.length < 8; i++) await new Promise((resolve) => setImmediate(resolve));
    expect(most, "four per client, two clients").toBe(8);
    while (answers.length > 0) {
      answers.shift()?.();
      await new Promise((resolve) => setImmediate(resolve));
      for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
    }
    expect((await Promise.all(waits)).every((job) => job.status === "done")).toBe(true);
  });
});
