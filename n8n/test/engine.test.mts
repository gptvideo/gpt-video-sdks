/**
 * The helpers of the engine on a virtual clock: following work until it ends, uploading in parts, downloading
 * through redirects. The rules of a single call are in retry.vectors.test.ts.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { CONVENTIONS, OPERATIONS, RETRYABLE_CODES } from '../nodes/GptVideo/operations.generated.ts';
import { download } from '../nodes/GptVideo/transport/download.ts';
import { EARLY_ANSWER_PAUSE, Engine } from '../nodes/GptVideo/transport/engine.ts';
import { GptVideoCallError } from '../nodes/GptVideo/transport/errors.ts';
import { resolveBaseUrl } from '../nodes/GptVideo/transport/request.ts';
import { bytesSource, streamSource } from '../nodes/GptVideo/transport/sources.ts';
import { uploadFile } from '../nodes/GptVideo/transport/upload.ts';
import { type Scripted, VirtualClock, scriptedIo } from './support/clock.mts';

const NOW = Date.parse('2026-10-11T12:00:00.000Z');

function engineOn(script: Scripted[] | ((request: any, index: number) => Scripted), random = 0) {
	const clock = new VirtualClock(NOW);
	const net = scriptedIo(clock, script, { random: () => random });
	const engine = new Engine({
		io: net.io,
		base: resolveBaseUrl(undefined, CONVENTIONS.baseUrl),
		conventions: CONVENTIONS,
		operations: OPERATIONS,
		retryable: RETRYABLE_CODES,
		userAgent: 'test',
	});
	return { clock, net, engine };
}

const job = (status: string, finishedAt: string | null = null, extra: Record<string, unknown> = {}) => ({
	status: 200,
	json: { job: { id: 'job_1', status, finishedAt, errorMessage: null, ...extra } },
});

describe('waiting for work', () => {
	it('reads again with wait=25 until the job is done, and pauses 3 to 5 seconds after an answer that came back early', async () => {
		const { clock, net, engine } = engineOn([job('queued'), { ...job('running'), afterMs: 25_000 }, job('done', '2026-10-11T12:01:00.000Z')], 0.5);
		const got = await clock.drive(engine.waitFor('job', 'job_1', 60_000 * 10));
		assert.equal((got.value as any).status, 'done');
		const reads = net.calls.map((c) => new URL(c.request.url));
		assert.ok(reads.every((u) => u.pathname === '/v1/jobs/job_1' && u.searchParams.get('wait') === '25'));
		// the first read came back at once: the pause follows it; the second one was held, so the third follows at once
		assert.equal(net.calls[1]!.at, EARLY_ANSWER_PAUSE.minMs + EARLY_ANSWER_PAUSE.spreadMs / 2);
		assert.equal(net.calls[2]!.at, net.calls[1]!.at + 25_000);
	});

	it('ends on a finishedAt even with a status it does not know, and never on rendering', async () => {
		const known = engineOn([{ status: 200, json: { export: { id: 'rnd_1', status: 'rendering', finishedAt: null } }, afterMs: 25_000 }, { status: 200, json: { export: { id: 'rnd_1', status: 'archived', finishedAt: '2026-10-11T12:00:30.000Z' } } }]);
		const got = await known.clock.drive(known.engine.waitFor('export', 'rnd_1', 600_000));
		assert.equal((got.value as any).status, 'archived');
		assert.equal(known.net.calls.length, 2, 'rendering is still working');
	});

	it('a failed job is JOB_FAILED with what it said and the object; a cancelled one JOB_CANCELLED', async () => {
		for (const [status, code] of [['failed', 'JOB_FAILED'], ['cancelled', 'JOB_CANCELLED']] as const) {
			const { clock, engine } = engineOn([job(status, '2026-10-11T12:00:10.000Z', { errorMessage: 'No sound.' })]);
			const got = await clock.drive(engine.waitFor('job', 'job_1', 600_000));
			assert.ok(got.error instanceof GptVideoCallError);
			assert.equal(got.error.detail.code, code);
			assert.equal((got.error.detail.object as any).status, status);
			assert.equal(got.error.detail.retryable, false);
		}
	});

	it('the end of the time is WAIT_TIMEOUT with the last object, and waiting again can still see the work end', async () => {
		// the server holds each read for the seconds it asks for, as the API does
		const { clock, net, engine } = engineOn((request: any) => ({ ...job('running'), afterMs: Number(new URL(request.url).searchParams.get('wait')) * 1000 }));
		const got = await clock.drive(engine.waitFor('job', 'job_1', 60_000));
		assert.ok(got.error instanceof GptVideoCallError);
		assert.equal(got.error.detail.code, 'WAIT_TIMEOUT');
		assert.equal(got.error.detail.retryable, true);
		assert.equal((got.error.detail.object as any).status, 'running');
		assert.match(got.error.detail.message, /did not finish within 1 minute|did not finish within 60 seconds/);
		assert.ok(got.at <= 60_000 + 25_000, `the wait ended at ${got.at}`);
		const asked = net.calls.map((c) => Number(new URL(c.request.url).searchParams.get('wait')));
		assert.ok(asked.every((s) => s <= 25));
		assert.equal(asked.at(-1)! < 25, true, 'the last read asks only for the time that is left');
	});

	it('a read that carries no object is BAD_RESPONSE, never a wait without end', async () => {
		const { clock, engine } = engineOn([{ status: 200, json: { nothing: true } }]);
		const got = await clock.drive(engine.waitFor('job', 'job_1', 600_000));
		assert.ok(got.error instanceof GptVideoCallError);
		assert.equal(got.error.detail.code, 'BAD_RESPONSE');
	});
});

describe('uploading', () => {
	const open = (size: number, partSize: number) => ({ status: 201, json: { upload: { id: 'upl_1', partSizeBytes: partSize, partCount: Math.ceil(size / partSize), receivedParts: [] } } });

	it('a complete refused for missing parts reads the upload, sends them again, and asks once more with the same key', async () => {
		const bytes = new Uint8Array(10).map((_, i) => i);
		const { clock, net, engine } = engineOn((request: any) => {
			if (request.url.endsWith('/v1/uploads')) return open(10, 4);
			if (request.method === 'PUT') return { status: 200, json: { upload: { id: 'upl_1' } } };
			if (request.url.endsWith('/complete')) {
				const completes = net.calls.filter((c) => c.request.url.endsWith('/complete')).length;
				return completes === 1 ? { status: 409, json: { error: { code: 'CONFLICT', message: 'Part 2 is missing.' } } } : { status: 201, json: { asset: { id: 'ast_1' } } };
			}
			if (request.method === 'GET') return { status: 200, json: { upload: { id: 'upl_1', partSizeBytes: 4, partCount: 3, receivedParts: [1, 3] } } };
			throw new Error(request.url);
		});
		const got = await clock.drive(uploadFile(engine, { source: bytesSource(bytes), filename: 'a.mp4', contentType: undefined, title: undefined, createKey: 'k-create', completeKey: 'k-complete', keepOpenOnFailure: false }));
		assert.deepEqual(got.value, { asset: { id: 'ast_1' } });
		const parts = net.calls.filter((c) => c.request.method === 'PUT').map((c) => new URL(c.request.url).pathname.split('/').at(-1));
		assert.deepEqual(parts, ['1', '2', '3', '2']);
		const completes = net.calls.filter((c) => c.request.url.endsWith('/complete'));
		assert.deepEqual(completes.map((c) => c.request.headers['Idempotency-Key']), ['k-complete', 'k-complete']);
		const again = net.calls.filter((x) => x.request.method === 'PUT')[3]!;
		assert.deepEqual(Array.from(again.request.body as Uint8Array), [4, 5, 6, 7], 'part 2 is sent again with its bytes');
	});

	it('a part size that does not cover the file is refused before anything is sent, and the upload is cancelled', async () => {
		const { clock, net, engine } = engineOn((request: any) =>
			request.method === 'DELETE' ? { status: 200, json: {} } : { status: 201, json: { upload: { id: 'upl_1', partSizeBytes: 4, partCount: 2, receivedParts: [] } } },
		);
		const got = await clock.drive(uploadFile(engine, { source: bytesSource(new Uint8Array(10)), filename: 'a.mp4', contentType: undefined, title: undefined, createKey: 'a', completeKey: 'b', keepOpenOnFailure: false }));
		assert.ok(got.error instanceof GptVideoCallError);
		assert.equal(got.error.detail.code, 'BAD_RESPONSE');
		assert.equal(net.calls.filter((c) => c.request.method === 'PUT').length, 0);
	});

	it('a stream gives each part exactly, and is refused when it ends early or goes on past the size', async () => {
		async function* chunks(...sizes: number[]) {
			for (const n of sizes) yield new Uint8Array(n);
		}
		const exact = streamSource(chunks(3, 3, 4), 10);
		assert.equal((await exact.part(1, 4)).byteLength, 4);
		assert.equal((await exact.part(2, 4)).byteLength, 4);
		assert.equal((await exact.part(3, 4)).byteLength, 2);
		const short = streamSource(chunks(3), 10);
		await assert.rejects(short.part(1, 4), /ended after 3 bytes/);
		const long = streamSource(chunks(6, 6), 10);
		await long.part(1, 5);
		await assert.rejects(long.part(2, 5), /more than the 10 bytes/);
		await assert.rejects(streamSource(chunks(10), 10).part(2, 5), /in order/);
	});
});

describe('downloading', () => {
	const http = (answers: Array<{ status: number; headers?: Record<string, string> }>) => {
		const calls: string[] = [];
		return {
			calls,
			io: {
				get: async (url: string) => {
					calls.push(url);
					const a = answers.shift();
					if (!a) throw new Error('no answer');
					return { status: a.status, headers: a.headers ?? {}, body: 'BODY', discard: () => {} };
				},
			},
		};
	};

	it('follows an https redirect, retries a 503, and gives the answer of the file', async () => {
		const { clock, net } = engineOn([]);
		const h = http([{ status: 503 }, { status: 302, headers: { location: '/signed/f.mp4' } }, { status: 200 }]);
		const got = await clock.drive(download(net.io, h.io, 'https://files.gpt-video.com/f.mp4'));
		assert.equal((got.value as any).body, 'BODY');
		assert.deepEqual(h.calls, ['https://files.gpt-video.com/f.mp4', 'https://files.gpt-video.com/f.mp4', 'https://files.gpt-video.com/signed/f.mp4']);
	});

	it('refuses a link that is not https, a redirect to http, an expired link and an endless chain of redirects', async () => {
		const { clock, net } = engineOn([]);
		const refused = async (link: string, answers: Array<{ status: number; headers?: Record<string, string> }>, text: RegExp) => {
			const got = await clock.drive(download(net.io, http(answers).io, link));
			assert.ok(got.error instanceof GptVideoCallError, link);
			assert.match(got.error.message, text);
		};
		await refused('http://files.gpt-video.com/f.mp4', [], /must start with https/);
		await refused('https://files.gpt-video.com/f.mp4', [{ status: 301, headers: { location: 'http://x.example.com/f' } }], /not https/);
		await refused('https://files.gpt-video.com/f.mp4', [{ status: 403 }], /link was refused/);
		await refused('https://a.example.com/', Array.from({ length: 6 }, () => ({ status: 302, headers: { location: 'https://a.example.com/' } })), /too many times/);
	});
});
