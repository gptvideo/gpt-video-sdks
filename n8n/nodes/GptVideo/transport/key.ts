/**
 * The Idempotency-Key of a call made by the node: one per intention, the same on every attempt.
 *
 * An intention is one call of one item of one run of this node, in one execution of one workflow on one n8n
 * instance. The key is `n8n-` and the SHA-256 of those parts, so it is the same when n8n runs the node again
 * for the same item ("Retry On Fail"), and different for another item, another run of the node in the same
 * execution, another execution, or another instance whose execution has the same number. A node that makes
 * several calls for one item (an upload: open, then complete) names each call, so each has its own key.
 *
 * When an AI Agent uses the node as a tool, n8n gives every try of "Retry On Fail" a new run index, so there the
 * run cannot tell a try from a new call. The arguments of the tool call take its place: a try sends the same
 * arguments again and gets the same key. Two calls of the tool with the same arguments in one execution are one
 * intention, and the second gets the answer of the first.
 *
 * A key the user writes in Options > Idempotency Key wins over all of this: it is how a request whose answer
 * was lost is sent again from a new execution without paying twice.
 */

import { createHash } from 'node:crypto';

import { GptVideoInputError, MESSAGES } from './errors.ts';
import { isIdempotencyKey } from './rules.ts';

/** What makes one call of the node a different intention from every other. */
export type KeyParts = {
	readonly instanceId: string;
	readonly workflowId: string;
	readonly executionId: string;
	readonly nodeId: string;
	/** the run of the node in the execution; null when the node runs as a tool, where `toolCall` stands for it */
	readonly runIndex: number | null;
	readonly itemIndex: number;
	/** the SHA-256 of the arguments of the tool call, when an AI Agent uses the node as a tool */
	readonly toolCall?: string | null;
	/** which call of the item: the operation id, or a step of a composite operation (upload_file:complete) */
	readonly call: string;
};

/** The version of the recipe: changing what goes into the hash changes this, so two recipes never share a key. */
const RECIPE = 'gpt-video-n8n-key-2';

export const KEY_PREFIX = 'n8n-';

/** The key of one intention: `n8n-` and 64 lowercase hex digits (keys.json, generators.n8n). */
export function derivedKey(parts: KeyParts): string {
	const text = JSON.stringify([
		RECIPE,
		parts.instanceId,
		parts.workflowId,
		parts.executionId,
		parts.nodeId,
		parts.runIndex,
		parts.itemIndex,
		parts.toolCall ?? null,
		parts.call,
	]);
	return `${KEY_PREFIX}${createHash('sha256').update(text, 'utf8').digest('hex')}`;
}

/** A value as JSON with the keys of every object in order, so the same arguments always give the same text. */
export function canonicalJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v ?? null)).join(',')}]`;
	if (typeof value === 'object' && value !== null) {
		const toJSON = (value as { toJSON?: unknown }).toJSON;
		if (typeof toJSON === 'function') return canonicalJson(toJSON.call(value));
		const record = value as Record<string, unknown>;
		const entries = Object.keys(record)
			.filter((k) => record[k] !== undefined)
			.sort()
			.map((k) => `${JSON.stringify(k)}:${canonicalJson(record[k])}`);
		return `{${entries.join(',')}}`;
	}
	return JSON.stringify(value) ?? 'null';
}

/** What stands for the run of a tool call: the SHA-256 of its arguments. */
export function toolCallDigest(args: unknown): string {
	return createHash('sha256').update(canonicalJson(args), 'utf8').digest('hex');
}

/**
 * The key a call sends: the one the user wrote, checked, or the derived one. A key written for an item that
 * makes several calls gets the name of each call after it, so the calls do not share it.
 */
export function keyFor(userKey: unknown, parts: KeyParts, single: boolean): string {
	if (userKey === undefined || userKey === null || userKey === '') return derivedKey(parts);
	if (!isIdempotencyKey(userKey)) throw new GptVideoInputError(MESSAGES.badIdempotencyKey);
	if (single) return userKey;
	const named = `${userKey}:${parts.call}`;
	if (!isIdempotencyKey(named)) throw new GptVideoInputError(MESSAGES.badIdempotencyKey);
	return named;
}
