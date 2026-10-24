/**
 * Downloading the file behind a signed link, the downloadUrl of an export. The link is its own credential, so
 * the request never carries the API key: that is a rule of this function, not of the address, and it holds even
 * when the link points at the host of the API. Only https:// links are opened (http:// only to this machine).
 * Redirects are followed by this function, one hop at a time, and a hop to any other kind of address stops the
 * download before anything is sent there.
 *
 * Failures before the headers arrive are retried like a read of the API: a connection that failed, an attempt
 * that timed out, a 5xx or a 429, with Retry-After or a backoff. The body is the caller's to read.
 */

import { GptVideoCallError, MESSAGES, TEXTS, formatMessage } from './errors.ts';
import { type Io, anySignal, whenAborted } from './io.ts';
import { isSafeAddress } from './request.ts';
import { DEFAULTS, RETRY_AFTER_MAX_SEC, backoffMs, retryAfterSec } from './rules.ts';

/** The name a download goes by in its errors and pauses, where an API call has its operation id. */
export const DOWNLOAD = 'download';

/** The most redirects a download follows. */
export const MAX_REDIRECTS = 5;

/** The statuses that mean the link itself was refused: expired, wrong, or for another file. */
const REFUSED = new Set([401, 403, 404, 410]);

/** The answer of one request of a download, once its headers arrived. `body` is the stream of the file. */
export type DownloadAnswer = {
	readonly status: number;
	/** header names in lower case */
	readonly headers: Readonly<Record<string, string | readonly string[] | undefined>>;
	readonly body: unknown;
	/** lets go of a body nobody reads */
	readonly discard: () => void;
};

/** Sends one request without credentials and without following redirects. */
export type DownloadIo = {
	readonly get: (url: string, signal: AbortSignal) => Promise<DownloadAnswer | { readonly failed: true; readonly systemCode: string | null }>;
};

function header(answer: DownloadAnswer, name: string): string | null {
	const value = answer.headers[name];
	if (Array.isArray(value)) return typeof value[0] === 'string' ? value[0] : null;
	return typeof value === 'string' ? value : null;
}

function failure(code: 'CONNECTION_FAILED' | 'TIMEOUT' | 'ABORTED' | 'BAD_RESPONSE', status: number | null, text: string, retryAfterSec: number | null = null) {
	return new GptVideoCallError({
		kind: 'network',
		code,
		status,
		message: formatMessage({ code, status, message: text }),
		hint: null,
		requestId: null,
		details: null,
		retryable: false,
		mayHaveSpent: false,
		idempotencyKey: null,
		retryAfterSec,
		operation: DOWNLOAD,
	});
}

/** The address a link leads to, checked: an absolute https:// URL (http:// only to this machine). */
function checked(raw: string, base: string | undefined, insecureText: string): string {
	let url: URL;
	try {
		url = base === undefined ? new URL(raw) : new URL(raw, base);
	} catch {
		return stop(failure('BAD_RESPONSE', null, 'The download link is not an absolute URL.'));
	}
	if (!isSafeAddress(url)) return stop(failure('BAD_RESPONSE', null, insecureText));
	return url.href;
}

function stop(error: GptVideoCallError): never {
	throw error;
}

/**
 * The answer of a download whose status is 2xx, after the redirects. Each request has `timeoutMs` to receive
 * its headers, and the whole download `deadlineMs`, pauses included.
 */
export async function download(io: Io, http: DownloadIo, link: string): Promise<DownloadAnswer> {
	const deadlineAt = io.now() + DEFAULTS.deadlineMs;
	let url = checked(link, undefined, 'The download link must start with https://.');
	let redirects = 0;
	let failures = 0;
	for (let attempt = 1; ; attempt++) {
		const left = deadlineAt - io.now();
		if (left <= 0) throw failure('TIMEOUT', null, TEXTS.timeout(DEFAULTS.deadlineMs));
		const timeoutMs = Math.min(DEFAULTS.timeoutMs, left);
		// the timeout of the attempt stops a request that has no headers yet, and never a body already arriving:
		// the body belongs to the caller, and only the execution's own signal stops it
		const attemptController = new AbortController();
		let answered = false;
		io.timeoutSignal(timeoutMs).addEventListener(
			'abort',
			() => {
				if (!answered) attemptController.abort();
			},
			{ once: true },
		);
		const signal = anySignal([attemptController.signal, io.cancel]);
		const startedAt = io.now();
		const result = await Promise.race([http.get(url, signal), whenAborted(signal).then(() => 'stopped' as const)]);
		answered = true;
		let retry: { code: 'CONNECTION_FAILED' | 'TIMEOUT' | 'BAD_RESPONSE'; status: number | null; text: string; retryAfter: string | null } | null = null;
		if (result === 'stopped' || io.now() - startedAt >= timeoutMs) {
			if (result !== 'stopped' && !('failed' in result)) result.discard();
			if (io.cancel?.aborted) throw failure('ABORTED', null, MESSAGES.aborted);
			retry = { code: 'TIMEOUT', status: null, text: TEXTS.timeout(timeoutMs), retryAfter: null };
		} else if ('failed' in result) {
			if (io.cancel?.aborted) throw failure('ABORTED', null, MESSAGES.aborted);
			retry = { code: 'CONNECTION_FAILED', status: null, text: result.systemCode ? TEXTS.connectionFailed(result.systemCode) : MESSAGES.connectionFailed, retryAfter: null };
		} else if (result.status >= 300 && result.status < 400) {
			result.discard();
			const location = header(result, 'location');
			if (location === null) throw failure('BAD_RESPONSE', result.status, MESSAGES.downloadFailed);
			if (++redirects > MAX_REDIRECTS) throw failure('BAD_RESPONSE', result.status, MESSAGES.downloadTooManyRedirects);
			url = checked(location, url, MESSAGES.downloadInsecure);
			attempt = 0;
			continue;
		} else if (result.status >= 200 && result.status < 300) {
			return result;
		} else {
			result.discard();
			if (REFUSED.has(result.status)) throw failure('BAD_RESPONSE', result.status, MESSAGES.downloadRefused);
			if (result.status !== 429 && result.status < 500) throw failure('BAD_RESPONSE', result.status, MESSAGES.downloadFailed);
			retry = { code: 'BAD_RESPONSE', status: result.status, text: MESSAGES.downloadFailed, retryAfter: header(result, 'retry-after') };
		}
		const ra = retryAfterSec(retry.retryAfter, io.wallNow());
		if (++failures > DEFAULTS.maxRetries) throw failure(retry.code, retry.status, retry.text, ra);
		if (ra !== null && ra > RETRY_AFTER_MAX_SEC) throw failure(retry.code, retry.status, retry.text, ra);
		const delayMs = ra !== null ? ra * 1000 : backoffMs(attempt, io.random);
		if (io.now() + delayMs >= deadlineAt) throw failure(retry.code, retry.status, retry.text, ra);
		if (!(await io.sleep(delayMs, io.cancel))) throw failure('ABORTED', null, MESSAGES.aborted);
	}
}
