#!/usr/bin/env node
// @ts-check
/**
 * The executable. It has no logic: it reads the arguments, opens the loop and turns a failure into
 * an exit code. Everything that can be tested lives in `../src/bridge.mjs`; this file is the only
 * part that touches `process`.
 */
import { describeEdition, parseArgs, run } from "../src/bridge.mjs";

const options = parseArgs(process.argv.slice(2), process.env);
if ("info" in options) {
  // `--version` and `--help`: no protocol is running, so stdout is free
  process.stdout.write(`${options.info}\n`);
  process.exit(0);
}
if ("error" in options) {
  process.stderr.write(`gpt-video-mcp: ${options.error}\n`);
  process.exit(2);
}

// On stderr, never on stdout, and without the key: the host shows these lines in its logs when
// something goes wrong, and they are the only thing that tells a user whether the bridge read
// their configuration. The URL yes, the credential no.
process.stderr.write(`gpt-video-mcp: bridging stdio to ${options.url}\n`);
process.stderr.write(`gpt-video-mcp: ${describeEdition(options)}\n`);

run({ input: process.stdin, output: process.stdout, url: options.url, apiKey: options.apiKey }).then(
  () => process.exit(0),
  (error) => {
    process.stderr.write(`gpt-video-mcp: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  },
);
