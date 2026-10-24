/**
 * The signature of a GPT-Video webhook, checked as Standard Webhooks defines it and as the JavaScript and Python
 * SDKs check it: every case of webhooks.generated.json in the shared SDK vectors gives the same answer here.
 *
 * - The body is the bytes that arrived, never decoded and encoded again.
 * - Every `v1,<base64>` entry of webhook-signature is compared, as bytes and in constant time over the 32 bytes of
 *   an HMAC-SHA256, with the HMAC of `<id>.<timestamp>.<body>` keyed with the secret, with no early exit. A
 *   signature that is not standard base64 (base64url included), or that does not decode to 32 bytes, is no match.
 * - Only `v1` counts; `v1a`, `v2` and every other scheme are skipped.
 * - The timestamp is whole seconds since 1970, digits only, within the tolerance of the current time.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

export const SECRET_PREFIX = 'whsec_';
const API_KEY_PREFIX = 'gvk_';

/** How far, in seconds and in both directions, a timestamp may be from the current time. */
export const DEFAULT_TOLERANCE_SEC = 300;

const STANDARD_BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

export type FailureReason = 'missing_headers' | 'bad_timestamp' | 'timestamp_outside_tolerance' | 'no_matching_signature' | 'bad_secret' | 'body_not_raw';

export type Verified = { readonly ok: true; readonly id: string; readonly timestamp: number };
export type Refused = { readonly ok: false; readonly reason: FailureReason; readonly message: string };

const SENTENCES = Object.freeze({
	badSecret: 'The webhook signing secret must start with whsec_. Copy it from the webhook on the Developers page of the GPT-Video app.',
	apiKeyAsSecret: 'This is an API key (gvk_), not a webhook signing secret. The signing secret starts with whsec_.',
	badSecretEncoding: 'The webhook signing secret must be whsec_ followed by standard base64, with no spaces or line breaks.',
	noSecret: 'The credential has no signing secret.',
	bodyNotRaw: 'The request body did not arrive as bytes, so its signature cannot be checked.',
	missingHeader: (name: string) => `The ${name} header is missing or empty.`,
	ambiguousHeader: (name: string) => `The ${name} header was sent more than once, with different values.`,
	badTimestamp: 'The webhook-timestamp header must be whole seconds since 1970, written with digits only.',
	outsideTolerance: (sec: number) => `The webhook-timestamp is more than ${sec} seconds away from the current time. Check the clock of the n8n server; otherwise the message is a replay.`,
	noMatch: 'No signature of the webhook matches its signing secret.',
});

function refused(reason: FailureReason, message: string): Refused {
	return { ok: false, reason, message };
}

/** Standard base64 to bytes, or null. Padding may be left out; base64url, spaces and other characters are refused. */
export function fromStandardBase64(text: string): Uint8Array | null {
	if (!STANDARD_BASE64.test(text)) return null;
	const core = text.replace(/=+$/, '');
	if (core.length === 0 || core.length % 4 === 1) return null;
	if (core.length !== text.length && text.length % 4 !== 0) return null;
	const padded = core + '='.repeat((4 - (core.length % 4)) % 4);
	return new Uint8Array(Buffer.from(padded, 'base64'));
}

/** The bytes of a signing secret, or why it cannot be one. */
export function secretBytes(secret: unknown): Uint8Array | Refused {
	if (typeof secret !== 'string' || secret.length === 0) return refused('bad_secret', SENTENCES.noSecret);
	if (secret.startsWith(API_KEY_PREFIX)) return refused('bad_secret', SENTENCES.apiKeyAsSecret);
	if (!secret.startsWith(SECRET_PREFIX)) return refused('bad_secret', SENTENCES.badSecret);
	const bytes = fromStandardBase64(secret.slice(SECRET_PREFIX.length));
	return bytes === null ? refused('bad_secret', SENTENCES.badSecretEncoding) : bytes;
}

type Headers = Readonly<Record<string, unknown>>;

/** Every value of a header, whatever the case of its name, a list of values included. */
function headerValues(headers: Headers, name: string): string[] {
	const out: string[] = [];
	for (const key of Object.keys(headers)) {
		if (key.toLowerCase() !== name) continue;
		const value = headers[key];
		if (typeof value === 'string') out.push(value);
		else if (Array.isArray(value)) out.push(...value.filter((v): v is string => typeof v === 'string'));
	}
	return out;
}

function singleHeader(headers: Headers, name: string, ambiguous: FailureReason): string | Refused {
	const values = [...new Set(headerValues(headers, name).filter((v) => v !== ''))];
	if (values.length === 0) return refused('missing_headers', SENTENCES.missingHeader(name));
	if (values.length > 1) return refused(ambiguous, SENTENCES.ambiguousHeader(name));
	return values[0]!;
}

/** The decoded `v1` signatures of a header; an entry of another scheme, or not standard base64, is skipped. */
function signaturesOf(header: string): Uint8Array[] {
	const out: Uint8Array[] = [];
	for (const entry of header.split(' ')) {
		const [version, signature] = entry.split(',');
		if (version !== 'v1' || signature === undefined) continue;
		const bytes = fromStandardBase64(signature);
		if (bytes !== null) out.push(bytes);
	}
	return out;
}

/** 1 when two byte strings are equal, in a time that does not depend on where they differ; 0 otherwise. */
function equalBytes(a: Uint8Array, b: Uint8Array): 0 | 1 {
	// the lengths are public: an HMAC-SHA256 is always 32 bytes
	if (a.byteLength !== b.byteLength) return 0;
	return timingSafeEqual(a, b) ? 1 : 0;
}

function isBytes(body: unknown): body is Uint8Array {
	return body instanceof Uint8Array;
}

/**
 * Checks one delivery. `body` is the raw body as bytes or text; anything else is a body that was parsed, and is
 * refused. `nowMs` is the current time.
 */
export function verifySignature(input: {
	readonly secrets: readonly unknown[];
	readonly headers: Headers;
	readonly body: unknown;
	readonly nowMs: number;
	readonly toleranceSec?: number;
}): Verified | Refused {
	// the secret first: a wrong secret is a mistake in the setup, whatever the delivery carries
	if (input.secrets.length === 0) return refused('bad_secret', SENTENCES.noSecret);
	const keys: Uint8Array[] = [];
	for (const secret of input.secrets) {
		const bytes = secretBytes(secret);
		if (!(bytes instanceof Uint8Array)) return bytes;
		keys.push(bytes);
	}
	let body: Uint8Array;
	if (typeof input.body === 'string') body = new TextEncoder().encode(input.body);
	else if (isBytes(input.body)) body = input.body;
	else if (input.body instanceof ArrayBuffer) body = new Uint8Array(input.body);
	else return refused('body_not_raw', SENTENCES.bodyNotRaw);

	const id = singleHeader(input.headers, 'webhook-id', 'missing_headers');
	if (typeof id !== 'string') return id;
	const timestampText = singleHeader(input.headers, 'webhook-timestamp', 'bad_timestamp');
	if (typeof timestampText !== 'string') return timestampText;
	const signatureValues = headerValues(input.headers, 'webhook-signature').filter((v) => v !== '');
	if (signatureValues.length === 0) return refused('missing_headers', SENTENCES.missingHeader('webhook-signature'));

	if (!/^[0-9]+$/.test(timestampText)) return refused('bad_timestamp', SENTENCES.badTimestamp);
	const timestamp = Number(timestampText);
	const tolerance = input.toleranceSec ?? DEFAULT_TOLERANCE_SEC;
	const nowSec = Math.floor(input.nowMs / 1000);
	if (nowSec - timestamp > tolerance || timestamp - nowSec > tolerance) return refused('timestamp_outside_tolerance', SENTENCES.outsideTolerance(tolerance));

	// the signed content holds the timestamp as a number, as the sender writes it: 0123 is signed as 123
	const expected = keys.map((key) =>
		new Uint8Array(createHmac('sha256', key).update(`${id}.${timestamp}.`).update(body).digest()),
	);
	let matched = 0;
	for (const received of signaturesOf(signatureValues.join(' '))) {
		for (const mac of expected) matched |= equalBytes(received, mac);
	}
	if (matched !== 1) return refused('no_matching_signature', SENTENCES.noMatch);
	return { ok: true, id, timestamp };
}
