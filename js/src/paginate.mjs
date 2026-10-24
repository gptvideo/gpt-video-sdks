// @ts-check
/**
 * Every item of a list, page after page: `for await (const project of gv.paginate("listProjects"))`. Each
 * page is one call with its own retries; the next page is asked for only when the items of this one are
 * used up. The loop follows `nextCursor` while `hasMore` is true, and stops with BAD_RESPONSE on a cursor it
 * has already seen, which would never end. A CONFLICT of list_clips (the list changed under the cursor)
 * reaches the caller as it is: reading on would skip or repeat clips.
 */

import { GptVideoNetworkError, MESSAGES, formatErrorMessage } from "./errors.mjs";
import { checkNumber, checkOptionNames, invalid, isObject, isSignal } from "./transport.mjs";

/** @typedef {import("./table.mjs").OperationSpec} OperationSpec */
/** @typedef {import("./transport.mjs").Transport} Transport */
/** @typedef {import("./transport.mjs").OperationIndex} OperationIndex */

/** The options of paginate, passed to the call of every page. */
export const PAGINATE_OPTIONS = Object.freeze(["signal", "timeoutMs", "deadlineMs", "maxRetries"]);

/**
 * The options of paginate.
 * @typedef {object} PaginateOptions
 * @property {AbortSignal} [signal] stops the call of the page in flight
 * @property {number} [timeoutMs] the time of one attempt of a page
 * @property {number} [deadlineMs] the time of the call of one page
 * @property {number} [maxRetries] failures retried for each page
 */

/**
 * @typedef {object} PaginateContext
 * @property {Transport} transport
 * @property {OperationIndex} index
 */

/**
 * The items of a list. Mistakes in the arguments throw here, at the call, not at the first item.
 *
 * @param {PaginateContext} ctx
 * @param {unknown} method the method name of a list, `listProjects`
 * @param {unknown} [input] the input of the list; a `cursor` in it is where the iteration starts
 * @param {PaginateOptions} [options]
 * @returns {AsyncGenerator<any, void, undefined>}
 */
export function paginate(ctx, method, input, options) {
  const spec = typeof method === "string" ? ctx.index.byName(method) : undefined;
  if (!spec || !spec.paginated) {
    throw invalid(`${typeof method === "string" ? method : "This"} is not a list method. The list methods are: ${ctx.index.listNames.join(", ")}.`);
  }
  if (input !== undefined && !isObject(input)) throw invalid(`The input of ${spec.name} must be an object.`, spec.id);
  if (options !== undefined && !isObject(options)) throw invalid("The options of paginate must be an object.", spec.id);
  const o = /** @type {Record<string, unknown>} */ ({ ...(options ?? {}) });
  checkOptionNames(o, PAGINATE_OPTIONS, "paginate", spec.id);
  if (o.signal !== undefined && !isSignal(o.signal)) throw invalid("signal must be an AbortSignal.", spec.id);
  for (const name of ["timeoutMs", "deadlineMs"]) if (o[name] !== undefined) checkNumber(name, o[name], "duration", spec.id);
  if (o.maxRetries !== undefined) checkNumber("maxRetries", o.maxRetries, "count", spec.id);
  return items(ctx, spec, { ...(input ?? {}) }, /** @type {PaginateOptions} */ (o));
}

/**
 * @param {PaginateContext} ctx
 * @param {OperationSpec} spec
 * @param {Record<string, unknown>} input
 * @param {PaginateOptions} options
 */
async function* items(ctx, spec, input, options) {
  /** @type {Set<string>} */
  const seen = new Set();
  if (typeof input.cursor === "string") seen.add(input.cursor);
  let page = input;
  for (;;) {
    const answer = await ctx.transport.send(spec, page, options);
    if (!isObject(answer) || !Array.isArray(answer.data) || typeof answer.hasMore !== "boolean") throw badPage(spec, MESSAGES.notAPage);
    for (const item of answer.data) yield item;
    if (!answer.hasMore) return;
    const next = answer.nextCursor;
    if (typeof next !== "string" || next.length === 0) throw badPage(spec, MESSAGES.missingCursor);
    if (seen.has(next)) throw badPage(spec, MESSAGES.repeatedCursor);
    seen.add(next);
    page = { ...input, cursor: next };
  }
}

/** @param {OperationSpec} spec @param {string} message */
function badPage(spec, message) {
  return new GptVideoNetworkError(formatErrorMessage({ code: "BAD_RESPONSE", message }), { code: "BAD_RESPONSE", operation: spec.id });
}
