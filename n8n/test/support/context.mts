/**
 * A stand-in for the `this` of a node's execute(): the parameters of each item, the ids of the run, the HTTP
 * helpers and the binary helpers, faithful to what n8n gives a node. The HTTP helper with authentication adds
 * the credential's key the way n8n does, so a test can look for that key everywhere the node writes.
 */

export const API_KEY = `gvk_${'K'.repeat(43)}`;

export type HelperAnswer = { statusCode: number; headers?: Record<string, string>; body?: unknown };
export type HelperCall = { options: Record<string, any>; authorization: string | null };

export type ContextSetup = {
	items?: Array<{ json: Record<string, unknown>; binary?: Record<string, any> }>;
	/** the parameters, the same for every item, or a function of the item */
	params: Record<string, unknown> | ((name: string, itemIndex: number) => unknown);
	/** answers httpRequestWithAuthentication; may throw like the real helper */
	http?: (options: Record<string, any>, index: number) => Promise<HelperAnswer> | HelperAnswer;
	/** answers httpRequest (no credential) */
	plainHttp?: (options: Record<string, any>, index: number) => Promise<HelperAnswer> | HelperAnswer;
	executionId?: string | undefined;
	instanceId?: string | undefined;
	workflowId?: string;
	nodeId?: string;
	runIndex?: number;
	retryOnFail?: boolean;
	continueOnFail?: boolean;
	baseUrl?: string;
	streams?: Record<string, { chunks: Uint8Array[]; size: number }>;
	/**
	 * the context n8n keeps for the node during one execution: every try of Retry On Fail sees the same object,
	 * a new execution a new one. Pass the same object to two runs to stand for two tries of one execution.
	 */
	nodeContext?: Record<string, unknown>;
	/** true when an AI Agent runs the node as a tool, which gives each try of Retry On Fail a new run index */
	asTool?: boolean;
};

export function makeContext(setup: ContextSetup) {
	const calls: HelperCall[] = [];
	const plainCalls: HelperCall[] = [];
	const items = setup.items ?? [{ json: {} }];
	/** how far the node read each stream: the bytes taken, and the most taken beyond what was already sent */
	const streamReads: Record<string, number> = {};
	const param = (name: string, itemIndex: number, fallback?: unknown) => {
		const value = typeof setup.params === 'function' ? setup.params(name, itemIndex) : setup.params[name];
		if (value !== undefined) return value;
		if (fallback !== undefined) return fallback;
		throw new Error(`Could not get parameter "${name}"`);
	};
	const node = { id: setup.nodeId ?? 'node-1', name: 'GPT-Video', type: 'n8n-nodes-gpt-video.gptVideo', typeVersion: 1, position: [0, 0], parameters: {}, retryOnFail: setup.retryOnFail };
	const ctx: any = {
		getInputData: () => items,
		getNodeParameter: (name: string, itemIndex: number, fallback?: unknown) => param(name, itemIndex, fallback),
		getCredentials: async (type: string) => {
			if (type !== 'gptVideoApi') throw new Error(`no credential ${type}`);
			return { apiKey: API_KEY, ...(setup.baseUrl ? { baseUrl: setup.baseUrl } : {}) };
		},
		getExecutionId: () => setup.executionId,
		getInstanceId: () => setup.instanceId,
		getWorkflow: () => ({ id: setup.workflowId ?? 'wf-1', name: 'Test', active: false }),
		getNode: () => node,
		getWorkflowDataProxy: () => ({ $thisRunIndex: setup.runIndex ?? 0 }),
		getContext: (type: string) => {
			if (type !== 'node') throw new Error(`no context ${type}`);
			setup.nodeContext ??= {};
			return setup.nodeContext;
		},
		isToolExecution: () => setup.asTool === true,
		getExecutionCancelSignal: () => undefined,
		continueOnFail: () => setup.continueOnFail === true,
		helpers: {
			httpRequestWithAuthentication: async function (this: unknown, credential: string, options: Record<string, any>) {
				if (credential !== 'gptVideoApi') throw new Error(`no credential ${credential}`);
				// n8n adds the key from the credential, and an error of the helper carries the request it sent
				const headers = { ...(options.headers ?? {}), Authorization: `Bearer ${API_KEY}` };
				calls.push({ options, authorization: headers.Authorization });
				if (!setup.http) throw new Error('no http in this test');
				// an answer never arrives in the same turn of the event loop: a node that loops on answers still lets
				// timers run, as it does in n8n, so a test's own timeout can stop it
				await new Promise((resolve) => setImmediate(resolve));
				try {
					return await setup.http(options, calls.length - 1);
				} catch (error) {
					throw Object.assign(error as object, { config: { headers }, request: { headers } });
				}
			},
			httpRequest: async (options: Record<string, any>) => {
				plainCalls.push({ options, authorization: options.headers?.Authorization ?? null });
				if (!setup.plainHttp) throw new Error('no plain http in this test');
				return setup.plainHttp(options, plainCalls.length - 1);
			},
			assertBinaryData: (itemIndex: number, property: string) => {
				const binary = items[itemIndex]?.binary?.[property];
				if (!binary) throw new Error(`This operation expects the node's input data to contain a binary file '${property}', but none was found`);
				return binary;
			},
			getBinaryDataBuffer: async (itemIndex: number, property: string) => {
				const binary = items[itemIndex]?.binary?.[property];
				return Buffer.from(binary.data, 'base64');
			},
			getBinaryMetadata: async (id: string) => ({ fileSize: setup.streams![id]!.size }),
			getBinaryStream: async (id: string) => {
				const { chunks } = setup.streams![id]!;
				streamReads[id] = 0;
				return (async function* () {
					for (const chunk of chunks) {
						streamReads[id]! += chunk.byteLength;
						yield chunk;
					}
				})();
			},
			prepareBinaryData: async (data: unknown, fileName: string, mimeType: string) => {
				const chunks: Buffer[] = [];
				for await (const chunk of data as AsyncIterable<Buffer>) chunks.push(chunk);
				return { data: Buffer.concat(chunks).toString('base64'), fileName, mimeType };
			},
		},
	};
	return { ctx, calls, plainCalls, streamReads };
}

/** An answer of the helper with a JSON body, as `encoding: 'arraybuffer'` gives it: a Buffer. */
export function json(statusCode: number, body: unknown, headers: Record<string, string> = {}): HelperAnswer {
	return { statusCode, headers: { 'content-type': 'application/json', ...headers }, body: Buffer.from(JSON.stringify(body)) };
}
