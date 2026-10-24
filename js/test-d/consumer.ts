// A TypeScript program that uses the public surface of the package. It is type-checked twice and never run:
// against the JavaScript sources of this folder, by `npm run typecheck`, and against the declarations that tsc
// emits for the published package, by src/package.test.mjs, with strict settings and both node16 and bundler
// module resolution. Each @ts-expect-error is a mistake the types must refuse: if one is accepted, the check fails.

import { GptVideo, GptVideoApiError, GptVideoError, GptVideoJobError, GptVideoNetworkError } from "gpt-video";
import type { AsyncResult, Export, GptVideoOptions, Job, PageItem, Project, ResponseEvent, RetryEvent, UploadProgress } from "gpt-video";
import { Webhook, WebhookVerificationError, constructEvent, verifyWebhook } from "gpt-video/webhooks";

const options: GptVideoOptions = {
  baseUrl: "https://api.gpt-video.com/v1",
  maxRetries: 2,
  timeoutMs: 60_000,
  deadlineMs: 180_000,
  onResponse: (event: ResponseEvent) => {
    const status: number = event.status;
    const replayed: boolean = event.replayed;
    const remaining: number | null = event.rateLimit.remaining;
    void [status, replayed, remaining];
  },
  onRetry: (event: RetryEvent) => {
    const pause: number = event.delayMs;
    const code: string = event.code;
    void [pause, code];
  },
  userAgentSuffix: "my-app/1.0",
};

const gv = new GptVideo(options);

export async function clips(projectId: string): Promise<string[]> {
  const me = await gv.getMe();
  void me;

  const started = await gv.analyzeProject({ projectId }, { idempotencyKey: "order-42", timeoutMs: 30_000 });
  const charged: number = started.creditsCharged;
  void charged;
  const job: Job = await gv.wait(started, { timeoutMs: 30 * 60_000, onProgress: (current) => void current });
  const done: boolean = job.status === "done";
  void done;
  const again: Job = await gv.waitForJob(started.job.id);
  void again;

  const titles: string[] = [];
  for await (const project of gv.paginate("listProjects", { limit: 100 })) {
    const item: PageItem<"listProjects"> = project;
    const same: Project = item;
    titles.push(same.id);
  }
  return titles;
}

export async function exportClip(compositionId: string): Promise<Response | null> {
  const created = await gv.createExport({ compositionId });
  const result: AsyncResult = created;
  void result;
  const exported: Export = await gv.wait(created, { throwOnFailure: true });
  return exported.downloadUrl === null ? null : gv.download(exported.downloadUrl, { timeoutMs: 60_000 });
}

export async function upload(file: Blob): Promise<string> {
  const { asset } = await gv.uploadFile(file, {
    filename: "talk.mp4",
    contentType: "video/mp4",
    concurrency: 4,
    onProgress: (progress: UploadProgress) => void (progress.uploadedBytes / progress.totalBytes),
  });
  const part = await gv.uploadPart({ uploadId: "upl_1", partNumber: 1 }, new Uint8Array(8));
  void part;
  return asset.id;
}

export function explain(error: unknown): string {
  if (error instanceof GptVideoApiError) {
    const status: number = error.status;
    const requestId: string | null = error.requestId;
    const retryAfter: number | null = error.retryAfterSec;
    return `${error.code} ${status} ${requestId ?? ""} ${retryAfter ?? ""}`;
  }
  if (error instanceof GptVideoNetworkError) {
    const status: number | null = error.status;
    return `${error.code} ${status ?? ""}`;
  }
  if (error instanceof GptVideoJobError) {
    const last: unknown = error.handle;
    const why: string | null = error.errorMessage;
    return `${error.code} ${String(last)} ${why ?? ""}`;
  }
  if (error instanceof GptVideoError) {
    const key: string | null = error.idempotencyKey;
    const spent: boolean = error.mayHaveSpent;
    const retryable: boolean = error.retryable;
    const operation: string | null = error.operation;
    return `${error.code} ${key ?? ""} ${spent} ${retryable} ${operation ?? ""}`;
  }
  return String(error);
}

export async function receive(body: string, headers: Headers): Promise<string> {
  const verified = await verifyWebhook({ secret: "whsec_example", headers, body });
  const id: string = verified.id;
  const event = await constructEvent({ secrets: ["whsec_example", "whsec_previous"], headers, body, toleranceSec: 300 });
  const sameEvent = await new Webhook("whsec_example").verify(body, headers);
  void sameEvent;
  try {
    await verifyWebhook({ secret: "whsec_example", headers, body: new Uint8Array(0) });
  } catch (error) {
    if (error instanceof WebhookVerificationError) return error.reason;
  }
  return `${id} ${event.type}`;
}

export async function mistakes(): Promise<void> {
  // @ts-expect-error a read sends no Idempotency-Key
  await gv.getMe(undefined, { idempotencyKey: "order-42" });
  // @ts-expect-error analyzeProject needs the project
  await gv.analyzeProject({});
  // @ts-expect-error paginate takes the name of a list method
  gv.paginate("getMe");
  // @ts-expect-error the client has no option called timeout
  new GptVideo({ timeout: 5000 });
  // @ts-expect-error wait takes the answer of a call that starts work
  await gv.wait({ project: { id: "prj_1" } });
  // @ts-expect-error uploadPart takes bytes, not text
  await gv.uploadPart({ uploadId: "upl_1", partNumber: 1 }, "bytes");
  // @ts-expect-error the key of a client is a string
  new GptVideo({ apiKey: 42 });
}
