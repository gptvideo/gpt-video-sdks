// @ts-check
/**
 * Downloading the file behind a signed link: the downloadUrl of an export or of a tool run. The link is its
 * own credential, so the request never carries the API key. That is a rule of this function, not of the
 * address: it holds even when the link points at the host of the API. Only https:// links are opened, and
 * http:// to this machine for development. The runtime follows the redirects of a download, which carries no
 * key, and an answer that a redirect brought from any other kind of address is refused, its body unread.
 *
 * The answer comes back as a Response once its headers arrive in time: the body is the caller's to read, and
 * the caller's signal still stops it. Failures before the headers are retried like a read of the API: a
 * connection that failed, an attempt that timed out, a 5xx or a 429, with Retry-After or a backoff.
 */

import { GptVideoNetworkError, MESSAGES, TEXTS, formatErrorMessage } from "./errors.mjs";
import { RETRY_AFTER_MAX_SEC, backoffMs, retryAfterSec } from "./retry.mjs";
import {
  STOPPED,
  checkNumber,
  checkOptionNames,
  discard,
  invalid,
  isObject,
  isSafeAddress,
  isSignal,
  monotonicNow,
  onAbort,
  sleep,
  unlessAborted,
} from "./transport.mjs";

/** @typedef {import("./transport.mjs").Transport} Transport */

/** The name a download goes by in onRetry and in its errors, where an API call has its operation id. */
export const DOWNLOAD = "download";

/** The options of a download. */
export const DOWNLOAD_OPTIONS = Object.freeze(["signal", "timeoutMs", "deadlineMs", "maxRetries"]);

/** The statuses that mean the link itself was refused: expired, wrong, or for another file. */
const REFUSED = new Set([401, 403, 404, 410]);

/**
 * The options of a download.
 * @typedef {object} DownloadOptions
 * @property {AbortSignal} [signal] stops the download, its body included
 * @property {number} [timeoutMs] the time one attempt has to receive the headers
 * @property {number} [deadlineMs] the time all attempts have to receive the headers, pauses included
 * @property {number} [maxRetries] failures retried after the first attempt
 */

/**
 * @typedef {{ code: "CONNECTION_FAILED" | "TIMEOUT" | "ABORTED" | "BAD_RESPONSE", status: number | null, text: string, retry: boolean, retryAfter: string | null }} DownloadFailure
 */

/**
 * @param {{ transport: Transport }} ctx
 * @param {unknown} url
 * @param {DownloadOptions} [options]
 * @returns {Promise<Response>}
 */
export async function download(ctx, url, options) {
  if (typeof url !== "string" && !(url instanceof URL)) throw invalid("download takes a link, such as the downloadUrl of an export.");
  /** @type {URL} */
  let target;
  try {
    target = new URL(String(url));
  } catch {
    throw invalid("download takes an absolute link, such as the downloadUrl of an export.");
  }
  if (!isSafeAddress(target)) throw invalid("download takes an https:// link. http:// is accepted only for an address on this machine.");
  if (target.username || target.password) throw invalid("A download link must not hold a user name or a password.");

  if (options !== undefined && !isObject(options)) throw invalid("The options of download must be an object.");
  const o = /** @type {Record<string, unknown>} */ (options ?? {});
  checkOptionNames(o, DOWNLOAD_OPTIONS, DOWNLOAD);
  if (o.signal !== undefined && !isSignal(o.signal)) throw invalid("signal must be an AbortSignal.");
  const signal = /** @type {AbortSignal | undefined} */ (o.signal);
  const defaults = ctx.transport.defaults;
  const maxRetries = o.maxRetries === undefined ? defaults.maxRetries : checkNumber("maxRetries", o.maxRetries, "count");
  const timeoutMs = o.timeoutMs === undefined ? defaults.timeoutMs : checkNumber("timeoutMs", o.timeoutMs, "duration");
  const deadlineMs = o.deadlineMs === undefined ? defaults.deadlineMs : checkNumber("deadlineMs", o.deadlineMs, "duration");

  // no Authorization, ever: the signed link is the credential
  /** @type {Record<string, string>} */
  const headers = {};
  if (ctx.transport.userAgent) headers["User-Agent"] = ctx.transport.userAgent;

  const aborted = () => failureError({ code: "ABORTED", status: null, text: MESSAGES.aborted, retry: false, retryAfter: null }, null);
  if (signal?.aborted) throw aborted();
  const deadlineAt = monotonicNow() + deadlineMs;
  let failures = 0;
  /** @type {{ failure: DownloadFailure, ra: number | null } | null} */
  let last = null;
  for (let attempt = 1; ; attempt++) {
    const left = deadlineAt - monotonicNow();
    if (left <= 0 && last) throw failureError(last.failure, last.ra);
    const result = await attemptDownload(ctx.transport.fetch, target.href, headers, Math.min(timeoutMs, left), signal);
    if ("response" in result) return result.response;
    const failure = result.failure;
    const ra = retryAfterSec(failure.retryAfter, Date.now());
    last = { failure, ra };
    if (!failure.retry || ++failures > maxRetries) throw failureError(failure, ra);
    /** @type {number} */
    let delayMs;
    if (ra !== null) {
      if (ra > RETRY_AFTER_MAX_SEC) throw failureError(failure, ra);
      delayMs = ra * 1000;
    } else {
      delayMs = backoffMs(attempt, Math.random);
    }
    if (monotonicNow() + delayMs >= deadlineAt) throw failureError(failure, ra);
    ctx.transport.reportRetry({ operation: DOWNLOAD, attempt, code: failure.code, delayMs });
    if (!(await sleep(delayMs, signal))) throw aborted();
  }
}

/**
 * One attempt, until the headers arrive. A response handed over keeps the caller's signal on its body.
 *
 * @param {(input: string, init: RequestInit) => Promise<Response>} fetch
 * @param {string} href
 * @param {Record<string, string>} headers
 * @param {number} timeoutMs
 * @param {AbortSignal | undefined} signal
 * @returns {Promise<{ response: Response } | { failure: DownloadFailure }>}
 */
async function attemptDownload(fetch, href, headers, timeoutMs, signal) {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const unlink = onAbort(signal, () => controller.abort());
  const startedAt = monotonicNow();
  let handedOver = false;
  /** @param {DownloadFailure["code"]} code @param {number | null} status @param {string} text @param {boolean} retry @param {string | null} [retryAfter] */
  const fail = (code, status, text, retry, retryAfter = null) => ({ failure: { code, status, text, retry, retryAfter } });
  try {
    const sent = await unlessAborted(
      Promise.resolve().then(() => fetch(href, { method: "GET", headers, redirect: "follow", signal: controller.signal })),
      controller.signal,
    );
    if (sent === STOPPED || !sent.ok) {
      if (signal?.aborted) return fail("ABORTED", null, MESSAGES.aborted, false);
      if (timedOut) return fail("TIMEOUT", null, TEXTS.timeout(timeoutMs), true);
      return fail("CONNECTION_FAILED", null, MESSAGES.connectionFailed, true);
    }
    const res = sent.value;
    if (monotonicNow() - startedAt >= timeoutMs) {
      discard(res);
      return fail("TIMEOUT", null, TEXTS.timeout(timeoutMs), true);
    }
    // fetch follows the redirects of a download, which carries no key; where it landed must be https://, or
    // this machine, like the link itself, and an address that cannot be read is not a safe one
    if (res.redirected === true) {
      /** @type {URL | null} */
      let landed = null;
      try {
        landed = new URL(res.url);
      } catch {
        // stays null
      }
      if (!landed || !isSafeAddress(landed)) {
        discard(res);
        return fail("BAD_RESPONSE", res.status, MESSAGES.downloadInsecure, false);
      }
    }
    if (res.status >= 200 && res.status < 300) {
      handedOver = true;
      return { response: res };
    }
    discard(res);
    const retryAfter = headerOf(res, "Retry-After");
    const text = REFUSED.has(res.status) ? MESSAGES.downloadRefused : MESSAGES.downloadFailed;
    return fail("BAD_RESPONSE", res.status, text, res.status >= 500 || res.status === 429, retryAfter);
  } finally {
    clearTimeout(timer);
    // a body handed over is still the caller's to stop
    if (!handedOver) unlink();
  }
}

/** @param {Response} res @param {string} name */
function headerOf(res, name) {
  try {
    return res.headers.get(name);
  } catch {
    return null;
  }
}

/** @param {DownloadFailure} failure @param {number | null} ra */
function failureError(failure, ra) {
  return new GptVideoNetworkError(formatErrorMessage({ code: failure.code, status: failure.status, message: failure.text }), {
    code: failure.code,
    status: failure.status,
    retryAfterSec: failure.code === "BAD_RESPONSE" ? ra : null,
    retryable: failure.retry,
    operation: DOWNLOAD,
  });
}
