/**
 * The package as n8n verifies a community node: no dependency, an n8n block that points at what the build
 * makes, and sources that use none of what n8n Cloud forbids. `n8n-node lint` is the full check; these are the
 * rules that would turn a verified node into a rejected one, kept here so the tests catch them on every run.
 */

import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { GptVideoApi } from '../credentials/GptVideoApi.credentials.ts';
import { GptVideoWebhookApi } from '../credentials/GptVideoWebhookApi.credentials.ts';
import { CONVENTIONS } from '../nodes/GptVideo/operations.generated.ts';
import { resolveBaseUrl } from '../nodes/GptVideo/transport/request.ts';
import { readPackage } from './support/vectors.mts';

const ROOT = new URL('../', import.meta.url);
const PKG = readPackage();

function* sources(dir: string): Generator<string> {
	for (const entry of readdirSync(new URL(dir, ROOT), { withFileTypes: true })) {
		const path = `${dir}${entry.name}`;
		if (entry.isDirectory()) yield* sources(`${path}/`);
		else if (path.endsWith('.ts')) yield path;
	}
}

const SHIPPED = [...sources('nodes/'), ...sources('credentials/')];

/** The globals n8n Cloud does not allow a community node to use (no-restricted-globals of n8n's lint). */
const RESTRICTED_GLOBALS = ['clearInterval', 'clearTimeout', 'global', 'globalThis', 'process', 'setInterval', 'setTimeout', 'setImmediate', 'clearImmediate', '__dirname', '__filename'];
/** The modules a community node may import (no-restricted-imports of n8n's lint), and its own files. */
const ALLOWED_IMPORTS = new Set(['n8n-workflow', 'node:crypto', 'crypto']);

/** The code of a source without its comments and strings, where a word is a name and nothing else. */
function codeOf(text: string): string {
	return text
		.replace(/\/\*[\s\S]*?\*\//g, ' ')
		.replace(/(^|[^:])\/\/.*$/gm, '$1')
		.replace(/'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`/g, "''");
}

/** The restricted globals a source names, other than as a property (`signal.process` is not the global). */
export function restrictedIn(text: string): string[] {
	const code = codeOf(text);
	return RESTRICTED_GLOBALS.filter((name) => new RegExp(`(?<![.\\w$])${name}(?![\\w$])`).test(code));
}

export function importsOf(text: string): string[] {
	return [...text.matchAll(/^\s*(?:import|export)\b[^'";]*?\bfrom\s*'([^']+)'/gm), ...text.matchAll(/\b(?:import|require)\(\s*'([^']+)'\s*\)/g)].map((m) => m[1]!);
}

describe('the package', () => {
	it('is n8n-nodes-gpt-video, public with the page that tells you to install it, and installs nothing', () => {
		assert.equal(PKG.name, 'n8n-nodes-gpt-video');
		assert.equal(PKG.private, undefined);
		assert.equal(PKG.license, 'MIT');
		assert.ok((PKG.keywords as string[]).includes('n8n-community-node-package'));
		assert.deepEqual(PKG.files, ['dist']);
		for (const field of ['dependencies', 'optionalDependencies', 'bundleDependencies', 'bundledDependencies']) assert.equal(PKG[field], undefined, field);
		assert.deepEqual(PKG.peerDependencies, { 'n8n-workflow': '*' });
		for (const script of ['preinstall', 'install', 'postinstall', 'prepare']) assert.equal((PKG.scripts as Record<string, string>)[script], undefined, script);
		// the export adds repository, bugs and author (and refuses a source that already has them), so this test runs in both trees
		for (const field of ['repository', 'bugs', 'author']) if (PKG[field] !== undefined) assert.match(JSON.stringify(PKG[field]), /gpt-video-sdks|"GPT-Video"/, field);
	});

	it('lists in its n8n block every node and credential it has, by the file the build makes of it', () => {
		const n8n = PKG.n8n as { n8nNodesApiVersion: number; strict: boolean; nodes: string[]; credentials: string[] };
		assert.equal(n8n.n8nNodesApiVersion, 1);
		assert.equal(n8n.strict, true);
		const built = (list: string[]) => list.map((p) => p.replace(/^dist\//, '').replace(/\.js$/, '.ts')).sort();
		assert.deepEqual(built(n8n.nodes), SHIPPED.filter((p) => p.endsWith('.node.ts')).sort());
		assert.deepEqual(built(n8n.credentials), SHIPPED.filter((p) => p.endsWith('.credentials.ts')).sort());
		for (const p of [...n8n.nodes, ...n8n.credentials]) assert.ok(existsSync(new URL(p.replace(/^dist\//, '').replace(/\.js$/, '.ts'), ROOT)), p);
	});

	it('uses none of the globals n8n Cloud forbids, and imports only n8n-workflow, node:crypto and its own files', () => {
		assert.ok(SHIPPED.length >= 15, `the scan found ${SHIPPED.length} files`);
		const found: string[] = [];
		for (const path of SHIPPED) {
			const text = readFileSync(new URL(path, ROOT), 'utf8');
			for (const name of restrictedIn(text)) found.push(`${path}: ${name}`);
			for (const spec of importsOf(text)) if (!spec.startsWith('./') && !spec.startsWith('../') && !ALLOWED_IMPORTS.has(spec)) found.push(`${path}: imports ${spec}`);
		}
		assert.deepEqual(found, []);
	});

	it('keeps the API key in a password field, sends it as a Bearer token, and tests it on /v1/me of the base URL the node uses', () => {
		const credential = new GptVideoApi();
		const key = credential.properties.find((p) => p.name === 'apiKey')!;
		assert.equal(key.typeOptions?.password, true);
		assert.deepEqual(credential.authenticate, { type: 'generic', properties: { headers: { Authorization: '=Bearer {{$credentials.apiKey}}' } } });
		const base = credential.properties.find((p) => p.name === 'baseUrl')!;
		assert.equal(base.default, CONVENTIONS.baseUrl, 'the default Base URL is the one of the API catalogue');
		assert.equal(credential.test.request.url, '/me');
		// the expression of the test, run as n8n runs it, gives the base the node gives every request
		const expression = String(credential.test.request.baseURL).replace(/^=\{\{\s*/, '').replace(/\s*\}\}$/, '');
		const testBase = new Function('$credentials', `return ${expression};`) as (c: { baseUrl: string }) => string;
		for (const written of ['https://api.gpt-video.com/v1', 'https://api.gpt-video.com/v1/', 'https://api.gpt-video.com', 'http://localhost:3000/api/v1//']) {
			assert.equal(testBase({ baseUrl: written }), resolveBaseUrl(written, CONVENTIONS.baseUrl).baseUrl, written);
		}
		const secret = new GptVideoWebhookApi().properties.find((p) => p.name === 'signingSecret')!;
		assert.equal(secret.typeOptions?.password, true);
	});

	it('the check bites on each thing it forbids, and leaves comments, strings and properties alone', () => {
		assert.deepEqual(restrictedIn('setTimeout(() => {}, 1);'), ['setTimeout']);
		assert.deepEqual(restrictedIn('const a = globalThis.fetch;'), ['globalThis']);
		assert.deepEqual(restrictedIn('if (process.env.X) {}'), ['process']);
		assert.deepEqual(restrictedIn('// setTimeout is not used here\nconst s = "process";\nsignal.process();'), []);
		assert.deepEqual(importsOf("import { x } from 'axios';\nconst y = await import('fs');"), ['axios', 'fs']);
	});
});
