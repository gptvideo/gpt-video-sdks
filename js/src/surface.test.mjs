// @ts-check
// The surface frozen before the engine was written: the names the package exports, the error classes and
// their fields, the fixed sentences and the one shape of `message`. The units that build the client, the
// webhooks, the Python SDK and the n8n node all read these; a change here is a change to all of them.
import { describe, expect, it } from "vitest";
import * as root from "./index.mjs";
import * as hooks from "./webhooks.mjs";
import {
  GptVideoApiError,
  GptVideoError,
  GptVideoJobError,
  GptVideoNetworkError,
  JOB_ERROR_CODES,
  MESSAGES,
  NETWORK_ERROR_CODES,
  SERVER_TEXT_MAX,
  WEBHOOK_FAILURE_REASONS,
  WebhookVerificationError,
  formatErrorMessage,
} from "./errors.mjs";

describe("the public names", () => {
  it("gpt-video exports the client and the four error classes", () => {
    for (const name of ["GptVideo", "GptVideoError", "GptVideoApiError", "GptVideoNetworkError", "GptVideoJobError"]) {
      expect(typeof (/** @type {Record<string, unknown>} */ (root))[name], name).toBe("function");
    }
  });

  it("gpt-video/webhooks exports the two functions, the Standard Webhooks class and its error", () => {
    for (const name of ["verifyWebhook", "constructEvent", "Webhook", "WebhookVerificationError"]) {
      expect(typeof (/** @type {Record<string, unknown>} */ (hooks))[name], name).toBe("function");
    }
  });

  it("both entry points hand out the same error classes, so instanceof works whichever one was imported", () => {
    expect(root.GptVideoError).toBe(GptVideoError);
    expect(hooks.WebhookVerificationError).toBe(WebhookVerificationError);
  });
});

describe("the shape of message", () => {
  it("is CODE (status): message Hint: hint [request id], then the charge sentence", () => {
    expect(
      formatErrorMessage({ code: "INTERNAL", status: 500, message: "Something went wrong on our side.", hint: "Retry the request.", requestId: "req_1", mayHaveSpent: true }),
    ).toBe(
      "INTERNAL (500): Something went wrong on our side. Hint: Retry the request. [request req_1] " +
        "The request may have been charged. Call again with the same idempotencyKey to get its answer without paying twice.",
    );
  });

  it("leaves out a part that has no value, label included", () => {
    expect(formatErrorMessage({ code: "TIMEOUT", message: "No answer within 60 seconds." })).toBe("TIMEOUT: No answer within 60 seconds.");
    expect(formatErrorMessage({ code: "NOT_FOUND", status: 404, message: "Project prj_1 not found.", hint: null, requestId: "req_2" })).toBe(
      "NOT_FOUND (404): Project prj_1 not found. [request req_2]",
    );
    expect(formatErrorMessage({ code: "BAD_RESPONSE", status: 0, message: MESSAGES.notJson })).toBe("BAD_RESPONSE (0): The response is not JSON.");
  });

  it("cuts a server text that is longer than SERVER_TEXT_MAX", () => {
    const long = "x".repeat(SERVER_TEXT_MAX + 50);
    const text = formatErrorMessage({ code: "INTERNAL", status: 500, message: long, hint: long });
    expect(text).toBe(`INTERNAL (500): ${"x".repeat(SERVER_TEXT_MAX - 1)}… Hint: ${"x".repeat(SERVER_TEXT_MAX - 1)}…`);
    expect(formatErrorMessage({ code: "INTERNAL", message: "y".repeat(SERVER_TEXT_MAX) })).toBe(`INTERNAL: ${"y".repeat(SERVER_TEXT_MAX)}`);
  });
});

describe("the fixed sentences", () => {
  it("say the two things a caller needs after an unknown outcome: it may be charged, and how to ask again", () => {
    expect(MESSAGES.mayHaveSpent).toBe(
      "The request may have been charged. Call again with the same idempotencyKey to get its answer without paying twice.",
    );
  });

  it("tell where keys come from, without ever holding one", () => {
    expect(MESSAGES.missingApiKey).toBe("Set GPT_VIDEO_API_KEY or pass apiKey. Create a key at https://www.gpt-video.com/app/developers.");
    for (const [name, text] of Object.entries(MESSAGES)) {
      expect(text, name).not.toMatch(/gvk_[A-Za-z0-9_-]{4,}|whsec_[A-Za-z0-9+/=]{4,}/);
      expect(text, name).toMatch(/\.$/);
    }
  });

  it("are frozen", () => {
    expect(Object.isFrozen(MESSAGES)).toBe(true);
  });
});

describe("the error classes", () => {
  it("an API error carries what the API said, and its place in the hierarchy", () => {
    const err = new GptVideoApiError("INTERNAL (500): x", {
      code: "INTERNAL",
      status: 500,
      requestId: "req_9",
      hint: "Retry.",
      details: { reason: "x" },
      retryAfterSec: 3,
      retryable: true,
      operation: "analyze_project",
      idempotencyKey: "order-42",
      mayHaveSpent: true,
    });
    expect(err).toBeInstanceOf(GptVideoError);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("GptVideoApiError");
    expect({ ...err }).toEqual({
      name: "GptVideoApiError",
      code: "INTERNAL",
      retryable: true,
      operation: "analyze_project",
      idempotencyKey: "order-42",
      mayHaveSpent: true,
      status: 500,
      requestId: "req_9",
      hint: "Retry.",
      details: { reason: "x" },
      retryAfterSec: 3,
    });
  });

  it("an omitted field is null or false, never undefined, so a caller can test it without guessing", () => {
    const err = new GptVideoNetworkError("TIMEOUT: x", { code: "TIMEOUT" });
    expect({ ...err }).toEqual({
      name: "GptVideoNetworkError",
      code: "TIMEOUT",
      retryable: false,
      operation: null,
      idempotencyKey: null,
      mayHaveSpent: false,
      status: null,
      retryAfterSec: null,
    });
    const job = new GptVideoJobError("JOB_FAILED: x", { code: "JOB_FAILED", handle: { id: "job_1", status: "failed" } });
    expect(job.errorMessage).toBeNull();
    expect(job.handle).toEqual({ id: "job_1", status: "failed" });
    expect(job).toBeInstanceOf(GptVideoError);
  });

  it("drops a cause it is handed, so a transport error that holds the request headers never rides along", () => {
    // built at run time: a key-shaped literal in a published file fails scripts/sdk/layout.test.mjs
    const leaky = { config: { headers: { Authorization: `Bearer gvk_${"A".repeat(43)}` } } };
    const err = new GptVideoNetworkError("CONNECTION_FAILED: x", /** @type {any} */ ({ code: "CONNECTION_FAILED", cause: leaky }));
    expect("cause" in err).toBe(false);
    expect(JSON.stringify(err)).not.toContain("gvk_");
    expect(String(err.stack)).not.toContain("gvk_");
  });

  it("a webhook error has one code and a reason from the closed list", () => {
    const err = new WebhookVerificationError("x", { reason: "no_matching_signature" });
    expect(err).toBeInstanceOf(GptVideoError);
    expect(err.code).toBe("WEBHOOK_VERIFICATION_FAILED");
    expect(err.reason).toBe("no_matching_signature");
    expect(WEBHOOK_FAILURE_REASONS).toContain(err.reason);
  });

  // That the SDK's own codes never collide with the API's is checked in scripts/sdk/layout.test.mjs, which
  // reads the API's list from its source instead of copying it here.
  it("the SDK's own codes are distinct from each other", () => {
    const own = [...NETWORK_ERROR_CODES, ...JOB_ERROR_CODES, "INVALID_ARGUMENT", "WEBHOOK_VERIFICATION_FAILED"];
    expect(new Set(own).size).toBe(own.length);
  });
});
