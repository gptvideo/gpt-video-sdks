import type { IDataObject, IExecuteFunctions, INodeExecutionData, INodeType, INodeTypeDescription, JsonObject } from 'n8n-workflow';
import { NodeApiError, NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';

import { USER_AGENT, apiErrorResponse, bytesOf, downloadItem, errorJson, inputOf, isObject, jsonOf, keyFallbackOf, keyPartsOf, uploadItem, waited } from './actions.ts';
import { CREDENTIAL, n8nIo } from './n8n-io.ts';
import { CONVENTIONS, OPERATIONS, RETRYABLE_CODES } from './operations.generated.ts';
import { PROPERTIES } from './properties.generated.ts';
import { Engine } from './transport/engine.ts';
import { GptVideoCallError, GptVideoInputError } from './transport/errors.ts';
import { keyFor } from './transport/key.ts';
import { resolveBaseUrl } from './transport/request.ts';

export { USER_AGENT, VERSION } from './actions.ts';

/**
 * The GPT-Video node: one operation for each operation of the GPT-Video API, plus Upload a Video File and
 * Download an Export, which n8n users need as one step. Programmatic and not declarative, because a call is
 * more than one request: it is retried with the same Idempotency-Key, an upload is several calls, and a wait
 * reads the job again until it ends.
 */
export class GptVideo implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'GPT-Video',
		name: 'gptVideo',
		icon: { light: 'file:../../icons/gptVideo.svg', dark: 'file:../../icons/gptVideo.dark.svg' },
		group: ['transform'],
		version: 1,
		subtitle: '={{$parameter["operation"] + ": " + $parameter["resource"]}}',
		description: 'Turn long videos into short clips with captions, and export them, with the GPT-Video API',
		defaults: {
			name: 'GPT-Video',
		},
		usableAsTool: true,
		inputs: [NodeConnectionTypes.Main],
		outputs: [NodeConnectionTypes.Main],
		credentials: [
			{
				name: 'gptVideoApi',
				required: true,
			},
		],
		properties: PROPERTIES,
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const returnData: INodeExecutionData[] = [];
		const credentials = await this.getCredentials<{ baseUrl?: string }>(CREDENTIAL);
		const io = n8nIo(this);
		const fallback = keyFallbackOf(this);

		for (let i = 0; i < items.length; i++) {
			try {
				const engine = new Engine({
					io,
					base: resolveBaseUrl(credentials.baseUrl, CONVENTIONS.baseUrl),
					conventions: CONVENTIONS,
					operations: OPERATIONS,
					retryable: RETRYABLE_CODES,
					userAgent: USER_AGENT,
				});
				const operation = this.getNodeParameter('operation', i) as string;
				const parts = keyPartsOf(this, i, fallback, items[i]?.json);
				const options = this.getNodeParameter('options', i, {}) as IDataObject;

				if (operation === 'upload_file') {
					returnData.push({ json: jsonOf(await uploadItem(this, engine, i, parts, options)), pairedItem: { item: i } });
					continue;
				}
				if (operation === 'download_export') {
					returnData.push({ ...(await downloadItem(this, engine, io, i)), pairedItem: { item: i } });
					continue;
				}

				const row = engine.operation(operation);
				const input = inputOf(this, operation, i);
				const key = row.idempotencyKey === 'none' ? null : keyFor(options.idempotencyKey, { ...parts, call: operation }, true);

				if (row.paginated) {
					const returnAll = this.getNodeParameter('returnAll', i) as boolean;
					const limit = returnAll ? null : (this.getNodeParameter('limit', i) as number);
					for (const item of await engine.list(operation, input, limit)) returnData.push({ json: jsonOf(item), pairedItem: { item: i } });
					continue;
				}

				const bytes = row.binary ? await bytesOf(this, i, this.getNodeParameter('binaryPropertyName', i) as string, operation, row.binary.maxBytes) : undefined;
				const { body } = await engine.call(operation, { input, idempotencyKey: key, bytes });
				const wait = row.async !== null && (this.getNodeParameter('waitUntilFinished', i, false) as boolean);
				const json = wait ? await waited(engine, operation, body, this.getNodeParameter('waitTimeout', i, 5) as number) : jsonOf(body);
				returnData.push({ json, pairedItem: { item: i } });
			} catch (error) {
				if (this.continueOnFail()) {
					returnData.push({ json: errorJson(error), pairedItem: { item: i } });
					continue;
				}
				if (error instanceof GptVideoCallError) {
					const d = error.detail;
					// NodeApiError puts its own words in place of a message that names a system code (ECONNRESET...),
					// which would drop the sentence about a possible charge and its key, and reads a status from any
					// `code` or `status` of the response. So the response carries neither, the message starts as the
					// code alone, and the mapping turns it into the whole message: the one path that keeps it as it is.
					throw new NodeApiError(this.getNode(), apiErrorResponse(error) as JsonObject, {
						message: d.code,
						messageMapping: { [d.code]: d.message },
						httpCode: d.status === null ? undefined : String(d.status),
						itemIndex: i,
					});
				}
				if (error instanceof GptVideoInputError) throw new NodeOperationError(this.getNode(), error.message, { itemIndex: i });
				throw new NodeOperationError(this.getNode(), isObject(error) ? (error as unknown as Error) : String(error), { itemIndex: i });
			}
		}
		return [returnData];
	}
}
