/**
 * Uploading a file: create_upload says how many parts to send and how big each one is, the parts go out one
 * after the other with upload_part, and complete_upload turns the file into an asset. The part size is the one
 * the API answers, never a number of the node.
 *
 * What holds on every path:
 *  - a part is read when it is sent, so at most one part of the file is in memory at a time;
 *  - each part has a timeout that grows with its size, from 60 seconds at 100 KB a second up to 10 minutes, and
 *    is retried on its own: sending a part again replaces it;
 *  - create_upload and complete_upload carry the keys the node gives them, one per intention, so n8n running the
 *    node again for the same item continues the same upload and gets the same asset;
 *  - a complete refused with CONFLICT, from a file that can be read again, reads the upload, sends the parts it
 *    lacks once more and asks again with the same key, once.
 */

import { GptVideoCallError, GptVideoInputError, MESSAGES, TEXTS } from './errors.ts';
import { type Engine, badResponse } from './engine.ts';
import { RETRY_AFTER_MAX_SEC, type Failure } from './rules.ts';

/** The time a part has, whatever its size. */
export const PART_TIMEOUT_MIN_MS = 60_000;
/** The most time a part has. */
export const PART_TIMEOUT_MAX_MS = 600_000;
/** The slowest line a part is given time for: 100 KB a second. */
export const PART_SLOWEST_BYTES_PER_SEC = 100_000;
/** How long the cancel of a failed upload may take. */
export const CANCEL_DEADLINE_MS = 15_000;

/** The timeout of a part: its size at the slowest line, between one and ten minutes. */
export function partTimeoutMs(bytes: number): number {
	return Math.min(PART_TIMEOUT_MAX_MS, Math.max(PART_TIMEOUT_MIN_MS, Math.ceil((bytes * 1000) / PART_SLOWEST_BYTES_PER_SEC)));
}

/** The deadline of a part: every attempt with its whole timeout, and every pause with the longest Retry-After. */
export function partDeadlineMs(timeoutMs: number, maxRetries: number): number {
	return (maxRetries + 1) * timeoutMs + maxRetries * RETRY_AFTER_MAX_SEC * 1000;
}

/** What a file is read from. */
export type UploadSource = {
	readonly size: number;
	/** false for a stream, whose bytes are gone once read */
	readonly rereadable: boolean;
	/** the bytes of part `number` (from 1) of parts of `partSize` bytes; a stream is asked for its parts in order */
	readonly part: (number: number, partSize: number) => Promise<Uint8Array>;
};

export type UploadRequest = {
	readonly source: UploadSource;
	readonly filename: string;
	readonly contentType: string | undefined;
	readonly title: string | undefined;
	readonly createKey: string;
	readonly completeKey: string;
	/** true when n8n will run the node again on a failure (Retry On Fail): the upload stays open for that run */
	readonly keepOpenOnFailure: boolean;
};

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

type OpenUpload = { readonly id: string; readonly partSizeBytes: number; readonly partCount: number; readonly received: ReadonlySet<number> };

function uploadIn(body: unknown, size: number, operation: string): OpenUpload {
	const upload = isObject(body) ? body.upload : undefined;
	if (!isObject(upload) || typeof upload.id !== 'string' || upload.id.length === 0) throw badResponse(operation, TEXTS.missingHandle('upload'));
	const { partSizeBytes, partCount } = upload;
	if (
		typeof partSizeBytes !== 'number' ||
		!Number.isSafeInteger(partSizeBytes) ||
		partSizeBytes <= 0 ||
		typeof partCount !== 'number' ||
		partCount !== Math.ceil(size / partSizeBytes)
	) {
		throw badResponse(operation, TEXTS.partsMismatch(size, Number(partSizeBytes), Number(partCount)));
	}
	const received = new Set(Array.isArray(upload.receivedParts) ? upload.receivedParts.filter((n): n is number => Number.isSafeInteger(n)) : []);
	return { id: upload.id, partSizeBytes, partCount, received };
}

const numbersTo = (count: number) => Array.from({ length: count }, (_, i) => i + 1);

/** The sentence that says where else a video can be uploaded when uploads are turned off. */
function elsewhere(switchedOffReason: string) {
	return (outcome: Failure): string | null =>
		outcome.kind === 'api' && outcome.code === 'UNAVAILABLE' && isObject(outcome.details) && outcome.details.reason === switchedOffReason
			? MESSAGES.uploadElsewhere
			: null;
}

/** Uploads a file and resolves to the answer of complete_upload, `{ asset }`. */
export async function uploadFile(engine: Engine, request: UploadRequest): Promise<unknown> {
	const { source } = request;
	if (!Number.isSafeInteger(source.size) || source.size < 1) throw new GptVideoInputError('The file is empty.');
	if (request.filename === '') throw new GptVideoInputError('The upload needs a file name, such as interview.mp4: the API reads the type of the video from it.');

	const created = await engine.call('create_upload', {
		input: { filename: request.filename, sizeBytes: source.size, ...(request.contentType ? { contentType: request.contentType } : {}) },
		idempotencyKey: request.createKey,
		explain: elsewhere(engine.settings.conventions.switchedOffReason),
	});
	const upload = uploadIn(created.body, source.size, 'create_upload');
	const complete = () =>
		engine.call('complete_upload', {
			input: { uploadId: upload.id, ...(request.title ? { title: request.title } : {}) },
			idempotencyKey: request.completeKey,
		});
	const done = await settled(
		(async () => {
			await sendParts(engine, upload, source, numbersTo(upload.partCount).filter((n) => !upload.received.has(n) || !source.rereadable));
			const first = await settled(complete());
			if (first.ok) return first.value.body;
			const refusal = first.error;
			if (!(refusal instanceof GptVideoCallError) || refusal.detail.code !== 'CONFLICT' || !source.rereadable) throw refusal;
			// the API holds fewer parts than were sent: read which, send them once more, and ask again with the same key
			const read = await settled(engine.call('get_upload', { input: { uploadId: upload.id }, idempotencyKey: null }));
			// an upload that cannot be read leaves the refusal of complete as the answer the caller needs
			if (!read.ok) throw refusal;
			const again = uploadIn(read.value.body, source.size, 'get_upload');
			const missing = numbersTo(again.partCount).filter((n) => !again.received.has(n));
			if (missing.length === 0) throw refusal;
			await sendParts(engine, upload, source, missing);
			return (await complete()).body;
		})(),
	);
	if (done.ok) return done.value;
	if (!request.keepOpenOnFailure) await cancel(engine, upload.id);
	throw done.error;
}

/** A promise as a value: what it resolved to, or what it rejected with. Errors pass through here unchanged. */
export function settled<T>(promise: Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: unknown }> {
	return promise.then(
		(value) => ({ ok: true as const, value }),
		(error: unknown) => ({ ok: false as const, error }),
	);
}

/**
 * Parts one after the other. A stream is read from its start, so a part the API already holds is read and sent
 * again rather than skipped: skipping it would need the stream to jump, and sending a part again replaces it.
 */
async function sendParts(engine: Engine, upload: OpenUpload, source: UploadSource, numbers: readonly number[]): Promise<void> {
	for (const number of numbers) {
		const bytes = await source.part(number, upload.partSizeBytes);
		const timeoutMs = partTimeoutMs(bytes.byteLength);
		await engine.call('upload_part', {
			input: { uploadId: upload.id, partNumber: number },
			idempotencyKey: null,
			bytes,
			limits: { timeoutMs, deadlineMs: partDeadlineMs(timeoutMs, 2) },
		});
	}
}

/**
 * An open upload counts against the open uploads and the storage of the account until it expires, so a failed
 * one is cancelled. What the cancel answers does not change the error the caller gets.
 */
async function cancel(engine: Engine, uploadId: string): Promise<void> {
	// whatever the cancel answers, the upload expires on its own, and the failure that led here is the one to report
	await settled(engine.call('cancel_upload', { input: { uploadId }, idempotencyKey: null, limits: { deadlineMs: CANCEL_DEADLINE_MS, maxRetries: 1 } }));
}
