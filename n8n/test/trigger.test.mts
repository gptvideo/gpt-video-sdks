/**
 * The GPT-Video Trigger in a stand-in of n8n's webhook context: a delivery signed right starts the workflow with
 * the event, anything else is answered 401 and starts nothing, and an event the workflow does not want is
 * received without starting it.
 */

import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';

import { GptVideoTrigger } from '../nodes/GptVideoTrigger/GptVideoTrigger.node.ts';
import { WEBHOOK_EVENTS } from '../nodes/GptVideoTrigger/events.generated.ts';
import { readVectors } from './support/vectors.mts';

const DOC = readVectors('webhooks.generated.json');
const SERVER = DOC.cases.find((c: any) => c.name === 'a delivery as the server sends it');
const SECRET = `${DOC.secretPrefix}${DOC.secrets[SERVER.secretNames[0]]}`;
const trigger = new GptVideoTrigger();

function hook(options: { rawBody?: unknown; headers?: Record<string, unknown>; secret?: string; events?: string[] }) {
	const response = { statusCode: 200, body: undefined as unknown };
	const ctx: any = {
		getRequestObject: () => ({ rawBody: options.rawBody, headers: options.headers ?? SERVER.headers }),
		getResponseObject: () => ({
			status(code: number) {
				response.statusCode = code;
				return this;
			},
			json(body: unknown) {
				response.body = body;
				return this;
			},
		}),
		getCredentials: async () => ({ signingSecret: options.secret ?? SECRET }),
		getBodyData: () => JSON.parse(SERVER.body),
		getNodeParameter: (name: string, fallback: unknown) => (name === 'events' ? (options.events ?? []) : fallback),
	};
	return { result: trigger.webhook.call(ctx), response };
}

afterEach(() => mock.restoreAll());

describe('the GPT-Video Trigger', () => {
	const at = () => mock.method(Date, 'now', () => SERVER.nowSec * 1000);

	it('starts the workflow with the event and its webhook id when the signature matches the raw body', async () => {
		at();
		const { result, response } = hook({ rawBody: Buffer.from(SERVER.body) });
		const got = await result;
		const event = JSON.parse(SERVER.body);
		assert.deepEqual(got.workflowData, [[{ json: { ...event, webhookId: SERVER.expect.id, webhookTimestamp: SERVER.expect.timestamp } }]]);
		assert.equal(response.statusCode, 200);
	});

	it('answers 401 and starts nothing on a wrong secret, a changed body, an old delivery or no raw body', async () => {
		const other = `${DOC.secretPrefix}${DOC.secrets.unrelated}`;
		const cases = [
			{ name: 'wrong secret', options: { rawBody: Buffer.from(SERVER.body), secret: other }, reason: 'no_matching_signature', now: SERVER.nowSec },
			{ name: 'changed body', options: { rawBody: Buffer.from(`${SERVER.body} `) }, reason: 'no_matching_signature', now: SERVER.nowSec },
			{ name: 'old delivery', options: { rawBody: Buffer.from(SERVER.body) }, reason: 'timestamp_outside_tolerance', now: SERVER.nowSec + 301 },
			{ name: 'no raw body', options: {}, reason: 'body_not_raw', now: SERVER.nowSec },
			{ name: 'an API key as the secret', options: { rawBody: Buffer.from(SERVER.body), secret: `gvk_${'A'.repeat(43)}` }, reason: 'bad_secret', now: SERVER.nowSec },
		];
		for (const c of cases) {
			mock.restoreAll();
			mock.method(Date, 'now', () => c.now * 1000);
			const { result, response } = hook(c.options);
			const got = await result;
			assert.equal(got.workflowData, undefined, c.name);
			assert.equal(got.noWebhookResponse, true, c.name);
			assert.equal(response.statusCode, 401, c.name);
			assert.equal((response.body as any).error.reason, c.reason, c.name);
			assert.equal(JSON.stringify(response.body).includes('gvk_A'), false, 'the answer never repeats a key');
		}
	});

	it('receives an event the workflow does not want, without starting it, so it is not sent again', async () => {
		at();
		const { result } = hook({ rawBody: Buffer.from(SERVER.body), events: ['export.failed'] });
		const got = await result;
		assert.equal(got.workflowData, undefined);
		assert.deepEqual(got.webhookResponse, { received: true });
		const wanted = await hook({ rawBody: Buffer.from(SERVER.body), events: [JSON.parse(SERVER.body).type] }).result;
		assert.ok(wanted.workflowData);
	});

	it('offers every event the API sends, and tests a signing secret by its form', async () => {
		assert.deepEqual(trigger.description.properties.find((p) => p.name === 'events')!.options, WEBHOOK_EVENTS);
		const test = trigger.methods.credentialTest.gptVideoWebhookSecretTest;
		const ok = await test.call({} as any, { id: '1', name: 'x', type: 'gptVideoWebhookApi', data: { signingSecret: SECRET } });
		assert.equal(ok.status, 'OK');
		const bad = await test.call({} as any, { id: '1', name: 'x', type: 'gptVideoWebhookApi', data: { signingSecret: 'gvk_abc' } });
		assert.equal(bad.status, 'Error');
		assert.match(bad.message, /not a webhook signing secret/);
	});

	it('is a trigger n8n can list: no input, a webhook, the credential tested by the node', () => {
		const d = trigger.description;
		assert.deepEqual(d.inputs, []);
		assert.equal(d.webhooks?.[0]?.httpMethod, 'POST');
		assert.equal(d.credentials?.[0]?.testedBy, 'gptVideoWebhookSecretTest');
		assert.equal((d as { usableAsTool?: boolean }).usableAsTool, undefined, 'a trigger is never a tool');
		// without it, a real n8n answers a started workflow with the text "firstEntryJson"
		assert.equal(d.webhooks?.[0]?.responseData, 'noData');
	});

	it('turns on with a signing secret that can check a delivery, sends nothing anywhere, and stops on one that cannot', async () => {
		const lifecycle = trigger.webhookMethods.default;
		const hookCtx = (signingSecret: string) => {
			const sent: unknown[] = [];
			const ctx: any = {
				getNode: () => ({ name: 'GPT-Video Trigger' }),
				getCredentials: async () => ({ signingSecret }),
				helpers: new Proxy({}, { get: () => (...args: unknown[]) => sent.push(args) }),
			};
			return { ctx, sent };
		};
		const good = hookCtx(SECRET);
		assert.equal(await lifecycle.checkExists.call(good.ctx), false, 'there is nothing on GPT-Video to look up');
		assert.equal(await lifecycle.create.call(good.ctx), true);
		assert.equal(await lifecycle.delete.call(good.ctx), true);
		assert.deepEqual(good.sent, [], 'the lifecycle makes no request');
		const apiKey = `gvk_${'A'.repeat(43)}`;
		for (const [secret, why] of [
			[apiKey, /not a webhook signing secret/],
			['whsec_not base64!', /standard base64/],
			['', /no signing secret/],
		] as const) {
			const bad = hookCtx(secret);
			await assert.rejects(lifecycle.create.call(bad.ctx), (e: Error) => e.name === 'NodeOperationError' && why.test(e.message) && !e.message.includes(apiKey));
		}
	});
});
