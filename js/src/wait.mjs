// @ts-check
/**
 * Waiting for work that finishes later: a job, an export, a tool run, an Editor Assistant turn. The read that
 * follows each kind comes from the table (`async.waitWith`), and is sent again with `?wait=25` until the work
 * is final: its status is done, failed or cancelled, or it has a `finishedAt`, which also ends a status this
 * SDK does not know yet. Work that failed or was cancelled throws GptVideoJobError unless the caller says
 * otherwise; a failed analysis never looks like an empty list of clips.
 *
 * The API holds at most a few waits per account at once and answers the others at once. A read that comes
 * back early without a final status is followed by a pause of 3 to 5 seconds, and a client holds at most
 * WAITS_PER_CLIENT reads open, leaving room for the other clients of the same account.
 */

import { GptVideoJobError, GptVideoNetworkError, MESSAGES, TEXTS, formatErrorMessage } from "./errors.mjs";
import { CONVENTIONS } from "./operations.generated.mjs";
import { callHook, checkNumber, checkOptionNames, invalid, isObject, isSignal, monotonicNow, onAbort, sleep } from "./transport.mjs";

/** @typedef {import("./table.mjs").OperationSpec} OperationSpec */
/** @typedef {import("./transport.mjs").Transport} Transport */
/** @typedef {import("./transport.mjs").OperationIndex} OperationIndex */

/** The statuses that end a piece of work, as the API lists them. */
export const FINAL_STATUSES = CONVENTIONS.finalStatuses;

/** The longest `?wait=` the API holds a read for, in seconds. */
export const WAIT_READ_SEC = CONVENTIONS.waitMaxSec;

/** How long a wait lasts when the caller does not say: an analysis can take many minutes. */
export const WAIT_TIMEOUT_MS = 60 * 60_000;

/** How many reads with `?wait=` one client holds open at once. */
export const WAITS_PER_CLIENT = 4;

/** The pause after a read that came back early without a final status: 3 seconds and up to 2 more. */
export const EARLY_ANSWER_PAUSE = Object.freeze({ minMs: 3000, spreadMs: 2000 });

/**
 * The time a read of a wait has for the network: beyond the seconds the API holds the read, for one attempt,
 * and beyond the end of the wait, for the last read.
 */
export const READ_GRACE_MS = 10_000;

/** The options of a wait. */
export const WAIT_OPTIONS = Object.freeze(["timeoutMs", "signal", "onProgress", "throwOnFailure"]);

/**
 * The options of a wait.
 * @typedef {object} WaitOptions
 * @property {number} [timeoutMs] how long to wait in all, 60 minutes by default
 * @property {AbortSignal} [signal] stops the wait
 * @property {(current: Record<string, unknown>) => void} [onProgress] told of every read, with the object as
 *   it was read; what it throws is ignored
 * @property {boolean} [throwOnFailure] true by default: work that failed or was cancelled throws
 *   GptVideoJobError, which carries the object. With false, the object comes back instead.
 */

/**
 * The reads a client holds open with `?wait=`, first come first served.
 */
export class WaitSlots {
  #free;
  /** @type {{ grant: () => void }[]} */
  #queue = [];

  /** @param {number} size */
  constructor(size) {
    this.#free = size;
  }

  /**
   * A slot, as the function that gives it back, or null when the signal fires first.
   * @param {AbortSignal} signal
   * @returns {Promise<(() => void) | null>}
   */
  acquire(signal) {
    if (signal.aborted) return Promise.resolve(null);
    if (this.#free > 0) {
      this.#free--;
      return Promise.resolve(this.#release());
    }
    return new Promise((resolve) => {
      const entry = {
        grant: () => {
          unlisten();
          resolve(this.#release());
        },
      };
      const unlisten = onAbort(signal, () => {
        const at = this.#queue.indexOf(entry);
        if (at >= 0) this.#queue.splice(at, 1);
        resolve(null);
      });
      this.#queue.push(entry);
    });
  }

  /** @returns {() => void} */
  #release() {
    let given = false;
    return () => {
      if (given) return;
      given = true;
      const next = this.#queue.shift();
      if (next) next.grant();
      else this.#free++;
    };
  }
}

/**
 * What the wait functions need from the client.
 * @typedef {object} WaitContext
 * @property {Transport} transport
 * @property {OperationIndex} index
 * @property {WaitSlots} slots
 */

/**
 * The times of one read of a wait. An attempt always outlasts the seconds the API may hold the read, even when
 * the client has a short timeoutMs or deadlineMs for its other calls; the retries of the read end at most
 * READ_GRACE_MS after the wait itself.
 *
 * @param {{ timeoutMs: number, deadlineMs: number }} defaults the client's times for one call
 * @param {number} waitSec the seconds of `?wait=` this read asks for
 * @param {number} leftMs what is left of the wait
 * @returns {{ timeoutMs: number, deadlineMs: number }}
 */
export function readTimes(defaults, waitSec, leftMs) {
  const timeoutMs = Math.max(defaults.timeoutMs, waitSec * 1000 + READ_GRACE_MS);
  const deadlineMs = Math.min(Math.max(defaults.deadlineMs, timeoutMs), Math.max(1, leftMs) + READ_GRACE_MS);
  return { timeoutMs, deadlineMs };
}

/**
 * Whether a piece of work is over: a final status, or a finishedAt the API set.
 * @param {Record<string, unknown>} current
 */
export function isFinal(current) {
  return FINAL_STATUSES.includes(/** @type {string} */ (current.status)) || (current.finishedAt !== null && current.finishedAt !== undefined);
}

/**
 * @param {WaitOptions | undefined} options
 * @param {string} where
 */
function checkWaitOptions(options, where) {
  if (options !== undefined && !isObject(options)) throw invalid(`The options of ${where} must be an object.`);
  const o = /** @type {Record<string, unknown>} */ (options ?? {});
  checkOptionNames(o, WAIT_OPTIONS, where);
  if (o.signal !== undefined && !isSignal(o.signal)) throw invalid("signal must be an AbortSignal.");
  if (o.onProgress !== undefined && typeof o.onProgress !== "function") throw invalid("onProgress must be a function.");
  if (o.throwOnFailure !== undefined && typeof o.throwOnFailure !== "boolean") throw invalid("throwOnFailure must be true or false.");
  return {
    timeoutMs: o.timeoutMs === undefined ? WAIT_TIMEOUT_MS : checkNumber("timeoutMs", o.timeoutMs, "duration"),
    signal: /** @type {AbortSignal | undefined} */ (o.signal),
    onProgress: /** @type {WaitOptions["onProgress"]} */ (o.onProgress),
    throwOnFailure: o.throwOnFailure !== false,
  };
}

/**
 * `gv.wait(result)`: the answer of a call that starts work, `{ job }`, `{ export }`, `{ toolRun }` or
 * `{ turn }`, followed until the work is over. Resolves to the object as the last read gave it.
 *
 * @param {WaitContext} ctx
 * @param {unknown} result
 * @param {WaitOptions} [options]
 * @returns {Promise<any>}
 */
export async function waitOn(ctx, result, options) {
  const o = checkWaitOptions(options, "wait");
  const handles = ctx.index.handles;
  const found = isObject(result) ? handles.filter((handle) => isObject(result[handle])) : [];
  if (found.length !== 1) {
    throw invalid(`wait takes the answer of a call that starts work: an object with one of ${handles.join(", ")}.`);
  }
  const handle = /** @type {string} */ (found[0]);
  const current = /** @type {Record<string, unknown>} */ (/** @type {Record<string, unknown>} */ (result)[handle]);
  if (typeof current.id !== "string" || current.id.length === 0) throw invalid(`${handle}.id must be a non-empty string.`);
  return follow(ctx, handle, current.id, o);
}

/**
 * The long forms, `waitForJob(jobOrId)` and its siblings: an id, the object (`{ id }`), or the answer that
 * carries it (`{ job }`).
 *
 * @param {WaitContext} ctx
 * @param {string} handle
 * @param {unknown} target
 * @param {WaitOptions | undefined} options
 * @param {string} where the method name, for the messages
 * @returns {Promise<any>}
 */
export async function waitForHandle(ctx, handle, target, options, where) {
  const o = checkWaitOptions(options, where);
  /** @type {unknown} */
  let id = target;
  if (isObject(target)) id = isObject(target[handle]) ? target[handle].id : target.id;
  if (typeof id !== "string" || id.length === 0) throw invalid(`${where} takes an id, the ${handle} object, or the answer that carries it.`);
  return follow(ctx, handle, id, o);
}

/**
 * The loop. The wait ends at its own time or on the caller's signal; a read already sent ends on its own
 * terms, within a deadline that outlasts the wait by READ_GRACE_MS at most.
 *
 * @param {WaitContext} ctx
 * @param {string} handle
 * @param {string} id
 * @param {ReturnType<typeof checkWaitOptions>} o
 * @returns {Promise<any>}
 */
async function follow(ctx, handle, id, o) {
  const read = ctx.index.readFor(handle);
  if (!read) throw invalid(`There is no way to follow ${handle} in this version of the SDK.`);
  const param = /** @type {string} */ (read.pathParams[0]);
  const endAt = monotonicNow() + o.timeoutMs;
  const stop = new AbortController();
  const unlink = onAbort(o.signal, () => stop.abort());
  const timer = setTimeout(() => stop.abort(), o.timeoutMs);
  /** @type {Record<string, unknown> | null} */
  let last = null;
  const ended = () => (o.signal?.aborted ? aborted(read) : timedOut(ctx, read, id, last, o.timeoutMs));
  try {
    for (;;) {
      if (endAt - monotonicNow() <= 0) throw ended();
      const release = await ctx.slots.acquire(stop.signal);
      if (!release) throw ended();
      const startedAt = monotonicNow();
      const waitSec = Math.max(0, Math.min(WAIT_READ_SEC, Math.floor((endAt - startedAt) / 1000)));
      /** @type {unknown} */
      let body;
      try {
        const times = readTimes(ctx.transport.defaults, waitSec, endAt - startedAt);
        body = await ctx.transport.send(read, { [param]: id, wait: waitSec }, o.signal ? { signal: o.signal, ...times } : times);
      } finally {
        release();
      }
      const current = objectIn(ctx, body, handle, read);
      last = current;
      callHook(o.onProgress, current);
      if (isFinal(current)) return settle(ctx, current, read, o.throwOnFailure);
      // an answer before the wait it asked for was not held: the account's waits are full, so pause
      if (waitSec === 0 || monotonicNow() - startedAt < waitSec * 1000) {
        const pauseMs = EARLY_ANSWER_PAUSE.minMs + Math.floor(Math.random() * EARLY_ANSWER_PAUSE.spreadMs);
        if (!(await sleep(pauseMs, stop.signal))) throw ended();
      }
    }
  } finally {
    clearTimeout(timer);
    unlink();
  }
}

/**
 * The object a read carries, or BAD_RESPONSE when it carries none.
 * @param {WaitContext} ctx
 * @param {unknown} body
 * @param {string} handle
 * @param {OperationSpec} read
 * @returns {Record<string, unknown>}
 */
function objectIn(ctx, body, handle, read) {
  const current = isObject(body) ? body[handle] : undefined;
  if (isObject(current) && typeof current.status === "string") return current;
  throw new GptVideoNetworkError(formatErrorMessage({ code: "BAD_RESPONSE", message: TEXTS.missingHandle(handle) }), {
    code: "BAD_RESPONSE",
    operation: read.id,
  });
}

/**
 * The end of a wait on a final object: failed and cancelled throw unless the caller asked for the object.
 * @param {WaitContext} ctx
 * @param {Record<string, unknown>} current
 * @param {OperationSpec} read
 * @param {boolean} throwOnFailure
 */
function settle(ctx, current, read, throwOnFailure) {
  const code = current.status === "failed" ? "JOB_FAILED" : current.status === "cancelled" ? "JOB_CANCELLED" : null;
  if (!code || !throwOnFailure) return current;
  const id = ctx.transport.scrub(String(current.id));
  const said = typeof current.errorMessage === "string" && current.errorMessage.length > 0 ? ctx.transport.scrub(current.errorMessage) : null;
  const text = code === "JOB_FAILED" ? TEXTS.jobFailed(id) : TEXTS.jobCancelled(id);
  throw new GptVideoJobError(formatErrorMessage({ code, message: said ? `${text} ${said}` : text }), {
    code,
    handle: ctx.transport.scrubValue(current),
    errorMessage: said,
    operation: read.id,
  });
}

/** @param {OperationSpec} read */
function aborted(read) {
  return new GptVideoNetworkError(formatErrorMessage({ code: "ABORTED", message: MESSAGES.aborted }), { code: "ABORTED", operation: read.id });
}

/**
 * @param {WaitContext} ctx
 * @param {OperationSpec} read
 * @param {string} id
 * @param {Record<string, unknown> | null} last
 * @param {number} timeoutMs
 */
function timedOut(ctx, read, id, last, timeoutMs) {
  const status = last && typeof last.status === "string" ? ctx.transport.scrub(last.status).slice(0, 64) : null;
  const said = last && typeof last.errorMessage === "string" && last.errorMessage.length > 0 ? ctx.transport.scrub(last.errorMessage) : null;
  return new GptVideoJobError(formatErrorMessage({ code: "WAIT_TIMEOUT", message: TEXTS.waitTimeout(ctx.transport.scrub(id), status, timeoutMs) }), {
    code: "WAIT_TIMEOUT",
    handle: last === null ? null : ctx.transport.scrubValue(last),
    errorMessage: said,
    // waiting again can still see the work end
    retryable: true,
    operation: read.id,
  });
}
