// @ts-check
/**
 * Uploading a file: create_upload says how many parts to send and how big each one is, the parts go out in
 * parallel with upload_part, and complete_upload turns the file into an asset. The part size is the one the
 * API answers, never a number of this SDK.
 *
 * What holds on every path:
 *  - a part is read when it is sent (`Blob.slice`, a view of the bytes, or the next bytes of a stream), so
 *    the file is never held in memory whole; a stream holds at most one part per part in flight;
 *  - each part has a timeout that grows with its size, from 60 seconds at 100 KB a second up to 10
 *    minutes, and is retried on its own: sending a part again replaces it. A slow part never restarts the
 *    others; after a part times out, the next parts go one at a time, because parallel parts share the line;
 *  - a complete refused with CONFLICT reads the upload again, sends the parts it lacks once more and asks
 *    again with the same Idempotency-Key, once;
 *  - an upload that fails after it was opened is cancelled in the background, so it does not count against
 *    the open uploads and the storage of the account until it expires.
 */

import { GptVideoApiError, GptVideoNetworkError, MESSAGES, TEXTS, formatErrorMessage } from "./errors.mjs";
import { RETRY_AFTER_MAX_SEC, SWITCHED_OFF, newIdempotencyKey } from "./retry.mjs";
import { MAX_TIMER_MS, STOPPED, byteLengthOf, callHook, checkOptionNames, invalid, isObject, isSignal, onAbort, unlessAborted } from "./transport.mjs";

/** @typedef {import("./table.mjs").OperationSpec} OperationSpec */
/** @typedef {import("./transport.mjs").Transport} Transport */
/** @typedef {import("./transport.mjs").OperationIndex} OperationIndex */
/** @typedef {import("./transport.mjs").BinaryBody} BinaryBody */
/** @typedef {import("./retry.mjs").Failure} Failure */

/** The options of uploadFile. */
export const UPLOAD_OPTIONS = Object.freeze(["filename", "contentType", "sizeBytes", "title", "concurrency", "onProgress", "signal"]);

/** Parts in flight at once, unless the caller says otherwise. */
export const UPLOAD_CONCURRENCY = 4;

/** The most parts in flight a caller may ask for. */
export const UPLOAD_CONCURRENCY_MAX = 16;

/** The time a part has, whatever its size. */
export const PART_TIMEOUT_MIN_MS = 60_000;

/** The most time a part has. */
export const PART_TIMEOUT_MAX_MS = 600_000;

/** The slowest line a part is given time for: 100 KB a second. */
export const PART_SLOWEST_BYTES_PER_SEC = 100_000;

/** How long the cancel of a failed upload may take, in the background. */
export const CANCEL_DEADLINE_MS = 15_000;

/**
 * The options of uploadFile.
 * @typedef {object} UploadOptions
 * @property {string} [filename] the name of the file, such as interview.mp4; a File gives its own
 * @property {string} [contentType] the type of the file, such as video/mp4; a Blob gives its own, and
 *   without either the API reads it from the extension of filename
 * @property {number} [sizeBytes] the exact size in bytes: needed for a ReadableStream, checked for the rest
 * @property {string} [title] the title of the video in the app
 * @property {number} [concurrency] parts in flight at once, 4 by default, at most 16
 * @property {(progress: UploadProgress) => void} [onProgress] told after every part the API received;
 *   what it throws is ignored
 * @property {AbortSignal} [signal] stops the upload
 */

/** @typedef {{ uploadedBytes: number, totalBytes: number }} UploadProgress */

/**
 * What uploadFile reads parts from.
 * @typedef {object} Source
 * @property {number} size
 * @property {boolean} rereadable false for a stream, whose bytes are gone once sent
 * @property {string | undefined} name the name of a File
 * @property {string | undefined} type the type of a Blob
 * @property {(number: number, partSize: number) => Promise<BinaryBody>} part the bytes of a part, from 1
 * @property {() => void} close releases a stream that was read
 */

/**
 * @typedef {object} UploadContext
 * @property {Transport} transport
 * @property {OperationIndex} index
 */

/**
 * The timeout of a part: its size at the slowest line, between one and ten minutes.
 * @param {number} bytes
 */
export function partTimeoutMs(bytes) {
  return Math.min(PART_TIMEOUT_MAX_MS, Math.max(PART_TIMEOUT_MIN_MS, Math.ceil((bytes * 1000) / PART_SLOWEST_BYTES_PER_SEC)));
}

/**
 * The deadline of a part: every attempt with its whole timeout, and every pause with the longest Retry-After
 * the SDK waits. It never cuts a run of retries the rules allow, and it ends.
 * @param {number} timeoutMs
 * @param {number} maxRetries
 */
export function partDeadlineMs(timeoutMs, maxRetries) {
  return Math.min(MAX_TIMER_MS, (maxRetries + 1) * timeoutMs + maxRetries * RETRY_AFTER_MAX_SEC * 1000);
}

/** @param {unknown} value @returns {Uint8Array} */
function bytesOf(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  throw invalid("The stream must give bytes, such as Uint8Array chunks.");
}

/**
 * @param {ReadableStream<unknown>} stream
 * @param {number} size
 * @returns {Source}
 */
function streamSource(stream, size) {
  /** @type {ReadableStreamDefaultReader<unknown> | null} */
  let reader = null;
  /** @type {Uint8Array} */
  let leftover = new Uint8Array(0);
  let consumed = 0;
  /** @type {Promise<unknown>} */
  let chain = Promise.resolve();
  const read = async () => {
    reader ??= stream.getReader();
    return reader.read();
  };
  /**
   * The next `count` bytes of the stream, or, with `keep` false, the next `count` bytes dropped (a part the API
   * already holds).
   * @param {number} count
   * @param {boolean} keep
   */
  const take = async (count, keep) => {
    const out = new Uint8Array(keep ? count : 0);
    let filled = 0;
    while (filled < count) {
      if (leftover.byteLength === 0) {
        const { done, value } = await read();
        if (done) throw invalid(`The stream ended after ${consumed + filled} bytes, and sizeBytes is ${size}.`);
        leftover = bytesOf(value);
        continue;
      }
      const n = Math.min(count - filled, leftover.byteLength);
      if (keep) out.set(leftover.subarray(0, n), filled);
      leftover = leftover.subarray(n);
      filled += n;
    }
    consumed += count;
    return out;
  };
  const assertEnd = async () => {
    if (leftover.byteLength > 0) throw invalid(`The stream has more bytes than sizeBytes, ${size}.`);
    for (;;) {
      const { done, value } = await read();
      if (done) return;
      if (bytesOf(value).byteLength > 0) throw invalid(`The stream has more bytes than sizeBytes, ${size}.`);
    }
  };
  return {
    size,
    rereadable: false,
    name: undefined,
    type: undefined,
    // the parts of a stream are read in order, one after the other, whatever the parallel sending does; the
    // bytes of a part the API already holds are read and dropped
    part(number, partSize) {
      const start = (number - 1) * partSize;
      const end = Math.min(number * partSize, size);
      const result = chain.then(async () => {
        // uploadFile asks for each part once, in increasing order, and keeps its bytes for the retries
        if (start < consumed) throw new Error(`Part ${number} of a stream was asked for after its bytes were read.`);
        await take(start - consumed, false);
        const bytes = await take(end - start, true);
        if (end === size) await assertEnd();
        return bytes;
      });
      chain = result.catch(() => {});
      return result;
    },
    close() {
      reader?.cancel().catch(() => {});
    },
  };
}

/**
 * What a source of uploadFile is, checked before anything is read or sent.
 * @param {unknown} source
 * @param {number | undefined} sizeBytes
 * @returns {Source}
 */
function sourceOf(source, sizeBytes) {
  if (typeof Blob !== "undefined" && source instanceof Blob) {
    const name = /** @type {{ name?: unknown }} */ (source).name;
    return {
      size: source.size,
      rereadable: true,
      name: typeof name === "string" && name.length > 0 ? name : undefined,
      type: source.type.length > 0 ? source.type : undefined,
      part: async (number, partSize) => source.slice((number - 1) * partSize, Math.min(number * partSize, source.size)),
      close() {},
    };
  }
  if (source instanceof ArrayBuffer || ArrayBuffer.isView(source)) {
    const bytes = bytesOf(source);
    return {
      size: bytes.byteLength,
      rereadable: true,
      name: undefined,
      type: undefined,
      part: async (number, partSize) => bytes.subarray((number - 1) * partSize, Math.min(number * partSize, bytes.byteLength)),
      close() {},
    };
  }
  if (isObject(source) && typeof source.getReader === "function") {
    if (sizeBytes === undefined) throw invalid("uploadFile needs sizeBytes for a stream: the API asks for the size before the first byte.");
    if (source.locked === true) throw invalid("The stream is already being read by someone else.");
    return streamSource(/** @type {ReadableStream<unknown>} */ (/** @type {unknown} */ (source)), sizeBytes);
  }
  throw invalid("uploadFile takes a Blob, a File, an ArrayBuffer, a Uint8Array or a ReadableStream. In Node.js, open a file with fs.openAsBlob(path).");
}

/**
 * The upload an answer carries, checked: its parts must cover the file exactly.
 * @param {unknown} body
 * @param {number} size
 * @param {OperationSpec} spec
 */
function uploadIn(body, size, spec) {
  const upload = isObject(body) ? body.upload : undefined;
  if (!isObject(upload) || typeof upload.id !== "string" || upload.id.length === 0) throw badAnswer(spec, TEXTS.missingHandle("upload"));
  const { partSizeBytes, partCount } = upload;
  if (
    typeof partSizeBytes !== "number" ||
    !Number.isSafeInteger(partSizeBytes) ||
    partSizeBytes <= 0 ||
    typeof partCount !== "number" ||
    partCount !== Math.ceil(size / partSizeBytes)
  ) {
    throw badAnswer(spec, TEXTS.partsMismatch(size, Number(partSizeBytes), Number(partCount)));
  }
  const received = new Set(Array.isArray(upload.receivedParts) ? upload.receivedParts.filter((n) => Number.isSafeInteger(n)) : []);
  return { id: upload.id, partSizeBytes, partCount, received };
}

/** @param {OperationSpec} spec @param {string} message */
function badAnswer(spec, message) {
  return new GptVideoNetworkError(formatErrorMessage({ code: "BAD_RESPONSE", message }), { code: "BAD_RESPONSE", operation: spec.id });
}

/** @param {number} count @returns {number[]} */
function numbersTo(count) {
  return Array.from({ length: count }, (_, i) => i + 1);
}

/**
 * The sentence that says where else a video can be uploaded when uploads are turned off.
 * @param {Failure} outcome
 * @returns {string | null}
 */
function elsewhere(outcome) {
  return outcome.kind === "api" && outcome.code === "UNAVAILABLE" && isObject(outcome.details) && outcome.details.reason === SWITCHED_OFF
    ? MESSAGES.uploadElsewhere
    : null;
}

/**
 * `gv.uploadFile(source, options)`: resolves to the answer of complete_upload, `{ asset }`.
 *
 * @param {UploadContext} ctx
 * @param {unknown} source
 * @param {UploadOptions} [options]
 * @returns {Promise<any>}
 */
export async function uploadFile(ctx, source, options) {
  if (options !== undefined && !isObject(options)) throw invalid("The options of uploadFile must be an object.");
  const o = /** @type {Record<string, unknown>} */ (options ?? {});
  checkOptionNames(o, UPLOAD_OPTIONS, "uploadFile");
  if (o.signal !== undefined && !isSignal(o.signal)) throw invalid("signal must be an AbortSignal.");
  if (o.onProgress !== undefined && typeof o.onProgress !== "function") throw invalid("onProgress must be a function.");
  for (const name of ["filename", "contentType", "title"]) {
    const value = o[name];
    if (value !== undefined && (typeof value !== "string" || value.length === 0)) throw invalid(`${name} must be a non-empty string.`);
  }
  const concurrency = o.concurrency === undefined ? UPLOAD_CONCURRENCY : o.concurrency;
  if (typeof concurrency !== "number" || !Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > UPLOAD_CONCURRENCY_MAX) {
    throw invalid(`concurrency must be a whole number from 1 to ${UPLOAD_CONCURRENCY_MAX}.`);
  }
  const sizeBytes = o.sizeBytes;
  if (sizeBytes !== undefined && (typeof sizeBytes !== "number" || !Number.isSafeInteger(sizeBytes) || sizeBytes < 1)) {
    throw invalid("sizeBytes must be a whole number of bytes, 1 or more.");
  }
  const src = sourceOf(source, /** @type {number | undefined} */ (sizeBytes));
  if (sizeBytes !== undefined && sizeBytes !== src.size) throw invalid(`sizeBytes is ${sizeBytes}, and the file has ${src.size} bytes.`);
  if (src.size === 0) throw invalid("The file is empty.");
  const filename = /** @type {string | undefined} */ (o.filename) ?? src.name;
  if (!filename) throw invalid("uploadFile needs a filename, such as interview.mp4: the API reads the type of the video from it.");
  const contentType = /** @type {string | undefined} */ (o.contentType) ?? src.type;
  const title = /** @type {string | undefined} */ (o.title);
  const signal = /** @type {AbortSignal | undefined} */ (o.signal);
  const onProgress = /** @type {UploadOptions["onProgress"]} */ (o.onProgress);
  const completeKey = newIdempotencyKey();
  if (completeKey === null) throw invalid(MESSAGES.noCrypto);

  const ops = {
    create: ctx.index.operation("create_upload"),
    part: ctx.index.operation("upload_part"),
    read: ctx.index.operation("get_upload"),
    complete: ctx.index.operation("complete_upload"),
    cancel: ctx.index.operation("cancel_upload"),
  };
  const withSignal = signal ? { signal } : {};

  try {
    const created = await ctx.transport.send(ops.create, { filename, sizeBytes: src.size, ...(contentType ? { contentType } : {}) }, withSignal, undefined, {
      explain: elsewhere,
    });
    const openedId = isObject(created) && isObject(created.upload) && typeof created.upload.id === "string" && created.upload.id.length > 0 ? created.upload.id : null;
    /** @type {ReturnType<typeof uploadIn>} */
    let upload;
    try {
      upload = uploadIn(created, src.size, ops.create);
    } catch (e) {
      if (openedId) cancelInBackground(ctx, ops.cancel, openedId);
      throw e;
    }
    let uploadedBytes = 0;
    /** @param {number[]} numbers */
    const sendParts = (numbers) =>
      sendInParallel(ctx, ops.part, upload, src, numbers, concurrency, signal, (bytes) => {
        uploadedBytes += bytes;
        callHook(onProgress, { uploadedBytes, totalBytes: src.size });
      });
    const complete = () => ctx.transport.send(ops.complete, { uploadId: upload.id, ...(title ? { title } : {}) }, { idempotencyKey: completeKey, ...withSignal });
    try {
      await sendParts(numbersTo(upload.partCount).filter((n) => !upload.received.has(n)));
      try {
        return await complete();
      } catch (e) {
        if (!(e instanceof GptVideoApiError) || e.code !== "CONFLICT" || !src.rereadable) throw e;
        /** @type {number[]} */
        let missing;
        try {
          const again = uploadIn(await ctx.transport.send(ops.read, { uploadId: upload.id }, withSignal), src.size, ops.read);
          missing = numbersTo(again.partCount).filter((n) => !again.received.has(n));
        } catch {
          // the upload cannot be read: the refusal of complete is the answer the caller needs
          throw e;
        }
        if (missing.length === 0) throw e;
        // the progress goes back to what the API holds, and the parts sent again add up to the whole file
        const partBytes = (/** @type {number} */ n) => Math.min(n * upload.partSizeBytes, src.size) - (n - 1) * upload.partSizeBytes;
        uploadedBytes = src.size - missing.reduce((sum, n) => sum + partBytes(n), 0);
        await sendParts(missing);
        return await complete();
      }
    } catch (e) {
      cancelInBackground(ctx, ops.cancel, upload.id);
      throw e;
    }
  } finally {
    src.close();
  }
}

/**
 * An open upload counts against the open uploads and the storage of the account until it expires: once an
 * upload fails, it is cancelled in the background, without the caller's signal, and whatever the cancel
 * answers is ignored. The failure that caused it reaches the caller at once.
 *
 * @param {UploadContext} ctx
 * @param {OperationSpec} cancelSpec
 * @param {string} uploadId
 */
function cancelInBackground(ctx, cancelSpec, uploadId) {
  ctx.transport.send(cancelSpec, { uploadId }, { deadlineMs: CANCEL_DEADLINE_MS, maxRetries: 1 }).catch(() => {});
}

/**
 * Sends parts, at most `concurrency` at once, one at a time after a part timed out. The first part that
 * fails stops the others and is the error.
 *
 * @param {UploadContext} ctx
 * @param {OperationSpec} partSpec
 * @param {{ id: string, partSizeBytes: number }} upload
 * @param {Source} src
 * @param {number[]} numbers
 * @param {number} concurrency
 * @param {AbortSignal | undefined} signal
 * @param {(bytes: number) => void} received
 * @returns {Promise<void>}
 */
function sendInParallel(ctx, partSpec, upload, src, numbers, concurrency, signal, received) {
  const stop = new AbortController();
  const unlink = onAbort(signal, () => stop.abort());
  const maxRetries = ctx.transport.defaults.maxRetries;
  let limit = concurrency;
  /** @param {number} number */
  const sendPart = async (number) => {
    // the bytes come from the caller's source, which the SDK cannot hurry: a stream that stalls would hold the
    // upload open for ever, so the read ends when the upload is stopped (the caller's signal, or another part
    // that failed), like a request would
    const read = await unlessAborted(src.part(number, upload.partSizeBytes), stop.signal);
    if (read === STOPPED) {
      throw new GptVideoNetworkError(formatErrorMessage({ code: "ABORTED", message: MESSAGES.aborted }), { code: "ABORTED", operation: partSpec.id });
    }
    if (!read.ok) throw read.error;
    const bytes = read.value;
    const length = byteLengthOf(bytes);
    const timeoutMs = partTimeoutMs(length);
    await ctx.transport.send(
      partSpec,
      { uploadId: upload.id, partNumber: number },
      { signal: stop.signal, timeoutMs, deadlineMs: partDeadlineMs(timeoutMs, maxRetries) },
      bytes,
      {
        onFailure: (outcome) => {
          if (outcome.code === "TIMEOUT") limit = 1;
        },
      },
    );
    received(length);
  };
  return new Promise((resolve, reject) => {
    const queue = [...numbers];
    let inFlight = 0;
    let failed = false;
    const pump = () => {
      if (failed) return;
      if (queue.length === 0 && inFlight === 0) {
        unlink();
        resolve();
        return;
      }
      while (inFlight < limit && queue.length > 0) {
        const number = /** @type {number} */ (queue.shift());
        inFlight++;
        sendPart(number).then(
          () => {
            inFlight--;
            pump();
          },
          (error) => {
            inFlight--;
            if (failed) return;
            failed = true;
            stop.abort();
            unlink();
            reject(error);
          },
        );
      }
    };
    pump();
  });
}
