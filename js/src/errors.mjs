// @ts-check
/**
 * The errors of the GPT-Video SDK: the classes, the codes the SDK adds to the API's own, and the fixed
 * sentences an error can carry. The sentences and the shape of `message` are part of the public contract:
 * people search for them, and the Python SDK says the same words.
 *
 * No error ever holds the API key, in any field. The classes take no `cause`, because the error of a
 * transport (an HTTP helper, a proxy library) can carry the request headers, and with them the key.
 */

/** The codes of a request that never got a readable answer from the API. */
export const NETWORK_ERROR_CODES = /** @type {const} */ (["CONNECTION_FAILED", "TIMEOUT", "ABORTED", "BAD_RESPONSE"]);

/** The codes of a wait (`gv.wait`) that ended without the result the caller asked for. */
export const JOB_ERROR_CODES = /** @type {const} */ (["JOB_FAILED", "JOB_CANCELLED", "WAIT_TIMEOUT"]);

/** The code of a mistake found before anything is sent: a missing or malformed key, a bad option. */
export const INVALID_ARGUMENT = "INVALID_ARGUMENT";

/** The code of every webhook that fails verification; `reason` says why. */
export const WEBHOOK_VERIFICATION_FAILED = "WEBHOOK_VERIFICATION_FAILED";

/** Why a webhook was refused. */
export const WEBHOOK_FAILURE_REASONS = /** @type {const} */ ([
  "missing_headers",
  "bad_timestamp",
  "timestamp_outside_tolerance",
  "no_matching_signature",
  "bad_secret",
  "body_not_raw",
]);

/** Where API keys are created. */
export const CONSOLE_URL = "https://www.gpt-video.com/app/developers";

/** The fixed sentences. Change one and the Python SDK, the README and the tests change with it. */
export const MESSAGES = Object.freeze({
  /** no `apiKey` option and no GPT_VIDEO_API_KEY in the environment */
  missingApiKey: `Set GPT_VIDEO_API_KEY or pass apiKey. Create a key at ${CONSOLE_URL}.`,
  /** a key that does not start with gvk_ (the key itself is never repeated) */
  badApiKeyPrefix: `This is not a GPT-Video API key: API keys start with gvk_. Create one at ${CONSOLE_URL}.`,
  /** a webhook secret that does not start with whsec_ */
  badWebhookSecret: "The webhook signing secret must start with whsec_. Copy it from the webhook in the console.",
  /** an API key passed where the webhook secret goes */
  apiKeyAsWebhookSecret: "This is an API key (gvk_), not a webhook signing secret. The signing secret starts with whsec_.",
  /** a body that was already parsed into an object before verification */
  webhookBodyNotRaw: "Verify the raw request body (a string or bytes), exactly as it arrived, before parsing it as JSON.",
  /** an Idempotency-Key from the caller that the API would refuse */
  badIdempotencyKey: "idempotencyKey must be 1 to 255 visible ASCII characters, with no spaces.",
  /** a response whose body is not JSON: the status is said, the body never is */
  notJson: "The response is not JSON.",
  /** a 3xx: following it would send the API key to another address */
  redirect: "The API answered with a redirect, which the SDK does not follow because it would send your API key to another address. Check baseUrl.",
  /** a fetch passed in by the caller followed a redirect although the SDK asked it not to */
  redirectFollowed:
    "The fetch you passed in followed a redirect to another address, so the answer is not the API's and was not read. The request may have reached that address with your API key. Check baseUrl, and pass a fetch that does not follow redirects.",
  /** appended to the message of a spend whose outcome is unknown */
  mayHaveSpent: "The request may have been charged. Call again with the same idempotencyKey to get its answer without paying twice.",
  /** an http:// baseUrl that is not this machine */
  insecureBaseUrl: "baseUrl must start with https://. http:// is accepted only for an address on this machine, such as localhost.",
  /** the SDK constructed in a web page without the explicit flag */
  browser:
    "The GPT-Video SDK is running in a web page, where anyone who opens the page can read the API key. Call the API from your server. If the key is meant to be public, pass dangerouslyAllowBrowser: true.",
  /** Python only: an ssl.SSLCertVerificationError */
  pythonTls: "Python cannot verify TLS certificates on this machine; on macOS run Install Certificates.command.",
  /** a key with a space, a line break or another byte that cannot travel in a header (the key is never repeated) */
  badApiKeyCharacters: `The API key has a space, a line break or another character that cannot be sent in a header. Copy it again from ${CONSOLE_URL}.`,
  /** no fetch option and no global fetch */
  noFetch: "This runtime has no fetch function. Use Node.js 20.19 or later, or pass fetch.",
  /** no crypto.getRandomValues: an Idempotency-Key is never made from Math.random */
  noCrypto: "This runtime has no crypto.getRandomValues, which the SDK needs to make an Idempotency-Key.",
  /** CONNECTION_FAILED */
  connectionFailed: "The connection to the API failed.",
  /** ABORTED: the caller's signal */
  aborted: "The call was aborted.",
  /** BAD_RESPONSE: JSON that is not the API's error body */
  notApiError: "The response is not an error from the GPT-Video API.",
  /** an API error body whose message is missing */
  noServerMessage: "The API sent no message.",
  /** BAD_RESPONSE from paginate: a cursor seen before */
  repeatedCursor: "The API sent a cursor it had sent before, so the list would never end.",
  /** BAD_RESPONSE from paginate: hasMore without a cursor */
  missingCursor: "The API said there are more items and sent no nextCursor.",
  /** BAD_RESPONSE from paginate: not { data, hasMore, nextCursor } */
  notAPage: "The answer is not a page of a list.",
  /** appended to a create_upload refused because uploads are turned off */
  uploadElsewhere:
    "Upload the video in the GPT-Video app instead: it then shows in listAssets, and its id is the sourceAssetId of createProject.",
  /** a download that answered with an error status */
  downloadFailed: "The download failed.",
  /** a download refused by the server of the file: the link expired or is wrong */
  downloadRefused: "The download link was refused. A link expires after a while: read the export again for a new one.",
  /** a download redirected to an address that is not https */
  downloadInsecure: "The download was redirected to an address that is not https, so it was stopped.",
});

/**
 * A duration as the messages say it: whole minutes from two minutes up, seconds below or in between.
 *
 * @param {number} ms
 * @returns {string}
 */
export function durationText(ms) {
  if (ms >= 120_000 && ms % 60_000 === 0) return `${ms / 60_000} minutes`;
  const seconds = Math.round(ms / 100) / 10;
  return `${seconds} ${seconds === 1 ? "second" : "seconds"}`;
}

/**
 * The sentences that carry a value. Like MESSAGES, the Python SDK says the same words.
 */
export const TEXTS = Object.freeze({
  /** TIMEOUT: the attempt ran out of time */
  timeout: (/** @type {number} */ ms) => `No answer within ${durationText(ms)}.`,
  /** CONNECTION_FAILED with the system error code (ECONNREFUSED, ENOTFOUND...) */
  connectionFailed: (/** @type {string} */ code) => `The connection to the API failed (${code}).`,
  /** JOB_FAILED */
  jobFailed: (/** @type {string} */ id) => `${id} failed.`,
  /** JOB_CANCELLED */
  jobCancelled: (/** @type {string} */ id) => `${id} was cancelled.`,
  /** WAIT_TIMEOUT; status is null when no read came back before the end */
  waitTimeout: (/** @type {string} */ id, /** @type {string | null} */ status, /** @type {number} */ ms) =>
    `${id} did not finish within ${durationText(ms)}.${status ? ` Its last status is ${status}.` : ""}`,
  /** BAD_RESPONSE from a wait: the read did not carry the object it follows */
  missingHandle: (/** @type {string} */ field) => `The answer has no ${field} object.`,
  /** BAD_RESPONSE from uploadFile: the parts the API asks for do not cover the file */
  partsMismatch: (/** @type {number} */ sizeBytes, /** @type {number} */ partSizeBytes, /** @type {number} */ partCount) =>
    `The API split a file of ${sizeBytes} bytes into ${partCount} parts of ${partSizeBytes} bytes, which does not cover it.`,
});

/** The longest server-provided text (message or hint) an error repeats. */
export const SERVER_TEXT_MAX = 1000;

/** @param {string} text */
function clip(text) {
  return text.length > SERVER_TEXT_MAX ? `${text.slice(0, SERVER_TEXT_MAX - 1)}…` : text;
}

/**
 * The one shape of `message`: `<CODE> (<status>): <message> Hint: <hint> [request <requestId>]`, then the
 * sentence about a possible charge when the outcome of a spend is unknown, then `note`, a sentence of this
 * SDK about what the caller can do instead. A part with no value is left out, with its label. The server's
 * texts are cut at SERVER_TEXT_MAX; the SDK's own sentences never are.
 *
 * @param {{ code: string, status?: number | null, message: string, hint?: string | null, requestId?: string | null, mayHaveSpent?: boolean, note?: string | null }} parts
 * @returns {string}
 */
export function formatErrorMessage(parts) {
  const status = typeof parts.status === "number" ? ` (${parts.status})` : "";
  let text = `${parts.code}${status}: ${clip(parts.message)}`;
  if (parts.hint) text += ` Hint: ${clip(parts.hint)}`;
  if (parts.requestId) text += ` [request ${clip(parts.requestId)}]`;
  if (parts.mayHaveSpent) text += ` ${MESSAGES.mayHaveSpent}`;
  if (parts.note) text += ` ${parts.note}`;
  return text;
}

/**
 * @typedef {object} GptVideoErrorFields
 * @property {string} code the API's code, or one of the SDK's (NETWORK_ERROR_CODES, JOB_ERROR_CODES, INVALID_ARGUMENT, WEBHOOK_VERIFICATION_FAILED)
 * @property {boolean} [retryable] whether sending the same call again, with the same idempotencyKey, can succeed
 * @property {string | null} [operation] the operation id, `analyze_project`
 * @property {string | null} [idempotencyKey] the Idempotency-Key of the call, to send again after a crash
 * @property {boolean} [mayHaveSpent] true when a spend ended without a clear answer
 */

/** The base of every error the SDK throws. */
export class GptVideoError extends Error {
  /**
   * @param {string} message
   * @param {GptVideoErrorFields} fields
   */
  constructor(message, fields) {
    super(message);
    this.name = "GptVideoError";
    /** @type {string} */
    this.code = fields.code;
    /** @type {boolean} */
    this.retryable = fields.retryable ?? false;
    /** @type {string | null} */
    this.operation = fields.operation ?? null;
    /** @type {string | null} */
    this.idempotencyKey = fields.idempotencyKey ?? null;
    /** @type {boolean} */
    this.mayHaveSpent = fields.mayHaveSpent ?? false;
  }
}

/**
 * @typedef {GptVideoErrorFields & {
 *   status: number,
 *   requestId?: string | null,
 *   hint?: string | null,
 *   details?: unknown,
 *   retryAfterSec?: number | null,
 * }} GptVideoApiErrorFields
 */

/** An error the API answered with its JSON error body. */
export class GptVideoApiError extends GptVideoError {
  /**
   * @param {string} message
   * @param {GptVideoApiErrorFields} fields
   */
  constructor(message, fields) {
    super(message, fields);
    this.name = "GptVideoApiError";
    /** @type {number} */
    this.status = fields.status;
    /** @type {string | null} */
    this.requestId = fields.requestId ?? null;
    /** @type {string | null} */
    this.hint = fields.hint ?? null;
    /** @type {unknown} */
    this.details = fields.details ?? null;
    /** @type {number | null} */
    this.retryAfterSec = fields.retryAfterSec ?? null;
  }
}

/**
 * @typedef {GptVideoErrorFields & {
 *   code: (typeof NETWORK_ERROR_CODES)[number],
 *   status?: number | null,
 *   retryAfterSec?: number | null,
 * }} GptVideoNetworkErrorFields
 */

/**
 * A request with no readable answer: the connection failed, the attempt timed out, the caller aborted, or
 * something that is not the API answered (`BAD_RESPONSE`, with the HTTP status when there was one).
 */
export class GptVideoNetworkError extends GptVideoError {
  /**
   * @param {string} message
   * @param {GptVideoNetworkErrorFields} fields
   */
  constructor(message, fields) {
    super(message, fields);
    this.name = "GptVideoNetworkError";
    /** @type {number | null} */
    this.status = fields.status ?? null;
    /** @type {number | null} */
    this.retryAfterSec = fields.retryAfterSec ?? null;
  }
}

/**
 * @typedef {GptVideoErrorFields & {
 *   code: (typeof JOB_ERROR_CODES)[number],
 *   handle: unknown,
 *   errorMessage?: string | null,
 * }} GptVideoJobErrorFields
 */

/** A wait that ended without success: the work failed or was cancelled, or the wait ran out of time. */
export class GptVideoJobError extends GptVideoError {
  /**
   * @param {string} message
   * @param {GptVideoJobErrorFields} fields
   */
  constructor(message, fields) {
    super(message, fields);
    this.name = "GptVideoJobError";
    /** @type {unknown} the last object read: the job, export, tool run or turn */
    this.handle = fields.handle;
    /** @type {string | null} */
    this.errorMessage = fields.errorMessage ?? null;
  }
}

/** A webhook that failed verification, or a verification called the wrong way. */
export class WebhookVerificationError extends GptVideoError {
  /**
   * @param {string} message
   * @param {{ reason: (typeof WEBHOOK_FAILURE_REASONS)[number] }} fields
   */
  constructor(message, fields) {
    super(message, { code: WEBHOOK_VERIFICATION_FAILED });
    this.name = "WebhookVerificationError";
    /** @type {(typeof WEBHOOK_FAILURE_REASONS)[number]} */
    this.reason = fields.reason;
  }
}
