/**
 * requests.generated.json, the shared request vectors: for every example of the API reference, the request the
 * node builds (path, query, JSON body, bytes, Idempotency-Key) and what it makes of the answer, field by field.
 * keys.json: the keys the node accepts from a user and the keys it makes. Both run on the engine of the node.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { CONVENTIONS, OPERATIONS, RETRYABLE_CODES } from '../nodes/GptVideo/operations.generated.ts';
import { send } from '../nodes/GptVideo/transport/call.ts';
import { GptVideoCallError } from '../nodes/GptVideo/transport/errors.ts';
import { derivedKey, keyFor } from '../nodes/GptVideo/transport/key.ts';
import { buildRequest, resolveBaseUrl } from '../nodes/GptVideo/transport/request.ts';
import { isIdempotencyKey } from '../nodes/GptVideo/transport/rules.ts';
import { VirtualClock, scriptedIo } from './support/clock.mts';
import { readVectors } from './support/vectors.mts';

const VECTORS = readVectors('requests.generated.json');
const KEYS = readVectors('keys.json');
const DERIVED = new RegExp(KEYS.generators.n8n.pattern);
const PARTS = { instanceId: 'inst', workflowId: 'wf', executionId: '41', nodeId: 'node', runIndex: 0, itemIndex: 0 };
const BASE = resolveBaseUrl(VECTORS.baseUrl, CONVENTIONS.baseUrl);
const rowOf = (id: string) => {
	const row = OPERATIONS.find((r) => r.id === id);
	assert.ok(row, `the table of the node has no ${id}`);
	return row;
};

/** The path segments and the query of a URL, decoded the way a server decodes them. */
function decoded(url: string) {
	const parsed = new URL(url);
	const base = new URL(VECTORS.baseUrl);
	assert.ok(parsed.pathname.startsWith(`${base.pathname}/`), url);
	const segments = parsed.pathname.slice(base.pathname.length + 1).split('/').map(decodeURIComponent);
	const query: Record<string, string> = {};
	for (const [name, value] of parsed.searchParams) {
		assert.ok(!(name in query), `${url}: ${name} twice`);
		query[name] = value;
	}
	return { segments, query };
}

function requestOf(v: any) {
	const row = rowOf(v.operation);
	const key = row.idempotencyKey === 'none' ? null : keyFor(v.options?.idempotencyKey, { ...PARTS, call: row.id }, true);
	const bytes = typeof v.bodyBytes === 'number' ? new Uint8Array(v.bodyBytes) : undefined;
	return { row, key, request: buildRequest(BASE, CONVENTIONS, row, v.input, bytes, key, 'test') };
}

describe('requests.generated.json on the engine of the n8n node', () => {
	it('was generated from the same contract as the table of the node', () => {
		assert.ok(VECTORS.vectors.length >= 100);
		assert.equal(VECTORS.baseUrl, CONVENTIONS.baseUrl);
	});

	for (const v of [...VECTORS.vectors, ...VECTORS.encoding]) {
		it(v.name, async () => {
			const { row, key, request } = requestOf(v);
			const want = v.request;
			assert.equal(request.method, want.method);
			const got = decoded(request.url);
			assert.deepEqual(got.segments, want.segments);
			assert.deepEqual(got.query, want.query);
			if (!('contentType' in want)) return; // an encoding vector checks the URL only
			assert.equal(request.headers['Content-Type'] ?? null, want.contentType);
			assert.deepEqual(typeof request.body === 'string' ? JSON.parse(request.body) : null, want.json);
			assert.equal(request.body instanceof Uint8Array ? request.body.byteLength : null, want.bytes);
			const sent = request.headers['Idempotency-Key'];
			if (want.idempotencyKey === 'none') assert.equal(sent, undefined);
			else if (want.idempotencyKey === 'caller') assert.equal(sent, v.options.idempotencyKey);
			else assert.match(sent!, DERIVED);

			// one attempt decides: the answer, or the error with the fields the rules give it
			const clock = new VirtualClock(Date.parse('2026-10-11T12:00:00.000Z'));
			const script = scriptedIo(clock, [{ status: v.response.status, headers: v.response.headers, json: v.response.body }]);
			const ctx = { io: script.io, conventions: CONVENTIONS, retryable: new Set(RETRYABLE_CODES) };
			const outcome = await clock.drive(send(ctx, row, request, { idempotencyKey: key, limits: { maxRetries: 0 } }));
			if (v.outcome.kind === 'result') {
				assert.equal(outcome.error, undefined, String((outcome.error as Error | undefined)?.message));
				assert.deepEqual((outcome.value as any).body, v.response.body);
				return;
			}
			assert.ok(outcome.error instanceof GptVideoCallError);
			const d = outcome.error.detail;
			const e = v.outcome.error;
			assert.equal(d.kind, e.class);
			for (const field of ['code', 'status', 'retryable', 'mayHaveSpent', 'retryAfterSec', 'requestId', 'hint', 'details'] as const) {
				assert.deepEqual(d[field], e[field], field);
			}
		});
	}
});

describe('keys.json', () => {
	it('every key the API accepts is accepted from the user, and every key it refuses is refused before sending', () => {
		for (const { key, why } of KEYS.valid) assert.ok(isIdempotencyKey(key), why);
		for (const { key, why } of KEYS.invalid) {
			assert.ok(!isIdempotencyKey(key), why);
			// an empty n8n field is a field left empty: the node makes the key, it never sends an empty one
			if (key === '') assert.match(keyFor(key, { ...PARTS, call: 'x' }, true), DERIVED);
			else assert.throws(() => keyFor(key, { ...PARTS, call: 'x' }, true), /Idempotency Key/, why);
		}
	});

	it('the key the node makes has the form keys.json gives it, and one form only', () => {
		const key = derivedKey({ ...PARTS, call: 'analyze_project' });
		assert.match(key, DERIVED);
		assert.ok(isIdempotencyKey(key));
		assert.match(KEYS.generators.n8n.example, DERIVED);
	});

	it('the key is one per intention: the same for the same call, new when any part of it changes', () => {
		const base = { ...PARTS, call: 'analyze_project' };
		assert.equal(derivedKey(base), derivedKey({ ...base }), 'n8n running the node again for the same item');
		for (const [part, value] of [
			['instanceId', 'another-instance'],
			['workflowId', 'wf2'],
			['executionId', '42'],
			['nodeId', 'node2'],
			['runIndex', 1],
			['itemIndex', 1],
			['call', 'create_export'],
		] as const) {
			assert.notEqual(derivedKey({ ...base, [part]: value }), derivedKey(base), part);
		}
		// the parts are kept apart: moving a character from one part to the next makes another key
		assert.notEqual(derivedKey({ ...base, workflowId: 'w', executionId: 'f41' }), derivedKey({ ...base, workflowId: 'wf', executionId: '41' }));
	});

	it("a user's key is sent as it is for one call, and named after each call when an item makes several", () => {
		assert.equal(keyFor('order-42', { ...PARTS, call: 'analyze_project' }, true), 'order-42');
		assert.equal(keyFor('order-42', { ...PARTS, call: 'upload_file:create' }, false), 'order-42:upload_file:create');
		assert.equal(keyFor('', { ...PARTS, call: 'analyze_project' }, true), derivedKey({ ...PARTS, call: 'analyze_project' }));
		assert.throws(() => keyFor('k'.repeat(250), { ...PARTS, call: 'upload_file:complete' }, false), /Idempotency Key/);
	});
});
