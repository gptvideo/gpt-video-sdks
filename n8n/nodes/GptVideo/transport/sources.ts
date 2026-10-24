/**
 * The two kinds of file an upload reads parts from: bytes already in memory, which can be read again, and a
 * stream, read once from its start. A stream is never gathered whole: it holds at most one part, plus what is
 * left of the last chunk it was given.
 */

import { GptVideoInputError } from './errors.ts';
import type { UploadSource } from './upload.ts';

/** Bytes in memory. */
export function bytesSource(bytes: Uint8Array): UploadSource {
	return {
		size: bytes.byteLength,
		rereadable: true,
		part: async (number, partSize) => bytes.subarray((number - 1) * partSize, Math.min(number * partSize, bytes.byteLength)),
	};
}

function asBytes(chunk: unknown): Uint8Array {
	if (chunk instanceof Uint8Array) return chunk;
	if (chunk instanceof ArrayBuffer) return new Uint8Array(chunk);
	if (ArrayBuffer.isView(chunk)) return new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
	throw new GptVideoInputError('The binary stream gave something that is not bytes.');
}

/**
 * A stream of `size` bytes. Parts are asked for in order, from 1, and each one is exactly `partSize` bytes but
 * the last. A stream that ends early, or goes on past `size`, is an error: the API would hold another file.
 */
export function streamSource(chunks: AsyncIterable<unknown>, size: number): UploadSource {
	const iterator = chunks[Symbol.asyncIterator]();
	let leftover: Uint8Array = new Uint8Array(0);
	let consumed = 0;
	let next = 1;
	const take = async (count: number): Promise<Uint8Array> => {
		const out = new Uint8Array(count);
		let filled = 0;
		while (filled < count) {
			if (leftover.byteLength === 0) {
				const { done, value } = await iterator.next();
				if (done) throw new GptVideoInputError(`The binary stream ended after ${consumed + filled} bytes, and the file has ${size}.`);
				leftover = asBytes(value);
				continue;
			}
			const n = Math.min(count - filled, leftover.byteLength);
			out.set(leftover.subarray(0, n), filled);
			leftover = leftover.subarray(n);
			filled += n;
		}
		consumed += count;
		return out;
	};
	return {
		size,
		rereadable: false,
		part: async (number, partSize) => {
			if (number !== next) throw new Error(`a stream is read in order: part ${next} comes before part ${number}`);
			next++;
			const count = Math.min(number * partSize, size) - (number - 1) * partSize;
			const bytes = await take(count);
			if (consumed === size) {
				// past the last part the stream must be over
				while (leftover.byteLength === 0) {
					const { done, value } = await iterator.next();
					if (done) return bytes;
					leftover = asBytes(value);
				}
				throw new GptVideoInputError(`The binary stream has more than the ${size} bytes of the file.`);
			}
			return bytes;
		},
	};
}
