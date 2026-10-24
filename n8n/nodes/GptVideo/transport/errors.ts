/**
 * The errors of the node's engine, as plain values. The node turns them into NodeApiError or NodeOperationError.
 *
 * No error ever carries what the HTTP helper threw: that error can hold the request headers, and with them the
 * API key. An engine error is built only from the parts of the answer listed here.
 */

/** Where API keys and webhooks are made. */
export const CONSOLE_URL = 'https://www.gpt-video.com/app/developers';

/** The code of a mistake found before anything is sent. */
export const INVALID_ARGUMENT = 'INVALID_ARGUMENT';

/** The fixed sentences. The JavaScript and Python SDKs say the same words where the situation is the same. */
export const MESSAGES = Object.freeze({
	/** a spend whose outcome is unknown: n8n's own retry reuses the key, a new execution needs it written down */
	mayHaveSpent: (key: string) =>
		`The request may have been charged. To get its answer without paying twice, run it again with Options > Idempotency Key set to ${key}.`,
	notJson: 'The response is not JSON.',
	redirect: 'The API answered with a redirect, which the node does not follow because it would send your API key to another address. Check the Base URL of the credential.',
	insecureBaseUrl: 'The Base URL of the credential must start with https://. http:// is accepted only for an address on this machine, such as localhost.',
	connectionFailed: 'The connection to the API failed.',
	aborted: 'The execution was stopped.',
	notApiError: 'The response is not an error from the GPT-Video API.',
	noServerMessage: 'The API sent no message.',
	badIdempotencyKey: 'Idempotency Key must be 1 to 255 visible ASCII characters, with no spaces.',
	repeatedCursor: 'The API sent a cursor it had sent before, so the list would never end.',
	missingCursor: 'The API said there are more items and sent no nextCursor.',
	notAPage: 'The answer is not a page of a list.',
	uploadElsewhere:
		'Upload the video in the GPT-Video app instead: it then shows in the list of videos, and its id is the source asset ID of a new project.',
	downloadFailed: 'The download failed.',
	downloadRefused: 'The download link was refused. A link expires after a while: read the export again for a new one.',
	downloadInsecure: 'The download was redirected to an address that is not https, so it was stopped.',
	downloadTooManyRedirects: 'The download was redirected too many times.',
	noDownloadUrl: 'The export has no download link: it is not done, or its file was deleted.',
});

/** A duration as the messages say it: whole minutes from two minutes up, seconds below or in between. */
export function durationText(ms: number): string {
	if (ms >= 120_000 && ms % 60_000 === 0) return `${ms / 60_000} minutes`;
	const seconds = Math.round(ms / 100) / 10;
	return `${seconds} ${seconds === 1 ? 'second' : 'seconds'}`;
}

export const TEXTS = Object.freeze({
	timeout: (ms: number) => `No answer within ${durationText(ms)}.`,
	connectionFailed: (code: string) => `The connection to the API failed (${code}).`,
	jobFailed: (id: string) => `${id} failed.`,
	jobCancelled: (id: string) => `${id} was cancelled.`,
	waitTimeout: (id: string, status: string | null, ms: number) =>
		`${id} did not finish within ${durationText(ms)}.${status ? ` Its last status is ${status}.` : ''} It goes on running: read it again later, or start the workflow from the GPT-Video Trigger when it ends.`,
	missingHandle: (field: string) => `The answer has no ${field} object.`,
	partsMismatch: (sizeBytes: number, partSizeBytes: number, partCount: number) =>
		`The API split a file of ${sizeBytes} bytes into ${partCount} parts of ${partSizeBytes} bytes, which does not cover it.`,
});

/** The longest text of the server (a message or a hint) an error repeats. */
export const SERVER_TEXT_MAX = 1000;

function clip(text: string): string {
	return text.length > SERVER_TEXT_MAX ? `${text.slice(0, SERVER_TEXT_MAX - 1)}…` : text;
}

/**
 * The one shape of a message: `<CODE> (<status>): <message> Hint: <hint> [request <requestId>]`, then the
 * sentence about a possible charge, then `note`. A part with no value is left out, with its label.
 */
export function formatMessage(parts: {
	code: string;
	status?: number | null;
	message: string;
	hint?: string | null;
	requestId?: string | null;
	mayHaveSpentWithKey?: string | null;
	note?: string | null;
}): string {
	const status = typeof parts.status === 'number' ? ` (${parts.status})` : '';
	let text = `${parts.code}${status}: ${clip(parts.message)}`;
	if (parts.hint) text += ` Hint: ${clip(parts.hint)}`;
	if (parts.requestId) text += ` [request ${clip(parts.requestId)}]`;
	if (parts.mayHaveSpentWithKey) text += ` ${MESSAGES.mayHaveSpent(parts.mayHaveSpentWithKey)}`;
	if (parts.note) text += ` ${parts.note}`;
	return text;
}

/** How a call ended when it did not succeed. */
export type CallError = {
	readonly kind: 'api' | 'network' | 'job';
	readonly code: string;
	readonly status: number | null;
	readonly message: string;
	readonly hint: string | null;
	readonly requestId: string | null;
	readonly details: unknown;
	readonly retryable: boolean;
	readonly mayHaveSpent: boolean;
	readonly idempotencyKey: string | null;
	readonly retryAfterSec: number | null;
	readonly operation: string;
	/** the object a wait read last, for JOB_FAILED, JOB_CANCELLED and WAIT_TIMEOUT */
	readonly object?: Record<string, unknown> | null;
};

/** A call that did not succeed, thrown by the engine and turned into a NodeApiError by the node. */
export class GptVideoCallError extends Error {
	readonly detail: CallError;

	constructor(detail: CallError) {
		super(detail.message);
		this.name = 'GptVideoCallError';
		this.detail = detail;
	}
}

/** A mistake found before anything is sent; the node turns it into a NodeOperationError. */
export class GptVideoInputError extends Error {
	readonly code = INVALID_ARGUMENT;

	constructor(message: string) {
		super(message);
		this.name = 'GptVideoInputError';
	}
}
