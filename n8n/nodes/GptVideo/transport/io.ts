/**
 * What the engine needs from the world, passed in so that the rules run the same in n8n and in the tests:
 * the network, the clock and the pauses. The node builds it from n8n's helpers (n8n-io.ts); the tests build
 * one on a fake clock. The engine itself never starts a timer.
 */

import type { HttpRequest } from './request.ts';

/** An HTTP answer with its whole body. */
export type HttpAnswer = {
	readonly status: number;
	/** header names in lower case */
	readonly headers: Readonly<Record<string, string | readonly string[] | undefined>>;
	readonly body: Uint8Array;
};

/**
 * Why a request got no answer. The engine reads only this: what the HTTP helper threw (which can hold the
 * request headers, and with them the API key) never leaves io.
 */
export type SendFailure = { readonly failed: true; readonly systemCode: string | null };

export type Io = {
	/** sends one request and reads the whole answer; resolves to a SendFailure when there is no answer */
	readonly send: (request: HttpRequest, signal: AbortSignal) => Promise<HttpAnswer | SendFailure>;
	/** resolves to true after `ms`, or to false as soon as the signal fires */
	readonly sleep: (ms: number, signal: AbortSignal | undefined) => Promise<boolean>;
	/** a signal that fires after `ms` */
	readonly timeoutSignal: (ms: number) => AbortSignal;
	/** a clock that only moves forward, in milliseconds */
	readonly now: () => number;
	/** the wall clock, in milliseconds since 1970: only for Retry-After dates */
	readonly wallNow: () => number;
	/** a number in [0, 1) for the jitter of a pause */
	readonly random: () => number;
	/** the signal of the execution: it fires when someone stops it */
	readonly cancel: AbortSignal | undefined;
};

export function isSendFailure(value: HttpAnswer | SendFailure): value is SendFailure {
	return (value as SendFailure).failed === true;
}

/**
 * A signal that fires when any of the given ones fires. AbortSignal.any (Node.js 20.3 and later, which every
 * n8n that loads this package runs on) lets go of its sources when it is no longer used, so a long execution
 * that makes many calls does not pile listeners on the signal of the execution.
 */
export function anySignal(signals: ReadonlyArray<AbortSignal | undefined>): AbortSignal {
	return AbortSignal.any(signals.filter((s): s is AbortSignal => s !== undefined));
}

/** Resolves when the signal fires; never rejects. */
export function whenAborted(signal: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		if (signal.aborted) resolve();
		else signal.addEventListener('abort', () => resolve(), { once: true });
	});
}

/** One header of an answer, the first value when it was sent more than once. */
export function headerOf(answer: HttpAnswer, name: string): string | null {
	const value = answer.headers[name.toLowerCase()];
	if (Array.isArray(value)) return typeof value[0] === 'string' ? value[0] : null;
	return typeof value === 'string' ? value : null;
}
