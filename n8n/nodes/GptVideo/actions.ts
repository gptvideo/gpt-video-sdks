/**
 * What the GPT-Video node does for one item, apart from n8n's error classes: the input of an operation from its
 * parameters, the parts of its Idempotency-Key, a call with its wait, the two composite operations. A mistake
 * of the user is a GptVideoInputError and a failed call a GptVideoCallError; the node turns them into
 * NodeOperationError and NodeApiError.
 */

import type { IDataObject, IExecuteFunctions, INodeExecutionData } from 'n8n-workflow';
import { randomUUID } from 'node:crypto';

import { n8nDownloadIo, type n8nIo } from './n8n-io.ts';
import { FIELDS } from './operations.generated.ts';
import { download } from './transport/download.ts';
import type { Engine } from './transport/engine.ts';
import { GptVideoCallError, GptVideoInputError, MESSAGES } from './transport/errors.ts';
import { type KeyParts, keyFor, toolCallDigest } from './transport/key.ts';
import { bytesSource, streamSource } from './transport/sources.ts';
import type { FieldSpec } from './transport/table.ts';
import { uploadFile } from './transport/upload.ts';

/** The version of this package. A test ties it to package.json. */
export const VERSION = '1.0.0';

/** The User-Agent of every request: the request log of the API counts it as an automation tool. */
export const USER_AGENT = `n8n-nodes-gpt-video/${VERSION}`;

export function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** An answer as the json of an item: an object as it is, anything else under `value`. */
export function jsonOf(value: unknown): IDataObject {
	return isObject(value) ? (value as IDataObject) : { value: value as IDataObject[keyof IDataObject] };
}

function parsedJson(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}

/** The value of one field of the API input, or undefined when it is not sent. */
function valueOf(ctx: IExecuteFunctions, spec: FieldSpec, itemIndex: number, additional: IDataObject): unknown {
	let raw: unknown;
	if (spec.additional) {
		if (!(spec.param in additional)) return undefined;
		raw = additional[spec.param];
	} else {
		raw = ctx.getNodeParameter(spec.param, itemIndex);
	}
	if (spec.kind === 'json') {
		// an expression may give the value itself; text is parsed as JSON
		if (typeof raw !== 'string') return raw;
		const text = raw.trim();
		if (text === '') {
			if (spec.additional) return undefined;
			throw new GptVideoInputError(`${spec.field} is required: write it as JSON, such as null, "text" or an object.`);
		}
		const value = parsedJson(text);
		if (value === undefined) throw new GptVideoInputError(`${spec.field} is not valid JSON.`);
		return value;
	}
	// an optional text field added and left empty is not sent
	if (spec.additional && spec.kind === 'string' && raw === '') return undefined;
	return raw;
}

/** The flat input of an operation, from the parameters of the node for one item. */
export function inputOf(ctx: IExecuteFunctions, operation: string, itemIndex: number): Record<string, unknown> {
	const specs = FIELDS[operation] ?? [];
	const additional = specs.some((s) => s.additional) ? (ctx.getNodeParameter('additionalFields', itemIndex, {}) as IDataObject) : {};
	const input: Record<string, unknown> = {};
	for (const spec of specs) {
		const value = valueOf(ctx, spec, itemIndex, additional);
		if (value !== undefined) input[spec.field] = value;
	}
	return input;
}

/** Where the node keeps its stand-in for a missing execution id, in the context n8n keeps for one execution. */
export const KEY_FALLBACK_SLOT = 'gptVideoKeyFallback';

/** The execution id n8n writes when it has none (PLACEHOLDER_EMPTY_EXECUTION_ID): every such run shares it. */
const NO_EXECUTION_ID = '__UNKNOWN__';

/**
 * The random value that stands for a missing execution id or instance id. It is made once per execution and
 * kept in the node's context, which n8n keeps for the whole execution and every try of Retry On Fail, so a try
 * sends the same key; a new execution starts with an empty context and gets a new value, never a fixed one.
 */
export function keyFallbackOf(ctx: IExecuteFunctions): string {
	let store: IDataObject | undefined;
	try {
		store = ctx.getContext?.('node') as IDataObject | undefined;
	} catch {
		store = undefined;
	}
	const kept = store?.[KEY_FALLBACK_SLOT];
	if (typeof kept === 'string' && kept !== '') return kept;
	const made = randomUUID();
	if (store) store[KEY_FALLBACK_SLOT] = made;
	return made;
}

/**
 * What makes a call of this node one intention. Without an execution id or an instance id (a test run that has
 * none), `fallback` stands for it (keyFallbackOf). When an AI Agent runs the node as a tool, the arguments of the
 * tool call stand for the run, which n8n changes on every try there (key.ts).
 */
export function keyPartsOf(ctx: IExecuteFunctions, itemIndex: number, fallback: string, toolArgs: unknown): Omit<KeyParts, 'call'> {
	const executionId = ctx.getExecutionId?.();
	const instanceId = ctx.getInstanceId?.();
	const asTool = ctx.isToolExecution?.() === true;
	const runIndex = asTool ? null : ctx.getWorkflowDataProxy(itemIndex).$thisRunIndex;
	return {
		instanceId: typeof instanceId === 'string' && instanceId !== '' ? instanceId : fallback,
		workflowId: String(ctx.getWorkflow().id ?? ''),
		executionId: typeof executionId === 'string' && executionId !== '' && executionId !== NO_EXECUTION_ID ? executionId : fallback,
		nodeId: ctx.getNode().id,
		runIndex: asTool ? null : typeof runIndex === 'number' ? runIndex : 0,
		itemIndex,
		toolCall: asTool ? toolCallDigest(toolArgs) : null,
	};
}

/** The fields of an engine error a workflow can branch on, for an item of Continue On Fail. Never a header. */
export function errorJson(error: unknown): IDataObject {
	if (error instanceof GptVideoCallError) {
		const d = error.detail;
		return {
			error: d.message,
			code: d.code,
			status: d.status,
			requestId: d.requestId,
			retryable: d.retryable,
			mayHaveSpent: d.mayHaveSpent,
			idempotencyKey: d.idempotencyKey,
			operation: d.operation,
			...(d.object ? { object: d.object as IDataObject } : {}),
		};
	}
	if (error instanceof GptVideoInputError) return { error: error.message, code: error.code };
	return { error: error instanceof Error ? error.message : String(error) };
}

/**
 * What a NodeApiError carries of a failed call, for n8n's error view: never a header, and no field named code,
 * status or message, which NodeApiError would read as an HTTP status or put in place of the node's message.
 */
export function apiErrorResponse(error: GptVideoCallError): IDataObject {
	const d = error.detail;
	return {
		apiCode: d.code,
		requestId: d.requestId,
		retryable: d.retryable,
		mayHaveSpent: d.mayHaveSpent,
		idempotencyKey: d.idempotencyKey,
		operation: d.operation,
	};
}

/** The bytes of a binary field for an operation that sends bytes, refused before they are read when too many. */
export async function bytesOf(ctx: IExecuteFunctions, itemIndex: number, property: string, operation: string, maxBytes: number): Promise<Uint8Array> {
	const binary = ctx.helpers.assertBinaryData(itemIndex, property);
	if (typeof binary.bytes === 'number' && binary.bytes > maxBytes) {
		throw new GptVideoInputError(`${operation} sends at most ${maxBytes} bytes, and ${property} has ${binary.bytes}.`);
	}
	const buffer = await ctx.helpers.getBinaryDataBuffer(itemIndex, property);
	return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
}

/** The answer of a call that started work, with the work as it ended, after following it for `minutes`. */
export async function waited(engine: Engine, operation: string, body: unknown, minutes: number): Promise<IDataObject> {
	const row = engine.operation(operation);
	if (!row.async) return jsonOf(body);
	const handle = row.async.handle;
	const started = isObject(body) ? body[handle] : undefined;
	if (!isObject(started) || typeof started.id !== 'string') throw new GptVideoInputError(`The answer has no ${handle} to wait for.`);
	const finished = await engine.waitFor(handle, started.id, minutes * 60_000);
	return { ...jsonOf(body), [handle]: finished as IDataObject };
}

/** Upload a video file: the binary field of the item, part by part, read as it is sent. */
export async function uploadItem(ctx: IExecuteFunctions, engine: Engine, i: number, parts: Omit<KeyParts, 'call'>, options: IDataObject): Promise<unknown> {
	const property = ctx.getNodeParameter('binaryPropertyName', i) as string;
	const additional = ctx.getNodeParameter('additionalFields', i, {}) as IDataObject;
	const binary = ctx.helpers.assertBinaryData(i, property);
	const filename = typeof additional.filename === 'string' && additional.filename !== '' ? additional.filename : (binary.fileName ?? '');
	const title = typeof additional.title === 'string' && additional.title !== '' ? additional.title : undefined;
	const contentType = binary.mimeType && binary.mimeType !== 'application/octet-stream' ? binary.mimeType : undefined;
	let source;
	if (binary.id) {
		const { fileSize } = await ctx.helpers.getBinaryMetadata(binary.id);
		source = streamSource(await ctx.helpers.getBinaryStream(binary.id), fileSize);
	} else {
		const buffer = await ctx.helpers.getBinaryDataBuffer(i, property);
		source = bytesSource(new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength));
	}
	return uploadFile(engine, {
		source,
		filename,
		contentType,
		title,
		createKey: keyFor(options.idempotencyKey, { ...parts, call: 'upload_file:create' }, false),
		completeKey: keyFor(options.idempotencyKey, { ...parts, call: 'upload_file:complete' }, false),
		// n8n runs the node again with the same keys: the open upload is how that run picks up where this one stopped
		keepOpenOnFailure: ctx.getNode().retryOnFail === true,
	});
}

/** Download an export: read it for a fresh link, then the file into a binary field, as a stream. */
export async function downloadItem(ctx: IExecuteFunctions, engine: Engine, io: ReturnType<typeof n8nIo>, i: number): Promise<INodeExecutionData> {
	const exportId = ctx.getNodeParameter('exportId', i) as string;
	const property = ctx.getNodeParameter('binaryPropertyName', i) as string;
	const { body } = await engine.call('get_export', { input: { exportId }, idempotencyKey: null });
	const exported = isObject(body) ? body.export : undefined;
	if (!isObject(exported) || typeof exported.downloadUrl !== 'string' || exported.downloadUrl === '') throw new GptVideoInputError(MESSAGES.noDownloadUrl);
	const answer = await download(io, n8nDownloadIo(ctx, USER_AGENT), exported.downloadUrl);
	const type = answer.headers['content-type'];
	const mimeType = typeof type === 'string' && type !== '' ? type.split(';')[0]!.trim() : 'video/mp4';
	const data = await ctx.helpers.prepareBinaryData(answer.body as Parameters<IExecuteFunctions['helpers']['prepareBinaryData']>[0], `${exportId}.mp4`, mimeType);
	return { json: { export: exported as IDataObject }, binary: { [property]: data } };
}
