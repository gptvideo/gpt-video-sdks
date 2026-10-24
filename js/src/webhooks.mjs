// @ts-check
/**
 * `gpt-video/webhooks`: verifying the signature of a GPT-Video webhook, as Standard Webhooks defines it.
 *
 * A delivery carries three headers: `webhook-id`, `webhook-timestamp` (whole seconds since 1970) and
 * `webhook-signature`, a list of `v1,<base64>` separated by spaces. Each `v1` signature is
 * HMAC-SHA256 over the bytes of `<id>.<timestamp>.<body>`, keyed with the bytes of the signing secret
 * (`whsec_` followed by standard base64). A delivery is accepted when its timestamp is within the
 * tolerance of the current time and at least one `v1` signature equals, byte for byte, the one computed
 * with one of the secrets.
 *
 * The rules this file keeps, each one tested in `webhooks.test.mjs` and by `webhooks.generated.json` of the shared vectors:
 * - The body is verified as the bytes that arrived: a string is encoded as UTF-8, bytes are used as they
 *   are and are never decoded. A body that was already parsed into an object is refused, because its
 *   bytes are gone.
 * - Signatures are compared as bytes, in constant time over the 32 bytes of an HMAC-SHA256. A signature
 *   that is not standard base64 (base64url included), or that does not decode to exactly 32 bytes, is no
 *   match. Missing `=` padding is accepted, as the specification's libraries accept it.
 * - Only `v1` counts. `v1a`, `v2` and any other version are skipped, so a sender can add a new scheme
 *   without breaking a receiver, and a receiver never accepts a scheme it does not check.
 * - Every signature is compared with every secret, with no early exit: the time taken can tell which
 *   signature matched, never its bytes.
 * - Only `crypto.subtle`: the module runs in Node, Deno, Bun and Workers, and imports nothing but the errors of
 *   this package.
 */

import { GptVideoError, INVALID_ARGUMENT, MESSAGES, WEBHOOK_VERIFICATION_FAILED, WebhookVerificationError, formatErrorMessage } from "./errors.mjs";

export { WebhookVerificationError } from "./errors.mjs";

/** The prefix of a webhook signing secret. */
const SECRET_PREFIX = "whsec_";

/** The prefix of an API key, which is not a signing secret. */
const API_KEY_PREFIX = "gvk_";

/** How far, in seconds and in both directions, a timestamp may be from the current time: five minutes. */
const DEFAULT_TOLERANCE_SEC = 300;

/** The only signature scheme this SDK checks. */
const SIGNATURE_VERSION = "v1";

const HEADER_ID = "webhook-id";
const HEADER_TIMESTAMP = "webhook-timestamp";
const HEADER_SIGNATURE = "webhook-signature";

/** Standard base64, padding optional. Base64url (`-`, `_`) and whitespace do not match. */
const STANDARD_BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/** The sentences of a refusal. */
const SENTENCES = Object.freeze({
  badSecretEncoding:
    "The webhook signing secret must be whsec_ followed by standard base64, as the console shows it, with no spaces or line breaks. If you read it from a file, remove the line break at the end.",
  noSecret: "Pass the signing secret of the webhook: secret, or secrets during a rotation.",
  secretAndSecrets: "Pass secret or secrets, not both.",
  missingHeader: (/** @type {string} */ name) => `The ${name} header is missing or empty.`,
  ambiguousHeader: (/** @type {string} */ name) => `The ${name} header was sent more than once, with different values.`,
  badTimestamp: "The webhook-timestamp header must be whole seconds since 1970, written with digits only.",
  outsideTolerance: (/** @type {number} */ sec) =>
    `The webhook-timestamp is more than ${sec} seconds away from the current time. Check the clock of this machine; otherwise the message is a replay.`,
  noMatch:
    "No v1 signature in the webhook-signature header matches this body with this secret. Verify the raw body, exactly as it arrived, with the signing secret of this webhook.",
  badTolerance: "toleranceSec must be a finite number of seconds, 0 or more.",
  badNow: "now must be a Date or a number of milliseconds since 1970.",
  notAnObject: "Pass an object: { secret, headers, body }.",
  noWebCrypto: "This runtime has no Web Crypto (globalThis.crypto.subtle), which webhook verification needs.",
});

/**
 * The body as it arrived: the text of the request, or its bytes. A `Buffer` is a `Uint8Array`.
 * @typedef {string | Uint8Array | ArrayBuffer | ArrayBufferView} RawBody
 */

/**
 * The request headers: a Fetch `Headers` (or anything with `get(name)`), or a plain object such as
 * Node's `req.headers`, with names in any case and values that are strings or arrays of strings.
 * @typedef {{ get(name: string): string | null | undefined } | Readonly<Record<string, string | readonly string[] | undefined | null>>} WebhookHeaders
 */

/**
 * @typedef {object} VerifyWebhookInput
 * @property {string} [secret] the signing secret of the webhook, `whsec_…`
 * @property {readonly string[]} [secrets] several signing secrets, during a rotation on your side; any one of them may match
 * @property {WebhookHeaders} headers the request headers
 * @property {RawBody} body the raw request body, before any JSON parsing
 * @property {number} [toleranceSec] how far the timestamp may be from now, in seconds; 300 by default
 * @property {Date | number} [now] the current time, as a Date or milliseconds since 1970; the clock by default
 */

/**
 * What a verified delivery says about itself.
 * @typedef {object} VerifiedWebhook
 * @property {string} id the `webhook-id`: the same for every retry of one message, so it can be used to skip duplicates
 * @property {number} timestamp the `webhook-timestamp` of this attempt, in seconds since 1970
 */

/** @import { WebhookEvent as GeneratedWebhookEvent } from "./types.generated.js" */

/**
 * The event a webhook carries: one of the event types of the API, with when it happened and its data.
 * Generated from the API's catalogue of events.
 * @typedef {GeneratedWebhookEvent} WebhookEvent
 */

/**
 * Verifies a webhook delivery. Resolves with its id and timestamp, or rejects with a
 * `WebhookVerificationError` whose `reason` says why: `missing_headers`, `bad_timestamp`,
 * `timestamp_outside_tolerance`, `no_matching_signature`, `bad_secret`, `body_not_raw`.
 *
 * @param {VerifyWebhookInput} input
 * @returns {Promise<VerifiedWebhook>}
 */
export async function verifyWebhook(input) {
  const options = optionsOf(input);
  return verifyWithKeys(await importKeys(options.secrets), options.headers, options.body, options.toleranceSec, options.nowMs);
}

/**
 * Verifies a webhook delivery, then parses its body as JSON. Rejects like `verifyWebhook`; a verified body
 * that is not JSON rejects with the `SyntaxError` of `JSON.parse`.
 *
 * @param {VerifyWebhookInput} input
 * @returns {Promise<WebhookEvent>}
 */
export async function constructEvent(input) {
  const options = optionsOf(input);
  await verifyWithKeys(await importKeys(options.secrets), options.headers, options.body, options.toleranceSec, options.nowMs);
  return JSON.parse(new TextDecoder().decode(options.body));
}

/**
 * The form of the Standard Webhooks libraries: `new Webhook(secret).verify(body, headers)`. One difference:
 * `verify` returns a Promise, because the SDK uses `crypto.subtle`, which is asynchronous. Write
 * `await wh.verify(body, headers)`.
 */
export class Webhook {
  /** @type {readonly Uint8Array[]} */
  #secrets;
  /** @type {number} */
  #toleranceSec;
  /** @type {Promise<CryptoKey[]> | null} */
  #keys = null;

  /**
   * Checks the secret at once: a wrong secret fails here, not on the first delivery.
   * @param {string | readonly string[]} secret the signing secret, `whsec_…`, or several during a rotation on your side
   * @param {{ toleranceSec?: number }} [options]
   */
  constructor(secret, options = {}) {
    this.#secrets = secretsOf(typeof secret === "string" ? { secret } : { secrets: secret });
    this.#toleranceSec = toleranceOf(options.toleranceSec);
  }

  /**
   * Verifies a delivery against the clock of this machine and returns its event.
   * @param {RawBody} payload the raw request body
   * @param {WebhookHeaders} headers the request headers
   * @returns {Promise<WebhookEvent>}
   */
  async verify(payload, headers) {
    const body = bytesOf(payload);
    this.#keys ??= importKeys(this.#secrets);
    let keys;
    try {
      keys = await this.#keys;
    } catch (err) {
      this.#keys = null;
      throw err;
    }
    await verifyWithKeys(keys, headers, body, this.#toleranceSec, Date.now());
    return JSON.parse(new TextDecoder().decode(body));
  }

  /** The secret never shows in a log line. */
  toJSON() {
    return { secret: "[redacted]" };
  }

  [Symbol.for("nodejs.util.inspect.custom")]() {
    return "Webhook { secret: [redacted] }";
  }
}

// ------------------------------------------------------------------------------------------------------ input

/**
 * @param {unknown} input
 * @returns {{ secrets: readonly Uint8Array[], headers: unknown, body: Uint8Array, toleranceSec: number, nowMs: number }}
 */
function optionsOf(input) {
  if (input === null || typeof input !== "object") throw invalidArgument(SENTENCES.notAnObject);
  const given = /** @type {Record<string, unknown>} */ (input);
  // the secret first: a wrong secret is a mistake in the setup, and it shows on the first delivery whatever it carries
  const secrets = secretsOf(given);
  const body = bytesOf(given.body);
  return { secrets, headers: given.headers, body, toleranceSec: toleranceOf(given.toleranceSec), nowMs: nowOf(given.now) };
}

/**
 * The bytes of each signing secret.
 * @param {Record<string, unknown>} given
 * @returns {readonly Uint8Array[]}
 */
function secretsOf(given) {
  const hasOne = given.secret !== undefined;
  const hasMany = given.secrets !== undefined;
  if (hasOne && hasMany) throw invalidArgument(SENTENCES.secretAndSecrets);
  const list = hasMany ? given.secrets : hasOne ? [given.secret] : [];
  if (!Array.isArray(list) || list.length === 0) throw refused("bad_secret", SENTENCES.noSecret);
  return list.map(secretBytesOf);
}

/**
 * @param {unknown} secret
 * @returns {Uint8Array}
 */
function secretBytesOf(secret) {
  if (typeof secret !== "string" || secret.length === 0) throw refused("bad_secret", SENTENCES.noSecret);
  if (secret.startsWith(API_KEY_PREFIX)) throw refused("bad_secret", MESSAGES.apiKeyAsWebhookSecret);
  if (!secret.startsWith(SECRET_PREFIX)) throw refused("bad_secret", MESSAGES.badWebhookSecret);
  const bytes = fromStandardBase64(secret.slice(SECRET_PREFIX.length));
  if (bytes === null) throw refused("bad_secret", SENTENCES.badSecretEncoding);
  return bytes;
}

/**
 * The bytes of the body, never decoded. Anything that is not text or bytes is a body that was parsed.
 * @param {unknown} body
 * @returns {Uint8Array}
 */
function bytesOf(body) {
  if (typeof body === "string") return new TextEncoder().encode(body);
  if (ArrayBuffer.isView(body)) return new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
  if (Object.prototype.toString.call(body) === "[object ArrayBuffer]") return new Uint8Array(/** @type {ArrayBuffer} */ (body));
  throw refused("body_not_raw", MESSAGES.webhookBodyNotRaw);
}

/**
 * @param {unknown} value
 * @returns {number}
 */
function toleranceOf(value) {
  if (value === undefined) return DEFAULT_TOLERANCE_SEC;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw invalidArgument(SENTENCES.badTolerance);
  return value;
}

/**
 * @param {unknown} value
 * @returns {number}
 */
function nowOf(value) {
  if (value === undefined) return Date.now();
  const ms = value instanceof Date ? value.getTime() : value;
  if (typeof ms !== "number" || !Number.isFinite(ms)) throw invalidArgument(SENTENCES.badNow);
  return ms;
}

// ---------------------------------------------------------------------------------------------------- headers

/**
 * Every value a header has, whatever the case of its name and the form of the headers.
 * @param {unknown} headers
 * @param {string} name lower case
 * @returns {string[]}
 */
function headerValues(headers, name) {
  if (headers === null || typeof headers !== "object") return [];
  const getter = /** @type {{ get?: unknown }} */ (headers).get;
  if (typeof getter === "function") return valuesOf(getter.call(headers, name));
  /** @type {string[]} */
  const out = [];
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === name) out.push(...valuesOf(/** @type {Record<string, unknown>} */ (headers)[key]));
  }
  return out;
}

/**
 * @param {unknown} value
 * @returns {string[]}
 */
function valuesOf(value) {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.filter((v) => typeof v === "string");
  return [];
}

/**
 * The one value of a header that must have one. Missing or empty is `missing_headers`; two different
 * values are refused, because the content to sign would be ambiguous.
 * @param {unknown} headers
 * @param {string} name
 * @param {"missing_headers" | "bad_timestamp"} ambiguousReason
 * @returns {string}
 */
function singleHeader(headers, name, ambiguousReason) {
  const values = [...new Set(headerValues(headers, name).filter((v) => v !== ""))];
  const [value, ...others] = values;
  if (value === undefined) throw refused("missing_headers", SENTENCES.missingHeader(name));
  if (others.length > 0) throw refused(ambiguousReason, SENTENCES.ambiguousHeader(name));
  return value;
}

// --------------------------------------------------------------------------------------------- verification

/**
 * @param {readonly CryptoKey[]} keys
 * @param {unknown} headers
 * @param {Uint8Array} body
 * @param {number} toleranceSec
 * @param {number} nowMs
 * @returns {Promise<VerifiedWebhook>}
 */
async function verifyWithKeys(keys, headers, body, toleranceSec, nowMs) {
  const id = singleHeader(headers, HEADER_ID, "missing_headers");
  const timestampText = singleHeader(headers, HEADER_TIMESTAMP, "bad_timestamp");
  const signatureValues = headerValues(headers, HEADER_SIGNATURE).filter((v) => v !== "");
  if (signatureValues.length === 0) throw refused("missing_headers", SENTENCES.missingHeader(HEADER_SIGNATURE));

  if (!/^[0-9]+$/.test(timestampText)) throw refused("bad_timestamp", SENTENCES.badTimestamp);
  const timestamp = Number(timestampText);
  // Whole seconds on both sides, as the specification's libraries compare them: the sender writes the second
  // it is in, rounded down, so the receiver does the same with its clock. A timestamp of many digits needs no
  // check of its own: it is far outside any sensible tolerance, and whatever passes here still needs a signature.
  const nowSec = Math.floor(nowMs / 1000);
  if (nowSec - timestamp > toleranceSec || timestamp - nowSec > toleranceSec) {
    throw refused("timestamp_outside_tolerance", SENTENCES.outsideTolerance(toleranceSec));
  }

  // the signed content holds the timestamp as a number, as the sender writes it: 0123 is signed as 123
  const content = concat(new TextEncoder().encode(`${id}.${timestamp}.`), body);
  const expected = await Promise.all(keys.map(async (key) => new Uint8Array(await subtle().sign("HMAC", key, content))));

  let matched = 0;
  for (const received of signaturesOf(signatureValues.join(" "))) {
    for (const mac of expected) matched |= equalBytes(received, mac);
  }
  if (matched !== 1) throw refused("no_matching_signature", SENTENCES.noMatch);
  return { id, timestamp };
}

/**
 * The decoded `v1` signatures of a header. Each space-separated entry is split on commas as the
 * specification's libraries split it: the first part is the version, the second the signature. An entry of
 * another version, an empty one, or one whose signature is not standard base64 is skipped; one that decodes to
 * another length than the HMAC is no match in `equalBytes`.
 * @param {string} header
 * @returns {Uint8Array[]}
 */
function signaturesOf(header) {
  const out = [];
  for (const entry of header.split(" ")) {
    const [version, signature] = entry.split(",");
    if (version !== SIGNATURE_VERSION || signature === undefined) continue;
    const bytes = fromStandardBase64(signature);
    if (bytes !== null) out.push(bytes);
  }
  return out;
}

/**
 * 1 when two byte strings are equal, else 0. When the lengths match, the loop always runs over every byte,
 * so the time does not depend on where the first difference is. This length check is the one guard against a
 * signature of 31 or 33 bytes; the lengths themselves are public, since an HMAC-SHA256 is always 32 bytes.
 * @param {Uint8Array} a
 * @param {Uint8Array} b
 * @returns {0 | 1}
 */
function equalBytes(a, b) {
  if (a.length !== b.length) return 0;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= /** @type {number} */ (a[i]) ^ /** @type {number} */ (b[i]);
  return diff === 0 ? 1 : 0;
}

// ---------------------------------------------------------------------------------------------------- helpers

/**
 * Standard base64 to bytes, or null. Padding may be left out; when it is there it must complete the last
 * group. Base64url, whitespace and any other character are refused.
 * @param {string} text
 * @returns {Uint8Array | null}
 */
function fromStandardBase64(text) {
  if (!STANDARD_BASE64.test(text)) return null;
  const core = text.replace(/=+$/, "");
  if (core.length === 0 || core.length % 4 === 1) return null;
  if (core.length !== text.length && text.length % 4 !== 0) return null;
  const binary = atob(core + "=".repeat((4 - (core.length % 4)) % 4));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/**
 * @param {Uint8Array} a
 * @param {Uint8Array} b
 * @returns {Uint8Array<ArrayBuffer>}
 */
function concat(a, b) {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

/** @returns {SubtleCrypto} */
function subtle() {
  const s = globalThis.crypto?.subtle;
  if (!s) throw new Error(SENTENCES.noWebCrypto);
  return s;
}

/**
 * @param {readonly Uint8Array[]} secrets
 * @returns {Promise<CryptoKey[]>}
 */
async function importKeys(secrets) {
  return Promise.all(secrets.map((bytes) => subtle().importKey("raw", Uint8Array.from(bytes), { name: "HMAC", hash: "SHA-256" }, false, ["sign"])));
}

/**
 * @param {(typeof import("./errors.mjs").WEBHOOK_FAILURE_REASONS)[number]} reason
 * @param {string} sentence
 */
function refused(reason, sentence) {
  return new WebhookVerificationError(formatErrorMessage({ code: WEBHOOK_VERIFICATION_FAILED, message: sentence }), { reason });
}

/** @param {string} sentence */
function invalidArgument(sentence) {
  return new GptVideoError(formatErrorMessage({ code: INVALID_ARGUMENT, message: sentence }), { code: INVALID_ARGUMENT });
}
