// @ts-check
// The package as npm would publish it: what package.json promises, the files the tarball holds (computed from
// `files` the way npm reads it), the version in the User-Agent, no declaration of the engine written by hand, and
// a TypeScript program compiled against the declarations tsc emits from the JSDoc, laid out as an installed
// package, with strict settings and both node16 and bundler module resolution.
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { afterAll, describe, expect, it } from "vitest";
import { USER_AGENT_PRODUCT, VERSION, resolveSettings } from "./transport.mjs";

const PACKAGE_DIR = fileURLToPath(new URL("..", import.meta.url));
const PKG = JSON.parse(readFileSync(join(PACKAGE_DIR, "package.json"), "utf8"));
const INSTALL_SCRIPTS = ["preinstall", "install", "postinstall", "preprepare", "prepare", "postprepare"];
const LIBS = ["lib.es2022.d.ts", "lib.dom.d.ts", "lib.dom.iterable.d.ts", "lib.dom.asynciterable.d.ts"];
// built at run time, so that this file does not hold the words it looks for
const INTERNAL_NAMES = new RegExp(["vir" + "ality", "co" + "pilot", "co" + "dex"].join("|"), "i");
const SECRET = new RegExp(["gv" + "k_[A-Za-z0-9_-]{20,}", "wh" + "sec_[A-Za-z0-9+/=]{24,}"].join("|"));

/** Every file under a folder, as a path relative to it with forward slashes, node_modules left out. @param {string} dir */
function filesUnder(dir, prefix = "") {
  /** @type {string[]} */
  const out = [];
  for (const entry of readdirSync(join(dir, prefix), { withFileTypes: true })) {
    if (entry.name === "node_modules") continue;
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...filesUnder(dir, rel));
    else out.push(rel);
  }
  return out;
}

/**
 * The files npm puts in the tarball: package.json, a README and a LICENSE at the root, and every file a pattern of
 * `files` matches and no `!` pattern excludes.
 */
function packedFiles() {
  /** @type {string[]} */
  const patterns = PKG.files;
  const include = patterns.filter((p) => !p.startsWith("!"));
  const exclude = patterns.filter((p) => p.startsWith("!")).map((p) => p.slice(1));
  const always = (/** @type {string} */ file) => file === "package.json" || /^(?:README|LICENSE|LICENCE)(?:\.[^/]*)?$/i.test(file);
  return filesUnder(PACKAGE_DIR)
    .filter((file) => always(file) || (include.some((g) => posix.matchesGlob(file, g)) && !exclude.some((g) => posix.matchesGlob(file, g))))
    .sort();
}

/**
 * The relative modules a source names: its imports and re-exports, and the files its JSDoc types come from.
 * @param {string} text
 */
function referencesOf(text) {
  /** @type {string[]} */
  const out = [];
  for (const m of text.matchAll(/\bfrom\s*["'](\.\.?\/[^"']+)["']/g)) out.push(/** @type {string} */ (m[1]));
  for (const m of text.matchAll(/\bimport\(\s*["'](\.\.?\/[^"']+)["']\s*\)/g)) out.push(/** @type {string} */ (m[1]));
  return out;
}

/** The files the published entry points need, followed from `exports` through every import and JSDoc type. */
function reachableFiles() {
  const pending = Object.values(/** @type {Record<string, string>} */ (PKG.exports)).map((target) => posix.normalize(target));
  /** @type {Set<string>} */
  const seen = new Set();
  while (pending.length > 0) {
    const file = /** @type {string} */ (pending.pop());
    if (seen.has(file)) continue;
    seen.add(file);
    for (const spec of referencesOf(readFileSync(join(PACKAGE_DIR, file), "utf8"))) {
      let target = posix.join(posix.dirname(file), spec);
      // TypeScript writes the name of the compiled file: ./types.generated.js is types.generated.d.ts
      if (target.endsWith(".js")) target = `${target.slice(0, -3)}.d.ts`;
      pending.push(target);
    }
  }
  return [...seen].sort();
}

/** The settings `npm pack` emits the declarations with: tsconfig.dts.json, which the prepack script names. */
function prepackConfig() {
  const config = ts.getParsedCommandLineOfConfigFile(join(PACKAGE_DIR, "tsconfig.dts.json"), {}, {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic: (diagnostic) => {
      throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"));
    },
  });
  if (!config) throw new Error("tsconfig.dts.json cannot be read");
  return config;
}

/** @param {readonly ts.Diagnostic[]} diagnostics */
function readable(diagnostics) {
  return diagnostics.map((d) => {
    const where = d.file && d.start !== undefined ? `${d.file.fileName}:${d.file.getLineAndCharacterOfPosition(d.start).line + 1} ` : "";
    return `${where}${ts.flattenDiagnosticMessageText(d.messageText, "\n")}`;
  });
}

const TEMP = mkdtempSync(join(tmpdir(), "gpt-video-package-"));
afterAll(() => rmSync(TEMP, { recursive: true, force: true }));

/**
 * An installed copy of the package in a project of its own: the files of the tarball, and next to each source the
 * declaration tsc emits from its JSDoc. Returns the project folder and what the emit said.
 */
function installedProject() {
  const project = join(TEMP, "project");
  const installed = join(project, "node_modules", PKG.name);
  for (const file of packedFiles()) {
    mkdirSync(join(installed, posix.dirname(file)), { recursive: true });
    copyFileSync(join(PACKAGE_DIR, file), join(installed, file));
  }
  // the settings of the prepack, as `npm pack` runs them, with only the output moved into the installed copy
  const config = prepackConfig();
  const program = ts.createProgram({ rootNames: config.fileNames, options: { ...config.options, outDir: join(installed, "src") } });
  const emitted = program.emit();
  writeFileSync(join(project, "package.json"), JSON.stringify({ name: "consumer", private: true, type: "module" }));
  copyFileSync(fileURLToPath(new URL("../test-d/consumer.ts", import.meta.url)), join(project, "consumer.ts"));
  return { project, installed, problems: readable([...ts.getPreEmitDiagnostics(program), ...emitted.diagnostics]) };
}

/**
 * The type errors of the consumer, compiled against the installed copy.
 * @param {string} project
 * @param {"node16" | "bundler"} resolution
 */
function compileConsumer(project, resolution) {
  const program = ts.createProgram({
    rootNames: [join(project, "consumer.ts")],
    options: {
      ...(resolution === "node16"
        ? { module: ts.ModuleKind.Node16, moduleResolution: ts.ModuleResolutionKind.Node16 }
        : { module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler }),
      target: ts.ScriptTarget.ES2022,
      lib: LIBS,
      types: [],
      strict: true,
      noEmit: true,
      skipLibCheck: false,
      noUncheckedIndexedAccess: true,
      exactOptionalPropertyTypes: true,
      noImplicitOverride: true,
      noImplicitReturns: true,
    },
  });
  return readable(ts.getPreEmitDiagnostics(program));
}

describe("package.json", () => {
  it("installs nothing and runs nothing on the machine that installs it", () => {
    for (const field of ["dependencies", "peerDependencies", "optionalDependencies", "bundleDependencies", "bundledDependencies"]) {
      expect(Object.keys(PKG[field] ?? {}), field).toEqual([]);
    }
    for (const name of INSTALL_SCRIPTS) expect(PKG.scripts ?? {}, name).not.toHaveProperty(name);
    expect(PKG.type).toBe("module");
    expect(PKG.engines).toEqual({ node: ">=20.19" });
    expect(PKG.sideEffects).toBe(false);
  });

  it("is public, and packs the declarations tsc emits from the JSDoc of its entry points", () => {
    // the package is published to npm, so it must not be marked private
    expect(PKG.private).toBeUndefined();
    expect(PKG.scripts.prepack).toBe("tsc -p tsconfig.dts.json");
    expect(PKG.files).toContain("src/*.d.mts");
    // the declarations are build output: postpack removes them, so the sources keep no declaration but the generated one
    expect(PKG.scripts.postpack).toContain(".d.mts");
    const config = prepackConfig();
    expect(config.options.declaration).toBe(true);
    expect(config.options.emitDeclarationOnly).toBe(true);
    const roots = config.fileNames.map((file) => posix.relative(PACKAGE_DIR.replaceAll("\\", "/"), file.replaceAll("\\", "/"))).sort();
    const entries = Object.values(/** @type {Record<string, string>} */ (PKG.exports)).map((target) => posix.normalize(target)).sort();
    expect(roots).toEqual(entries);
  });

  it("names the version the client sends in its User-Agent, as the request log of the API counts an SDK", () => {
    expect(VERSION).toBe(PKG.version);
    expect(PKG.version).toMatch(/^\d+\.\d+\.\d+$/);
    // the request log of the API labels a User-Agent that starts with gpt-video- (or gptvideo-) as an SDK
    expect(USER_AGENT_PRODUCT).toMatch(/^gpt-?video-/);
    expect(resolveSettings({ apiKey: `gvk_${"P".repeat(43)}`, fetch: async () => new Response("{}") }).userAgent).toBe(`${USER_AGENT_PRODUCT}/${PKG.version}`);
  });
});

describe("the tarball", () => {
  const packed = packedFiles();

  it("holds every file the two entry points need, and the license", () => {
    expect(Object.keys(PKG.exports).sort()).toEqual([".", "./webhooks"]);
    const missing = reachableFiles().filter((file) => !packed.includes(file));
    expect(missing).toEqual([]);
    expect(packed).toContain("LICENSE");
    expect(packed).toContain("package.json");
    expect(reachableFiles()).toContain("src/types.generated.d.ts");
  });

  it("holds no test, no test helper and no build setting", () => {
    // the helpers of the tests are .js files in src/testing: the tarball takes src/*.mjs, never them
    expect(filesUnder(join(PACKAGE_DIR, "src", "testing")).every((file) => file.endsWith(".js"))).toBe(true);
    expect(packed.filter((file) => /\.test\.mjs$|^src\/testing\/|^test-d\/|^tsconfig|\.generated\.json$/.test(file))).toEqual([]);
    expect(packed.every((file) => file === "package.json" || file === "LICENSE" || /^README/.test(file) || /^src\/[^/]+\.(?:mjs|d\.ts|d\.mts)$/.test(file))).toBe(true);
  });

  it("says GPT-Video and holds no internal name and no key, in any file", () => {
    for (const file of packed) {
      const text = readFileSync(join(PACKAGE_DIR, file), "utf8");
      expect(text.match(INTERNAL_NAMES)?.[0] ?? null, file).toBeNull();
      expect(text.match(SECRET)?.[0] ?? null, file).toBeNull();
    }
  });

  it("runs no code made from a string", () => {
    for (const file of packed.filter((f) => f.endsWith(".mjs"))) {
      const text = readFileSync(join(PACKAGE_DIR, file), "utf8");
      expect(text, file).not.toMatch(/\beval\s*\(|\bnew\s+Function\s*\(|\bFunction\s*\(\s*["'`]/);
    }
  });
});

describe("the declarations", () => {
  it("of the engine are never written by hand: the only declaration file in src is generated", () => {
    const declarations = filesUnder(join(PACKAGE_DIR, "src")).filter((file) => /\.d\.(?:ts|mts|cts)$/.test(file));
    expect(declarations).toEqual(["types.generated.d.ts"]);
  });

  it("that tsc emits from the JSDoc give a strict TypeScript program the right types, with node16 and bundler resolution", { timeout: 120_000 }, () => {
    const { project, installed, problems } = installedProject();
    expect(problems, "the emit").toEqual([]);
    const emitted = readdirSync(join(installed, "src")).filter((file) => file.endsWith(".d.mts"));
    for (const entry of ["index", "webhooks", "client", "transport", "errors"]) expect(emitted, entry).toContain(`${entry}.d.mts`);
    // the declarations are published text too: their comments come from the JSDoc of the sources
    for (const file of emitted) {
      const text = readFileSync(join(installed, "src", file), "utf8");
      expect(text.match(INTERNAL_NAMES)?.[0] ?? null, file).toBeNull();
      expect(text.match(SECRET)?.[0] ?? null, file).toBeNull();
    }
    for (const resolution of /** @type {const} */ (["node16", "bundler"])) {
      expect(compileConsumer(project, resolution), resolution).toEqual([]);
    }
  });
});
