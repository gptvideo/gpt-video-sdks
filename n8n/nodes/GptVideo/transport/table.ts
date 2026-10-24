/**
 * The shapes of the generated tables (operations.generated.ts and properties.generated.ts). They are the
 * same rows the JavaScript and Python SDKs read: one per operation of the GPT-Video API, with every rule of
 * how a call is sent written as data. The node decides nothing from the name of an operation.
 */

export type Effect = 'read' | 'write' | 'spend';

/** Whether a call sends an Idempotency-Key: always (a spend), always (a write that can be retried), never. */
export type IdempotencyKeyRule = 'required' | 'auto' | 'none';

/** The four kinds of work that finish later, by the field of the answer that carries them. */
export type AsyncHandle = 'job' | 'export' | 'toolRun' | 'turn';

/** One operation of the API. */
export type OperationRow = {
	readonly id: string;
	readonly name: string;
	readonly method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
	/** starts with /v1/, with {name} for each path field */
	readonly path: string;
	readonly pathParams: readonly string[];
	/** true when the fields outside the path go in the query, false when they are the JSON body */
	readonly inQuery: boolean;
	readonly binary: { readonly contentType: string; readonly maxBytes: number } | null;
	readonly effect: Effect;
	readonly idempotencyKey: IdempotencyKeyRule;
	/** sending it again does not do the work twice: a GET, an idempotent call, or one with a key */
	readonly retrySafe: boolean;
	readonly async: { readonly handle: AsyncHandle; readonly waitWith: string } | null;
	/** a list answered as { data, hasMore, nextCursor }, read page after page with cursor */
	readonly paginated: boolean;
	readonly successStatus: 200 | 201 | 202;
};

/** What the engine reads besides the rows. */
export type Conventions = {
	readonly baseUrl: string;
	readonly headers: {
		readonly requestId: string;
		readonly idempotencyKey: string;
		readonly replayed: string;
		readonly retryAfter: string;
		readonly location: string;
		readonly rateLimitLimit: string;
		readonly rateLimitRemaining: string;
		readonly rateLimitReset: string;
	};
	readonly finalStatuses: readonly string[];
	readonly waitMaxSec: number;
	readonly switchedOffReason: string;
	readonly idempotencyRetentionHours: number;
	readonly idempotencyKeyMaxLength: number;
};

export type ApiContract = { readonly apiVersion: string; readonly fingerprint: string };

/**
 * How a field of the node becomes a field of the API input.
 * - string, number, boolean, options: the value of the parameter, as it is;
 * - json: the parameter holds JSON text (or a value an expression gave), parsed before it is sent;
 *   objects, lists and fields that also take null are written this way.
 * A field in `additional` is read from the Additional Fields collection, and left out when it is not there.
 */
export type FieldKind = 'string' | 'number' | 'boolean' | 'options' | 'json';

export type FieldSpec = {
	/** the name of the field in the API */
	readonly field: string;
	/** the name of the node parameter */
	readonly param: string;
	readonly kind: FieldKind;
	readonly additional: boolean;
};

/** An operation the node offers on top of the API: it is made of calls of the operations it names. */
export type CompositeOperation = 'upload_file' | 'download_export';
