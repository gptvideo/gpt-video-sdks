// @ts-check
/**
 * Keeping the API key out of everything the SDK hands back. The key travels in one place only, the
 * Authorization header of a request to the API. Every text and value that comes back from the server and
 * ends up in an error (message, hint, details) passes through here first, and so does the printed form of
 * a client.
 */

export const REDACTED = "[redacted]";

/** A key-shaped token, whichever key it is: `gvk_` and at least 16 more characters of its alphabet. */
const KEY_SHAPE = /gvk_[A-Za-z0-9_-]{16,}/g;

/** How deep an error's `details` is copied; anything deeper is cut, never walked. */
const MAX_DEPTH = 16;

/** What stands in for a part of `details` deeper than MAX_DEPTH. */
export const TRUNCATED = "[truncated]";

/**
 * The text with the key, and anything shaped like a key, replaced by `[redacted]`.
 *
 * @param {string} text
 * @param {string | null} key the API key of the client, when there is one
 * @returns {string}
 */
export function scrubText(text, key) {
  const plain = key ? text.split(key).join(REDACTED) : text;
  return plain.replace(KEY_SHAPE, REDACTED);
}

/**
 * A copy of a parsed JSON value with every string scrubbed, object keys included. The copy is made with
 * `Object.fromEntries`, so a `__proto__` key stays a key and never becomes a prototype.
 *
 * @param {unknown} value
 * @param {string | null} key
 * @param {number} [depth]
 * @returns {unknown}
 */
export function scrubValue(value, key, depth = 0) {
  if (typeof value === "string") return scrubText(value, key);
  if (value === null || typeof value !== "object") return value;
  if (depth >= MAX_DEPTH) return TRUNCATED;
  if (Array.isArray(value)) return value.map((item) => scrubValue(item, key, depth + 1));
  return Object.fromEntries(Object.entries(value).map(([name, item]) => [scrubText(name, key), scrubValue(item, key, depth + 1)]));
}

// Typed `unique symbol` so that the methods named by them stay in the declarations a TypeScript program reads.

/**
 * The symbol Node's `util.inspect` calls to print an object.
 * @type {unique symbol}
 */
export const NODE_INSPECT = Symbol.for("nodejs.util.inspect.custom");

/**
 * The symbol Deno's `Deno.inspect` calls to print an object.
 * @type {unique symbol}
 */
export const DENO_INSPECT = Symbol.for("Deno.customInspect");
