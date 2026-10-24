// @ts-check
/**
 * How the SDK sends one call: the client's settings, the request built from an operation of the table, one
 * attempt over fetch, and the loop that applies the rules of retry.mjs to the attempts of a call.
 *
 * Four things hold on every path through this file:
 *  - a call makes its Idempotency-Key once, before the first attempt, and sends that key on every attempt
 *    and every wait; it never makes a second one;
 *  - every attempt ends by its own timeout, and every call by its deadline, even when a fetch passed in by
 *    the caller ignores the abort signal;
 *  - a redirect is never followed: it would carry the API key to another address. A fetch passed in by the
 *    caller that follows one anyway has its answer refused, and a spend sent that way may have been charged;
 *  - the API key leaves this file only in the Authorization header of a request to baseUrl.
 */

import {
  GptVideoApiError,
  GptVideoError,
  GptVideoNetworkError,
  INVALID_ARGUMENT,
  MESSAGES,
  TEXTS,
  formatErrorMessage,
} from "./errors.mjs";
import { DENO_INSPECT, NODE_INSPECT, REDACTED, scrubText, scrubValue } from "./redact.mjs";
import {
  DEFAULTS,
  RETRY_AFTER_MAX_SEC,
  backoffMs,
  isIdempotencyKey,
  mayHaveSpent,
  newIdempotencyKey,
  policyOf,
  retryAfterSec,
} from "./retry.mjs";
import { CONVENTIONS } from "./operations.generated.mjs";

/** @typedef {import("./table.mjs").OperationSpec} OperationSpec */
/** @typedef {import("./retry.mjs").Answer} Answer */
/** @typedef {import("./retry.mjs").Outcome} Outcome */
/** @typedef {import("./retry.mjs").Failure} Failure */
/** @typedef {import("./retry.mjs").NetworkFailure} NetworkFailure */

/** The version of this package. A test ties it to package.json. */
export const VERSION = "1.0.0";

/** The base URL of the documentation, used when the caller gives none. */
export const DEFAULT_BASE_URL = CONVENTIONS.baseUrl;

/** The environment variable read when the caller passes no apiKey. */
export const API_KEY_ENV = CONVENTIONS.apiKeyEnv;

/** Every API key starts with this. */
export const API_KEY_PREFIX = "gvk_";

/** The product token of the User-Agent; the request log of the API counts it as an SDK. */
export const USER_AGENT_PRODUCT = "gpt-video-js";

/** The longest delay a timer can hold: past it, setTimeout fires at once instead. */
export const MAX_TIMER_MS = 2_147_483_647;

/** The header names, as the API writes them. */
const HEADER = CONVENTIONS.headers;

/** The shape of an error code the API sends; anything else is not the API's error body. */
const ERROR_CODE = /^[A-Z][A-Z0-9_]{0,63}$/;

/** A system error code worth repeating in a message (ECONNREFUSED, ENOTFOUND, UND_ERR_SOCKET). */
const SYSTEM_CODE = /^[A-Z][A-Z0-9_]{1,40}$/;

/** The options of `new GptVideo()`. */
export const CLIENT_OPTIONS = Object.freeze([
  "apiKey",
  "baseUrl",
  "maxRetries",
  "timeoutMs",
  "deadlineMs",
  "fetch",
  "onResponse",
  "onRetry",
  "userAgentSuffix",
  "dangerouslyAllowBrowser",
]);

/** The options of one call. The bytes of an operation that sends bytes travel beside them, never inside. */
export const CALL_OPTIONS = Object.freeze(["idempotencyKey", "signal", "timeoutMs", "deadlineMs", "maxRetries"]);

/**
 * @typedef {object} RateLimit
 * @property {number | null} limit requests allowed in the window
 * @property {number | null} remaining requests left in the window
 * @property {number | null} resetSec seconds until the window starts again
 */

/**
 * What `onResponse` receives for every HTTP answer, error answers included. Never a header, never the key.
 * @typedef {object} ResponseEvent
 * @property {string} operation the operation id, `analyze_project`
 * @property {number} status
 * @property {string | null} requestId the X-Request-Id of the answer
 * @property {number} attempt 1 for the first attempt of the call
 * @property {boolean} replayed true when the API answered from an earlier request with the same Idempotency-Key
 * @property {RateLimit} rateLimit
 */

/**
 * What `onRetry` receives before every pause of a call.
 * @typedef {object} RetryEvent
 * @property {string} operation the operation id
 * @property {number} attempt the attempt that just ended, from 1
 * @property {string} code what it ended with: an API code, or CONNECTION_FAILED, TIMEOUT, BAD_RESPONSE
 * @property {number} delayMs how long the SDK waits before the next attempt
 */

/**
 * @typedef {(input: string, init: RequestInit) => Promise<Response>} FetchFunction
 */

/**
 * The options of `new GptVideo()`.
 * @typedef {object} GptVideoOptions
 * @property {string} [apiKey] defaults to the GPT_VIDEO_API_KEY environment variable
 * @property {string} [baseUrl] the base URL of the documentation, with or without its final /v1;
 *   defaults to https://api.gpt-video.com/v1
 * @property {number} [maxRetries] failures retried after the first attempt, 2 by default
 * @property {number} [timeoutMs] the time of one attempt, 60000 by default
 * @property {number} [deadlineMs] the time of a whole call, pauses included, 180000 by default
 * @property {FetchFunction} [fetch] the fetch to send requests with; defaults to the global one
 * @property {(event: ResponseEvent) => void} [onResponse] told of every answer; what it throws is ignored
 * @property {(event: RetryEvent) => void} [onRetry] told before every pause; what it throws is ignored
 * @property {string} [userAgentSuffix] added after gpt-video-js/<version> in the User-Agent
 * @property {boolean} [dangerouslyAllowBrowser] lets the SDK run in a web page, where anyone who opens the
 *   page can read the API key
 */

/**
 * The options of one call, as `send` reads them: the generated CallOptions, and the idempotencyKey of the
 * operations that send one (KeyedCallOptions).
 * @typedef {object} SendOptions
 * @property {string} [idempotencyKey]
 * @property {AbortSignal} [signal]
 * @property {number} [timeoutMs]
 * @property {number} [deadlineMs]
 * @property {number} [maxRetries]
 */

/** The bytes of an operation that sends bytes, such as uploadPart. @typedef {Blob | ArrayBuffer | ArrayBufferView} BinaryBody */

/**
 * The settings of a client, checked once.
 * @typedef {object} Settings
 * @property {string} apiKey
 * @property {string} root the base URL without its final /v1: catalogue paths, which start with /v1, go after it
 * @property {string} baseUrl the base URL with /v1, as the documentation writes it
 * @property {number} maxRetries
 * @property {number} timeoutMs
 * @property {number} deadlineMs
 * @property {FetchFunction} fetch
 * @property {((event: ResponseEvent) => void) | null} onResponse
 * @property {((event: RetryEvent) => void) | null} onRetry
 * @property {string | null} userAgent null in a web page, where the header is not sent
 * @property {boolean} browser
 */

// ------------------------------------------------------------------------------------------- small helpers

/**
 * A mistake found before anything is sent.
 * @param {string} message
 * @param {string | null} [operation]
 */
export function invalid(message, operation = null) {
  return new GptVideoError(formatErrorMessage({ code: INVALID_ARGUMENT, message }), { code: INVALID_ARGUMENT, operation });
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
export function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** @param {unknown} value @returns {value is AbortSignal} */
export function isSignal(value) {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (/** @type {{ aborted?: unknown }} */ (value).aborted) === "boolean" &&
    typeof (/** @type {{ addEventListener?: unknown }} */ (value).addEventListener) === "function" &&
    typeof (/** @type {{ removeEventListener?: unknown }} */ (value).removeEventListener) === "function"
  );
}

/** A clock that only moves forward, for timeouts and deadlines. Wall-clock time is only for Retry-After dates. */
export function monotonicNow() {
  const performance = globalThis.performance;
  return typeof performance?.now === "function" ? performance.now() : Date.now();
}

/**
 * Waits `ms`, or less when the signal fires. Resolves to true when the time passed, false when the signal
 * stopped it.
 *
 * @param {number} ms
 * @param {AbortSignal | null | undefined} signal
 * @returns {Promise<boolean>}
 */
export function sleep(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve(false);
      return;
    }
    /** @param {boolean} passed */
    const done = (passed) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve(passed);
    };
    const onAbort = () => done(false);
    const timer = setTimeout(() => done(true), Math.max(0, ms));
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Calls `then` when the signal fires (at once if it already has). Returns the function that stops listening.
 *
 * @param {AbortSignal | null | undefined} signal
 * @param {() => void} then
 * @returns {() => void}
 */
export function onAbort(signal, then) {
  if (!signal) return () => {};
  if (signal.aborted) {
    then();
    return () => {};
  }
  signal.addEventListener("abort", then, { once: true });
  return () => signal.removeEventListener("abort", then);
}

export const STOPPED = Symbol("stopped");

/**
 * Waits for a promise unless the signal fires first. A fetch that ignores its signal cannot hold a call past
 * its timeout: the call stops waiting for it, and a late answer has its body cancelled.
 *
 * @template T
 * @param {Promise<T>} promise
 * @param {AbortSignal} signal
 * @returns {Promise<typeof STOPPED | { ok: true, value: T } | { ok: false, error: unknown }>}
 */
export function unlessAborted(promise, signal) {
  return new Promise((resolve) => {
    let stopped = false;
    const stop = () => {
      stopped = true;
      resolve(STOPPED);
    };
    const unlisten = onAbort(signal, stop);
    promise.then(
      (value) => {
        unlisten();
        if (stopped) discard(value);
        else resolve({ ok: true, value });
      },
      (error) => {
        unlisten();
        resolve({ ok: false, error });
      },
    );
  });
}

/** Cancels the body of an answer nobody reads, so its connection goes back to the pool. @param {unknown} value */
export function discard(value) {
  const body = /** @type {{ body?: { cancel?: () => Promise<unknown> } | null } | null} */ (value)?.body;
  if (body && typeof body.cancel === "function") body.cancel().catch(() => {});
}

/**
 * Calls a hook of the caller. What it throws or rejects is ignored: a logging hook must never turn a call
 * that succeeded, perhaps a spend, into an exception the caller would answer by sending it again.
 *
 * @template E
 * @param {((event: E) => unknown) | null | undefined} hook
 * @param {E} event
 */
export function callHook(hook, event) {
  if (!hook) return;
  try {
    const result = hook(event);
    if (result && typeof (/** @type {{ then?: unknown }} */ (result).then) === "function") {
      /** @type {Promise<unknown>} */ (result).then(undefined, () => {});
    }
  } catch {
    // ignored, as documented on the option
  }
}

/** @param {string | null} raw @returns {number | null} */
function wholeNumber(raw) {
  if (raw === null) return null;
  const value = raw.trim();
  return /^[0-9]{1,15}$/.test(value) ? Number(value) : null;
}

/** @param {Response} res @param {string} name @returns {string | null} */
function headerOf(res, name) {
  try {
    return res.headers.get(name);
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------------------------------------ settings

/** Whether the code runs in a web page: `window` and `document` both exist. Workers, Deno and Bun have no `document`. */
export function inBrowser() {
  return typeof globalThis.window !== "undefined" && typeof globalThis.document !== "undefined";
}

/**
 * Whether an http:// address is this machine, the only place a key may travel without TLS: localhost,
 * *.localhost, 127.0.0.0/8 and [::1]. WHATWG URL has already written the host in its canonical form.
 *
 * @param {string} hostname
 */
export function isThisMachine(hostname) {
  const host = hostname.toLowerCase();
  return host === "localhost" || host.endsWith(".localhost") || /^127\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}$/.test(host) || host === "[::1]";
}

/**
 * Whether an address may be called: https://, or http:// to this machine.
 * @param {URL} url
 */
export function isSafeAddress(url) {
  return url.protocol === "https:" || (url.protocol === "http:" && isThisMachine(url.hostname));
}

/** @param {unknown} raw */
function readEnvKey(raw) {
  if (raw !== undefined) return raw;
  try {
    const env = /** @type {{ process?: { env?: Record<string, string | undefined> } }} */ (/** @type {unknown} */ (globalThis)).process?.env;
    const value = env?.[API_KEY_ENV];
    return typeof value === "string" ? value : undefined;
  } catch {
    // a runtime that guards its environment (Deno without --allow-env) has no key to give
    return undefined;
  }
}

/**
 * The base URL with and without its final /v1. Both forms send the same requests.
 *
 * @param {unknown} raw
 * @returns {{ root: string, baseUrl: string }}
 */
export function resolveBaseUrl(raw) {
  if (typeof raw !== "string") throw invalid(`baseUrl must be a string, such as ${DEFAULT_BASE_URL}.`);
  /** @type {URL} */
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw invalid(`baseUrl is not an absolute URL. Use the base URL of the documentation, such as ${DEFAULT_BASE_URL}.`);
  }
  if (!isSafeAddress(url)) throw invalid(MESSAGES.insecureBaseUrl);
  if (url.username || url.password) throw invalid("baseUrl must not hold a user name or a password.");
  if (url.search || url.hash) throw invalid("baseUrl must not have a query or a fragment.");
  const path = url.pathname.replace(/\/+$/, "").replace(/\/v1$/, "");
  return { root: `${url.origin}${path}`, baseUrl: `${url.origin}${path}/v1` };
}

/**
 * A whole number of milliseconds a timer can hold, or a count of retries.
 *
 * @param {string} name
 * @param {unknown} value
 * @param {"duration" | "count"} kind
 * @param {string | null} [operation]
 * @returns {number}
 */
export function checkNumber(name, value, kind, operation = null) {
  if (kind === "count") {
    if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return value;
    throw invalid(`${name} must be a whole number, 0 or more.`, operation);
  }
  if (typeof value === "number" && Number.isFinite(value) && value > 0 && value <= MAX_TIMER_MS) return value;
  throw invalid(`${name} must be a number of milliseconds, more than 0 and at most ${MAX_TIMER_MS}.`, operation);
}

/**
 * Refuses an option this SDK does not have, so a misspelled option is a clear error instead of a setting
 * that never applies.
 *
 * @param {Record<string, unknown>} options
 * @param {readonly string[]} known
 * @param {string} where how the caller wrote the call, `new GptVideo()` or `analyzeProject`
 * @param {string | null} [operation]
 */
export function checkOptionNames(options, known, where, operation = null) {
  for (const name of Object.keys(options)) {
    if (!known.includes(name)) throw invalid(`${where} has no option ${name}. Its options are: ${known.join(", ")}.`, operation);
  }
}

/**
 * The settings of a client, checked in this order: the web page, the key, the base URL, the rest. Every
 * mistake is a GptVideoError with INVALID_ARGUMENT, thrown before anything is sent; no message repeats the key.
 *
 * @param {GptVideoOptions | undefined} options
 * @returns {Settings}
 */
export function resolveSettings(options) {
  if (options !== undefined && !isObject(options)) throw invalid("The options of new GptVideo() must be an object.");
  const o = /** @type {Record<string, unknown>} */ (options ?? {});
  const browser = inBrowser();
  if (browser && o.dangerouslyAllowBrowser !== true) throw invalid(MESSAGES.browser);
  checkOptionNames(o, CLIENT_OPTIONS, "new GptVideo()");
  if (o.dangerouslyAllowBrowser !== undefined && typeof o.dangerouslyAllowBrowser !== "boolean") throw invalid("dangerouslyAllowBrowser must be true or false.");

  const apiKey = readEnvKey(o.apiKey);
  if (apiKey === undefined || apiKey === null || apiKey === "") throw invalid(MESSAGES.missingApiKey);
  // a key pasted with a space or a line break around it is a key with bad characters, not a wrong key
  if (typeof apiKey !== "string" || !apiKey.trim().startsWith(API_KEY_PREFIX)) throw invalid(MESSAGES.badApiKeyPrefix);
  if (!/^[\x21-\x7E]+$/.test(apiKey)) throw invalid(MESSAGES.badApiKeyCharacters);

  const { root, baseUrl } = resolveBaseUrl(o.baseUrl ?? DEFAULT_BASE_URL);
  const maxRetries = o.maxRetries === undefined ? DEFAULTS.maxRetries : checkNumber("maxRetries", o.maxRetries, "count");
  const timeoutMs = o.timeoutMs === undefined ? DEFAULTS.timeoutMs : checkNumber("timeoutMs", o.timeoutMs, "duration");
  const deadlineMs = o.deadlineMs === undefined ? DEFAULTS.deadlineMs : checkNumber("deadlineMs", o.deadlineMs, "duration");

  for (const name of ["fetch", "onResponse", "onRetry"]) {
    if (o[name] !== undefined && typeof o[name] !== "function") throw invalid(`${name} must be a function.`);
  }
  /** @type {FetchFunction | undefined} */
  const given = /** @type {FetchFunction | undefined} */ (o.fetch);
  const global = typeof globalThis.fetch === "function" ? globalThis.fetch : undefined;
  if (!given && !global) throw invalid(MESSAGES.noFetch);
  // the global fetch is called through globalThis: a browser refuses it on any other receiver
  /** @type {FetchFunction} */
  const fetch = given ?? ((input, init) => globalThis.fetch(input, init));

  let userAgent = `${USER_AGENT_PRODUCT}/${VERSION}`;
  if (o.userAgentSuffix !== undefined) {
    const suffix = o.userAgentSuffix;
    if (typeof suffix !== "string" || !/^[\x21-\x7E](?:[\x20-\x7E]{0,254}[\x21-\x7E])?$/.test(suffix)) {
      throw invalid("userAgentSuffix must be 1 to 256 visible ASCII characters, with no space at either end.");
    }
    userAgent += ` ${suffix}`;
  }

  return {
    apiKey,
    root,
    baseUrl,
    maxRetries,
    timeoutMs,
    deadlineMs,
    fetch,
    onResponse: /** @type {Settings["onResponse"]} */ (o.onResponse ?? null),
    onRetry: /** @type {Settings["onRetry"]} */ (o.onRetry ?? null),
    // a web page decides its own User-Agent, and the CORS of the API does not allow the header
    userAgent: browser ? null : userAgent,
    browser,
  };
}

// ------------------------------------------------------------------------------------------------- request

/**
 * @typedef {object} PreparedRequest
 * @property {string} url
 * @property {string} method
 * @property {Record<string, string>} headers every header but Authorization, added at the last moment
 * @property {BodyInit | undefined} body
 */

/** @param {BinaryBody} body @returns {number} */
export function byteLengthOf(body) {
  if (typeof Blob !== "undefined" && body instanceof Blob) return body.size;
  return /** @type {ArrayBuffer | ArrayBufferView} */ (body).byteLength;
}

/** @param {unknown} value @returns {value is BinaryBody} */
export function isBinaryBody(value) {
  if (typeof Blob !== "undefined" && value instanceof Blob) return true;
  return value instanceof ArrayBuffer || ArrayBuffer.isView(value);
}

/**
 * A text percent-encoded for a URL: every byte outside A-Z a-z 0-9 - _ . ! ~ * ' ( ) as %XX, a space as %20, so
 * that no server reads a `+` or a `/` of the value as anything but itself. A string with a lone surrogate has
 * no UTF-8 form, and is refused before anything is sent.
 *
 * @param {OperationSpec} spec
 * @param {string} name
 * @param {string} text
 */
function encoded(spec, name, text) {
  try {
    return encodeURIComponent(text);
  } catch {
    throw invalid(`${name} is not well-formed text: it has a lone surrogate.`, spec.id);
  }
}

/**
 * The text of a path parameter. A string is percent-encoded, so `/` stays inside the segment; `.` and `..`
 * are refused, because a URL parser would read them as "this folder" and "the folder above" and send the
 * call, with the key, to another endpoint.
 *
 * @param {OperationSpec} spec
 * @param {string} name
 * @param {unknown} value
 */
function pathSegment(spec, name, value) {
  if (value === undefined || value === null || value === "") throw invalid(`${spec.name} needs ${name}.`, spec.id);
  if (typeof value === "string") {
    if (value === "." || value === "..") throw invalid(`${name} cannot be "${value}".`, spec.id);
    return encoded(spec, name, value);
  }
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return String(value);
  throw invalid(`${name} must be a non-empty string or a whole number.`, spec.id);
}

/**
 * The text of a query value, in the only forms the API reads from a URL: a string as it is, true or false, a
 * whole number in decimal digits, with no sign (no number the API reads from a URL is negative).
 *
 * @param {OperationSpec} spec
 * @param {string} name
 * @param {unknown} value
 */
function queryValue(spec, name, value) {
  if (typeof value === "string") return value;
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return String(value);
  throw invalid(`${name} must be a string, true or false, or a whole number 0 or more: ${spec.name} sends it in the URL.`, spec.id);
}

/**
 * The request of one call, built once and sent as it is on every attempt. The flat input of the catalogue is
 * split as the API reads it: the path parameters into the path, the other fields into the query or the JSON
 * body (`inQuery`); an operation that sends bytes sends `body` with its content type.
 *
 * @param {Settings} settings
 * @param {OperationSpec} spec
 * @param {unknown} input
 * @param {BinaryBody | undefined} bytes
 * @param {string | null} idempotencyKey
 * @returns {PreparedRequest}
 */
export function buildRequest(settings, spec, input, bytes, idempotencyKey) {
  if (input !== undefined && input !== null && !isObject(input)) throw invalid(`The input of ${spec.name} must be an object.`, spec.id);
  /** @type {Record<string, unknown>} */
  const fields = { ...(input ?? {}) };
  let path = spec.path;
  for (const name of spec.pathParams) {
    path = path.split(`{${name}}`).join(pathSegment(spec, name, fields[name]));
    delete fields[name];
  }

  /** @type {Record<string, string>} */
  const headers = { Accept: "application/json" };
  if (settings.userAgent) headers["User-Agent"] = settings.userAgent;
  if (idempotencyKey !== null) headers[HEADER.idempotencyKey] = idempotencyKey;

  let query = "";
  /** @type {BodyInit | undefined} */
  let body;
  const present = Object.entries(fields).filter(([, value]) => value !== undefined);
  if (spec.inQuery || spec.binary) {
    query = present.map(([name, value]) => `${encoded(spec, name, name)}=${encoded(spec, name, queryValue(spec, name, value))}`).join("&");
  } else if (present.length > 0) {
    try {
      body = JSON.stringify(Object.fromEntries(present));
    } catch (e) {
      throw invalid(`The input of ${spec.name} cannot be written as JSON: ${e instanceof Error ? e.message : String(e)}`, spec.id);
    }
    headers["Content-Type"] = "application/json";
  }
  if (spec.binary && bytes !== undefined) {
    body = /** @type {BodyInit} */ (bytes);
    headers["Content-Type"] = spec.binary.contentType;
  }
  return { url: `${settings.root}${path}${query ? `?${query}` : ""}`, method: spec.method, headers, body };
}

/**
 * The bytes of a call: required by an operation that sends bytes, at most its `maxBytes`, and refused by any
 * other operation.
 *
 * @param {OperationSpec} spec
 * @param {unknown} bytes
 * @returns {BinaryBody | undefined}
 */
export function checkBytes(spec, bytes) {
  if (!spec.binary) {
    if (bytes !== undefined) throw invalid(`${spec.name} sends no bytes.`, spec.id);
    return undefined;
  }
  if (!isBinaryBody(bytes)) throw invalid(`${spec.name} sends bytes: pass a Blob, an ArrayBuffer or a Uint8Array.`, spec.id);
  if (byteLengthOf(bytes) > spec.binary.maxBytes) throw invalid(`${spec.name} sends at most ${spec.binary.maxBytes} bytes.`, spec.id);
  return bytes;
}

// ------------------------------------------------------------------------------------------------- attempt

/**
 * @param {NetworkFailure["code"]} code
 * @param {number | null} status
 * @param {string} text
 * @param {Answer | null} answer
 * @returns {NetworkFailure}
 */
function networkFailure(code, status, text, answer) {
  return { kind: "network", code, status, text, answer };
}

/** The message of a failed connection, with the system code when there is a clean one. @param {unknown} error */
function connectionText(error) {
  for (const candidate of [error, /** @type {{ cause?: unknown }} */ (error)?.cause]) {
    try {
      const code = /** @type {{ code?: unknown } | null | undefined} */ (candidate)?.code;
      if (typeof code === "string" && SYSTEM_CODE.test(code)) return TEXTS.connectionFailed(code);
    } catch {
      // a code that cannot be read is not repeated
    }
  }
  return MESSAGES.connectionFailed;
}

/** @param {string} text @returns {{ ok: true, value: unknown } | { ok: false }} */
function parseJson(text) {
  if (text.length === 0) return { ok: false };
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

/** @param {Response} res @returns {Answer} */
function answerOf(res) {
  const replayed = headerOf(res, HEADER.replayed);
  return {
    status: res.status,
    retryAfter: headerOf(res, HEADER.retryAfter),
    requestId: headerOf(res, HEADER.requestId),
    replayed: replayed !== null && replayed.trim().toLowerCase() === "true",
    rateLimit: {
      limit: wholeNumber(headerOf(res, HEADER.rateLimitLimit)),
      remaining: wholeNumber(headerOf(res, HEADER.rateLimitRemaining)),
      resetSec: wholeNumber(headerOf(res, HEADER.rateLimitReset)),
    },
  };
}

/**
 * What an answer whose body was read means: a 2xx with a JSON body is a success; a JSON body with
 * `error.code` is an API error; anything else is BAD_RESPONSE, and its body is never repeated.
 *
 * @param {Answer} answer
 * @param {string} text
 * @returns {Outcome}
 */
export function classifyAnswer(answer, text) {
  const { status } = answer;
  const parsed = parseJson(text);
  if (status >= 200 && status < 300) {
    return parsed.ok ? { kind: "success", status, body: parsed.value, answer } : networkFailure("BAD_RESPONSE", status, MESSAGES.notJson, answer);
  }
  if (!parsed.ok) return networkFailure("BAD_RESPONSE", status, MESSAGES.notJson, answer);
  const error = isObject(parsed.value) ? parsed.value.error : undefined;
  if (!isObject(error) || typeof error.code !== "string" || !ERROR_CODE.test(error.code)) {
    return networkFailure("BAD_RESPONSE", status, MESSAGES.notApiError, answer);
  }
  return {
    kind: "api",
    code: error.code,
    status,
    message: typeof error.message === "string" && error.message.length > 0 ? error.message : MESSAGES.noServerMessage,
    hint: typeof error.hint === "string" && error.hint.length > 0 ? error.hint : null,
    details: error.details === undefined ? null : error.details,
    requestId: typeof error.requestId === "string" && error.requestId.length > 0 ? error.requestId : answer.requestId,
    answer,
  };
}

// ----------------------------------------------------------------------------------------------- the table

/**
 * The operation table, indexed for the engine: by id, by method name, and, for each kind of work that
 * finishes later, the read that follows it with `?wait=`. A table that breaks what the engine relies on
 * (two rows with one name, a handle followed by two reads, a read that is not a GET of one id) is refused
 * when the package loads, never discovered at the first wait.
 */
export class OperationIndex {
  /** @type {Map<string, OperationSpec>} */
  #byId = new Map();
  /** @type {Map<string, OperationSpec>} */
  #byName = new Map();
  /** @type {Map<string, OperationSpec>} */
  #reads = new Map();

  /** @param {readonly OperationSpec[]} rows */
  constructor(rows) {
    for (const row of rows) {
      if (this.#byId.has(row.id) || this.#byName.has(row.name)) throw new Error(`The operation table has two rows for ${row.id}.`);
      this.#byId.set(row.id, row);
      this.#byName.set(row.name, row);
    }
    for (const row of rows) {
      if (!row.async) continue;
      const read = this.#byId.get(row.async.waitWith);
      if (!read || read.method !== "GET" || read.pathParams.length !== 1 || !read.inQuery) {
        throw new Error(`The operation table follows ${row.async.handle} with ${row.async.waitWith}, which is not a GET of one id.`);
      }
      const known = this.#reads.get(row.async.handle);
      if (known && known !== read) throw new Error(`The operation table follows ${row.async.handle} with two reads.`);
      this.#reads.set(row.async.handle, read);
    }
  }

  /** @param {string} id */
  byId(id) {
    return this.#byId.get(id);
  }

  /** @param {string} name */
  byName(name) {
    return this.#byName.get(name);
  }

  /** The read that follows a kind of work: `job` → get_job. @param {string} handle */
  readFor(handle) {
    return this.#reads.get(handle);
  }

  /** The kinds of work that finish later, in the order of the table: job, export, toolRun, turn. */
  get handles() {
    return [...this.#reads.keys()];
  }

  /** The method names of the lists, in the order of the table. */
  get listNames() {
    return [...this.#byName.values()].filter((row) => row.paginated).map((row) => row.name);
  }

  /** An operation the engine composes calls from (uploadFile), which the table must have. @param {string} id */
  operation(id) {
    const row = this.#byId.get(id);
    if (!row) throw new Error(`The operation table has no ${id}.`);
    return row;
  }
}

// ---------------------------------------------------------------------------------------------- transport

/**
 * What a module of this package passes to `send` beyond the caller's options.
 * @typedef {object} SendHooks
 * @property {(outcome: Failure) => void} [onFailure] told of every failed attempt, before the rules decide
 * @property {(outcome: Failure) => string | null} [explain] a sentence of this SDK to add after the message
 *   of the error a call stops with, when the caller can do something the API's words do not say
 */

/**
 * Sends calls for one client. The key lives in a private field and leaves it only in the Authorization
 * header of a request to the base URL.
 */
export class Transport {
  /** @type {Settings} */
  #settings;
  /** @type {ReadonlySet<string>} */
  #retryable;

  /**
   * @param {Settings} settings
   * @param {ReadonlySet<string>} retryable the API's retryable error codes
   */
  constructor(settings, retryable) {
    this.#settings = settings;
    this.#retryable = retryable;
  }

  /** The base URL with /v1, as the documentation writes it. */
  get baseUrl() {
    return this.#settings.baseUrl;
  }

  /** The defaults of a call, for the modules that send calls of their own. */
  get defaults() {
    const { maxRetries, timeoutMs, deadlineMs } = this.#settings;
    return { maxRetries, timeoutMs, deadlineMs };
  }

  /** The User-Agent the client sends, or null in a web page. */
  get userAgent() {
    return this.#settings.userAgent;
  }

  /** The fetch the client sends with: download uses it too, without the key. */
  get fetch() {
    return this.#settings.fetch;
  }

  /** Scrubs the key from a text that came from outside. @param {string} text */
  scrub(text) {
    return scrubText(text, this.#settings.apiKey);
  }

  /** Scrubs the key from a parsed JSON value that came from outside, into a copy. @param {unknown} value */
  scrubValue(value) {
    return scrubValue(value, this.#settings.apiKey);
  }

  /** Tells the caller's onRetry of a pause taken outside `send` (a download). @param {RetryEvent} event */
  reportRetry(event) {
    callHook(this.#settings.onRetry, event);
  }

  /**
   * One call: the options checked, the request built, the key made, then attempts until one succeeds or the
   * rules stop the call. Resolves to the body of the answer, as it is; rejects with a GptVideoError.
   *
   * @param {OperationSpec} spec
   * @param {unknown} input
   * @param {SendOptions} [options]
   * @param {unknown} [bytes] the bytes of an operation that sends bytes, and only of one
   * @param {SendHooks} [hooks]
   * @returns {Promise<any>}
   */
  async send(spec, input, options, bytes, hooks = {}) {
    // the caller's key is checked with the options; the key of the call is made once, here, before any attempt
    const call = this.#callOptions(spec, options);
    const body = checkBytes(spec, bytes);
    const key = spec.idempotencyKey === "none" ? null : (call.idempotencyKey ?? newIdempotencyKey());
    if (spec.idempotencyKey !== "none" && key === null) throw invalid(MESSAGES.noCrypto, spec.id);
    const request = buildRequest(this.#settings, spec, input, body, key);

    // whether an attempt of this call has left the charge of a spend unknown: once it has, a later refusal that
    // the API gives before looking at the key (RATE_LIMITED) cannot make it known again
    let unknown = false;
    /**
     * The error the call stops with: its last outcome, the key, and what the rules say about them.
     * @param {Failure} outcome
     * @param {boolean} sent whether a request left the client
     * @param {number | null} ra the readable Retry-After of the answer, in seconds
     * @param {boolean} retryable
     */
    const stop = (outcome, sent, ra, retryable) => {
      let extra = null;
      try {
        extra = hooks.explain?.(outcome) ?? null;
      } catch {
        // a sentence that cannot be written is left out
      }
      return this.#errorOf(spec, outcome, key, sent, ra, retryable, extra, unknown);
    };
    const aborted = networkFailure("ABORTED", null, MESSAGES.aborted, null);
    if (call.signal?.aborted) throw stop(aborted, false, null, false);

    const deadlineAt = monotonicNow() + call.deadlineMs;
    let failures = 0;
    /** @type {{ outcome: Failure, ra: number | null, retry: boolean } | null} */
    let last = null;
    for (let attempt = 1; ; attempt++) {
      const left = deadlineAt - monotonicNow();
      // a pause can end late on a busy machine: past the deadline, no attempt starts
      if (left <= 0 && last) throw stop(last.outcome, true, last.ra, last.retry);
      const outcome = await this.#attempt(request, Math.min(call.timeoutMs, left), call.signal);
      if (outcome.answer) this.#reportAnswer(spec, outcome.answer, attempt);
      if (outcome.kind === "success") return outcome.body;
      callHook(hooks.onFailure, outcome);

      const ra = outcome.answer ? retryAfterSec(outcome.answer.retryAfter, Date.now()) : null;
      const { retry, consumes } = policyOf(outcome, spec, this.#retryable);
      unknown = unknown || mayHaveSpent(outcome, spec, true, unknown);
      last = { outcome, ra, retry };
      if (!retry) throw stop(outcome, true, ra, retry);
      if (consumes && ++failures > call.maxRetries) throw stop(outcome, true, ra, retry);
      /** @type {number} */
      let delayMs;
      if (ra !== null) {
        if (ra > RETRY_AFTER_MAX_SEC) throw stop(outcome, true, ra, retry);
        delayMs = ra * 1000;
      } else {
        delayMs = backoffMs(attempt, Math.random);
      }
      if (monotonicNow() + delayMs >= deadlineAt) throw stop(outcome, true, ra, retry);
      callHook(this.#settings.onRetry, { operation: spec.id, attempt, code: outcome.code, delayMs });
      if (!(await sleep(delayMs, call.signal))) throw stop(aborted, true, null, false);
    }
  }

  /**
   * @param {OperationSpec} spec
   * @param {SendOptions | undefined} options
   */
  #callOptions(spec, options) {
    if (options !== undefined && !isObject(options)) throw invalid(`The options of ${spec.name} must be an object.`, spec.id);
    const o = /** @type {Record<string, unknown>} */ (options ?? {});
    checkOptionNames(o, CALL_OPTIONS, spec.name, spec.id);
    const { maxRetries, timeoutMs, deadlineMs } = this.#settings;
    if (o.signal !== undefined && !isSignal(o.signal)) throw invalid("signal must be an AbortSignal.", spec.id);
    /** @type {string | null} */
    let idempotencyKey = null;
    if (o.idempotencyKey !== undefined) {
      if (spec.idempotencyKey === "none") throw invalid(`${spec.name} takes no idempotencyKey: the API does not read one for it.`, spec.id);
      if (!isIdempotencyKey(o.idempotencyKey)) throw invalid(MESSAGES.badIdempotencyKey, spec.id);
      idempotencyKey = o.idempotencyKey;
    }
    return {
      idempotencyKey,
      signal: /** @type {AbortSignal | undefined} */ (o.signal),
      maxRetries: o.maxRetries === undefined ? maxRetries : checkNumber("maxRetries", o.maxRetries, "count", spec.id),
      timeoutMs: o.timeoutMs === undefined ? timeoutMs : checkNumber("timeoutMs", o.timeoutMs, "duration", spec.id),
      deadlineMs: o.deadlineMs === undefined ? deadlineMs : checkNumber("deadlineMs", o.deadlineMs, "duration", spec.id),
    };
  }

  /**
   * One attempt: the request, then the whole body, within `timeoutMs`. An answer that arrives at or after
   * that moment is a TIMEOUT.
   *
   * @param {PreparedRequest} request
   * @param {number} timeoutMs
   * @param {AbortSignal | undefined} callerSignal
   * @returns {Promise<Outcome>}
   */
  async #attempt(request, timeoutMs, callerSignal) {
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    const unlink = onAbort(callerSignal, () => controller.abort());
    const startedAt = monotonicNow();
    /** @param {unknown} error */
    const lost = (error) => {
      if (callerSignal?.aborted) return networkFailure("ABORTED", null, MESSAGES.aborted, null);
      if (timedOut) return networkFailure("TIMEOUT", null, TEXTS.timeout(timeoutMs), null);
      return networkFailure("CONNECTION_FAILED", null, connectionText(error), null);
    };
    const late = () => monotonicNow() - startedAt >= timeoutMs;
    const timeout = () => networkFailure("TIMEOUT", null, TEXTS.timeout(timeoutMs), null);
    try {
      /** @type {RequestInit} */
      const init = {
        method: request.method,
        headers: { ...request.headers, Authorization: `Bearer ${this.#settings.apiKey}` },
        // written out, never left to the default: following a redirect would carry the key elsewhere
        redirect: "manual",
        signal: controller.signal,
      };
      if (request.body !== undefined) init.body = request.body;
      const fetching = Promise.resolve().then(() => this.#settings.fetch(request.url, init));
      const sent = await unlessAborted(fetching, controller.signal);
      if (sent === STOPPED || !sent.ok) return lost(sent === STOPPED ? undefined : sent.error);
      const res = sent.value;
      if (late()) {
        discard(res);
        return timeout();
      }
      // a fetch passed in by the caller may follow a redirect whatever `redirect` says: its answer comes from
      // another address, so it is not the API's answer and nothing of it is read, it is never sent again, and
      // a spend may have been charged on the way
      if (res.redirected === true) {
        discard(res);
        return { ...networkFailure("BAD_RESPONSE", null, MESSAGES.redirectFollowed, null), followed: true };
      }
      const answer = answerOf(res);
      if (res.type === "opaqueredirect" || (res.status >= 300 && res.status < 400)) {
        discard(res);
        return networkFailure("BAD_RESPONSE", res.status > 0 ? res.status : null, MESSAGES.redirect, answer);
      }
      const read = await unlessAborted(Promise.resolve().then(() => res.text()), controller.signal);
      if (read === STOPPED || !read.ok) return lost(read === STOPPED ? undefined : read.error);
      if (late()) return timeout();
      return classifyAnswer(answer, read.value);
    } finally {
      clearTimeout(timer);
      unlink();
    }
  }

  /** @param {OperationSpec} spec @param {Answer} answer @param {number} attempt */
  #reportAnswer(spec, answer, attempt) {
    if (!this.#settings.onResponse) return;
    callHook(this.#settings.onResponse, {
      operation: spec.id,
      status: answer.status,
      requestId: answer.requestId === null ? null : this.scrub(answer.requestId),
      attempt,
      replayed: answer.replayed,
      rateLimit: { ...answer.rateLimit },
    });
  }

  /**
   * The error a call stops with: its last outcome, with the key of the call and what the rules say about it.
   * Every text that came from the server is scrubbed of the key first.
   *
   * @param {OperationSpec} spec
   * @param {Failure} outcome
   * @param {string | null} key
   * @param {boolean} sent whether a request left the client
   * @param {number | null} ra the readable Retry-After of the answer, in seconds
   * @param {boolean} retryable
   * @param {string | null} extra a sentence of this SDK that goes after the message
   * @param {boolean} unknownBefore whether an earlier attempt of the call left the charge unknown
   * @returns {GptVideoError}
   */
  #errorOf(spec, outcome, key, sent, ra, retryable, extra, unknownBefore) {
    const spent = mayHaveSpent(outcome, spec, sent, unknownBefore);
    const common = { retryable, operation: spec.id, idempotencyKey: key, mayHaveSpent: spent, retryAfterSec: ra };
    if (outcome.kind === "api") {
      const message = this.scrub(outcome.message);
      const hint = outcome.hint === null ? null : this.scrub(outcome.hint);
      const requestId = outcome.requestId === null ? null : this.scrub(outcome.requestId);
      return new GptVideoApiError(
        formatErrorMessage({ code: outcome.code, status: outcome.status, message, hint, requestId, mayHaveSpent: spent, note: extra }),
        { ...common, code: outcome.code, status: outcome.status, requestId, hint, details: scrubValue(outcome.details, this.#settings.apiKey) },
      );
    }
    return new GptVideoNetworkError(formatErrorMessage({ code: outcome.code, status: outcome.status, message: outcome.text, mayHaveSpent: spent, note: extra }), {
      ...common,
      code: outcome.code,
      status: outcome.status,
    });
  }

  [NODE_INSPECT]() {
    return `Transport { baseUrl: '${this.#settings.baseUrl}', apiKey: '${REDACTED}' }`;
  }

  [DENO_INSPECT]() {
    return this[NODE_INSPECT]();
  }
}
