/**
 * The request of one call, built once from a row of the table and the flat input of the operation, and sent as
 * it is on every attempt. The rules are those of requests.generated.json in the shared SDK vectors: the path
 * fields into the path, the other fields into the query or the JSON body (`inQuery`), every value in a URL
 * percent-encoded, a JSON body only when a field goes in it.
 */

import { GptVideoInputError, MESSAGES } from './errors.ts';
import type { Conventions, OperationRow } from './table.ts';

export type HttpRequest = {
	readonly method: OperationRow['method'];
	readonly url: string;
	/** every header but Authorization, which n8n adds from the credential */
	readonly headers: Readonly<Record<string, string>>;
	readonly body: string | Uint8Array | undefined;
};

/** The base URL as the credential holds it, with and without its final /v1. */
export type BaseUrl = { readonly root: string; readonly baseUrl: string };

/** Whether an http:// host is this machine, the only place a request may go without TLS. */
export function isThisMachine(hostname: string): boolean {
	const host = hostname.toLowerCase();
	return host === 'localhost' || host.endsWith('.localhost') || /^127\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}$/.test(host) || host === '[::1]';
}

/** Whether an address may be called: https://, or http:// to this machine. */
export function isSafeAddress(url: URL): boolean {
	return url.protocol === 'https:' || (url.protocol === 'http:' && isThisMachine(url.hostname));
}

/** The base URL, written with or without its final /v1; both send the same requests. */
export function resolveBaseUrl(raw: unknown, fallback: Conventions['baseUrl']): BaseUrl {
	const text = typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : fallback;
	let url: URL;
	try {
		url = new URL(text);
	} catch {
		return refuse(`The Base URL of the credential is not an absolute URL. Use ${fallback}.`);
	}
	if (!isSafeAddress(url)) return refuse(MESSAGES.insecureBaseUrl);
	if (url.username || url.password) return refuse('The Base URL of the credential must not hold a user name or a password.');
	if (url.search || url.hash) return refuse('The Base URL of the credential must not have a query or a fragment.');
	const path = url.pathname.replace(/\/+$/, '').replace(/\/v1$/, '');
	return { root: `${url.origin}${path}`, baseUrl: `${url.origin}${path}/v1` };
}

function refuse(message: string): never {
	throw new GptVideoInputError(message);
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Every byte outside A-Z a-z 0-9 - _ . ! ~ * ' ( ) as %XX, a space as %20. A lone surrogate is refused. */
function encoded(name: string, text: string): string {
	try {
		return encodeURIComponent(text);
	} catch {
		return refuse(`${name} is not well-formed text.`);
	}
}

/** A path value: a string, percent-encoded so that / stays inside the segment, or a whole number. */
function pathSegment(row: OperationRow, name: string, value: unknown): string {
	if (value === undefined || value === null || value === '') return refuse(`${row.id} needs ${name}.`);
	if (typeof value === 'string') {
		// a URL parser reads . and .. as this folder and the folder above, which would send the call elsewhere
		if (value === '.' || value === '..') return refuse(`${name} cannot be "${value}".`);
		return encoded(name, value);
	}
	if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return String(value);
	return refuse(`${name} must be a non-empty string or a whole number.`);
}

/** A query value, in the only forms the API reads from a URL: a string, true or false, a whole number. */
function queryValue(row: OperationRow, name: string, value: unknown): string {
	if (typeof value === 'string') return value;
	if (typeof value === 'boolean') return value ? 'true' : 'false';
	if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return String(value);
	return refuse(`${name} must be text, true or false, or a whole number 0 or more: ${row.id} sends it in the URL.`);
}

/** The request of one call. `bytes` is the body of an operation that sends bytes, and only of one. */
export function buildRequest(
	base: BaseUrl,
	conventions: Conventions,
	row: OperationRow,
	input: Readonly<Record<string, unknown>>,
	bytes: Uint8Array | undefined,
	idempotencyKey: string | null,
	userAgent: string,
): HttpRequest {
	if (!isObject(input)) return refuse(`The input of ${row.id} must be an object.`);
	const fields: Record<string, unknown> = { ...input };
	let path = row.path;
	for (const name of row.pathParams) {
		path = path.split(`{${name}}`).join(pathSegment(row, name, fields[name]));
		delete fields[name];
	}
	const headers: Record<string, string> = { Accept: 'application/json', 'User-Agent': userAgent };
	if (idempotencyKey !== null) headers[conventions.headers.idempotencyKey] = idempotencyKey;

	let query = '';
	let body: string | Uint8Array | undefined;
	const present = Object.entries(fields).filter(([, value]) => value !== undefined);
	if (row.inQuery || row.binary) {
		query = present.map(([name, value]) => `${encoded(name, name)}=${encoded(name, queryValue(row, name, value))}`).join('&');
	} else if (present.length > 0) {
		body = JSON.stringify(Object.fromEntries(present));
		headers['Content-Type'] = 'application/json';
	}
	if (row.binary) {
		if (bytes === undefined) return refuse(`${row.id} sends bytes, and none were given.`);
		if (bytes.byteLength > row.binary.maxBytes) return refuse(`${row.id} sends at most ${row.binary.maxBytes} bytes.`);
		body = bytes;
		headers['Content-Type'] = row.binary.contentType;
	} else if (bytes !== undefined) {
		return refuse(`${row.id} sends no bytes.`);
	}
	return { method: row.method, url: `${base.root}${path}${query ? `?${query}` : ''}`, headers, body };
}
