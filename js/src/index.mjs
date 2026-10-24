// @ts-check
/**
 * The entry point of the `gpt-video` package: the client and its errors. Webhooks are verified with
 * `gpt-video/webhooks`.
 */

export { GptVideo } from "./client.mjs";
export { GptVideoError, GptVideoApiError, GptVideoNetworkError, GptVideoJobError } from "./errors.mjs";

// The types a program names most often. Every input and output is in Operations: Operations["analyze_project"]["input"].

/** @typedef {import("./transport.mjs").GptVideoOptions} GptVideoOptions */
/** @typedef {import("./transport.mjs").ResponseEvent} ResponseEvent */
/** @typedef {import("./transport.mjs").RetryEvent} RetryEvent */
/** @typedef {import("./transport.mjs").RateLimit} RateLimit */
/** @typedef {import("./wait.mjs").WaitOptions} WaitOptions */
/** @typedef {import("./paginate.mjs").PaginateOptions} PaginateOptions */
/** @typedef {import("./upload.mjs").UploadOptions} UploadOptions */
/** @typedef {import("./upload.mjs").UploadProgress} UploadProgress */
/** @typedef {import("./download.mjs").DownloadOptions} DownloadOptions */

// The generated types are a declaration file, types.generated.d.ts, which TypeScript names by the .js it stands for.
/** @import * as T from "./types.generated.js" */

/** @typedef {T.CallOptions} CallOptions */
/** @typedef {T.KeyedCallOptions} KeyedCallOptions */
/** @typedef {T.BinaryBody} BinaryBody */
/** @typedef {T.Operations} Operations */
/** @typedef {T.OperationId} OperationId */
/** @typedef {T.AsyncResult} AsyncResult */
/** @typedef {T.AsyncHandles} AsyncHandles */
/** @typedef {T.PaginatedMethod} PaginatedMethod */
/** @typedef {T.ApiErrorCode} ApiErrorCode */
/** @typedef {T.Job} Job */
/** @typedef {T.Export} Export */
/** @typedef {T.ToolRun} ToolRun */
/** @typedef {T.AssistantTurn} AssistantTurn */
/** @typedef {T.Project} Project */
/**
 * @template {PaginatedMethod} M
 * @typedef {T.PageItem<M>} PageItem
 */
