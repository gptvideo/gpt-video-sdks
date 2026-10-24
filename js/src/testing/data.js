// @ts-check
/**
 * Where the tests find the shared vectors. In the public repository of the SDKs they are the folder `vectors`
 * beside the folder of this package; where the SDKs are developed they sit one level further out, in the
 * folder that holds the other SDKs. Both places are tried, in that order; a test that cannot read its vectors
 * fails, it never passes on nothing.
 *
 * The files of this folder are .js on purpose: the package publishes src/*.mjs and nothing else, so test code
 * written as .js under src can never ship.
 */
import { existsSync, readFileSync } from "node:fs";

const FOLDERS = [new URL("../../../vectors/", import.meta.url), new URL("../../../../sdks/vectors/", import.meta.url)];

/**
 * A file of the shared vectors, parsed.
 * @param {string} name such as retry.json
 * @returns {any}
 */
export function readVectors(name) {
  const folder = FOLDERS.find((dir) => existsSync(new URL(name, dir)));
  if (!folder) throw new Error(`${name} of the shared vectors was not found beside the package.`);
  return JSON.parse(readFileSync(new URL(name, folder), "utf8"));
}
