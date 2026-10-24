// @ts-check
// Every item of a list: cursors followed while hasMore, pages asked for only when needed, and the three
// ways a list could never end (or end early) stopped with BAD_RESPONSE.
import { describe, expect, it } from "vitest";
import { GptVideoApiError, GptVideoNetworkError, MESSAGES } from "./errors.mjs";
import { paginate } from "./paginate.mjs";
import { Transport, resolveSettings } from "./transport.mjs";
import { scriptedFetch } from "./testing/fake-fetch.js";
import { FIXTURE_INDEX, FIXTURE_RETRYABLE_CODES } from "./testing/operations.fixture.js";

const API_KEY = `gvk_${"P".repeat(43)}`;

/** @param {import("./testing/fake-fetch.js").Scripted[]} script */
function setup(script) {
  const fake = scriptedFetch(script);
  const transport = new Transport(resolveSettings({ apiKey: API_KEY, fetch: fake.fetch, maxRetries: 0 }), FIXTURE_RETRYABLE_CODES);
  return { fake, ctx: { transport, index: FIXTURE_INDEX } };
}

/** @param {unknown[]} data @param {string | null} nextCursor */
const page = (data, nextCursor) => ({ json: { data, hasMore: nextCursor !== null, nextCursor } });

/** @param {AsyncIterable<unknown>} iterable */
async function collect(iterable) {
  const out = [];
  for await (const item of iterable) out.push(item);
  return out;
}

/** @param {AsyncIterable<unknown>} iterable @returns {Promise<{ items: unknown[], error: any }>} */
async function collectUntilError(iterable) {
  const items = [];
  try {
    for await (const item of iterable) items.push(item);
  } catch (error) {
    return { items, error };
  }
  return { items, error: undefined };
}

describe("paginate", () => {
  it("yields every item, page after page, following nextCursor while hasMore", async () => {
    const { fake, ctx } = setup([page([{ id: 1 }, { id: 2 }], "c2"), page([{ id: 3 }], "c3"), page([], null)]);
    expect(await collect(paginate(ctx, "listProjects", { limit: 2 }))).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }]);
    expect(fake.calls.map((c) => [...new URL(c.url).searchParams])).toEqual([[["limit", "2"]], [["limit", "2"], ["cursor", "c2"]], [["limit", "2"], ["cursor", "c3"]]]);
  });

  it("starts from the cursor the input gives, and keeps the other fields of the input on every page", async () => {
    const { fake, ctx } = setup([page([{ id: 9 }], "next"), page([{ id: 10 }], null)]);
    expect(await collect(paginate(ctx, "listClips", { projectId: "prj_1", status: "accepted", cursor: "start" }))).toEqual([{ id: 9 }, { id: 10 }]);
    expect(fake.calls.map((c) => c.url)).toEqual([
      "https://api.gpt-video.com/v1/projects/prj_1/clips?status=accepted&cursor=start",
      "https://api.gpt-video.com/v1/projects/prj_1/clips?status=accepted&cursor=next",
    ]);
  });

  it("asks for a page only when the items of the one before are used up", async () => {
    const { fake, ctx } = setup([page([{ id: 1 }, { id: 2 }], "c2"), page([{ id: 3 }], null)]);
    const items = paginate(ctx, "listProjects");
    expect(fake.calls).toHaveLength(0);
    for await (const item of items) {
      expect(item).toEqual({ id: 1 });
      break;
    }
    expect(fake.calls).toHaveLength(1);
  });

  it("stops with BAD_RESPONSE on a cursor it has seen, the one before or any earlier", async () => {
    const same = setup([page([{ id: 1 }], "c1"), page([{ id: 2 }], "c1")]);
    const a = await collectUntilError(paginate(same.ctx, "listProjects"));
    expect(a.items).toEqual([{ id: 1 }, { id: 2 }]);
    expect(a.error).toBeInstanceOf(GptVideoNetworkError);
    expect(a.error.code).toBe("BAD_RESPONSE");
    expect(a.error.message).toBe(`BAD_RESPONSE: ${MESSAGES.repeatedCursor}`);

    const loop = setup([page([1], "a"), page([2], "b"), page([3], "a")]);
    expect((await collectUntilError(paginate(loop.ctx, "listProjects"))).error.message).toBe(`BAD_RESPONSE: ${MESSAGES.repeatedCursor}`);

    const back = setup([page([1], "start")]);
    expect((await collectUntilError(paginate(back.ctx, "listProjects", { cursor: "start" }))).error.message).toBe(`BAD_RESPONSE: ${MESSAGES.repeatedCursor}`);
  });

  it("stops with BAD_RESPONSE when there are more items and no cursor, or the answer is not a page", async () => {
    const noCursor = setup([{ json: { data: [1], hasMore: true, nextCursor: null } }]);
    expect((await collectUntilError(paginate(noCursor.ctx, "listProjects"))).error.message).toBe(`BAD_RESPONSE: ${MESSAGES.missingCursor}`);
    for (const json of [{ data: "x", hasMore: false, nextCursor: null }, { items: [], hasMore: false }, [], { data: [], hasMore: "no" }]) {
      const notPage = setup([{ json }]);
      expect((await collectUntilError(paginate(notPage.ctx, "listProjects"))).error.message, JSON.stringify(json)).toBe(`BAD_RESPONSE: ${MESSAGES.notAPage}`);
    }
  });

  it("hands a CONFLICT of list_clips to the caller as it is: reading on would skip or repeat clips", async () => {
    const { fake, ctx } = setup([
      page([{ id: "cnd_1" }], "c2"),
      { status: 409, json: { error: { code: "CONFLICT", message: "The clips changed since this cursor.", requestId: "req_c", details: { stale: true } } } },
    ]);
    const got = await collectUntilError(paginate(ctx, "listClips", { projectId: "prj_1" }));
    expect(got.items).toEqual([{ id: "cnd_1" }]);
    expect(got.error).toBeInstanceOf(GptVideoApiError);
    expect(got.error.code).toBe("CONFLICT");
    expect(fake.calls).toHaveLength(2);
  });

  it("says which methods are lists, at the call and not at the first item", () => {
    const { ctx } = setup([]);
    for (const method of ["getProject", "list_projects", "", 42, undefined]) {
      expect(() => paginate(ctx, method), String(method)).toThrow("is not a list method. The list methods are: listProjects, listClips.");
    }
    expect(() => paginate(ctx, "listProjects", "x")).toThrow("The input of listProjects must be an object.");
    expect(() => paginate(ctx, "listProjects", {}, /** @type {any} */ ({ idempotencyKey: "k" }))).toThrow("paginate has no option idempotencyKey");
  });

  it("checks the value of every option at the call too, before any page is asked for", () => {
    const { fake, ctx } = setup([]);
    for (const options of [{ signal: {} }, { timeoutMs: 0 }, { deadlineMs: -1 }, { maxRetries: 1.5 }, { timeoutMs: "60000" }]) {
      expect(() => paginate(ctx, "listProjects", {}, /** @type {any} */ (options)), JSON.stringify(options)).toThrow(/^INVALID_ARGUMENT: /);
    }
    expect(fake.calls).toHaveLength(0);
  });

  it("sends every page with the options it was given, and sees no later change to them", async () => {
    const { fake, ctx } = setup([page([1], "c2"), page([2], null)]);
    const controller = new AbortController();
    const options = { signal: controller.signal, maxRetries: 0 };
    const items = paginate(ctx, "listProjects", {}, options);
    Object.assign(options, { maxRetries: /** @type {any} */ ("many") });
    expect(await collect(items)).toEqual([1, 2]);
    expect(fake.calls.every((c) => c.signal !== null)).toBe(true);
  });
});
