/**
 * The GPT-Video node in a stand-in of n8n: the parameters become the input of the vector, the key is one per
 * intention, the HTTP helper is asked for what the engine needs, the API key never reaches an error, a binary
 * file is uploaded a part at a time, and a download carries no key.
 */

import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';

import { GptVideo, USER_AGENT, VERSION } from '../nodes/GptVideo/GptVideo.node.ts';
import { pause } from '../nodes/GptVideo/n8n-io.ts';
import { FIELDS, OPERATIONS } from '../nodes/GptVideo/operations.generated.ts';
import { PROPERTIES } from '../nodes/GptVideo/properties.generated.ts';
import { API_KEY, json, makeContext, type ContextSetup } from './support/context.mts';
import { readPackage, readVectors } from './support/vectors.mts';

const VECTORS = readVectors('requests.generated.json');
const KEYS = readVectors('keys.json');
const DERIVED = new RegExp(KEYS.generators.n8n.pattern);
const node = new GptVideo();
const run = (setup: ContextSetup) => {
	const made = makeContext(setup);
	return { ...made, result: node.execute.call(made.ctx) };
};
const vector = (name: string) => VECTORS.vectors.find((v: any) => v.name === name);

/** The parameters of the node that give the input of a vector, as a user would set them. */
function paramsFor(v: any): Record<string, unknown> {
	const row = OPERATIONS.find((r) => r.id === v.operation)!;
	const out: Record<string, unknown> = { operation: v.operation, resource: 'x', options: { idempotencyKey: v.options?.idempotencyKey } };
	const additional: Record<string, unknown> = {};
	for (const spec of FIELDS[v.operation]!) {
		if (!(spec.field in v.input)) continue;
		const value = v.input[spec.field];
		const param = spec.kind === 'json' ? JSON.stringify(value) : value;
		if (spec.additional) additional[spec.param] = param;
		else out[spec.param] = param;
	}
	out.additionalFields = additional;
	if (row.paginated) {
		out.returnAll = false;
		out.limit = v.input.limit ?? 20;
	}
	return out;
}

beforeEach(() => {
	mock.method(Math, 'random', () => 0);
});
afterEach(() => {
	mock.restoreAll();
});

describe('the GPT-Video node', () => {
	it('is the package version, and says so in its User-Agent', () => {
		assert.equal(VERSION, readPackage().version);
		assert.equal(USER_AGENT, `n8n-nodes-gpt-video/${VERSION}`);
		assert.equal(node.description.usableAsTool, true, 'an AI Agent can use it as a tool');
		assert.equal(node.description.properties, PROPERTIES);
	});

	it('turns every example of the reference into its request, for every operation that has one', async () => {
		let checked = 0;
		for (const v of VECTORS.vectors) {
			const row = OPERATIONS.find((r) => r.id === v.operation)!;
			if (row.binary || row.paginated || v.outcome.kind !== 'result') continue;
			const { calls, result } = run({ params: paramsFor(v), http: () => json(v.response.status, v.response.body), executionId: '7', instanceId: 'inst' });
			const [[item]] = (await result) as any;
			const url = new URL(calls[0]!.options.url);
			assert.deepEqual(url.pathname.split('/').slice(2).map(decodeURIComponent), v.request.segments, v.name);
			assert.deepEqual(Object.fromEntries(url.searchParams), v.request.query, v.name);
			assert.deepEqual(calls[0]!.options.body === undefined ? null : JSON.parse(calls[0]!.options.body), v.request.json, v.name);
			assert.deepEqual(item.json, v.response.body, v.name);
			checked++;
		}
		assert.ok(checked >= 60, `only ${checked} examples were checked`);
	});

	it('asks the helper never to throw on a status, never to follow a redirect, and for the bytes of the answer', async () => {
		const v = vector('analyze_project: Analyze a project');
		const { calls, result } = run({ params: paramsFor(v), http: () => json(202, v.response.body), executionId: '7', instanceId: 'inst' });
		await result;
		const o = calls[0]!.options;
		assert.equal(o.ignoreHttpStatusErrors, true);
		assert.equal(o.disableFollowRedirect, true);
		assert.equal(o.returnFullResponse, true);
		assert.equal(o.encoding, 'arraybuffer');
		assert.equal(o.json, false);
		assert.ok(o.abortSignal, 'every attempt can be stopped');
		assert.equal(o.headers['User-Agent'], USER_AGENT);
		assert.equal(o.headers.Authorization, undefined, 'the key is added by n8n, never by the node');
	});

	describe('the Idempotency-Key', () => {
		const spend = { operation: 'analyze_project', projectId: 'prj_7c2e9a4f1b3d4e8096a5', options: {} };
		const keyOf = async (setup: Partial<ContextSetup>) => {
			const { calls, result } = run({ params: spend, http: () => json(202, vector('analyze_project: Analyze a project').response.body), ...setup });
			await result;
			return calls.map((c) => c.options.headers['Idempotency-Key']);
		};
		const base = { executionId: '7', instanceId: 'inst', workflowId: 'wf', nodeId: 'n1', runIndex: 0 };

		it('is the same when n8n runs the node again for the same item (Retry On Fail)', async () => {
			const [a] = await keyOf(base);
			const [b] = await keyOf(base);
			assert.match(a!, DERIVED);
			assert.equal(a, b);
		});

		it('is new on a new execution, on another instance with the same execution number, on another run and another item', async () => {
			const [a] = await keyOf(base);
			for (const change of [{ executionId: '8' }, { instanceId: 'other' }, { runIndex: 1 }, { workflowId: 'wf2' }, { nodeId: 'n2' }]) {
				const [b] = await keyOf({ ...base, ...change });
				assert.notEqual(a, b, JSON.stringify(change));
			}
			const twoItems = await keyOf({ ...base, items: [{ json: {} }, { json: {} }] });
			assert.notEqual(twoItems[0], twoItems[1]);
		});

		it('is never fixed when the run has no execution id: a test run gets a new one every time', async () => {
			const [a] = await keyOf({ ...base, executionId: undefined, instanceId: undefined });
			const [b] = await keyOf({ ...base, executionId: undefined, instanceId: undefined });
			assert.match(a!, DERIVED);
			assert.notEqual(a, b);
		});

		it('without an execution id, is still the same on every try of Retry On Fail in one execution', async () => {
			for (const executionId of [undefined, '', '__UNKNOWN__']) {
				const nodeContext = {};
				const [a] = await keyOf({ ...base, executionId, nodeContext });
				const [b] = await keyOf({ ...base, executionId, nodeContext });
				const [c] = await keyOf({ ...base, executionId, nodeContext: {} });
				assert.equal(a, b, `two tries of one execution, execution id ${JSON.stringify(executionId)}`);
				assert.notEqual(a, c, `another execution, execution id ${JSON.stringify(executionId)}`);
			}
		});

		it('as an AI Agent tool, is the same on every try although n8n gives each try a new run index', async () => {
			const args = { json: { projectId: 'prj_7c2e9a4f1b3d4e8096a5', note: 'first' } };
			const [a] = await keyOf({ ...base, asTool: true, runIndex: 0, items: [args] });
			const [b] = await keyOf({ ...base, asTool: true, runIndex: 1, items: [{ json: { note: 'first', projectId: 'prj_7c2e9a4f1b3d4e8096a5' } }] });
			const [c] = await keyOf({ ...base, asTool: true, runIndex: 2, items: [{ json: { ...args.json, note: 'second' } }] });
			const [d] = await keyOf({ ...base, asTool: false, runIndex: 0, items: [args] });
			assert.match(a!, DERIVED);
			assert.equal(a, b, 'a try sends the same arguments, in any order of their fields');
			assert.notEqual(a, c, 'a call with other arguments is another intention');
			assert.notEqual(a, d, 'the key of a tool call is not the key of a run of the workflow');
		});

		it("is the user's own when Options > Idempotency Key is set, and a key the API would refuse sends nothing", async () => {
			const [a] = await keyOf({ ...base, params: { ...spend, options: { idempotencyKey: 'order-42' } } });
			assert.equal(a, 'order-42');
			const { calls, result } = run({ ...base, params: { ...spend, options: { idempotencyKey: 'order 42' } }, http: () => json(202, {}) });
			await assert.rejects(result, (e: Error) => e.name === 'NodeOperationError' && /Idempotency Key/.test(e.message));
			assert.equal(calls.length, 0);
		});

		it('is the same on every attempt of a call, and not sent at all by a read', async () => {
			const answers = [json(500, { error: { code: 'INTERNAL', message: 'x' } }), json(202, vector('analyze_project: Analyze a project').response.body)];
			const { calls, result } = run({ ...base, params: spend, http: (_o, i) => answers[i]! });
			await result;
			assert.equal(calls.length, 2);
			assert.equal(calls[0]!.options.headers['Idempotency-Key'], calls[1]!.options.headers['Idempotency-Key']);
			const read = run({ ...base, params: { operation: 'get_project', projectId: 'prj_7c2e9a4f1b3d4e8096a5' }, http: () => json(200, { project: {} }) });
			await read.result;
			assert.equal(read.calls[0]!.options.headers['Idempotency-Key'], undefined);
		});
	});

	describe('errors', () => {
		const read = { operation: 'get_project', projectId: 'prj_7c2e9a4f1b3d4e8096a5' };
		const leaks = (value: unknown) => {
			const seen = new Set<unknown>();
			const walk = (v: unknown): string => {
				if (v === null || typeof v !== 'object') return String(v);
				if (seen.has(v)) return '';
				seen.add(v);
				return Object.getOwnPropertyNames(v).map((k) => `${k}:${walk((v as any)[k])}`).join(' ');
			};
			return walk(value).includes(API_KEY) || String((value as Error)?.stack).includes(API_KEY);
		};

		it('a helper error that carries the Authorization header never reaches the error of the node', async () => {
			const { result } = run({
				...{ executionId: '7', instanceId: 'inst' },
				params: read,
				http: () => {
					throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
				},
			});
			const error: any = await result.then(
				() => assert.fail('no error'),
				(e) => e,
			);
			assert.match(error.message, /^CONNECTION_FAILED: The connection to the API failed \(ECONNREFUSED\)\./);
			assert.equal(leaks(error), false, 'the key is not in the message, the stack or any field of the error');
			assert.equal(JSON.stringify(error).includes(API_KEY), false);
		});

		it('an API error keeps the code, the request id and the hint, and Continue On Fail returns them as an item', async () => {
			const body = { error: { code: 'NOT_FOUND', message: 'Project prj_x not found.', hint: 'List your projects.', requestId: 'req_1' } };
			const failing = run({ params: read, http: () => json(404, body), executionId: '7' });
			const error: any = await failing.result.then(() => assert.fail('no error'), (e) => e);
			assert.equal(error.name, 'NodeApiError');
			assert.equal(error.message, 'NOT_FOUND (404): Project prj_x not found. Hint: List your projects. [request req_1]');
			assert.equal(error.httpCode, '404');
			const going = run({ params: read, http: () => json(404, body), continueOnFail: true, executionId: '7' });
			const [[item]] = (await going.result) as any;
			assert.equal(item.json.code, 'NOT_FOUND');
			assert.equal(item.json.requestId, 'req_1');
			assert.deepEqual(item.pairedItem, { item: 0 });
		});

		it('a spend whose answer is lost says it may have been charged, with the key that gets the answer without paying twice', async () => {
			const spend = { operation: 'analyze_project', projectId: 'prj_7c2e9a4f1b3d4e8096a5', options: {} };
			const { calls, result } = run({
				params: spend,
				continueOnFail: true,
				executionId: '7',
				instanceId: 'inst',
				http: () => {
					throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
				},
			});
			const [[item]] = (await result) as any;
			const key = calls[0]!.options.headers['Idempotency-Key'];
			assert.equal(calls.length, 3, 'two retries with the same key');
			assert.ok(calls.every((c) => c.options.headers['Idempotency-Key'] === key));
			assert.equal(item.json.mayHaveSpent, true);
			assert.equal(item.json.idempotencyKey, key);
			assert.ok(item.json.error.includes(`Options > Idempotency Key set to ${key}`), item.json.error);
			assert.equal(JSON.stringify(item).includes(API_KEY), false);
		});

		it('a Base URL that would send the key in clear is refused before anything is sent', async () => {
			const { calls, result } = run({ params: read, baseUrl: 'http://api.example.com/v1', http: () => json(200, {}) });
			await assert.rejects(result, /must start with https/);
			assert.equal(calls.length, 0);
			const local = run({ params: read, baseUrl: 'http://localhost:3000', http: () => json(200, { project: {} }) });
			await local.result;
			assert.equal(local.calls[0]!.options.url, 'http://localhost:3000/v1/projects/prj_7c2e9a4f1b3d4e8096a5');
		});
	});

	describe('lists and waits', () => {
		it('Return All follows the cursors to the end, and Limit stops at its count', async () => {
			const pages = [
				json(200, { data: [{ id: 'a' }, { id: 'b' }], hasMore: true, nextCursor: 'c1' }),
				json(200, { data: [{ id: 'c' }], hasMore: false, nextCursor: null }),
			];
			const all = run({ params: { operation: 'list_projects', returnAll: true, additionalFields: {} }, http: (_o, i) => pages[i]! });
			const [items] = (await all.result) as any;
			assert.deepEqual(items.map((i: any) => i.json.id), ['a', 'b', 'c']);
			assert.equal(new URL(all.calls[1]!.options.url).searchParams.get('cursor'), 'c1');
			const some = run({ params: { operation: 'list_projects', returnAll: false, limit: 1, additionalFields: {} }, http: (_o, i) => pages[i]! });
			const [few] = (await some.result) as any;
			assert.deepEqual(few.map((i: any) => i.json.id), ['a']);
			assert.equal(new URL(some.calls[0]!.options.url).searchParams.get('limit'), '1');
		});

		it('a list whose cursor comes back again is an error, never an endless run', { timeout: 10_000 }, async () => {
			const page = json(200, { data: [{ id: 'a' }], hasMore: true, nextCursor: 'same' });
			const { result } = run({ params: { operation: 'list_projects', returnAll: true, additionalFields: {} }, http: () => page });
			await assert.rejects(result, /sent a cursor it had sent before/);
		});

		it('Wait Until Finished reads the job until it ends, and a failed job is an error with what it said', async () => {
			const started = vector('analyze_project: Analyze a project').response.body;
			const done = { job: { ...started.job, status: 'done', finishedAt: '2026-09-01T11:20:00.000Z' } };
			const ok = run({ params: { operation: 'analyze_project', projectId: 'prj_7c2e9a4f1b3d4e8096a5', options: {}, waitUntilFinished: true, waitTimeout: 5 }, executionId: '7', http: (_o, i) => (i === 0 ? json(202, started) : json(200, done)) });
			const [[item]] = (await ok.result) as any;
			assert.equal(item.json.job.status, 'done');
			assert.equal(item.json.creditsCharged, started.creditsCharged);
			const read = new URL(ok.calls[1]!.options.url);
			assert.equal(read.pathname, `/v1/jobs/${started.job.id}`);
			assert.equal(read.searchParams.get('wait'), '25');
			const failed = { job: { ...started.job, status: 'failed', errorMessage: 'The video has no sound.', finishedAt: '2026-09-01T11:20:00.000Z' } };
			const bad = run({ params: { operation: 'analyze_project', projectId: 'prj_7c2e9a4f1b3d4e8096a5', options: {}, waitUntilFinished: true, waitTimeout: 5 }, executionId: '7', http: (_o, i) => (i === 0 ? json(202, started) : json(200, failed)) });
			await assert.rejects(bad.result, (e: Error) => e.name === 'NodeApiError' && /^JOB_FAILED: job_\w+ failed\. The video has no sound\.$/.test(e.message));
		});
	});

	describe('files', () => {
		const MiB = 1024 * 1024;
		const created = (size: number, partSize: number) => ({
			upload: { id: 'upl_5d2a8f1e6c3b4079e0a1', filename: 'talk.mp4', sizeBytes: size, partSizeBytes: partSize, partCount: Math.ceil(size / partSize), receivedParts: [] },
		});
		const asset = { asset: { id: 'ast_0123456789abcdef0123' } };

		it('Upload a Video File reads the binary stream a part at a time, never the whole file', async () => {
			const size = 20 * MiB + 5;
			const partSize = 8 * MiB;
			const chunk = 64 * 1024;
			const chunks: Uint8Array[] = [];
			for (let sent = 0; sent < size; sent += chunk) chunks.push(new Uint8Array(Math.min(chunk, size - sent)).fill(sent % 251));
			const readAtPart: number[] = [];
			let streamReads: Record<string, number> = {};
			const made = makeContext({
				items: [{ json: {}, binary: { data: { id: 'filesystem-v2:1', fileName: 'talk.mp4', mimeType: 'video/mp4' } } }],
				params: { operation: 'upload_file', binaryPropertyName: 'data', additionalFields: {}, options: {} },
				streams: { 'filesystem-v2:1': { chunks, size } },
				executionId: '7',
				http: (o) => {
					if (o.url.endsWith('/v1/uploads')) return json(201, created(size, partSize));
					if (o.method === 'PUT') {
						readAtPart.push(streamReads['filesystem-v2:1']!);
						return json(200, created(size, partSize));
					}
					if (o.url.endsWith('/complete')) return json(201, asset);
					throw new Error(`unexpected ${o.method} ${o.url}`);
				},
			});
			streamReads = made.streamReads;
			const [[item]] = (await node.execute.call(made.ctx)) as any;
			assert.deepEqual(item.json, asset);
			const parts = made.calls.filter((c) => c.options.method === 'PUT');
			assert.deepEqual(parts.map((c) => c.options.body.byteLength), [partSize, partSize, 4 * MiB + 5]);
			assert.deepEqual(parts.map((c) => new URL(c.options.url).pathname.split('/').at(-1)), ['1', '2', '3']);
			readAtPart.forEach((read, i) => assert.ok(read <= (i + 1) * partSize + chunk, `part ${i + 1}: ${read} bytes read`));
			const first = made.calls[0]!.options;
			assert.deepEqual(JSON.parse(first.body), { filename: 'talk.mp4', sizeBytes: size, contentType: 'video/mp4' });
			const keys = made.calls.filter((c) => c.options.method === 'POST').map((c) => c.options.headers['Idempotency-Key']);
			assert.equal(keys.length, 2);
			assert.notEqual(keys[0], keys[1], 'open and complete are two calls, with two keys');
			for (const key of keys) assert.match(key, DERIVED);
		});

		it('an upload that fails is cancelled, unless n8n will run the node again with the same keys', async () => {
			const attempt = async (retryOnFail: boolean) => {
				const made = makeContext({
					items: [{ json: {}, binary: { data: { data: Buffer.from('abc').toString('base64'), fileName: 'a.mp4', mimeType: 'video/mp4' } } }],
					params: { operation: 'upload_file', binaryPropertyName: 'data', additionalFields: {}, options: {} },
					executionId: '7',
					retryOnFail,
					http: (o) => {
						if (o.url.endsWith('/v1/uploads')) return json(201, created(3, MiB));
						if (o.method === 'PUT') return json(409, { error: { code: 'CONFLICT', message: 'The upload is complete.' } });
						if (o.method === 'DELETE') return json(200, { uploadId: 'upl_5d2a8f1e6c3b4079e0a1', cancelled: true });
						throw new Error(`unexpected ${o.method} ${o.url}`);
					},
				});
				await assert.rejects(node.execute.call(made.ctx), /CONFLICT/);
				return made.calls.some((c) => c.options.method === 'DELETE');
			};
			assert.equal(await attempt(false), true);
			assert.equal(await attempt(true), false);
		});

		it('Download an Export reads a fresh link and fetches the file without the key', async () => {
			const exported = { export: { id: 'rnd_0123456789abcdef0123', status: 'done', downloadUrl: 'https://files.gpt-video.com/f.mp4?sig=x' } };
			const made = makeContext({
				params: { operation: 'download_export', exportId: 'rnd_0123456789abcdef0123', binaryPropertyName: 'video' },
				http: () => json(200, exported),
				plainHttp: () => ({ statusCode: 200, headers: { 'content-type': 'video/mp4' }, body: (async function* () { yield Buffer.from('MP4'); })() }),
			});
			const [[item]] = (await node.execute.call(made.ctx)) as any;
			assert.equal(Buffer.from(item.binary.video.data, 'base64').toString(), 'MP4');
			assert.equal(item.binary.video.mimeType, 'video/mp4');
			const get = made.plainCalls[0]!.options;
			assert.equal(get.url, exported.export.downloadUrl);
			assert.equal(get.headers.Authorization, undefined, 'the link is its own credential');
			assert.equal(get.disableFollowRedirect, true);
		});

		it('a download redirected to an address that is not https stops before going there', async () => {
			const exported = { export: { id: 'rnd_0123456789abcdef0123', status: 'done', downloadUrl: 'https://files.gpt-video.com/f.mp4' } };
			const made = makeContext({
				params: { operation: 'download_export', exportId: 'rnd_0123456789abcdef0123', binaryPropertyName: 'video' },
				http: () => json(200, exported),
				plainHttp: () => ({ statusCode: 302, headers: { location: 'http://evil.example.com/f.mp4' }, body: null }),
			});
			await assert.rejects(node.execute.call(made.ctx), /not https/);
			assert.equal(made.plainCalls.length, 1);
		});
	});

	describe('pauses', () => {
		it('end on the signal of the execution, and let go of it when they end', async () => {
			const controller = new AbortController();
			for (let i = 0; i < 25; i++) assert.equal(await pause(1, controller.signal), true);
			assert.equal(getEventListeners(controller.signal, 'abort').length, 0, 'no listener is left on the signal of the execution');
			const stopped = pause(60_000, controller.signal);
			controller.abort();
			assert.equal(await stopped, false);
			assert.equal(await pause(1, controller.signal), false, 'a stopped execution does not pause');
		});

		it('end on the signal even in an n8n whose sleep takes no signal', { timeout: 5_000 }, async () => {
			const controller = new AbortController();
			const deaf = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms).unref());
			const stopped = pause(60_000, controller.signal, deaf);
			controller.abort();
			assert.equal(await stopped, false);
			assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
		});
	});
});
