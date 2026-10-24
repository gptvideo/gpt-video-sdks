/**
 * Every scenario of retry.json, the shared retry vectors, run on the engine of the node with a scripted network
 * and a virtual clock: the requests, the Idempotency-Key of each, every pause, the time the call took, and the
 * result or the error, field by field. Each scenario runs with the random draw of the backoff at 0, 0.5 and just
 * under 1, so a backoff is checked at both ends of its range.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { CONVENTIONS, RETRYABLE_CODES } from '../nodes/GptVideo/operations.generated.ts';
import { type RetryEvent, send } from '../nodes/GptVideo/transport/call.ts';
import { GptVideoCallError, GptVideoInputError } from '../nodes/GptVideo/transport/errors.ts';
import { keyFor } from '../nodes/GptVideo/transport/key.ts';
import { buildRequest, resolveBaseUrl } from '../nodes/GptVideo/transport/request.ts';
import type { OperationRow } from '../nodes/GptVideo/transport/table.ts';
import { VirtualClock, expand, scriptedIo } from './support/clock.mts';
import { readVectors } from './support/vectors.mts';

const RETRY = readVectors('retry.json');
const KEYS = readVectors('keys.json');
const DERIVED = new RegExp(KEYS.generators.n8n.pattern);
const RANDOMS = [0, 0.5, 0.999999];
const PARTS = { instanceId: 'inst', workflowId: 'wf', executionId: '41', nodeId: 'node', runIndex: 0, itemIndex: 0 };

function rowOf(name: string): OperationRow {
	const op = RETRY.operations[name];
	return {
		id: `${name}_call`,
		name: `${name}Call`,
		method: op.method,
		path: '/v1/things/{thingId}',
		pathParams: ['thingId'],
		inQuery: op.method === 'GET',
		binary: null,
		effect: op.effect,
		idempotencyKey: op.idempotencyKey,
		retrySafe: op.retrySafe,
		async: null,
		paginated: false,
		successStatus: 200,
	};
}

async function run(sc: any, random: number) {
	const clock = new VirtualClock(Date.parse(sc.now ?? RETRY.defaults.now));
	const cancel = new AbortController();
	const o = sc.options ?? {};
	if (o.abortedBeforeStart) cancel.abort();
	if (o.abortAfterMs !== undefined) clock.at(o.abortAfterMs, () => cancel.abort());
	const script = scriptedIo(clock, expand(sc.responses), { random: () => random, cancel: cancel.signal });
	const retries: RetryEvent[] = [];
	const row = rowOf(sc.operation);
	const limits: Record<string, number> = {};
	for (const name of ['maxRetries', 'timeoutMs', 'deadlineMs']) if (o[name] !== undefined) limits[name] = o[name];
	const call = async () => {
		// the key is made, or the caller's checked, before anything is sent: a refused key sends nothing
		const key = row.idempotencyKey === 'none' ? null : keyFor(o.idempotencyKey, { ...PARTS, call: row.id }, true);
		const request = buildRequest(resolveBaseUrl(undefined, CONVENTIONS.baseUrl), CONVENTIONS, row, { thingId: 'thing_1' }, undefined, key, 'test');
		return send({ io: script.io, conventions: CONVENTIONS, retryable: new Set(RETRYABLE_CODES), onRetry: (e) => retries.push(e) }, row, request, {
			idempotencyKey: key,
			limits,
		});
	};
	const outcome = await clock.drive(call());
	return { script, retries, ...outcome };
}

describe('retry.json on the engine of the n8n node', () => {
	it('has the scenarios this runner expects', () => {
		assert.equal(RETRY.version, 1);
		assert.ok(RETRY.scenarios.length >= 40);
	});

	for (const sc of RETRY.scenarios) {
		for (const random of RANDOMS) {
			it(`${sc.name} (random ${random})`, async () => {
				const got = await run(sc, random);
				const want = sc.expect;
				const o = sc.options ?? {};
				assert.equal(got.script.calls.length, want.requests, 'requests');
				assert.equal(got.script.left, 0, 'answers left unused');

				const keys = got.script.calls.map((c) => c.request.headers['Idempotency-Key']);
				if (want.requests > 0) {
					if (want.key === 'none') assert.ok(keys.every((k) => k === undefined), 'no key on any request');
					else {
						assert.equal(new Set(keys).size, 1, 'one key on every request');
						if (want.key === 'caller') assert.equal(keys[0], o.idempotencyKey);
						else assert.match(keys[0]!, DERIVED);
					}
				}

				assert.deepEqual(got.retries.map((r) => r.code), want.sleeps.map((s: any) => s.after), 'pauses');
				want.sleeps.forEach((s: any, i: number) => {
					const ms = 'ms' in s ? s.ms : Math.floor(random * Math.min(RETRY.defaults.backoff.capMs, RETRY.defaults.backoff.baseMs * 2 ** s.backoff));
					assert.equal(got.retries[i]?.attempt, i + 1, `pause ${i + 1} follows attempt ${i + 1}`);
					assert.equal(got.retries[i]?.delayMs, ms, `pause ${i + 1}`);
				});
				if ('elapsedMs' in want) assert.equal(got.at, want.elapsedMs, 'elapsedMs');

				if ('result' in want) {
					assert.equal(got.error, undefined, String((got.error as Error | undefined)?.message));
					assert.equal((got.value as any).answer.status, want.result.status);
					assert.deepEqual((got.value as any).body, expand(sc.responses).at(-1)?.json);
					return;
				}
				const e = want.error;
				if (e.class === 'local') {
					assert.ok(got.error instanceof GptVideoInputError, 'a mistake found before sending');
					assert.equal(e.code, 'INVALID_ARGUMENT');
					return;
				}
				assert.ok(got.error instanceof GptVideoCallError, String(got.error));
				const d = got.error.detail;
				assert.equal(d.kind, e.class);
				assert.equal(d.code, e.code);
				assert.equal(d.status, e.status, 'status');
				assert.equal(d.retryable, e.retryable, 'retryable');
				assert.equal(d.mayHaveSpent, e.mayHaveSpent, 'mayHaveSpent');
				assert.equal(d.retryAfterSec, e.retryAfterSec, 'retryAfterSec');
				if ('requestId' in e) assert.equal(d.requestId, e.requestId);
				if (e.key === null) assert.equal(d.idempotencyKey, null);
				else if (e.key === 'caller') assert.equal(d.idempotencyKey, o.idempotencyKey);
				else assert.equal(d.idempotencyKey, keys[0] ?? d.idempotencyKey);
				if (e.key === 'generated') assert.match(d.idempotencyKey!, DERIVED);
				assert.ok(d.message.startsWith(e.code), d.message);
				// the sentence about a charge, with the key to send again, goes with mayHaveSpent and only with it
				assert.equal(d.message.includes('may have been charged'), e.mayHaveSpent);
				if (e.mayHaveSpent) assert.ok(d.message.includes(d.idempotencyKey!), 'the message names the key to send again');
			});
		}
	}
});
