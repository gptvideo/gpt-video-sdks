// @ts-check
/**
 * A stand-in for the generated operation table, so the tests of the engine stay put when the catalogue moves:
 * twenty-one rows copied from the API reference (method, path, effect, keys and async handles as openapi.v1.json
 * says them), in the shape of `OperationSpec`. client.test.mjs checks that every row here equals the row of the
 * same id in operations.generated.mjs, so the stand-in cannot drift from the real table without a red test.
 */

import { OperationIndex } from "../transport.mjs";

/** @typedef {import("../table.mjs").OperationSpec} OperationSpec */

/** @type {readonly OperationSpec[]} */
export const FIXTURE_OPERATIONS = Object.freeze([
  row("get_me", "getMe", "GET", "/v1/me", [], { effect: "read" }),
  row("create_upload", "createUpload", "POST", "/v1/uploads", [], { effect: "write", idempotencyKey: "auto", successStatus: 201 }),
  row("upload_part", "uploadPart", "PUT", "/v1/uploads/{uploadId}/parts/{partNumber}", ["uploadId", "partNumber"], {
    effect: "write",
    binary: { contentType: "application/octet-stream", maxBytes: 8_388_608 },
  }),
  row("get_upload", "getUpload", "GET", "/v1/uploads/{uploadId}", ["uploadId"], { effect: "read" }),
  row("cancel_upload", "cancelUpload", "DELETE", "/v1/uploads/{uploadId}", ["uploadId"], { effect: "write" }),
  row("complete_upload", "completeUpload", "POST", "/v1/uploads/{uploadId}/complete", ["uploadId"], { effect: "write", idempotencyKey: "auto", successStatus: 201 }),
  row("list_projects", "listProjects", "GET", "/v1/projects", [], { effect: "read", paginated: true }),
  row("get_project", "getProject", "GET", "/v1/projects/{projectId}", ["projectId"], { effect: "read" }),
  row("update_project", "updateProject", "PATCH", "/v1/projects/{projectId}", ["projectId"], { effect: "write" }),
  row("analyze_project", "analyzeProject", "POST", "/v1/projects/{projectId}/analyze", ["projectId"], {
    effect: "spend",
    idempotencyKey: "required",
    async: { handle: "job", waitWith: "get_job" },
    successStatus: 202,
  }),
  row("estimate_analysis", "estimateAnalysis", "POST", "/v1/projects/{projectId}/analyze/estimate", ["projectId"], { effect: "read" }),
  row("list_clips", "listClips", "GET", "/v1/projects/{projectId}/clips", ["projectId"], { effect: "read", paginated: true }),
  row("accept_clip", "acceptClip", "POST", "/v1/clips/{clipId}/accept", ["clipId"], { effect: "write", idempotencyKey: "auto" }),
  row("create_export", "createExport", "POST", "/v1/compositions/{compositionId}/exports", ["compositionId"], {
    effect: "spend",
    idempotencyKey: "required",
    async: { handle: "export", waitWith: "get_export" },
    successStatus: 202,
  }),
  row("get_export", "getExport", "GET", "/v1/exports/{exportId}", ["exportId"], { effect: "read" }),
  row("create_voiceover", "createVoiceover", "POST", "/v1/voiceovers", [], {
    effect: "spend",
    idempotencyKey: "required",
    async: { handle: "toolRun", waitWith: "get_tool_run" },
    successStatus: 202,
  }),
  row("get_tool_run", "getToolRun", "GET", "/v1/tool-runs/{toolRunId}", ["toolRunId"], { effect: "read" }),
  row("create_assistant_turn", "createAssistantTurn", "POST", "/v1/projects/{projectId}/assistant/turns", ["projectId"], {
    effect: "spend",
    idempotencyKey: "required",
    async: { handle: "turn", waitWith: "get_assistant_turn" },
    successStatus: 202,
  }),
  row("get_assistant_turn", "getAssistantTurn", "GET", "/v1/assistant/turns/{turnId}", ["turnId"], { effect: "read" }),
  row("get_job", "getJob", "GET", "/v1/jobs/{jobId}", ["jobId"], { effect: "read" }),
  row("update_fake_text_story", "updateFakeTextStory", "PUT", "/v1/projects/{projectId}/story", ["projectId"], { effect: "write" }),
]);

/** The API's retryable codes, as `x-retryable` lists them. client.test.mjs ties them to errors.generated.mjs. */
export const FIXTURE_RETRYABLE = Object.freeze(["NOT_READY", "IDEMPOTENCY_IN_PROGRESS", "RATE_LIMITED", "INTERNAL", "UPSTREAM_FAILED", "UNAVAILABLE"]);

/** The same codes as a set, the form the Transport takes. @type {ReadonlySet<string>} */
export const FIXTURE_RETRYABLE_CODES = new Set(FIXTURE_RETRYABLE);

/** The stand-in table, indexed as the client indexes the real one. */
export const FIXTURE_INDEX = new OperationIndex(FIXTURE_OPERATIONS);

/**
 * A row of the stand-in table, by id.
 * @param {string} id
 * @returns {OperationSpec}
 */
export function fixtureOp(id) {
  const found = FIXTURE_INDEX.byId(id);
  if (!found) throw new Error(`the stand-in table has no ${id}`);
  return found;
}

/**
 * @param {string} id
 * @param {string} name
 * @param {OperationSpec["method"]} method
 * @param {string} path
 * @param {string[]} pathParams
 * @param {Partial<OperationSpec>} rest
 * @returns {OperationSpec}
 */
function row(id, name, method, path, pathParams, rest) {
  const binary = rest.binary ?? null;
  return Object.freeze({
    id,
    name,
    method,
    path,
    pathParams: Object.freeze([...pathParams]),
    // GET and DELETE read the query, and so does an operation that sends bytes (apiReadsQuery)
    inQuery: method === "GET" || method === "DELETE" || binary !== null,
    binary,
    effect: rest.effect ?? "read",
    idempotencyKey: rest.idempotencyKey ?? "none",
    // every operation of today is retry-safe: a GET, idempotent, or sent with a key
    retrySafe: true,
    async: rest.async ?? null,
    paginated: rest.paginated ?? false,
    successStatus: rest.successStatus ?? 200,
  });
}
