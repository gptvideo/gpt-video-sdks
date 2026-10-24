/**
 * webhooks.generated.json, the shared webhook vectors, on the check of the GPT-Video Trigger: every delivery the
 * SDKs accept is accepted here, and every one they refuse is refused for the same reason.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { fromStandardBase64, secretBytes, verifySignature } from '../nodes/GptVideoTrigger/signature.ts';
import { readVectors } from './support/vectors.mts';

const DOC = readVectors('webhooks.generated.json');

function secretsOf(c: any): string[] {
	if (c.secretText !== null) return [c.secretText];
	return c.secretNames.map((name: string) => `${DOC.secretPrefix}${DOC.secrets[name]}`);
}

/** A case with a text body runs twice: with the text, and with its UTF-8 bytes. */
function bodiesOf(c: any): { label: string; body: unknown }[] {
	if (c.bodyParsed !== null) return [{ label: 'parsed', body: c.bodyParsed }];
	if (c.bodyBase64 !== null) return [{ label: 'bytes', body: new Uint8Array(Buffer.from(c.bodyBase64, 'base64')) }];
	return [
		{ label: 'text', body: c.body },
		{ label: 'bytes', body: new TextEncoder().encode(c.body) },
	];
}

describe('webhooks.generated.json on the GPT-Video Trigger', () => {
	it('has the cases this runner expects', () => {
		assert.ok(DOC.cases.length >= 40);
		assert.equal(DOC.secretPrefix, 'whsec_');
		assert.equal(DOC.defaultToleranceSec, 300);
	});

	for (const c of DOC.cases) {
		for (const { label, body } of bodiesOf(c)) {
			it(`${c.name} (${label})`, () => {
				const got = verifySignature({
					secrets: secretsOf(c),
					headers: c.headers,
					body,
					nowMs: c.nowSec * 1000,
					...(c.toleranceSec === null ? {} : { toleranceSec: c.toleranceSec }),
				});
				if (c.expect.ok) assert.deepEqual(got, { ok: true, id: c.expect.id, timestamp: c.expect.timestamp });
				else {
					assert.equal(got.ok, false);
					assert.equal((got as { reason: string }).reason, c.expect.reason);
				}
			});
		}
	}

	it('a delivery signed right is refused when one byte of its body changes, at any position', () => {
		const c = DOC.cases.find((x: any) => x.expect.ok && x.body && x.secretNames.length === 1);
		const bytes = new TextEncoder().encode(c.body);
		for (let i = 0; i < bytes.length; i++) {
			const changed = bytes.slice();
			changed[i]! ^= 1;
			const got = verifySignature({ secrets: secretsOf(c), headers: c.headers, body: changed, nowMs: c.nowSec * 1000 });
			assert.equal(got.ok, false, `byte ${i}`);
		}
	});

	it('reads standard base64 and nothing else', () => {
		assert.deepEqual(fromStandardBase64('AAEC'), new Uint8Array([0, 1, 2]));
		assert.deepEqual(fromStandardBase64('AAE'), new Uint8Array([0, 1]));
		for (const bad of ['', 'A', 'AA-_', 'AA E', 'AAE==', '=AAE', 'AA==AA']) assert.equal(fromStandardBase64(bad), null, bad);
	});

	it('says why a secret cannot be one, and never accepts an API key as one', () => {
		const key = `gvk_${'A'.repeat(43)}`;
		for (const bad of ['', 'whsec_', 'secret', key, 'whsec_ab-_']) assert.equal(secretBytes(bad) instanceof Uint8Array, false, bad);
		const refused = secretBytes(key) as { message: string };
		assert.match(refused.message, /API key/);
		assert.ok(!refused.message.includes(key), 'the message never repeats the key');
	});
});
