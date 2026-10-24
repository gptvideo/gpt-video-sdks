# gpt-video

The official JavaScript and TypeScript SDK for the GPT-Video API.

GPT-Video turns a long video into short vertical clips with captions and face framing. Your program uploads a video, GPT-Video finds the moments that work as clips, and your program exports the ones it keeps as MP4 files.

- One method for each of the 67 operations of the API, named after the [API reference](https://www.gpt-video.com/developers/api): `analyze_project` is `analyzeProject`.
- Retries that never pay twice: a call that spends sends the same Idempotency-Key on every attempt.
- Helpers for the work that takes more than one request: `uploadFile`, `wait`, `paginate`, `download`, and webhook verification.
- No dependencies. ES modules for Node.js 20.19 or later, Deno, Bun and Cloudflare Workers. TypeScript types come with the package.

## Install

```sh
npm install gpt-video
```

## Your first clip

1. Create a GPT-Video account and confirm your email address.
2. Open the Developers page of the app, https://www.gpt-video.com/app/developers, and create an API key with the scopes `clips:read`, `clips:write` and `spend`. The key is shown once, so copy it then.
3. Put the key in the environment, where the SDK reads it, and run the quickstart on a video of yours:

```sh
export GPT_VIDEO_API_KEY=gvk_...
node quickstart.mjs talk.mp4
```

The program below is `examples/quickstart.mjs`. It checks the key, uploads the video, shows the price, analyzes the video, accepts the first clip, exports it and saves it as `clip.mp4`. Our test suite runs this file, unchanged, against a test server of the API.

```js
// GPT-Video quickstart: from a video file to a vertical clip on your disk.
//
//   npm install gpt-video
//   export GPT_VIDEO_API_KEY=gvk_...
//   node quickstart.mjs talk.mp4
//
// Steps 1 to 4 use no credits. Step 5 spends credits: one per started minute of the video.
// Step 7 uses one export of your daily allowance, and one API bonus credit while the bonus pays.

import { openAsBlob } from "node:fs";
import { writeFile } from "node:fs/promises";
import { basename } from "node:path";
import { GptVideo, GptVideoError } from "gpt-video";

const path = process.argv[2];
if (!path) {
  console.error("Usage: node quickstart.mjs <video file>");
  process.exit(2);
}

const gv = new GptVideo(); // reads GPT_VIDEO_API_KEY

// A call that spends and ends without a clear answer (the network failed, or the time ran out) may have
// been charged. Calling again with the same idempotencyKey returns the first answer and never pays twice.
async function spendOnce(call) {
  try {
    return await call({});
  } catch (error) {
    if (!(error instanceof GptVideoError) || !error.mayHaveSpent) throw error;
    console.log(`No clear answer (${error.code}). Asking again with the same Idempotency-Key.`);
    return call({ idempotencyKey: error.idempotencyKey });
  }
}

// 1. Check the key.
const me = await gv.getMe();
console.log(`Key ${me.key.id} works. Scopes: ${me.key.scopes.join(", ")}. Plan: ${me.account.plan}.`);

// 2. Upload the video. The SDK sends it in parts and reads one part at a time from the disk.
const { asset } = await gv.uploadFile(await openAsBlob(path), {
  filename: basename(path),
  onProgress: ({ uploadedBytes, totalBytes }) => console.log(`Uploaded ${Math.round((100 * uploadedBytes) / totalBytes)}%`),
});
console.log(`Video ${asset.id} is ready.`);

// 3. Create an Auto Clip project. Auto Clip has no default settings: the analysis starts only when
// missingSettings is empty, so choose every one of them.
const { project } = await gv.createProject({
  sourceAssetId: asset.id,
  title: basename(path),
  settings: {
    language: "auto",
    clipCount: 3,
    minDurationSec: 15,
    maxDurationSec: 60,
    objective: "viral",
    captionStyle: "word-pop",
    reframe: "face",
  },
});
if (project.missingSettings.length > 0) throw new Error(`Settings still to choose: ${project.missingSettings.join(", ")}`);

// 4. Ask the price of the analysis.
const { estimate } = await gv.estimateAnalysis({ projectId: project.id });
console.log(`The analysis costs ${estimate.creditsToCharge} credits.`);
if (!estimate.enough) {
  console.error("The account cannot pay for it. See https://www.gpt-video.com/developers/pricing");
  process.exit(1);
}

// 5. Analyze the video, and wait until its clips are found.
const analysis = await spendOnce((options) => gv.analyzeProject({ projectId: project.id }, options));
console.log(`Analysis started (${analysis.creditsCharged} credits charged). Waiting for job ${analysis.job.id}.`);
await gv.wait(analysis);

// 6. Read the clips in the order the analysis ranked them, and accept the first one. Accepting makes a
// composition, whose framing follows the face of the speaker; it can be exported once its framing job is done.
const clips = [];
for await (const clip of gv.paginate("listClips", { projectId: project.id, status: "proposed" })) clips.push(clip);
for (const clip of clips) console.log(`${clip.rank + 1}. ${clip.title} (${clip.startSec}s to ${clip.endSec}s, score ${clip.score})`);
if (clips.length === 0) throw new Error("The analysis found no clips in this video.");
const { composition } = await gv.acceptClip({ clipId: clips[0].id });
if (composition.framing.jobId) await gv.waitForJob(composition.framing.jobId);

// 7. Export the composition to an MP4 file, wait for it, and download it. The download link is its own
// credential: the SDK never sends your API key to it.
const exported = await spendOnce((options) => gv.createExport({ compositionId: composition.id }, options));
const done = await gv.wait(exported);
const response = await gv.download(done.downloadUrl);
await writeFile("clip.mp4", response.body);
console.log(`Saved clip.mp4 (${done.file.sizeBytes} bytes).`);
```

## What uses credits

- `getMe`, `uploadFile`, `createProject`, `estimateAnalysis`, `listClips`, `acceptClip` and every other read use no credits. An upload counts toward the storage of the account.
- `analyzeProject` charges one credit per started minute of the source video when the analysis starts. The credits are not returned if the analysis fails, and analyzing again is charged again.
- `createExport` uses one export of the daily allowance, which starts again at 00:00 UTC. While the API bonus pays, it also uses one bonus credit.

Every method links to its page of the API reference, which says what it costs. [API pricing](https://www.gpt-video.com/developers/pricing) has the API bonus, the plans and the daily limits.

## When a call fails

Every error the SDK throws is a `GptVideoError`, with these fields:

| Field | What it says |
|---|---|
| `code` | The code of the API, such as `NOT_READY`, or one of the SDK's: `CONNECTION_FAILED`, `TIMEOUT`, `ABORTED`, `BAD_RESPONSE`, `INVALID_ARGUMENT`, `JOB_FAILED`, `JOB_CANCELLED`, `WAIT_TIMEOUT`, `WEBHOOK_VERIFICATION_FAILED` |
| `retryable` | Whether the same call, sent again with the same `idempotencyKey`, can succeed |
| `operation` | The operation of the call, such as `analyze_project` |
| `idempotencyKey` | The Idempotency-Key the call sent, or null for a call that sends none |
| `mayHaveSpent` | true when a call that spends ended without a clear answer |

`GptVideoApiError` is an error the API answered, with `status`, `requestId`, `hint`, `details` and `retryAfterSec`. `GptVideoNetworkError` is a request that got no usable answer. `GptVideoJobError` is work that `wait` was following and that failed, was cancelled or ran past the time of the wait: `handle` is the job, the export, the tool run or the turn as the last read gave it, and `errorMessage` says why the work failed. The `message` of an error has the form `NOT_READY (409): message of the API Hint: what to do [request req_...]`. The API key never appears in an error.

### Retries

The SDK sends a call again after a failure only when that is safe: a read, a PATCH, PUT or DELETE, which has the same effect when sent twice, or a POST that carries an Idempotency-Key. It retries `CONNECTION_FAILED`, `TIMEOUT`, `NOT_READY`, `INTERNAL`, `UPSTREAM_FAILED`, `UNAVAILABLE` (unless the API is switched off) and a `BAD_RESPONSE` with a 5xx status, up to `maxRetries` times (2). It waits the seconds of `Retry-After` when the API sends it, and otherwise a growing pause with jitter. A `Retry-After` longer than 60 seconds, or longer than the time the call has left, ends the call, and the error carries it in `retryAfterSec`. `RATE_LIMITED` is retried for every call, because the API refuses it before running anything. `onRetry` is told before every pause.

`IDEMPOTENCY_IN_PROGRESS` means the first request with the same key is still running on the server. The SDK waits and asks again with the same key until it gets the answer, and this does not count toward `maxRetries`.

`timeoutMs` (60 seconds) is the time of one attempt, and `deadlineMs` (180 seconds) the time of the whole call, pauses included.

### A call that may have spent

A call that spends gets an Idempotency-Key made once for the call, before the first attempt, and sent again on every retry. For 24 hours the API answers a key whose request succeeded with that same answer, marked replayed, and does not run the call again. A key whose request ended in an error can be sent again: the request runs again, and a charge it already made is not made a second time.

When a call that spends ends without a clear answer after its retries, its error has `mayHaveSpent: true`: the API may have charged it. Call again with `{ idempotencyKey: error.idempotencyKey }` as the second argument. If the first request ran, you get its answer and pay nothing more; if it did not, it runs now. The `spendOnce` function of the quickstart does this. A new key would be a new request, charged again.

Every POST that writes or spends sends a key, and you can pass one of your own in its second argument: 1 to 255 visible ASCII characters, with no spaces. A PATCH, PUT or DELETE takes none.

### CONFLICT

A `CONFLICT` is never retried. When it says that the revision you sent is no longer the current one, read the composition or the timeline again and decide from what it holds now. A change you sent as a new call, after an earlier call of the same change ended in an error, may already be in it: to send a change again, pass the `idempotencyKey` of that error, and if the first one was written you get its answer.

### NOT_READY after acceptClip

When the project follows the face of the speaker, `acceptClip` starts a framing job on the new composition, and `composition.framing.jobId` is that job. Until it is done, `createExport` answers `NOT_READY`; the SDK waits the seconds of `Retry-After` and sends it again with the same key, up to `maxRetries` times. The quickstart waits for the framing job with `waitForJob` first, so the export starts at once.

## Waiting for work

`analyzeProject`, `createExport`, the tools and the Editor Assistant start work and answer at once with the job, the export, the tool run or the turn. `gv.wait(answer)` takes that answer and reads the work again until it is done, failed or cancelled. Each read waits on the server for up to 25 seconds, so a wait sends few requests.

- `timeoutMs` is 60 minutes. A longer wait throws `WAIT_TIMEOUT`, with the last object read. Ending a wait never stops the work: waiting again picks it up.
- Work that failed or was cancelled throws `GptVideoJobError`. With `throwOnFailure: false` the wait returns the object instead.
- `onProgress` is told of every read.
- `waitForJob`, `waitForExport`, `waitForToolRun` and `waitForAssistantTurn` take an id or an object.

## Lists

The nine list methods answer one page at a time. `gv.paginate` follows `nextCursor` for you, and asks for a page only when the items before it are used up:

- `gv.paginate("listProjects", { limit: 100 })` goes through every project.
- `gv.paginate("listClips", { projectId, status: "proposed" })` goes through the clips of a project, in the order the analysis ranked them.

## Uploads and downloads

`uploadFile` takes a `Blob` or a `File`, an `ArrayBuffer`, a typed array, or a `ReadableStream` with `sizeBytes`. In Node.js, open a file on disk with `openAsBlob` from `node:fs`: the SDK reads one part at a time and never holds the whole file in memory.

- The API takes MP4, MOV, MKV, WebM, AVI and MPEG-TS files up to 8 GB, and chooses the size of the parts.
- Four parts travel at once (`concurrency`, up to 16), and each part is retried on its own.
- Each part has its own timeout: 60 seconds, or longer for a part that needs it at 100 KB a second, up to 10 minutes. After a part times out, the rest go one at a time.
- If the upload fails, the SDK cancels it.
- `onProgress` is told after every part the API received.

An upload takes as long as your connection needs to send the file. 1 GB is 8,000 megabits, so on a 10 Mbit/s upload link it takes at least 800 seconds, about 13 minutes.

`download(url)` fetches a signed link, such as the `downloadUrl` of a finished export, and returns the `Response` once its headers arrive. It never sends your API key, accepts only `https` links, and retries a failure that comes before the answer, as it does for a read. A link expires after a while: read the export again with `getExport` for a new one.

## Webhooks

GPT-Video can call your server when a job or an export ends. You add the address on the Developers page of the app, which shows the signing secret of the webhook. It starts with `whsec_`. [Webhooks](https://www.gpt-video.com/developers/webhooks) describes the events.

`gpt-video/webhooks` checks a delivery on the raw request body, before you parse it as JSON:

- `verifyWebhook({ secret, headers, body })` checks it and returns the `id` and `timestamp` of the delivery.
- `constructEvent({ secret, headers, body })` checks it and returns the event.
- `new Webhook(secret).verify(body, headers)` has the form of the Standard Webhooks libraries, so a receiver that uses one of them changes only its import.

A delivery that does not check out throws `WebhookVerificationError`, whose `reason` says why. A timestamp more than 300 seconds from your clock is refused (`toleranceSec`).

## Options

`new GptVideo(options)` checks every option before anything is sent.

| Option | Default | What it does |
|---|---|---|
| `apiKey` | `GPT_VIDEO_API_KEY` | The API key. It starts with `gvk_`. |
| `baseUrl` | `https://api.gpt-video.com/v1` | The address of the API, with or without `/v1` |
| `maxRetries` | 2 | Failures retried after the first attempt |
| `timeoutMs` | 60000 | The time of one attempt |
| `deadlineMs` | 180000 | The time of a whole call, pauses included |
| `fetch` | the global `fetch` | The function that sends requests |
| `onResponse` | none | Told of every answer, with its status and rate limit |
| `onRetry` | none | Told before every pause, with the code and the delay |
| `userAgentSuffix` | none | Added after `gpt-video-js/<version>` in the User-Agent |
| `dangerouslyAllowBrowser` | false | Lets the SDK start in a web page |

Each call takes `idempotencyKey`, `signal`, `timeoutMs`, `deadlineMs` and `maxRetries` in its second argument.

## In a web page

The SDK does not start in a web page: the API key would be readable by anyone who opens the page. Call the API from your server. `dangerouslyAllowBrowser: true` lets it start anyway, for a page that only you open.

## CommonJS

The package is made of ES modules. On Node.js 20.19 or later, `require` loads it as well:

```cjs
const { GptVideo } = require("gpt-video");

const gv = new GptVideo();
gv.getMe().then((me) => console.log(`Key ${me.key.id} works.`));
```

## From MCP to the SDK

If you used GPT-Video through its MCP server, most tools there have a method here that does the same work, with the same name in camelCase: `get_credits` is `getCredits`. These tools have another name here:

| MCP tool | SDK method | How they relate |
|---|---|---|
| `create_auto_clip_project` | `createProject` | The same operation |
| `configure_project` | `updateProject` | Close work with other arguments |
| `find_clips` | `analyzeProject` | Close work with other arguments |
| `export_clip` | `acceptClip` | Close work with other arguments |
| `export_clip` | `createExport` | Close work with other arguments |
| `wait_for_job` | `getJob` | The same operation |

For close work, read the page of the method before you switch.

The first tools of the MCP server were written by hand before the API, and five of them share a name with a method here but have arguments and answers of their own: `list_projects`, `create_project`, `get_project`, `list_clips` and `get_job`. On MCP, `create_project` makes an empty project for a video the user uploads in the app; `createProject` here takes the video in `sourceAssetId`. Read the page of the method for these too.

On MCP a tool that spends needs `confirm: true`. The SDK has no such field: calling the method is the decision.

## Versions

Version 1.0.0 of the SDK calls version 1 of the API. The answers come back as the API sends them, so a field the API adds reaches your code before the SDK knows it. [CHANGELOG.md](CHANGELOG.md) lists the changes.

Questions: hello@gpt-video.com. The API documentation: https://www.gpt-video.com/developers.

MIT license.
