// @ts-check
/**
 * `GptVideo`, the client: one method for each operation of the API (generated, in client.generated.mjs) and
 * the helpers written by hand on top of them: wait, the four waitFor forms, paginate, uploadFile, download.
 * Every call goes through one Transport, which holds the API key in a private field.
 */

import { GptVideoOperations } from "./client.generated.mjs";
import { download } from "./download.mjs";
import { API_ERRORS } from "./errors.generated.mjs";
import { OPERATIONS } from "./operations.generated.mjs";
import { paginate } from "./paginate.mjs";
import { DENO_INSPECT, NODE_INSPECT, REDACTED } from "./redact.mjs";
import { OperationIndex, Transport, invalid, resolveSettings } from "./transport.mjs";
import { uploadFile } from "./upload.mjs";
import { WAITS_PER_CLIENT, WaitSlots, waitForHandle, waitOn } from "./wait.mjs";

/** @import * as T from "./types.generated.js" */
/** @import { GptVideoOptions } from "./transport.mjs" */
/** @import { WaitOptions } from "./wait.mjs" */
/** @import { PaginateOptions } from "./paginate.mjs" */
/** @import { UploadOptions } from "./upload.mjs" */
/** @import { DownloadOptions } from "./download.mjs" */

/** The operation table of this version, indexed once when the package loads. */
export const OPERATION_INDEX = new OperationIndex(OPERATIONS);

/**
 * The API's retryable error codes, from the generated error table.
 * @type {ReadonlySet<string>}
 */
export const RETRYABLE_CODES = new Set(
  Object.entries(API_ERRORS)
    .filter(([, error]) => error.retryable)
    .map(([code]) => code),
);

/**
 * A client of the GPT-Video API.
 *
 * ```js
 * const gv = new GptVideo(); // reads GPT_VIDEO_API_KEY
 * const { asset } = await gv.uploadFile(await fs.openAsBlob("talk.mp4"), { filename: "talk.mp4" });
 * ```
 *
 * A call that spends sends an Idempotency-Key, made once for the call and sent again on every retry, so a
 * retry never pays twice. When a call that spends ends without a clear answer, its error says so in
 * `mayHaveSpent` and carries the key in `idempotencyKey`: call again with that key to get the answer
 * without paying twice.
 */
export class GptVideo extends GptVideoOperations {
  /** @type {Transport} */
  #transport;
  /** @type {{ transport: Transport, index: OperationIndex, slots: WaitSlots }} */
  #context;

  /**
   * @param {GptVideoOptions} [options] Every option is checked here: a mistake throws GptVideoError with
   *   INVALID_ARGUMENT before anything is sent. In a web page the client does not start unless
   *   `dangerouslyAllowBrowser` is true.
   */
  constructor(options) {
    const transport = new Transport(resolveSettings(options), RETRYABLE_CODES);
    /** @type {T.Send} */
    const send = (operation, input, callOptions, body) => sendOperation(transport, operation, input, callOptions, body);
    super(send);
    this.#transport = transport;
    this.#context = { transport, index: OPERATION_INDEX, slots: new WaitSlots(WAITS_PER_CLIENT) };
  }

  /**
   * Waits for the work that a call started, and resolves to the object as the last read gave it: the job, the
   * export, the tool run or the Editor Assistant turn. Pass the whole answer of the call.
   *
   * ```js
   * const { job } = await gv.analyzeProject({ projectId });
   * const done = await gv.wait({ job });
   * ```
   *
   * Work that failed or was cancelled throws GptVideoJobError, which carries the object, unless
   * `throwOnFailure` is false. A wait longer than `timeoutMs` (60 minutes) throws WAIT_TIMEOUT. Each read is a
   * call with its own retries, and a read that still fails after them ends the wait with its error. Ending a
   * wait never stops the work: waiting again can pick it up.
   *
   * @template {T.AsyncResult} R
   * @param {R} result the answer of a call that starts work: `{ job }`, `{ export }`, `{ toolRun }` or `{ turn }`
   * @param {WaitOptions} [options]
   * @returns {Promise<T.AsyncHandles[keyof R & keyof T.AsyncHandles]>}
   */
  wait(result, options) {
    return waitOn(this.#context, result, options);
  }

  /**
   * Waits for a job until it is done, failed or cancelled. Takes the job id, the job, or the answer that carries it.
   * @param {string | { id: string } | { job: { id: string } }} job
   * @param {WaitOptions} [options]
   * @returns {Promise<T.Job>}
   */
  waitForJob(job, options) {
    return waitForHandle(this.#context, "job", job, options, "waitForJob");
  }

  /**
   * Waits for an export until it is done, failed or cancelled; the export it resolves to has its downloadUrl.
   * Takes the export id, the export, or the answer that carries it.
   * @param {string | { id: string } | { export: { id: string } }} exported
   * @param {WaitOptions} [options]
   * @returns {Promise<T.Export>}
   */
  waitForExport(exported, options) {
    return waitForHandle(this.#context, "export", exported, options, "waitForExport");
  }

  /**
   * Waits for a tool run until it is done or failed. Takes the run id, the run, or the answer that carries it.
   * @param {string | { id: string } | { toolRun: { id: string } }} toolRun
   * @param {WaitOptions} [options]
   * @returns {Promise<T.ToolRun>}
   */
  waitForToolRun(toolRun, options) {
    return waitForHandle(this.#context, "toolRun", toolRun, options, "waitForToolRun");
  }

  /**
   * Waits for an Editor Assistant turn until it is done, failed or cancelled. Takes the turn id, the turn, or
   * the answer that carries it.
   * @param {string | { id: string } | { turn: { id: string } }} turn
   * @param {WaitOptions} [options]
   * @returns {Promise<T.AssistantTurn>}
   */
  waitForAssistantTurn(turn, options) {
    return waitForHandle(this.#context, "turn", turn, options, "waitForAssistantTurn");
  }

  /**
   * Every item of a list, page after page, asking for each page only when the items before it are used up.
   *
   * ```js
   * for await (const project of gv.paginate("listProjects", { limit: 100 })) console.log(project.title);
   * ```
   *
   * @template {T.PaginatedMethod} M
   * @param {M} method the name of a list method, such as listProjects
   * @param {Omit<T.Operations[T.PaginatedMethods[M]]["input"], "cursor"> & { cursor?: string }} [input] the
   *   input of the list; a cursor is where the iteration starts
   * @param {PaginateOptions} [options] for the call of every page
   * @returns {AsyncGenerator<T.PageItem<M>, void, undefined>}
   */
  paginate(method, input, options) {
    return paginate(this.#context, method, input, options);
  }

  /**
   * Uploads a video in parts and resolves to the answer of complete_upload, `{ asset }`: pass the asset id
   * to createProject as sourceAssetId. In Node.js, open a file with `fs.openAsBlob(path)`, so it is read a
   * part at a time and never whole. If the upload fails, the SDK cancels it.
   *
   * @param {Blob | ArrayBuffer | ArrayBufferView | ReadableStream<Uint8Array>} source the file; a stream
   *   needs `sizeBytes`
   * @param {UploadOptions} [options]
   * @returns {Promise<T.CompleteUploadOutput>}
   */
  uploadFile(source, options) {
    return uploadFile(this.#context, source, options);
  }

  /**
   * Downloads the file behind a signed link, such as the downloadUrl of an export, and resolves to the
   * Response once its headers arrive. The request never carries the API key: the link is its own credential.
   *
   * @param {string | URL} url an https:// link
   * @param {DownloadOptions} [options]
   * @returns {Promise<Response>}
   */
  download(url, options) {
    return download(this.#context, url, options);
  }

  /** How Node.js prints a client: the base URL, never the key. */
  [NODE_INSPECT]() {
    return `GptVideo { baseUrl: '${this.#transport.baseUrl}', apiKey: '${REDACTED}' }`;
  }

  /** How Deno prints a client. */
  [DENO_INSPECT]() {
    return this[NODE_INSPECT]();
  }
}

/**
 * Sends one call of an operation by its id, the function the generated methods call.
 *
 * @param {Transport} transport
 * @param {string} operation
 * @param {unknown} input
 * @param {unknown} options
 * @param {unknown} body
 * @returns {Promise<any>}
 */
async function sendOperation(transport, operation, input, options, body) {
  const spec = OPERATION_INDEX.byId(operation);
  if (!spec) throw invalid(`This version of the SDK has no operation ${operation}.`);
  return transport.send(spec, input, /** @type {import("./transport.mjs").SendOptions | undefined} */ (options), body);
}
