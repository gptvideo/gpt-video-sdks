/**
 * The engine's view of n8n: requests through n8n's HTTP helpers, pauses through the sleep of n8n-workflow, the
 * signal of the execution. Nothing here starts a timer of its own.
 *
 * The helper is asked never to throw for an HTTP status (`ignoreHttpStatusErrors`), to give the whole answer
 * with its bytes (`returnFullResponse`, `encoding: 'arraybuffer'`) and never to follow a redirect
 * (`disableFollowRedirect`): the engine reads every status itself and builds its own errors. When the helper
 * throws anyway (no connection, an abort), what it threw can hold the request headers, and with them the API
 * key: only a system code such as ECONNREFUSED is read from it, and the error itself goes no further.
 */

import type { IExecuteFunctions, IHttpRequestOptions } from 'n8n-workflow';
import { sleep } from 'n8n-workflow';

import type { DownloadAnswer, DownloadIo } from './transport/download.ts';
import { type HttpAnswer, type Io, type SendFailure } from './transport/io.ts';
import type { HttpRequest } from './transport/request.ts';

/** The name of the credential the node signs its requests with. */
export const CREDENTIAL = 'gptVideoApi';

const SYSTEM_CODE = /^[A-Z][A-Z0-9_]{1,40}$/;

/** A clean system code from an error, its cause or its cause's cause; nothing else is read. */
export function systemCodeOf(error: unknown): string | null {
	let current: unknown = error;
	for (let depth = 0; depth < 3 && typeof current === 'object' && current !== null; depth++) {
		const code = (current as { code?: unknown }).code;
		if (typeof code === 'string' && SYSTEM_CODE.test(code)) return code;
		current = (current as { cause?: unknown }).cause;
	}
	return null;
}

function headersOf(raw: unknown): Record<string, string | readonly string[] | undefined> {
	const out: Record<string, string | readonly string[] | undefined> = {};
	if (typeof raw !== 'object' || raw === null) return out;
	for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
		if (typeof value === 'string') out[name.toLowerCase()] = value;
		else if (Array.isArray(value)) out[name.toLowerCase()] = value.filter((v): v is string => typeof v === 'string');
		else if (typeof value === 'number') out[name.toLowerCase()] = String(value);
	}
	return out;
}

function bytesOfBody(body: unknown): Uint8Array {
	if (body instanceof Uint8Array) return body;
	if (body instanceof ArrayBuffer) return new Uint8Array(body);
	if (typeof body === 'string') return new TextEncoder().encode(body);
	if (body === undefined || body === null) return new Uint8Array(0);
	// an answer the helper already turned into an object is not the bytes the API sent; its text is what is left
	return new TextEncoder().encode(JSON.stringify(body));
}

/**
 * Resolves to true after `ms`, to false as soon as the signal fires; never rejects. The pause also listens to the
 * signal itself, for an n8n whose sleep takes no signal, and lets go of it when it ends: the signal is the
 * execution's, and a long wait pauses hundreds of times on it.
 */
export async function pause(ms: number, signal: AbortSignal | undefined, nap: (ms: number, signal?: AbortSignal) => Promise<void> = sleep): Promise<boolean> {
	if (signal?.aborted) return false;
	const slept = nap(ms, signal).then(
		() => true,
		() => false,
	);
	if (!signal) return slept;
	let onAbort: () => void = () => {};
	const aborted = new Promise<boolean>((resolve) => {
		onAbort = () => resolve(false);
		signal.addEventListener('abort', onAbort, { once: true });
	});
	try {
		return await Promise.race([slept, aborted]);
	} finally {
		signal.removeEventListener('abort', onAbort);
	}
}

/** The engine's Io over the helpers of one execution of the node. */
export function n8nIo(ctx: IExecuteFunctions): Io {
	return {
		send: async (request: HttpRequest, signal: AbortSignal): Promise<HttpAnswer | SendFailure> => {
			const options: IHttpRequestOptions = {
				method: request.method,
				url: request.url,
				headers: { ...request.headers },
				encoding: 'arraybuffer',
				json: false,
				returnFullResponse: true,
				ignoreHttpStatusErrors: true,
				disableFollowRedirect: true,
				abortSignal: signal,
			};
			if (typeof request.body === 'string') options.body = request.body;
			else if (request.body !== undefined) options.body = Buffer.from(request.body.buffer, request.body.byteOffset, request.body.byteLength);
			try {
				const res = (await ctx.helpers.httpRequestWithAuthentication.call(ctx, CREDENTIAL, options)) as {
					statusCode?: unknown;
					headers?: unknown;
					body?: unknown;
				};
				const status = typeof res?.statusCode === 'number' ? res.statusCode : 0;
				return { status, headers: headersOf(res?.headers), body: bytesOfBody(res?.body) };
			} catch (error) {
				return { failed: true, systemCode: systemCodeOf(error) };
			}
		},
		sleep: (ms: number, signal: AbortSignal | undefined) => pause(ms, signal),
		timeoutSignal: (ms: number) => AbortSignal.timeout(Math.max(1, Math.ceil(ms))),
		now: () => performance.now(),
		wallNow: () => Date.now(),
		random: () => Math.random(),
		cancel: ctx.getExecutionCancelSignal?.(),
	};
}

/** Requests of a download: no credential, no redirect followed by the helper, the body as a stream. */
export function n8nDownloadIo(ctx: IExecuteFunctions, userAgent: string): DownloadIo {
	return {
		get: async (url: string, signal: AbortSignal) => {
			try {
				const res = (await ctx.helpers.httpRequest({
					method: 'GET',
					url,
					headers: { 'User-Agent': userAgent },
					encoding: 'stream',
					returnFullResponse: true,
					ignoreHttpStatusErrors: true,
					disableFollowRedirect: true,
					// the idle time of the connection: a body that stops arriving for this long ends the download
					timeout: 60_000,
					abortSignal: signal,
				})) as { statusCode?: unknown; headers?: unknown; body?: unknown };
				const body = res?.body;
				const answer: DownloadAnswer = {
					status: typeof res?.statusCode === 'number' ? res.statusCode : 0,
					headers: headersOf(res?.headers),
					body,
					discard: () => {
						const destroy = (body as { destroy?: unknown } | null)?.destroy;
						if (typeof destroy === 'function') destroy.call(body);
					},
				};
				return answer;
			} catch (error) {
				return { failed: true as const, systemCode: systemCodeOf(error) };
			}
		},
	};
}
