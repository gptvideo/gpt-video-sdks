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
