/** The shared vectors of the GPT-Video SDKs, which sit beside this package. */

import { readFileSync } from 'node:fs';

export function readVectors(name: string): any {
	return JSON.parse(readFileSync(new URL(`../../../vectors/${name}`, import.meta.url), 'utf8'));
}

export function readPackage(): { name: string; version: string; [key: string]: unknown } {
	return JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
}
