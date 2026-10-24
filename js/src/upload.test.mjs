// @ts-check
// Uploading in parts against a fake upload server on a fake clock: the bytes of each part, the part size the
// API gives, parts in parallel, a slow part, a part that fails, a complete that finds parts missing, a stream,
// uploads turned off, and the clean-up of an upload that failed.
import { afterEach, describe, expect, it, vi } from "vitest";
import { GptVideoApiError, GptVideoNetworkError, MESSAGES } from "./errors.mjs";
import { Transport, resolveSettings } from "./transport.mjs";
import { CANCEL_DEADLINE_MS, PART_TIMEOUT_MAX_MS, PART_TIMEOUT_MIN_MS, partDeadlineMs, partTimeoutMs, uploadFile } from "./upload.mjs";
import { drive, useClock } from "./testing/clock.js";
import { scriptedFetch } from "./testing/fake-fetch.js";
import { FIXTURE_INDEX, FIXTURE_RETRYABLE_CODES } from "./testing/operations.fixture.js";

/** @typedef {import("./testing/fake-fetch.js").Recorded} Recorded */
/** @typedef {import("./testing/fake-fetch.js").Scripted} Scripted */

const API_KEY = `gvk_${"U".repeat(43)}`;
const NOW = Date.parse("2026-10-11T12:00:00.000Z");
const ID = "upl_0123456789abcdef0123";

/** @param {number} size */
const bytesOf = (size) => Uint8Array.from({ length: size }, (_, i) => (i * 7 + 3) % 251);

/** @param {unknown} body @returns {Promise<Uint8Array>} */
async function received(body) {
  if (body instanceof Blob) return new Uint8Array(await body.arrayBuffer());
  if (body instanceof Uint8Array) return Uint8Array.from(body);
  throw new Error(`a part came as ${Object.prototype.toString.call(body)}`);
}

/**
 * A fake of the upload operations: it opens one upload, keeps the parts it receives, and completes when all
 * are there. `on` lets a test change the answer of a request before the server gives its own.
 *
 * @param {{ size: number, partSize: number, partCount?: number, on?: (r: Recorded, i: number) => Scripted | Promise<Scripted | undefined> | undefined, partMs?: (n: number, attempt: number) => number }} options
 */
function uploadServer({ size, partSize, partCount = Math.ceil(size / partSize), on, partMs = () => 0 }) {
  /** @type {Map<number, Uint8Array>} */
  const parts = new Map();
  /** @type {Map<number, number>} */
  const attempts = new Map();
  /** @type {{ n: number, start: number, end: number | null }[]} */
  const timeline = [];
  let completed = false;
  const upload = () => ({
    upload: {
      id: ID,
      filename: "f.mp4",
      contentType: "video/mp4",
      sizeBytes: size,
      partSizeBytes: partSize,
      partCount,
      receivedParts: [...parts.keys()].sort((a, b) => a - b),
      createdAt: "2026-10-11T12:00:00.000Z",
      expiresAt: "2026-10-11T18:00:00.000Z",
    },
  });
  const fake = scriptedFetch(async (request, index) => {
    const custom = await on?.(request, index);
    if (custom) return custom;
    const url = new URL(request.url);
    const path = url.pathname;
    if (request.method === "POST" && path === "/v1/uploads") return { status: 201, json: upload() };
    const part = /^\/v1\/uploads\/[^/]+\/parts\/(\d+)$/.exec(path);
    if (request.method === "PUT" && part) {
      const n = Number(part[1]);
      const attempt = (attempts.get(n) ?? 0) + 1;
      attempts.set(n, attempt);
      const ms = partMs(n, attempt);
      if (ms === Number.POSITIVE_INFINITY) return { network: "hang" };
      const entry = { n, start: Date.now(), end: /** @type {number | null} */ (null) };
      timeline.push(entry);
      await new Promise((resolve) => setTimeout(resolve, ms));
      entry.end = Date.now();
      parts.set(n, await received(request.body));
      return { json: upload() };
    }
    if (request.method === "GET" && path === `/v1/uploads/${ID}`) return { json: upload() };
    if (request.method === "POST" && path === `/v1/uploads/${ID}/complete`) {
      const missing = Array.from({ length: partCount }, (_, i) => i + 1).filter((n) => !parts.has(n));
      if (missing.length) return { status: 409, json: { error: { code: "CONFLICT", message: `Parts ${missing.join(", ")} are missing.`, requestId: "req_m" } } };
      completed = true;
      return { status: 201, json: { asset: { id: "ast_0123456789abcdef0123", sizeBytes: size } } };
    }
    if (request.method === "DELETE" && path === `/v1/uploads/${ID}`) return { json: { uploadId: ID, cancelled: true } };
    throw new Error(`the fake upload server has no ${request.method} ${path}`);
  });
  /** the file the server holds, parts joined in order */
  const file = () => {
    const out = new Uint8Array(size);
    for (const [n, bytes] of parts) out.set(bytes, (n - 1) * partSize);
    return out;
  };
  const transport = new Transport(resolveSettings({ apiKey: API_KEY, fetch: fake.fetch }), FIXTURE_RETRYABLE_CODES);
  return { fake, parts, attempts, timeline, file, completed: () => completed, ctx: { transport, index: FIXTURE_INDEX } };
}

/** @param {Recorded[]} calls @param {string} method @param {RegExp} path */
const callsTo = (calls, method, path) => calls.filter((c) => c.method === method && path.test(new URL(c.url).pathname));

/** Lets a cancel sent in the background go out. */
async function settleBackground() {
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("uploadFile", () => {
  it("opens the upload, sends every part with its bytes, completes once and returns the asset", async () => {
    useClock(NOW);
    const s = uploadServer({ size: 10, partSize: 4 });
    /** @type {unknown[]} */
    const progress = [];
    const got = await drive(uploadFile(s.ctx, bytesOf(10), { filename: "talk.mp4", contentType: "video/mp4", title: "Talk", onProgress: (p) => progress.push(p) }));
    expect(got.error).toBeUndefined();
    expect(got.value).toEqual({ asset: { id: "ast_0123456789abcdef0123", sizeBytes: 10 } });
    expect(s.file()).toEqual(bytesOf(10));

    const [create] = callsTo(s.fake.calls, "POST", /^\/v1\/uploads$/);
    expect(JSON.parse(String(create?.body))).toEqual({ filename: "talk.mp4", sizeBytes: 10, contentType: "video/mp4" });
    const puts = callsTo(s.fake.calls, "PUT", /\/parts\//);
    expect(puts.map((c) => new URL(c.url).pathname).sort()).toEqual([1, 2, 3].map((n) => `/v1/uploads/${ID}/parts/${n}`));
    for (const put of puts) expect(put.headers["content-type"]).toBe("application/octet-stream");
    const [complete] = callsTo(s.fake.calls, "POST", /\/complete$/);
    expect(JSON.parse(String(complete?.body))).toEqual({ title: "Talk" });
    expect(complete?.headers["idempotency-key"]).toMatch(/^[0-9a-f-]{36}$/);
    expect(complete?.headers["idempotency-key"]).not.toBe(create?.headers["idempotency-key"]);
    expect(callsTo(s.fake.calls, "DELETE", /./)).toHaveLength(0);

    const sent = progress.map((p) => /** @type {any} */ (p).uploadedBytes);
    expect(sent.at(-1)).toBe(10);
    expect([...sent].sort((a, b) => a - b)).toEqual(sent);
    for (const p of progress) expect(/** @type {any} */ (p).totalBytes).toBe(10);
  });

  it("takes the name and the type of a File, and sends slices of it instead of reading it whole", async () => {
    useClock(NOW);
    const s = uploadServer({ size: 10, partSize: 4 });
    const file = new File([bytesOf(10)], "clip.mp4", { type: "video/mp4" });
    expect((await drive(uploadFile(s.ctx, file))).error).toBeUndefined();
    const [create] = callsTo(s.fake.calls, "POST", /^\/v1\/uploads$/);
    expect(JSON.parse(String(create?.body))).toEqual({ filename: "clip.mp4", sizeBytes: 10, contentType: "video/mp4" });
    const puts = callsTo(s.fake.calls, "PUT", /\/parts\//);
    for (const put of puts) expect(put.body).toBeInstanceOf(Blob);
    expect(puts.map((p) => /** @type {Blob} */ (p.body).size).sort()).toEqual([2, 4, 4]);
    expect(s.file()).toEqual(bytesOf(10));
  });

  it("uses the part size the API answers, never one of its own", async () => {
    useClock(NOW);
    const s = uploadServer({ size: 10, partSize: 3 });
    expect((await drive(uploadFile(s.ctx, bytesOf(10), { filename: "a.mp4" }))).error).toBeUndefined();
    expect(callsTo(s.fake.calls, "PUT", /\/parts\//)).toHaveLength(4);
    expect(s.file()).toEqual(bytesOf(10));
  });

  it("reads a stream in order, one part at a time, whatever its chunks", async () => {
    useClock(NOW);
    const s = uploadServer({ size: 10, partSize: 4 });
    const data = bytesOf(10);
    const stream = new ReadableStream({
      start(controller) {
        for (const [a, b] of [
          [0, 3],
          [3, 8],
          [8, 10],
        ]) {
          controller.enqueue(data.slice(a, b));
        }
        controller.close();
      },
    });
    expect((await drive(uploadFile(s.ctx, stream, { filename: "s.mp4", sizeBytes: 10 }))).error).toBeUndefined();
    expect(s.file()).toEqual(data);
  });

  it("refuses a stream shorter or longer than sizeBytes, and cancels the upload it opened", async () => {
    useClock(NOW);
    for (const [length, text] of /** @type {[number, string][]} */ ([
      [8, "INVALID_ARGUMENT: The stream ended after 8 bytes, and sizeBytes is 10."],
      [12, "INVALID_ARGUMENT: The stream has more bytes than sizeBytes, 10."],
    ])) {
      const s = uploadServer({ size: 10, partSize: 4 });
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(bytesOf(length));
          controller.close();
        },
      });
      const got = await drive(uploadFile(s.ctx, stream, { filename: "s.mp4", sizeBytes: 10 }));
      expect(/** @type {any} */ (got.error).message).toBe(text);
      await settleBackground();
      expect(callsTo(s.fake.calls, "DELETE", new RegExp(`/v1/uploads/${ID}$`))).toHaveLength(1);
      expect(callsTo(s.fake.calls, "POST", /\/complete$/)).toHaveLength(0);
    }
  });

  it("holds at most `concurrency` parts in flight", async () => {
    useClock(NOW);
    for (const concurrency of [4, 2, 1]) {
      let open = 0;
      let most = 0;
      const s = uploadServer({
        size: 40,
        partSize: 4,
        on: (r) => {
          if (r.method === "PUT") {
            open++;
            most = Math.max(most, open);
            setTimeout(() => open--, 1000);
          }
          return undefined;
        },
        partMs: () => 1000,
      });
      expect((await drive(uploadFile(s.ctx, bytesOf(40), { filename: "a.mp4", concurrency }))).error).toBeUndefined();
      expect(most, `concurrency ${concurrency}`).toBe(concurrency);
    }
  });

  it("retries a slow part on its own, never restarts the others, and sends one part at a time after a timeout", async () => {
    useClock(NOW);
    const s = uploadServer({ size: 48, partSize: 4, partMs: (n, attempt) => (n === 1 && attempt === 1 ? Number.POSITIVE_INFINITY : 25_000) });
    expect((await drive(uploadFile(s.ctx, bytesOf(48), { filename: "a.mp4" }))).error).toBeUndefined();
    expect(s.file()).toEqual(bytesOf(48));
    expect(s.attempts.get(1)).toBe(2);
    for (let n = 2; n <= 12; n++) expect(s.attempts.get(n), `part ${n}`).toBe(1);
    // part 1 timed out at 60 s, with the timeout of a small part; from then on no part starts while another is in flight
    const timedOutAt = NOW + PART_TIMEOUT_MIN_MS;
    const later = s.timeline.filter((t) => t.n !== 1 && t.start >= timedOutAt);
    expect(later.length).toBeGreaterThan(0);
    for (const t of later) {
      const others = s.timeline.filter((o) => o !== t && o.start < t.start && (o.end === null || o.end > t.start));
      expect(others, `part ${t.n} started at ${t.start - NOW} with others in flight`).toEqual([]);
    }
  });

  it("stops the other parts when one fails, gives that failure, and cancels the upload", async () => {
    useClock(NOW);
    const s = uploadServer({
      size: 40,
      partSize: 4,
      partMs: () => 5000,
      on: (r) =>
        r.method === "PUT" && r.url.endsWith("/parts/3")
          ? { status: 400, json: { error: { code: "VALIDATION_FAILED", message: "Part 3 must be 4 bytes.", requestId: "req_p" } } }
          : undefined,
    });
    const got = await drive(uploadFile(s.ctx, bytesOf(40), { filename: "a.mp4" }));
    const err = /** @type {any} */ (got.error);
    expect(err).toBeInstanceOf(GptVideoApiError);
    expect(err.code).toBe("VALIDATION_FAILED");
    expect(err.operation).toBe("upload_part");
    expect(callsTo(s.fake.calls, "PUT", /\/parts\//).length).toBeLessThan(10);
    await settleBackground();
    expect(callsTo(s.fake.calls, "POST", /\/complete$/)).toHaveLength(0);
    const cancels = callsTo(s.fake.calls, "DELETE", new RegExp(`/v1/uploads/${ID}$`));
    expect(cancels).toHaveLength(1);
  });

  it("sends again the parts a complete finds missing, and asks again with the same Idempotency-Key", async () => {
    useClock(NOW);
    /** @type {Uint8Array | null} */
    let dropped = null;
    const s = uploadServer({
      size: 10,
      partSize: 4,
      on: async (r) => {
        // the first part 2 is answered and lost, as a part stopped by a complete would be
        if (r.method === "PUT" && r.url.endsWith("/parts/2") && dropped === null) {
          dropped = await received(r.body);
          return { json: { upload: { id: ID } } };
        }
        return undefined;
      },
    });
    const got = await drive(uploadFile(s.ctx, bytesOf(10), { filename: "a.mp4" }));
    expect(got.error).toBeUndefined();
    expect(got.value).toEqual({ asset: { id: "ast_0123456789abcdef0123", sizeBytes: 10 } });
    const completes = callsTo(s.fake.calls, "POST", /\/complete$/);
    expect(completes).toHaveLength(2);
    expect(completes[1]?.headers["idempotency-key"]).toBe(completes[0]?.headers["idempotency-key"]);
    expect(callsTo(s.fake.calls, "GET", new RegExp(`/v1/uploads/${ID}$`))).toHaveLength(1);
    expect(callsTo(s.fake.calls, "PUT", /\/parts\/2$/)).toHaveLength(2);
    expect(s.file()).toEqual(bytesOf(10));
  });

  it("gives the refusal of a complete when nothing is missing, and cancels the upload", async () => {
    useClock(NOW);
    const s = uploadServer({
      size: 10,
      partSize: 4,
      on: (r) =>
        r.method === "POST" && r.url.endsWith("/complete") ? { status: 409, json: { error: { code: "CONFLICT", message: "This upload is being completed.", requestId: "req_c" } } } : undefined,
    });
    const err = /** @type {any} */ ((await drive(uploadFile(s.ctx, bytesOf(10), { filename: "a.mp4" }))).error);
    expect(err.code).toBe("CONFLICT");
    expect(err.message).toContain("This upload is being completed.");
    expect(callsTo(s.fake.calls, "POST", /\/complete$/)).toHaveLength(1);
    await settleBackground();
    expect(callsTo(s.fake.calls, "DELETE", /./)).toHaveLength(1);
  });

  it("cannot send the parts of a stream again: the refusal of a complete comes back as it is", async () => {
    useClock(NOW);
    let first = true;
    const s = uploadServer({
      size: 4,
      partSize: 4,
      on: (r) => {
        if (r.method === "PUT" && first) {
          first = false;
          return { json: { upload: { id: ID } } };
        }
        return undefined;
      },
    });
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(bytesOf(4));
        controller.close();
      },
    });
    const err = /** @type {any} */ ((await drive(uploadFile(s.ctx, stream, { filename: "a.mp4", sizeBytes: 4 }))).error);
    expect(err.code).toBe("CONFLICT");
    expect(callsTo(s.fake.calls, "GET", /./)).toHaveLength(0);
  });

  it("says where else to upload when uploads are turned off, and has nothing to cancel", async () => {
    useClock(NOW);
    const s = uploadServer({
      size: 10,
      partSize: 4,
      on: (r) =>
        r.method === "POST"
          ? {
              status: 503,
              headers: { "Retry-After": "60" },
              json: { error: { code: "UNAVAILABLE", message: "Uploading through the API is turned off.", hint: "Sending it again does not help.", requestId: "req_o", details: { reason: "switched_off" } } },
            }
          : undefined,
    });
    const err = /** @type {any} */ ((await drive(uploadFile(s.ctx, bytesOf(10), { filename: "a.mp4" }))).error);
    expect(err.code).toBe("UNAVAILABLE");
    expect(err.retryable).toBe(false);
    expect(err.message).toBe(
      `UNAVAILABLE (503): Uploading through the API is turned off. Hint: Sending it again does not help. [request req_o] ${MESSAGES.uploadElsewhere}`,
    );
    await settleBackground();
    expect(s.fake.calls).toHaveLength(1);
  });

  it("refuses an answer whose parts do not cover the file, and cancels that upload", async () => {
    useClock(NOW);
    const s = uploadServer({ size: 10, partSize: 4, partCount: 2 });
    const err = /** @type {any} */ ((await drive(uploadFile(s.ctx, bytesOf(10), { filename: "a.mp4" }))).error);
    expect(err).toBeInstanceOf(GptVideoNetworkError);
    expect(err.code).toBe("BAD_RESPONSE");
    expect(err.message).toBe("BAD_RESPONSE: The API split a file of 10 bytes into 2 parts of 4 bytes, which does not cover it.");
    await settleBackground();
    expect(callsTo(s.fake.calls, "PUT", /./)).toHaveLength(0);
    expect(callsTo(s.fake.calls, "DELETE", /./)).toHaveLength(1);
  });

  it("stops on the caller's signal and still cancels the upload, without that signal", async () => {
    useClock(NOW);
    const s = uploadServer({ size: 40, partSize: 4, partMs: () => 10_000 });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 15_000);
    const err = /** @type {any} */ ((await drive(uploadFile(s.ctx, bytesOf(40), { filename: "a.mp4", signal: controller.signal }))).error);
    expect(err.code).toBe("ABORTED");
    await settleBackground();
    const [cancel] = callsTo(s.fake.calls, "DELETE", /./);
    expect(cancel).toBeDefined();
    expect(cancel?.signal?.aborted, "the cancel does not carry the caller's aborted signal").toBe(false);
  });

  it("stops on the caller's signal even while a stream that gives no bytes is being read, and cancels the upload", async () => {
    useClock(NOW);
    const s = uploadServer({ size: 10, partSize: 4 });
    // a source the SDK cannot hurry: it never gives a byte, so no part is ever sent
    const stalled = new ReadableStream({ pull: () => new Promise(() => {}) });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 1000);
    const got = await drive(uploadFile(s.ctx, stalled, { filename: "a.mp4", sizeBytes: 10, signal: controller.signal }));
    const err = /** @type {any} */ (got.error);
    expect(err).toBeInstanceOf(GptVideoNetworkError);
    expect(err.code).toBe("ABORTED");
    expect(err.operation).toBe("upload_part");
    expect(got.at - NOW, "the upload ends when the signal fires, not when the stream does").toBe(1000);
    expect(callsTo(s.fake.calls, "PUT", /./)).toHaveLength(0);
    await settleBackground();
    expect(callsTo(s.fake.calls, "DELETE", new RegExp(`/v1/uploads/${ID}$`))).toHaveLength(1);
  });

  it("checks its arguments before anything is sent", async () => {
    const s = uploadServer({ size: 10, partSize: 4 });
    const locked = new ReadableStream();
    locked.getReader();
    for (const [source, options, text] of /** @type {[unknown, any, string][]} */ ([
      [bytesOf(10), {}, "uploadFile needs a filename, such as interview.mp4"],
      [new Uint8Array(0), { filename: "a.mp4" }, "The file is empty."],
      [bytesOf(10), { filename: "a.mp4", sizeBytes: 11 }, "sizeBytes is 11, and the file has 10 bytes."],
      [new ReadableStream(), { filename: "a.mp4" }, "uploadFile needs sizeBytes for a stream"],
      [locked, { filename: "a.mp4", sizeBytes: 10 }, "The stream is already being read by someone else."],
      ["videos/talk.mp4", { filename: "a.mp4" }, "In Node.js, open a file with fs.openAsBlob(path)."],
      [bytesOf(10), { filename: "a.mp4", concurrency: 0 }, "concurrency must be a whole number from 1 to 16."],
      [bytesOf(10), { filename: "a.mp4", concurrency: 17 }, "concurrency must be a whole number from 1 to 16."],
      [bytesOf(10), { filename: "", contentType: "video/mp4" }, "filename must be a non-empty string."],
      [bytesOf(10), { filename: "a.mp4", idempotencyKey: "k" }, "uploadFile has no option idempotencyKey."],
    ])) {
      const err = /** @type {any} */ (await uploadFile(s.ctx, source, options).catch((e) => e));
      expect(err.code, text).toBe("INVALID_ARGUMENT");
      expect(err.message, text).toContain(text);
    }
    expect(s.fake.calls).toHaveLength(0);
  });
});

describe("the time of a part", () => {
  it("grows with its size, from one minute at 100 KB a second up to ten", () => {
    expect(partTimeoutMs(1)).toBe(PART_TIMEOUT_MIN_MS);
    expect(partTimeoutMs(8_388_608)).toBe(83_887);
    expect(partTimeoutMs(1e9)).toBe(PART_TIMEOUT_MAX_MS);
  });

  it("has a deadline that fits every attempt with its whole timeout and every pause at its longest", () => {
    expect(partDeadlineMs(60_000, 2)).toBe(3 * 60_000 + 2 * 60_000);
    expect(partDeadlineMs(60_000, 0)).toBe(60_000);
    expect(CANCEL_DEADLINE_MS).toBeLessThanOrEqual(15_000);
  });
});
