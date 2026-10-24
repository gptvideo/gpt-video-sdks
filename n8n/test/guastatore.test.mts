/**
 * The saboteur's list for the n8n nodes: the ways the node could charge twice, leak the key, or start a workflow
 * on a forged delivery, each tried from a road the other tests do not take. The invariants: one intention, one
 * key, on every attempt and every wait; the key goes nowhere but the credential n8n adds; the Trigger accepts only
 * bytes signed with the secret; the package installs nothing.
 */

import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';

import { GptVideo } from '../nodes/GptVideo/GptVideo.node.ts';
import { GptVideoTrigger } from '../nodes/GptVideoTrigger/GptVideoTrigger.node.ts';
import { API_KEY, type ContextSetup, json, makeContext } from './support/context.mts';
import { readPackage, readVectors } from './support/vectors.mts';

const KEYS = readVectors('keys.json');
const DERIVED = new RegExp(KEYS.generators.n8n.pattern);
const node = new GptVideo();
const spend = { operation: 'analyze_project', projectId: 'prj_7c2e9a4f1b3d4e8096a5', options: {} };
const accepted = () => json(202, { job: { id: 'job_1', status: 'queued', finishedAt: null }, creditsCharged: 3 });
const apiError = (code: string, status: number, headers: Record<string, string> = {}) => json(status, { error: { code, message: `${code} happened.` } }, headers);

const run = (setup: ContextSetup) => {
	const made = makeContext(setup);
	return { ...made, result: node.execute.call(made.ctx) };
};

/** Every own property of a value, walked, and the stack of an error: true when the key is anywhere in it. */
function leaks(value: unknown): boolean {
	const seen = new Set<unknown>();
	const walk = (v: unknown): string => {
		if (v === null || typeof v !== 'object') return String(v);
		if (seen.has(v)) return '';
		seen.add(v);
		return Object.getOwnPropertyNames(v)
			.map((k) => `${k}:${walk((v as any)[k])}`)
			.join(' ');
	};
	return walk(value).includes(API_KEY.slice(4)) || String((value as Error)?.stack).includes(API_KEY.slice(4));
}

beforeEach(() => {
	mock.method(Math, 'random', () => 0);
});
afterEach(() => {
	mock.restoreAll();
});

describe('G1. a spend is charged at most once per intention', () => {
	it('sends one key on every attempt and every wait for IDEMPOTENCY_IN_PROGRESS, which never uses up a retry', async () => {
		const answers = [apiError('INTERNAL', 500), apiError('IDEMPOTENCY_IN_PROGRESS', 409, { 'retry-after': '0' }), apiError('IDEMPOTENCY_IN_PROGRESS', 409, { 'retry-after': '0' }), apiError('UPSTREAM_FAILED', 502), accepted()];
		const { calls, result } = run({ params: spend, executionId: '7', instanceId: 'inst', http: (_o, i) => answers[i]! });
		const [[item]] = (await result) as any;
		assert.equal(item.json.job.id, 'job_1');
		const keys = calls.map((c) => c.options.headers['Idempotency-Key']);
		assert.equal(keys.length, 5);
		assert.match(keys[0]!, DERIVED);
		assert.equal(new Set(keys).size, 1, 'one key for the whole call');
	});

	it('keeps the key on Retry On Fail, and gives another instance with the same execution number another key', async () => {
		const nodeContext = {};
		const tries = [run({ params: spend, executionId: '7', instanceId: 'inst', nodeContext, retryOnFail: true, http: () => accepted() }), run({ params: spend, executionId: '7', instanceId: 'inst', nodeContext, retryOnFail: true, http: () => accepted() })];
		await Promise.all(tries.map((t) => t.result));
		const [a, b] = tries.map((t) => t.calls[0]!.options.headers['Idempotency-Key']);
		assert.equal(a, b, 'the same intention, tried again by n8n');
		const elsewhere = run({ params: spend, executionId: '7', instanceId: 'another-instance', nodeContext: {}, http: () => accepted() });
		await elsewhere.result;
		assert.notEqual(elsewhere.calls[0]!.options.headers['Idempotency-Key'], a, 'another instance with execution 7 is another intention');
	});

	it('a key the API says was reused is a refusal sent once, never a call with a fresh key', async () => {
		const { calls, result } = run({ params: { ...spend, options: { idempotencyKey: 'order-42' } }, executionId: '7', instanceId: 'inst', http: () => apiError('IDEMPOTENCY_KEY_REUSED', 422) });
		await assert.rejects(result, /IDEMPOTENCY_KEY_REUSED \(422\)/);
		assert.deepEqual(
			calls.map((c) => c.options.headers['Idempotency-Key']),
			['order-42'],
		);
	});
});

describe('G2. the key goes nowhere but the credential', () => {
	it('is in no error of the node, even when the helper throws with the request headers and the key in its message', async () => {
		const thrower = () => {
			throw Object.assign(new Error(`request failed with Authorization: Bearer ${API_KEY}`), { code: 'ECONNRESET', response: { headers: { authorization: `Bearer ${API_KEY}` } } });
		};
		const failing = run({ params: spend, executionId: '7', instanceId: 'inst', http: thrower });
		const error: any = await failing.result.then(
			() => assert.fail('no error'),
			(e) => e,
		);
		assert.match(error.message, /^CONNECTION_FAILED: The connection to the API failed \(ECONNRESET\)\./);
		assert.equal(leaks(error), false);
		assert.equal(JSON.stringify(error, Object.getOwnPropertyNames(error)).includes(API_KEY.slice(4)), false);
		const going = run({ params: spend, executionId: '7', instanceId: 'inst', continueOnFail: true, http: thrower });
		const items = (await going.result) as any;
		assert.equal(leaks(items), false, 'Continue On Fail returns the error as an item, without the key');
		assert.equal(items[0][0].json.mayHaveSpent, true);
	});

	it('never writes the key into a request itself, and never into a URL', async () => {
		const { calls, result } = run({ params: spend, executionId: '7', instanceId: 'inst', http: () => accepted() });
		await result;
		const o = calls[0]!.options;
		assert.equal(o.headers.Authorization, undefined, 'n8n adds the credential, the node never does');
		assert.equal(JSON.stringify(o).includes(API_KEY.slice(4)), false);
	});
});

describe('G3. the Trigger starts a workflow only on bytes signed with the secret', () => {
	const trigger = new GptVideoTrigger();
	const secretBytes = Buffer.from('abcdefghijklmnopqrstuvwxyz012345');
	const secret = `whsec_${secretBytes.toString('base64')}`;
	const id = 'wev_32aeca77d094a0e08a11';
	const timestamp = 1767225600;
	const sign = (content: string) => createHmac('sha256', secretBytes).update(content).digest('base64');
	// a body whose signature holds a + or a /, so its base64url form differs from the standard one beyond the padding
	const bodyOf = (n: number) => `{"type":"job.completed","timestamp":"2026-01-01T00:00:00.000Z","data":{"jobId":"job_${n}","kind":"analysis"}}`;
	let nonce = 0;
	while (!/[+/]/.test(sign(`${id}.${timestamp}.${bodyOf(nonce)}`))) nonce++;
	const body = bodyOf(nonce);
	const good = sign(`${id}.${timestamp}.${body}`);
	const raw = Buffer.from(good, 'base64');

	function hook(signature: string, options: { secret?: string; rawBody?: unknown } = {}) {
		const response = { statusCode: 200, body: undefined as unknown };
		const ctx: any = {
			getRequestObject: () => ({ rawBody: options.rawBody ?? Buffer.from(body), headers: { 'webhook-id': id, 'webhook-timestamp': String(timestamp), 'webhook-signature': signature } }),
			getResponseObject: () => ({
				status(code: number) {
					response.statusCode = code;
					return this;
				},
				json(value: unknown) {
					response.body = value;
					return this;
				},
			}),
			getCredentials: async () => ({ signingSecret: options.secret ?? secret }),
			getBodyData: () => JSON.parse(body),
			getNodeParameter: (name: string, fallback: unknown) => (name === 'events' ? [] : fallback),
		};
		return { result: trigger.webhook.call(ctx), response };
	}

	it('accepts the signature with and without its padding, and among wrong ones', async () => {
		mock.method(Date, 'now', () => timestamp * 1000);
		assert.ok(good.endsWith('='));
		for (const header of [`v1,${good}`, `v1,${good.replace(/=+$/, '')}`, `v1,${sign('x')} v2,${good} v1,${good}`]) {
			const { result, response } = hook(header);
			const got = await result;
			assert.equal(response.statusCode, 200, header);
			assert.equal((got.workflowData as any)[0][0].json.webhookId, id, header);
		}
	});

	it('answers 401 and starts nothing on another scheme, base64url, 31 or 33 bytes, a wrong secret or an API key as the secret', async () => {
		mock.method(Date, 'now', () => timestamp * 1000);
		const cases: [string, string, { secret?: string }][] = [
			['v2', `v2,${good}`, {}],
			['v1a', `v1a,${good}`, {}],
			['base64url', `v1,${raw.toString('base64url')}`, {}],
			['31 bytes', `v1,${raw.subarray(0, 31).toString('base64')}`, {}],
			['33 bytes', `v1,${Buffer.concat([raw, Buffer.from([0])]).toString('base64')}`, {}],
			['none right', `v1,${sign('a')} v1,${sign('b')}`, {}],
			['another secret', `v1,${good}`, { secret: `whsec_${Buffer.from('ABCDEFGHIJKLMNOPQRSTUVWXYZ543210').toString('base64')}` }],
			['an API key', `v1,${good}`, { secret: API_KEY }],
		];
		for (const [name, header, options] of cases) {
			const { result, response } = hook(header, options);
			const got = await result;
			assert.equal(got.workflowData, undefined, name);
			assert.equal(response.statusCode, 401, name);
			assert.equal(JSON.stringify(response.body).includes(API_KEY.slice(4)), false, name);
			assert.equal(JSON.stringify(response.body).includes(good), false, name);
		}
		assert.match(good, /[+/]/, 'the base64url form differs for this signature beyond the padding, or the case proves nothing');
	});
});

describe('G7. the package installs nothing', () => {
	it('declares no dependency and runs no script on install', () => {
		const pkg = readPackage() as any;
		assert.equal(pkg.dependencies, undefined);
		assert.equal(pkg.optionalDependencies, undefined);
		for (const name of ['preinstall', 'install', 'postinstall', 'prepare']) assert.equal(pkg.scripts?.[name], undefined, name);
		// `private` is asserted by package.test.mts, which the publish patch rewrites; a second assertion here would
		// turn red the day the package is published (found by the gate of wave 7 on the patched tree)
	});
});
