// @ts-check
// Downloading a signed link: never with the API key, even on the host of the API; https only; the body is
// the caller's; retried like a read before the headers arrive.
import { afterEach, describe, expect, it, vi } from "vitest";
import { GptVideoNetworkError, MESSAGES } from "./errors.mjs";
import { DOWNLOAD, download } from "./download.mjs";
import { Transport, VERSION, resolveSettings } from "./transport.mjs";
import { drive, useClock } from "./testing/clock.js";
import { scriptedFetch } from "./testing/fake-fetch.js";
import { FIXTURE_RETRYABLE_CODES } from "./testing/operations.fixture.js";

const API_KEY = `gvk_${"D".repeat(43)}`;
const NOW = Date.parse("2026-10-11T12:00:00.000Z");
const LINK = "https://www.gpt-video.com/media/ast_0123456789abcdef0123?exp=1788258600&sig=0f";

/** @param {Parameters<typeof scriptedFetch>[0]} script @param {Record<string, unknown>} [options] */
function setup(script, options = {}) {
  const fake = scriptedFetch(script);
  /** @type {any[]} */
  const retries = [];
  const transport = new Transport(
    resolveSettings({ apiKey: API_KEY, fetch: fake.fetch, onRetry: (e) => retries.push(e), ...options }),
    FIXTURE_RETRYABLE_CODES,
  );
  return { fake, retries, ctx: { transport } };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("download", () => {
  it("hands back the response, and sends no key, even to the host of the API", async () => {
    for (const url of [LINK, "https://api.gpt-video.com/media/x?sig=1", new URL(LINK)]) {
      const { fake, ctx } = setup([{ status: 200, headers: { "Content-Type": "video/mp4" }, text: "MP4BYTES" }]);
      const res = await download(ctx, url);
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("MP4BYTES");
      expect(fake.calls[0]?.url).toBe(String(url));
      expect(fake.calls[0]?.headers).toEqual({ "user-agent": `gpt-video-js/${VERSION}` });
      expect(JSON.stringify(fake.calls)).not.toContain(API_KEY);
    }
  });

  it("opens only https:// links, and http:// to this machine", async () => {
    const { fake, ctx } = setup([{ text: "x" }]);
    for (const url of ["http://www.gpt-video.com/media/x", "ftp://x/y", "/media/x", "media/x", "", 42, null, "https://user:pw@www.gpt-video.com/media/x"]) {
      const err = /** @type {any} */ (await download(ctx, url).catch((e) => e));
      expect(err.code, String(url)).toBe("INVALID_ARGUMENT");
    }
    expect(fake.calls).toHaveLength(0);
    expect((await download(ctx, "http://localhost:3000/media/x")).status).toBe(200);
  });

  it("stops a redirect that lands on an address that is not https, or on one it cannot read", async () => {
    for (const where of ["http://cdn.example.com/file.mp4", "", "not a url", "ftp://cdn.example.com/file.mp4"]) {
      const { fake, ctx } = setup([{ status: 200, text: "x", redirectedTo: where }]);
      const err = /** @type {any} */ (await download(ctx, LINK).catch((e) => e));
      expect(err, where).toBeInstanceOf(GptVideoNetworkError);
      expect(err.code).toBe("BAD_RESPONSE");
      expect(err.retryable).toBe(false);
      expect(err.message).toBe(`BAD_RESPONSE (200): ${MESSAGES.downloadInsecure}`);
      expect(fake.calls).toHaveLength(1);
    }
  });

  it("takes a redirect that lands on another https address, still without the key", async () => {
    const { fake, ctx } = setup([{ status: 200, text: "MP4", redirectedTo: "https://cdn.example.com/file.mp4" }]);
    const res = await download(ctx, LINK);
    expect(await res.text()).toBe("MP4");
    expect(fake.calls[0]?.redirect, "a download has no key, so the runtime may follow").toBe("follow");
    expect(fake.calls[0]?.headers).not.toHaveProperty("authorization");
  });

  it("says the link was refused on 403, and does not retry it", async () => {
    const { fake, ctx } = setup([{ status: 403, text: "Forbidden" }]);
    const err = /** @type {any} */ (await download(ctx, LINK).catch((e) => e));
    expect(err.code).toBe("BAD_RESPONSE");
    expect(err.status).toBe(403);
    expect(err.retryable).toBe(false);
    expect(err.operation).toBe(DOWNLOAD);
    expect(err.message).toBe(`BAD_RESPONSE (403): ${MESSAGES.downloadRefused}`);
    expect(fake.calls).toHaveLength(1);
  });

  it("retries a 503 and a failed connection before the headers, and tells onRetry", async () => {
    useClock(NOW);
    const { fake, retries, ctx } = setup([
      { status: 503, headers: { "Retry-After": "2" }, text: "busy" },
      { network: "connection_failed" },
      { status: 200, text: "ok" },
    ]);
    const got = await drive(download(ctx, LINK));
    expect(/** @type {Response} */ (got.value).status).toBe(200);
    expect(fake.calls).toHaveLength(3);
    expect(retries.map((r) => [r.operation, r.code])).toEqual([
      [DOWNLOAD, "BAD_RESPONSE"],
      [DOWNLOAD, "CONNECTION_FAILED"],
    ]);
    expect(retries[0].delayMs).toBe(2000);
  });

  it("times out an attempt that gets no headers, and gives up at the deadline", async () => {
    useClock(NOW);
    const { fake, ctx } = setup([{ network: "hang" }, { network: "hang" }], { timeoutMs: 10_000, deadlineMs: 15_000 });
    const got = await drive(download(ctx, LINK));
    const err = /** @type {any} */ (got.error);
    expect(err.code).toBe("TIMEOUT");
    expect(err.retryable).toBe(true);
    expect(got.at - NOW).toBe(15_000);
    expect(fake.calls).toHaveLength(2);
  });

  it("leaves the body to the caller's signal once the headers arrived", async () => {
    const { fake, ctx } = setup([{ status: 200, text: "x" }]);
    const controller = new AbortController();
    await download(ctx, LINK, { signal: controller.signal });
    const signal = fake.calls[0]?.signal;
    expect(signal?.aborted).toBe(false);
    controller.abort();
    expect(signal?.aborted, "aborting the caller's signal stops the body too").toBe(true);
  });

  it("refuses an option it does not have", async () => {
    const { ctx } = setup([]);
    const err = /** @type {any} */ (await download(ctx, LINK, /** @type {any} */ ({ headers: { Authorization: "x" } })).catch((e) => e));
    expect(err.message).toBe("INVALID_ARGUMENT: download has no option headers. Its options are: signal, timeoutMs, deadlineMs, maxRetries.");
  });
});
