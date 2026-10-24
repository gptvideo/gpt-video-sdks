import type {
	ICredentialDataDecryptedObject,
	ICredentialTestFunctions,
	ICredentialsDecrypted,
	IDataObject,
	IHookFunctions,
	INodeCredentialTestResult,
	INodeType,
	INodeTypeDescription,
	IWebhookFunctions,
	IWebhookResponseData,
} from 'n8n-workflow';
import { NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';

import { WEBHOOK_EVENTS } from './events.generated.ts';
import { secretBytes, verifySignature } from './signature.ts';

/** The name of the credential that holds the signing secret. */
export const WEBHOOK_CREDENTIAL = 'gptVideoWebhookApi';

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Starts a workflow when GPT-Video sends a webhook: a job or an export that ended, or a test event. The node
 * checks the signature of every delivery against the signing secret of the credential, on the bytes that
 * arrived, and answers 401 without starting anything when it does not match.
 *
 * GPT-Video's API has no call that registers a webhook, so the address of this node is added by hand on the
 * Developers page of the GPT-Video app, which shows the signing secret to put in the credential.
 */
export class GptVideoTrigger implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'GPT-Video Trigger',
		name: 'gptVideoTrigger',
		icon: { light: 'file:../../icons/gptVideo.svg', dark: 'file:../../icons/gptVideo.dark.svg' },
		group: ['trigger'],
		version: 1,
		subtitle: '={{($parameter["events"] || []).length ? $parameter["events"].join(", ") : "every event"}}',
		description: 'Starts the workflow when a GPT-Video job or export ends',
		defaults: {
			name: 'GPT-Video Trigger',
		},
		inputs: [],
		outputs: [NodeConnectionTypes.Main],
		credentials: [
			{
				name: 'gptVideoWebhookApi',
				required: true,
				testedBy: 'gptVideoWebhookSecretTest',
			},
		],
		webhooks: [
			{
				name: 'default',
				httpMethod: 'POST',
				responseMode: 'onReceived',
				// a 200 with no body as soon as the event is checked: without it n8n answers with the name of its default
				responseData: 'noData',
				path: 'webhook',
			},
		],
		properties: [
			{
				displayName:
					'Copy the production URL of this node into a new webhook on the Developers page of the GPT-Video app (https://www.gpt-video.com/app/developers), then put the signing secret it shows in the credential.',
				name: 'setupNotice',
				type: 'notice',
				default: '',
			},
			{
				displayName: 'Events',
				name: 'events',
				type: 'multiOptions',
				options: WEBHOOK_EVENTS,
				default: [],
				description: 'The events that start the workflow. Leave it empty to start it on every event.',
			},
		],
	};

	/**
	 * The lifecycle n8n runs when the workflow is turned on and off. GPT-Video's API has no call that registers a
	 * webhook, so there is nothing to look up, make or remove on GPT-Video's side: the address is added by hand
	 * on the Developers page. What turning the workflow on does check is the credential: a signing secret that
	 * cannot check any delivery stops the activation with the reason, instead of answering 401 to every event.
	 */
	webhookMethods = {
		default: {
			async checkExists(this: IHookFunctions): Promise<boolean> {
				return false;
			},
			async create(this: IHookFunctions): Promise<boolean> {
				const credentials = await this.getCredentials<{ signingSecret?: string }>(WEBHOOK_CREDENTIAL);
				const bytes = secretBytes(credentials.signingSecret);
				if (!(bytes instanceof Uint8Array)) throw new NodeOperationError(this.getNode(), bytes.message);
				return true;
			},
			async delete(this: IHookFunctions): Promise<boolean> {
				return true;
			},
		},
	};

	methods = {
		credentialTest: {
			/** A signing secret can only be proved right by a signed event, so the test checks its form. */
			async gptVideoWebhookSecretTest(
				this: ICredentialTestFunctions,
				credential: ICredentialsDecrypted<ICredentialDataDecryptedObject>,
			): Promise<INodeCredentialTestResult> {
				const bytes = secretBytes(credential.data?.signingSecret);
				if (bytes instanceof Uint8Array) return { status: 'OK', message: 'The signing secret has the right form.' };
				return { status: 'Error', message: bytes.message };
			},
		},
	};

	async webhook(this: IWebhookFunctions): Promise<IWebhookResponseData> {
		const request = this.getRequestObject() as unknown as { rawBody?: unknown; headers: Record<string, unknown> };
		const credentials = await this.getCredentials<{ signingSecret?: string }>(WEBHOOK_CREDENTIAL);
		const verified = verifySignature({
			secrets: [credentials.signingSecret],
			headers: request.headers,
			body: request.rawBody,
			nowMs: Date.now(),
		});
		if (!verified.ok) {
			const response = this.getResponseObject();
			response.status(401).json({ error: { code: 'WEBHOOK_VERIFICATION_FAILED', reason: verified.reason, message: verified.message } });
			return { noWebhookResponse: true };
		}
		const event = this.getBodyData();
		const type = isObject(event) && typeof event.type === 'string' ? event.type : '';
		const wanted = this.getNodeParameter('events', []) as string[];
		// an event the workflow does not want is still received, so GPT-Video does not send it again
		if (wanted.length > 0 && !wanted.includes(type)) return { webhookResponse: { received: true } };
		return {
			// webhookId is the same on every delivery of one event: a Remove Duplicates node keyed on it skips repeats
			workflowData: [[{ json: { ...(event as IDataObject), webhookId: verified.id, webhookTimestamp: verified.timestamp } }]],
		};
	}
}
