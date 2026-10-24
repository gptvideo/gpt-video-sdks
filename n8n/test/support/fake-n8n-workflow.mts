/**
 * What the node takes from n8n-workflow at run time, for the tests: the two error classes, the connection
 * type and sleep. The error classes keep what they are given in the fields the real ones use (`node`,
 * `itemIndex`, `httpCode`, and the error response in `errorResponse`), so a test can look for the API key in
 * every one of them.
 */

export const NodeConnectionTypes = { Main: 'main' } as const;

type Options = { message?: string; description?: string; httpCode?: string; itemIndex?: number; messageMapping?: Record<string, string> };

/** What the real NodeApiError does to a message that names a system code: it puts its own words in its place. */
const COMMON_ERRORS: Record<string, string> = {
	ECONNREFUSED: 'The service refused the connection - perhaps it is offline',
	ECONNRESET: 'The connection to the server was closed unexpectedly, perhaps it is offline.',
	ENOTFOUND: 'The connection cannot be established, this usually occurs due to an incorrect host (domain) value',
	ETIMEDOUT: 'The connection timed out',
};

/**
 * The message the real NodeApiError (n8n-workflow 2.x, setDescriptiveErrorMessage) ends with: a mapping whose key
 * is in the message wins only when it changes the message; otherwise a common error code anywhere in the message
 * puts n8n's words in its place.
 */
function descriptive(message: string, mapping: Record<string, string> | undefined): string {
	for (const [key, text] of Object.entries(mapping ?? {})) {
		if (message.toUpperCase().includes(key.toUpperCase())) {
			if (text !== message) return text;
			break;
		}
	}
	for (const [code, text] of Object.entries(COMMON_ERRORS)) if (message.toUpperCase().includes(code)) return text;
	return message;
}

export class NodeOperationError extends Error {
	node: unknown;
	itemIndex: number | undefined;
	cause: unknown;

	constructor(node: unknown, error: unknown, options: Options = {}) {
		super(typeof error === 'string' ? error : error instanceof Error ? error.message : String(error));
		this.name = 'NodeOperationError';
		this.node = node;
		this.itemIndex = options.itemIndex;
		this.cause = typeof error === 'string' ? undefined : error;
	}
}

export class NodeApiError extends Error {
	node: unknown;
	itemIndex: number | undefined;
	httpCode: string | undefined;
	errorResponse: unknown;

	constructor(node: unknown, errorResponse: unknown, options: Options = {}) {
		super(descriptive(options.message ?? 'NodeApiError', options.messageMapping));
		this.name = 'NodeApiError';
		this.node = node;
		this.itemIndex = options.itemIndex;
		this.httpCode = options.httpCode;
		this.errorResponse = errorResponse;
	}
}

/**
 * Resolves after `ms`; rejects when the signal fires first; lets go of the signal when the time is up. The real
 * one (@n8n/utils sleep, which n8n-workflow 2.x exports) does the same three things.
 */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(new Error('aborted'));
			return;
		}
		const onAbort = () => {
			clearTimeout(timer);
			reject(new Error('aborted'));
		};
		const timer = setTimeout(() => {
			signal?.removeEventListener('abort', onAbort);
			resolve();
		}, ms);
		signal?.addEventListener('abort', onAbort, { once: true });
	});
}
