/**
 * A clock for the tests of the engine: time moves only when every promise that can run has run, and then
 * straight to the next thing that waits for time (a pause, the timeout of an attempt, an answer that takes
 * long). The engine gets its time through Io, so nothing in it needs a real timer.
 */

import type { HttpAnswer, Io, SendFailure } from '../../nodes/GptVideo/transport/io.ts';
import type { HttpRequest } from '../../nodes/GptVideo/transport/request.ts';

type Timer = { at: number; seq: number; fire: () => void };

export class VirtualClock {
	now = 0;
	readonly wallStart: number;
	#timers: Timer[] = [];
	#seq = 0;

	constructor(wallStart: number) {
		this.wallStart = wallStart;
	}

	/** Runs `fire` when the clock reaches now + ms. Returns the function that cancels it. */
	at(ms: number, fire: () => void): () => void {
		const timer = { at: this.now + Math.max(0, ms), seq: this.#seq++, fire };
		this.#timers.push(timer);
		return () => {
			this.#timers = this.#timers.filter((t) => t !== timer);
		};
	}

	sleep = (ms: number, signal: AbortSignal | undefined): Promise<boolean> =>
		new Promise((resolve) => {
			if (signal?.aborted) {
				resolve(false);
				return;
			}
			const cancel = this.at(ms, () => {
				signal?.removeEventListener('abort', onAbort);
				resolve(true);
			});
			const onAbort = () => {
				cancel();
				resolve(false);
			};
			signal?.addEventListener('abort', onAbort, { once: true });
		});

	timeoutSignal = (ms: number): AbortSignal => {
		const controller = new AbortController();
		this.at(ms, () => controller.abort());
		return controller.signal;
	};

	/** Runs the clock until the promise settles: real microtasks first, then the next timer, again and again. */
	async drive<T>(promise: Promise<T>, rounds = 100_000): Promise<{ value?: T; error?: unknown; at: number }> {
		let outcome: { value?: T; error?: unknown; at: number } | null = null;
		promise.then(
			(value) => {
				outcome = { value, at: this.now };
			},
			(error: unknown) => {
				outcome = { error, at: this.now };
			},
		);
		for (let round = 0; round < rounds; round++) {
			await new Promise((resolve) => setImmediate(resolve));
			if (outcome) return outcome;
			if (this.#timers.length === 0) continue;
			this.#timers.sort((a, b) => a.at - b.at || a.seq - b.seq);
			const next = this.#timers.shift()!;
			this.now = next.at;
			next.fire();
		}
		throw new Error('the promise never settled');
	}
}

/** One scripted answer, in the format of retry.json. */
export type Scripted = {
	status?: number;
	headers?: Record<string, string>;
	json?: unknown;
	text?: string;
	afterMs?: number;
	network?: 'hang' | 'connection_failed';
};

export type Recorded = { request: HttpRequest; at: number };

/** An Io on the virtual clock whose network answers from a script, and records every request. */
export function scriptedIo(clock: VirtualClock, script: Scripted[] | ((request: HttpRequest, index: number) => Scripted), options: { random?: () => number; cancel?: AbortSignal } = {}) {
	const queue = Array.isArray(script) ? [...script] : null;
	const calls: Recorded[] = [];
	const send = (request: HttpRequest, signal: AbortSignal): Promise<HttpAnswer | SendFailure> => {
		const index = calls.push({ request, at: clock.now }) - 1;
		const entry = queue ? queue.shift() : (script as (r: HttpRequest, i: number) => Scripted)(request, index);
		if (!entry) throw new Error(`the script has no answer for request ${index + 1}: ${request.method} ${request.url}`);
		if (entry.network === 'connection_failed') return Promise.resolve({ failed: true, systemCode: 'ECONNREFUSED' });
		return new Promise((resolve) => {
			if (entry.network === 'hang') {
				signal.addEventListener('abort', () => resolve({ failed: true, systemCode: null }), { once: true });
				return;
			}
			const headers: Record<string, string> = {};
			for (const [name, value] of Object.entries(entry.headers ?? {})) headers[name.toLowerCase()] = value;
			const text = 'json' in entry ? JSON.stringify(entry.json) : (entry.text ?? '');
			const cancel = clock.at(entry.afterMs ?? 0, () => resolve({ status: entry.status ?? 200, headers, body: new TextEncoder().encode(text) }));
			signal.addEventListener(
				'abort',
				() => {
					cancel();
					resolve({ failed: true, systemCode: null });
				},
				{ once: true },
			);
		});
	};
	const io: Io = {
		send,
		sleep: clock.sleep,
		timeoutSignal: clock.timeoutSignal,
		now: () => clock.now,
		wallNow: () => clock.wallStart + clock.now,
		random: options.random ?? (() => 0.5),
		cancel: options.cancel,
	};
	return {
		io,
		calls,
		get left() {
			return queue ? queue.length : 0;
		},
	};
}

/** The entries of retry.json with `repeat: n` written out. */
export function expand(responses: ReadonlyArray<Scripted & { repeat?: number }>): Scripted[] {
	const out: Scripted[] = [];
	for (const { repeat = 1, ...one } of responses) for (let i = 0; i < repeat; i++) out.push(one);
	return out;
}
