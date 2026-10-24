// @ts-check
/**
 * The shape of the operation table: one row per REST operation of the GPT-Video API. The rows themselves are
 * generated from the API catalogue into `operations.generated.mjs`, which exports them as
 * `OPERATIONS: readonly OperationSpec[]` next to `API_CONTRACT: ApiContract`. The engine (requests, retries,
 * waits, pages, uploads) reads only these fields, and the Python SDK reads the same fields from `_table.py`.
 *
 * Every rule the engine follows comes from a field here, never from the name of an operation.
 */

/** @typedef {"GET" | "POST" | "PUT" | "PATCH" | "DELETE"} HttpMethod */

/** What an operation does: reads, writes, or spends credits or a daily allowance. @typedef {"read" | "write" | "spend"} Effect */

/**
 * Whether the call sends an Idempotency-Key. `required`: a spend, the API refuses it without one, and the SDK
 * always sends one. `auto`: a POST that writes, and the SDK sends one so the call can be retried. `none`: the
 * API does not read the header, and the SDK does not send it.
 * @typedef {"required" | "auto" | "none"} IdempotencyKeyPolicy
 */

/** The four kinds of work that finish later, by the field of the response that carries them. @typedef {"job" | "export" | "toolRun" | "turn"} AsyncHandle */

/**
 * An operation that starts work. `handle` is the response field that carries the object to follow
 * (`{ job }`), `waitWith` is the id of the read that follows it with `?wait=`.
 * @typedef {{ handle: AsyncHandle, waitWith: string }} AsyncSpec
 */

/**
 * An operation whose body is bytes instead of JSON (the part of an upload): sent with this content type and
 * at most this many bytes. Its other input fields go in the query.
 * @typedef {{ contentType: string, maxBytes: number }} BinarySpec
 */

/**
 * @typedef {object} OperationSpec
 * @property {string} id the operation id, `analyze_project`: the name in the API reference and in Python
 * @property {string} name the method name, `analyzeProject`
 * @property {HttpMethod} method
 * @property {string} path the catalogue path, starting with `/v1/`, with `{camelCase}` parameters
 * @property {readonly string[]} pathParams the input fields that fill the path, in order of appearance
 * @property {boolean} inQuery true when the input fields that are not in the path go in the query string;
 *   false when they are the JSON body
 * @property {BinarySpec | null} binary
 * @property {Effect} effect
 * @property {IdempotencyKeyPolicy} idempotencyKey
 * @property {boolean} retrySafe true when sending the call twice cannot do the work twice: a GET, an
 *   operation the API makes idempotent, or one that carries an Idempotency-Key
 * @property {AsyncSpec | null} async
 * @property {boolean} paginated true for a list that answers `{ data, hasMore, nextCursor }` and reads `cursor`
 * @property {200 | 201 | 202} successStatus
 */

/**
 * The version of the contract the table was generated from: `info.version` of the OpenAPI document and the
 * SHA-256 of the generator's model, so two builds from different catalogues never look the same.
 * @typedef {{ apiVersion: string, fingerprint: string }} ApiContract
 */

export {};
