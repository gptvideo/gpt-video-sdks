// @ts-check
// Waiting for work that finishes later, on a fake clock: the read with ?wait=, the final statuses and
// finishedAt, failures that throw, the pause after an early answer, the waits a client holds open, the
// caller's signal, and the time a wait can take.
import { afterEach, describe, expect, it, vi } from "vitest";
import { GptVideoApiError, GptVideoJobError, GptVideoNetworkError } from "./errors.mjs";
import { Transport, resolveSettings } from "./transport.mjs";
import { EARLY_ANSWER_PAUSE, FINAL_STATUSES, READ_GRACE_MS, WAITS_PER_CLIENT, WAIT_READ_SEC, WaitSlots, isFinal, readTimes, waitForHandle, waitOn } from "./wait.mjs";
import { drive, useClock } from "./testing/clock.js";
import { scriptedFetch } from "./testing/fake-fetch.js";
import { FIXTURE_INDEX, FIXTURE_RETRYABLE_CODES } from "./testing/operations.fixture.js";

const API_KEY = `gvk_${"W".repeat(43)}`;
const NOW = Date.parse("2026-10-11T12:00:00.000Z");

/** @param {import("./testing/fake-fetch.js").Scripted[] | ((r: import("./testing/fake-fetch.js").Recorded, i: number) => any)} script */
function setup(script) {
  const fake = scriptedFetch(script);
  const transport = new Transport(resolveSettings({ apiKey: API_KEY, fetch: fake.fetch }), FIXTURE_RETRYABLE_CODES);
  return { fake, ctx: { transport, index: FIXTURE_INDEX, slots: new WaitSlots(WAITS_PER_CLIENT) } };
}

/** @param {string} status @param {Record<string, unknown>} [more] */
function job(status, more = {}) {
  const final = FINAL_STATUSES.includes(status);
  return { id: "job_1", kind: "analysis", status, progress: final ? 1 : 0.5, errorMessage: null, finishedAt: final ? "2026-10-11T12:30:00.000Z" : null, ...more };
}

/**
 * A server that answers each read with the next object, holding a read that is not final for the seconds
 * of its ?wait=, as the API does when the account has room for another wait.
 * @param {string} field
 * @param {Record<string, unknown>[]} objects
 * @param {{ hold?: boolean }} [options]
 */
function holding(field, objects, { hold = true } = {}) {
  let i = 0;
  return (/** @type {import("./testing/fake-fetch.js").Recorded} */ request) => {
    const current = objects[Math.min(i++, objects.length - 1)];
    const wait = Number(new URL(request.url).searchParams.get("wait") ?? "0");
    const held = hold && current && !isFinal(current) ? wait * 1000 : 0;
    return { afterMs: held, json: { [field]: current } };
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("a wait", () => {
  it("reads the job with ?wait=25 until it is done, and returns the job as the last read gave it", async () => {
    useClock(NOW);
    const { fake, ctx } = setup(holding("job", [job("running"), job("done")]));
    const got = await drive(waitOn(ctx, { job: job("queued"), creditsCharged: 3 }));
    expect(got.value).toEqual(job("done"));
    expect(fake.calls.map((c) => c.url)).toEqual(["https://api.gpt-video.com/v1/jobs/job_1?wait=25", "https://api.gpt-video.com/v1/jobs/job_1?wait=25"]);
    expect(fake.calls[1]?.at, "a held read is followed at once").toBe(NOW + 25_000);
    for (const call of fake.calls) expect(call.headers).not.toHaveProperty("idempotency-key");
  });

  it("keeps waiting on an export that is rendering, and returns it with its link once done", async () => {
    useClock(NOW);
    const rendering = { id: "rnd_1", status: "rendering", finishedAt: null, downloadUrl: null };
    const done = { id: "rnd_1", status: "done", finishedAt: "2026-10-11T12:01:00.000Z", downloadUrl: "https://www.gpt-video.com/media/x" };
    const { fake, ctx } = setup(holding("export", [rendering, rendering, done]));
    const got = await drive(waitOn(ctx, { export: { id: "rnd_1", status: "queued" }, paidWith: "credits" }));
    expect(got.value).toEqual(done);
    expect(fake.calls).toHaveLength(3);
    expect(new URL(fake.calls[0]?.url ?? "").pathname).toBe("/v1/exports/rnd_1");
  });

  it("follows a tool run and an Editor Assistant turn with their own reads", async () => {
    useClock(NOW);
    const run = setup(holding("toolRun", [{ id: "run_1", status: "done", finishedAt: "x" }]));
    await drive(waitOn(run.ctx, { toolRun: { id: "run_1", status: "queued" } }));
    expect(run.fake.calls[0]?.url).toBe("https://api.gpt-video.com/v1/tool-runs/run_1?wait=25");
    const turn = setup(holding("turn", [{ id: "agm_1", status: "done", finishedAt: "x" }]));
    await drive(waitOn(turn.ctx, { turn: { id: "agm_1", status: "queued" } }));
    expect(turn.fake.calls[0]?.url).toBe("https://api.gpt-video.com/v1/assistant/turns/agm_1?wait=25");
  });

  it("pauses 3 to 5 seconds after a read that came back early without a final status", async () => {
    useClock(NOW);
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const { fake, ctx } = setup(holding("job", [job("running"), job("running"), job("done")], { hold: false }));
    const got = await drive(waitOn(ctx, { job: job("queued") }));
    expect(got.value).toEqual(job("done"));
    const pause = EARLY_ANSWER_PAUSE.minMs + Math.floor(0.5 * EARLY_ANSWER_PAUSE.spreadMs);
    expect(pause).toBe(4000);
    expect(fake.calls.map((c) => c.at - NOW)).toEqual([0, pause, 2 * pause]);
  });

  it("ends on a status it does not know when finishedAt is set", async () => {
    useClock(NOW);
    const archived = job("archived", { finishedAt: "2026-10-11T12:00:01.000Z" });
    const { fake, ctx } = setup(holding("job", [archived]));
    expect((await drive(waitOn(ctx, { job: job("queued") }))).value).toEqual(archived);
    expect(fake.calls).toHaveLength(1);
  });

  it("without a final status or finishedAt, ends at its time with WAIT_TIMEOUT and the last object", async () => {
    useClock(NOW);
    const paused = job("paused", { errorMessage: "Waiting for a worker." });
    const { fake, ctx } = setup(holding("job", [paused]));
    const got = await drive(waitOn(ctx, { job: job("queued") }, { timeoutMs: 60_000 }));
    const err = /** @type {any} */ (got.error);
    expect(err).toBeInstanceOf(GptVideoJobError);
    expect(err.code).toBe("WAIT_TIMEOUT");
    expect(err.retryable).toBe(true);
    expect(err.operation).toBe("get_job");
    expect(err.handle).toEqual(paused);
    expect(err.errorMessage).toBe("Waiting for a worker.");
    expect(err.message).toBe("WAIT_TIMEOUT: job_1 did not finish within 60 seconds. Its last status is paused.");
    expect(got.at - NOW).toBe(60_000);
    expect(fake.calls.map((c) => new URL(c.url).searchParams.get("wait"))).toEqual(["25", "25", "10"]);
  });

  it("throws GptVideoJobError on work that failed, with the object and what went wrong", async () => {
    useClock(NOW);
    const failed = job("failed", { errorMessage: "The video has no audio." });
    const { ctx } = setup(holding("job", [failed]));
    const err = /** @type {any} */ ((await drive(waitOn(ctx, { job: job("queued") }))).error);
    expect(err).toBeInstanceOf(GptVideoJobError);
    expect(err.code).toBe("JOB_FAILED");
    expect(err.retryable).toBe(false);
    expect(err.handle).toEqual(failed);
    expect(err.errorMessage).toBe("The video has no audio.");
    expect(err.message).toBe("JOB_FAILED: job_1 failed. The video has no audio.");
  });

  it("throws JOB_CANCELLED on work that was cancelled, and returns either object with throwOnFailure: false", async () => {
    useClock(NOW);
    const cancelled = job("cancelled");
    const a = setup(holding("job", [cancelled]));
    const err = /** @type {any} */ ((await drive(waitOn(a.ctx, { job: job("queued") }))).error);
    expect(err.code).toBe("JOB_CANCELLED");
    expect(err.message).toBe("JOB_CANCELLED: job_1 was cancelled.");
    const b = setup(holding("job", [job("failed")]));
    expect((await drive(waitOn(b.ctx, { job: job("queued") }, { throwOnFailure: false }))).value).toEqual(job("failed"));
  });

  it("is told to onProgress at every read, and what onProgress throws is ignored", async () => {
    useClock(NOW);
    /** @type {unknown[]} */
    const seen = [];
    const { ctx } = setup(holding("job", [job("running"), job("done")]));
    const onProgress = (/** @type {Record<string, unknown>} */ current) => {
      seen.push(current.status);
      throw new Error("a bug in the caller's progress bar");
    };
    expect((await drive(waitOn(ctx, { job: job("queued") }, { onProgress }))).value).toEqual(job("done"));
    expect(seen).toEqual(["running", "done"]);
  });

  it("stops on the caller's signal in a read and in a pause", async () => {
    useClock(NOW);
    const reading = setup(holding("job", [job("running")]));
    const inRead = new AbortController();
    setTimeout(() => inRead.abort(), 10_000);
    const a = /** @type {any} */ ((await drive(waitOn(reading.ctx, { job: job("queued") }, { signal: inRead.signal }))).error);
    expect(a).toBeInstanceOf(GptVideoNetworkError);
    expect(a.code).toBe("ABORTED");

    const pausing = setup(holding("job", [job("running")], { hold: false }));
    const inPause = new AbortController();
    setTimeout(() => inPause.abort(), 1000);
    const started = Date.now();
    const b = await drive(waitOn(pausing.ctx, { job: job("queued") }, { signal: inPause.signal }));
    expect(/** @type {any} */ (b.error).code).toBe("ABORTED");
    expect(b.at - started).toBe(1000);
    expect(pausing.fake.calls).toHaveLength(1);
  });

  it("never lets its last read outlast it by more than the grace", async () => {
    useClock(NOW);
    let i = 0;
    const { ctx } = setup(() => (i++ === 0 ? { afterMs: 25_000, json: { job: job("running") } } : { network: "hang" }));
    const got = await drive(waitOn(ctx, { job: job("queued") }, { timeoutMs: 30_000 }));
    expect(/** @type {any} */ (got.error).code).toBe("TIMEOUT");
    expect(got.at - NOW).toBe(30_000 + READ_GRACE_MS);
  });

  it("ends with the error of a read that fails after its own retries, and sends no more reads", async () => {
    useClock(NOW);
    const { fake, ctx } = setup([
      { json: { job: job("running") } },
      { status: 404, json: { error: { code: "NOT_FOUND", message: "Job job_1 not found.", requestId: "req_n" } } },
    ]);
    const got = await drive(waitOn(ctx, { job: job("queued") }));
    const err = /** @type {any} */ (got.error);
    expect(err).toBeInstanceOf(GptVideoApiError);
    expect(err.code).toBe("NOT_FOUND");
    expect(err.operation).toBe("get_job");
    expect(fake.calls).toHaveLength(2);
  });

  it("holds its reads for 25 seconds even on a client whose calls time out sooner", async () => {
    useClock(NOW);
    const fake = scriptedFetch(holding("job", [job("running"), job("running"), job("done")]));
    const transport = new Transport(resolveSettings({ apiKey: API_KEY, fetch: fake.fetch, timeoutMs: 5000, deadlineMs: 8000 }), FIXTURE_RETRYABLE_CODES);
    const got = await drive(waitOn({ transport, index: FIXTURE_INDEX, slots: new WaitSlots(WAITS_PER_CLIENT) }, { job: job("queued") }));
    expect(got.error).toBeUndefined();
    expect(got.value).toEqual(job("done"));
    expect(fake.calls.map((c) => c.at - NOW), "every read held, none timed out and sent again").toEqual([0, 25_000, 50_000]);
  });

  it("gives each read an attempt longer than its ?wait=, and retries that end with the wait", () => {
    const defaults = { timeoutMs: 60_000, deadlineMs: 180_000 };
    expect(readTimes(defaults, 25, 3_600_000)).toEqual({ timeoutMs: 60_000, deadlineMs: 180_000 });
    expect(readTimes(defaults, 5, 5_000)).toEqual({ timeoutMs: 60_000, deadlineMs: 5_000 + READ_GRACE_MS });
    expect(readTimes({ timeoutMs: 5000, deadlineMs: 8000 }, 25, 3_600_000)).toEqual({ timeoutMs: 25_000 + READ_GRACE_MS, deadlineMs: 25_000 + READ_GRACE_MS });
    expect(readTimes(defaults, 0, -50).deadlineMs, "never zero or less").toBe(1 + READ_GRACE_MS);
  });
});

describe("the long forms", () => {
  it("take an id, the object, or the answer that carries it", async () => {
    useClock(NOW);
    for (const target of ["job_1", job("running"), { job: job("running") }]) {
      const { fake, ctx } = setup(holding("job", [job("done")]));
      expect((await drive(waitForHandle(ctx, "job", target, undefined, "waitForJob"))).value).toEqual(job("done"));
      expect(fake.calls[0]?.url).toBe("https://api.gpt-video.com/v1/jobs/job_1?wait=25");
    }
  });

  it("say what they take when given something else", async () => {
    const { ctx } = setup([]);
    for (const target of [undefined, "", 42, {}, { id: 7 }, { export: { id: "rnd_1" } }]) {
      const err = /** @type {any} */ (await waitForHandle(ctx, "job", target, undefined, "waitForJob").catch((e) => e));
      expect(err.code, JSON.stringify(target)).toBe("INVALID_ARGUMENT");
      expect(err.message).toBe("INVALID_ARGUMENT: waitForJob takes an id, the job object, or the answer that carries it.");
    }
  });
});

describe("wait", () => {
  it("takes only the answer of a call that starts work", async () => {
    const { ctx, fake } = setup([]);
    for (const result of [undefined, "job_1", {}, { job: null }, { job: job("queued"), export: { id: "rnd_1" } }, { project: { id: "prj_1" } }]) {
      const err = /** @type {any} */ (await waitOn(ctx, result).catch((e) => e));
      expect(err.code, JSON.stringify(result)).toBe("INVALID_ARGUMENT");
    }
    expect(/** @type {any} */ (await waitOn(ctx, { job: { id: "" } }).catch((e) => e)).message).toBe("INVALID_ARGUMENT: job.id must be a non-empty string.");
    expect(/** @type {any} */ (await waitOn(ctx, { job: job("queued") }, /** @type {any} */ ({ timeout: 5 })).catch((e) => e)).message).toContain("wait has no option timeout");
    expect(fake.calls).toHaveLength(0);
  });

  it("holds at most four reads open per client, and every wait still ends", async () => {
    useClock(NOW);
    let open = 0;
    let most = 0;
    /** @type {Map<string, number>} */
    const reads = new Map();
    const { ctx } = setup(async (request) => {
      const id = new URL(request.url).pathname.split("/").pop() ?? "";
      const n = (reads.get(id) ?? 0) + 1;
      reads.set(id, n);
      open++;
      most = Math.max(most, open);
      await new Promise((resolve) => setTimeout(resolve, 25_000));
      open--;
      return { json: { job: { id, status: n >= 2 ? "done" : "running", finishedAt: n >= 2 ? "x" : null } } };
    });
    const waits = Array.from({ length: 6 }, (_, k) => waitOn(ctx, { job: { id: `job_${k}`, status: "queued" } }));
    const all = await drive(Promise.all(waits));
    expect(all.error).toBeUndefined();
    expect(all.value?.map((/** @type {any} */ j) => j.status)).toEqual(Array(6).fill("done"));
    expect(most).toBe(WAITS_PER_CLIENT);
    expect([...reads.values()]).toEqual(Array(6).fill(2));
  });

  it("gives up its place in line when its signal fires before a slot is free, and the line goes on", async () => {
    const slots = new WaitSlots(1);
    const first = await slots.acquire(new AbortController().signal);
    const leaving = new AbortController();
    const queued = slots.acquire(leaving.signal);
    const next = slots.acquire(new AbortController().signal);
    leaving.abort();
    expect(await queued, "the wait that left gets no slot").toBeNull();
    first?.();
    const granted = await next;
    expect(typeof granted, "the slot goes to the next in line, not to the one that left").toBe("function");
    granted?.();
    granted?.();
    // giving a slot back twice frees it once: one more acquire is granted at once, the one after waits
    const a = await slots.acquire(new AbortController().signal);
    let bGranted = false;
    const b = slots.acquire(new AbortController().signal).then((release) => {
      bGranted = true;
      return release;
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(bGranted).toBe(false);
    a?.();
    expect(typeof (await b)).toBe("function");
  });
});

describe("the end of a piece of work", () => {
  // that every status of the four objects is final or working, and that each object has finishedAt, is checked
  // where the catalogue is: the statuses and the seconds of ?wait= below are generated from it
  it("is a final status, or a finishedAt the API set, whatever the status says", () => {
    expect([...FINAL_STATUSES]).toEqual(["done", "failed", "cancelled"]);
    expect(WAIT_READ_SEC).toBe(25);
    for (const status of FINAL_STATUSES) expect(isFinal({ status, finishedAt: null }), status).toBe(true);
    for (const status of ["queued", "running", "rendering", "paused"]) {
      expect(isFinal({ status, finishedAt: null }), status).toBe(false);
      expect(isFinal({ status }), `${status} without the field`).toBe(false);
      expect(isFinal({ status, finishedAt: "2026-10-11T12:00:00.000Z" }), `${status} with finishedAt`).toBe(true);
    }
  });

  it("is read from frozen statuses", () => {
    expect(Object.isFrozen(FINAL_STATUSES)).toBe(true);
  });
});
