// @ts-check
/**
 * The stdio to HTTPS bridge: an MCP client that only speaks stdio on one side, GPT-Video that only
 * speaks HTTP on the other.
 *
 * It is for the long tail: Zed, JetBrains, some Windsurf installs, self-hosted n8n and every
 * machine behind a corporate proxy can launch a process and write to its standard input, but
 * cannot make an HTTP request to a remote server.
 *
 * Three choices that look like laziness and are not.
 *
 * **JavaScript, not TypeScript.** This package is run by a stranger with `npx`, on their machine,
 * with their Node. Type stripping needs Node 22.6 with a flag or 23.6 without; a user who gets a
 * syntax error from a binary that was supposed to "just work" closes the page. It is still
 * checked by the compiler: `@ts-check` plus JSDoc types.
 *
 * **No dependencies.** This code runs on a customer's machine with their API key in memory. Every
 * dependency is a supply-chain surface we do not control, and nothing here needs more than what
 * Node ships: `fetch` is in the runtime since 18.
 *
 * **Nothing goes to stdout except protocol messages.** It is the classic defect of hand-written
 * stdio bridges: a diagnostic line lands in the middle of the JSON-RPC stream, the client tries to
 * parse it and drops the connection without saying why. All diagnostics go to stderr.
 *
 * Two editions of the server exist. The directory edition (eight tools) is the address that
 * Claude and ChatGPT connect to by URL. The full edition is the whole catalogue, chosen with
 * `--edition full`, and it can be narrowed to some toolsets with `--toolsets`.
 */

/** The wire format of MCP over stdio: one JSON message per line, no length header. */
const NEWLINE = "\n";

/** The version of this package. A test ties it to `package.json`, so `--version` cannot lie. */
export const VERSION = "1.0.1";

/** The public address of each edition. */
export const DIRECTORY_URL = "https://www.gpt-video.com/api/mcp";
export const FULL_URL = "https://api.gpt-video.com/mcp";

/** Where the key is created, said the same way in every message. */
const KEYS_PAGE = "the Developers page (/app/developers)";

/** @typedef {"directory" | "full"} Edition */
/** @typedef {{ jsonrpc?: unknown, id?: string | number | null, method?: unknown, params?: unknown }} JsonRpcMessage */

/** JSON-RPC errors this bridge can produce on its own. Everything else comes from the server. */
const PARSE_ERROR = -32700;
const INTERNAL_ERROR = -32603;

/** The longest server message the bridge passes on. */
const MESSAGE_MAX = 500;

/**
 * Splits a byte stream into complete lines, keeping the unfinished one aside.
 *
 * It is an object and not a `split("\n")` because stdin arrives in chunks that do not match
 * messages: a `tools/call` with a large schema arrives in three chunks, and splitting each chunk
 * breaks the JSON in half. It is the first bug of every bridge written in a hurry, and it only
 * shows under load.
 *
 * @returns {{ push(chunk: string): string[] }}
 */
export function lineReader() {
  let buffer = "";
  return {
    push(chunk) {
      buffer += chunk;
      const lines = buffer.split(NEWLINE);
      // the last piece is not a line: it is the start of the next one, or "" when the chunk ended clean
      buffer = lines.pop() ?? "";
      return lines.filter((line) => line.trim() !== "");
    },
  };
}

/**
 * Forwards one message and returns what to write on stdout, or `undefined` when nothing is written.
 *
 * The rule that holds everything up: a notification (no `id`) has no answer. Writing anything in
 * reply, even a correct error, breaks the protocol: the client waits for nothing and finds an
 * orphan answer in the stream. So every branch checks `id` before producing output, and a network
 * failure during a notification goes to stderr and nowhere else.
 *
 * @param {string} line
 * @param {{ url: string, apiKey: string, fetch?: typeof globalThis.fetch, log?: (message: string) => void }} options
 * @returns {Promise<string | undefined>}
 */
export async function forward(line, options) {
  const send = options.fetch ?? globalThis.fetch;
  const log = options.log ?? ((message) => process.stderr.write(`${message}${NEWLINE}`));

  /** @type {JsonRpcMessage} */
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    // We do not even know what id it had: `null` is what JSON-RPC prescribes for an unreadable
    // request, and it is the only case where we answer something we cannot identify.
    return JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: PARSE_ERROR, message: "The bridge could not parse that line as JSON." } });
  }
  const id = message.id ?? undefined;
  const wantsAnswer = id !== undefined && id !== null;

  try {
    const response = await send(options.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        authorization: `Bearer ${options.apiKey}`,
        // The headers that the 2026-07-28 revision wants on Streamable HTTP requests. The bridge
        // adds them and not the client, because a client that only speaks stdio is by definition
        // one that does not know them: without them a WAF or a gateway that routes by method sees nothing.
        ...(typeof message.method === "string" ? { "mcp-method": message.method } : {}),
        ...(typeof (/** @type {{name?: unknown}} */ (message.params ?? {}).name) === "string"
          ? { "mcp-name": String(/** @type {{name?: unknown}} */ (message.params ?? {}).name) }
          : {}),
      },
      body: line,
    });

    // 202 is the answer to a notification: no body, nothing to write.
    if (response.status === 202) return undefined;

    const body = await response.text();
    if (!response.ok) {
      // The body is NOT passed on as it is: an HTML page from a corporate proxy would land on
      // stdout and break the stream. It becomes a JSON-RPC error, which is what the client can
      // read, and the details go to stderr.
      log(`gpt-video-mcp: HTTP ${response.status} from ${options.url}`);
      if (!wantsAnswer) return undefined;
      return JSON.stringify({
        jsonrpc: "2.0",
        id,
        error: { code: INTERNAL_ERROR, message: httpExplanation(response.status, body, options.apiKey) },
      });
    }
    // A 200 with an empty body is not an expected case, but it must not produce an empty line on stdout.
    if (body.trim() === "") return undefined;
    // The body is passed on UNTOUCHED: rewriting it (parse + stringify) would mean that a field
    // the specification adds tomorrow is lost today, silently.
    return body;
  } catch (error) {
    log(`gpt-video-mcp: ${error instanceof Error ? error.message : String(error)}`);
    if (!wantsAnswer) return undefined;
    return JSON.stringify({
      jsonrpc: "2.0",
      id,
      error: { code: INTERNAL_ERROR, message: "The bridge could not reach GPT-Video. Check your connection and try again." },
    });
  }
}

/**
 * The `error.message` of a JSON error body, when the body is one: `{ "error": { "message": "…" } }`.
 * Anything else, HTML above all, is ignored. The key is never repeated, even if the server sent it back.
 *
 * @param {string} body
 * @param {string} apiKey
 * @returns {string | undefined}
 */
function serverMessage(body, apiKey) {
  try {
    const parsed = JSON.parse(body);
    const message = parsed?.error?.message;
    if (typeof message !== "string" || message.trim() === "") return undefined;
    const clean = (apiKey ? message.split(apiKey).join("gvk_…") : message).replace(/\s+/g, " ").trim();
    return clean.length > MESSAGE_MAX ? `${clean.slice(0, MESSAGE_MAX)}…` : clean;
  } catch {
    return undefined;
  }
}

/**
 * True when the body is a web page and not an API answer: a firewall or a proxy answered.
 *
 * @param {string} body
 */
function looksLikeHtml(body) {
  return /^\s*<(!doctype|html|head|body)\b/i.test(body);
}

/**
 * What to tell the user for an HTTP status, in plain English.
 *
 * The statuses that really happen (a wrong key, a plan that cannot use the API, the call limit)
 * have a cause the user can remove, and "HTTP 401" does not say it. When the server sent its own
 * message for those, the message is the better text, because it knows the reason.
 *
 * @param {number} status
 * @param {string} [body]
 * @param {string} [apiKey]
 */
export function httpExplanation(status, body = "", apiKey = "") {
  if (looksLikeHtml(body)) return "GPT-Video could not be reached: a firewall answered instead of the server.";
  const fromServer = status === 401 || status === 403 || status === 429 ? serverMessage(body, apiKey) : undefined;
  // a wrong key is the one failure with a fixed next step, so the server's reason is followed by where to fix it
  if (fromServer && status === 401) return `${fromServer}${/[.!?]$/.test(fromServer) ? "" : "."} If the key is wrong, create a new one on ${KEYS_PAGE}.`;
  if (fromServer) return fromServer;
  if (status === 401) return `GPT-Video rejected the API key. Check it, or create a new one on ${KEYS_PAGE}.`;
  if (status === 403) return `GPT-Video does not allow this key to do that. Check its permissions on ${KEYS_PAGE}.`;
  if (status === 404) return "That GPT-Video server does not expose an MCP endpoint at this URL.";
  if (status === 429) return "Too many requests to GPT-Video. Wait a moment and try again.";
  return `GPT-Video answered with HTTP ${status}.`;
}

/**
 * Reads `--name value` and `--name=value`. Everything after the first `=` is the value, so
 * `--url=https://host/mcp?a=b` keeps its query.
 *
 * @param {string[]} argv
 * @returns {Record<string, string>}
 */
function readFlags(argv) {
  /** @type {Record<string, string>} */
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg?.startsWith("--")) continue;
    const body = arg.slice(2);
    const eq = body.indexOf("=");
    const name = eq < 0 ? body : body.slice(0, eq);
    if (!name) continue;
    flags[name] = eq < 0 ? (argv[++i] ?? "") : body.slice(eq + 1);
  }
  return flags;
}

/**
 * The edition a path belongs to, or undefined when it is none of the three known paths.
 * `/api/mcp` is tested before `/mcp`, which it also ends with.
 *
 * @param {string} pathname without trailing slashes
 * @returns {Edition | undefined}
 */
function editionOfPath(pathname) {
  if (pathname.endsWith("/api/mcp-full")) return "full";
  if (pathname.endsWith("/api/mcp")) return "directory";
  if (pathname.endsWith("/mcp")) return "full";
  return undefined;
}

/**
 * Turns the options into the URL of one edition.
 *
 * - No URL: the public address of the edition.
 * - A URL that ends in `/api/mcp`, `/api/mcp-full` or `/mcp` is used as it is, and says which
 *   edition it is. If `--edition` says another one, that is an error, not a guess.
 * - A bare origin is completed with `/api/mcp` for the directory only. For the full edition the
 *   address has to be written, because it depends on the host.
 *
 * @param {{ url: string, edition: Edition | undefined, toolsets: string[] }} input
 * @returns {{ url: string, edition: Edition, toolsets: string[] } | { error: string }}
 */
function resolveUrl({ url, edition, toolsets }) {
  /** @type {Edition} */
  let chosen = edition ?? "directory";
  /** @type {string} */
  let base;
  if (!url) {
    base = chosen === "full" ? FULL_URL : DIRECTORY_URL;
  } else {
    /** @type {URL} */
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      return { error: `That is not a URL: ${url.slice(0, 80)}. Write it like ${DIRECTORY_URL}.` };
    }
    // the key travels in a header: over plain http only to a server on this machine, never across a network
    const loopback = /^(localhost|127(\.\d{1,3}){3}|\[::1\])$/i.test(parsed.hostname) || /\.localhost$/i.test(parsed.hostname);
    if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && loopback)) {
      return { error: "The URL has to start with https://. Plain http:// works only for a server on this machine." };
    }
    const pathname = parsed.pathname.replace(/\/+$/, "");
    const fromPath = editionOfPath(pathname);
    if (fromPath) {
      if (edition && edition !== fromPath) {
        return { error: `The URL ${parsed.origin}${pathname} is the ${fromPath} edition, but --edition says ${edition}. Use one of the two.` };
      }
      chosen = fromPath;
      base = `${parsed.origin}${pathname}`;
      // a `?toolsets=` written in the URL stays, unless the flag gives toolsets
      if (chosen === "full") base += parsed.search;
    } else if (chosen === "full") {
      return { error: `For the full edition, write the whole address: ${FULL_URL}` };
    } else {
      // the directory: an origin, or a path in front of the endpoint such as a proxy prefix, is completed
      base = `${parsed.origin}${pathname}/api/mcp`;
    }
  }
  if (chosen === "directory" && toolsets.length > 0) {
    return { error: "--toolsets works only with --edition full. The directory edition has eight tools and no toolsets." };
  }
  if (toolsets.length > 0) base = `${base.split("?")[0]}?toolsets=${toolsets.join(",")}`;
  // the toolsets that actually go out, flag or URL, so the start line says what the server will see
  const sent = chosen === "full" ? toolsetNames(new URL(base).searchParams.get("toolsets") ?? "") : [];
  return { url: base, edition: chosen, toolsets: sent };
}

/**
 * `a, B,a` → `["a", "b"]`: lower case, trimmed, without repeats or empty names.
 *
 * @param {string} raw
 */
function toolsetNames(raw) {
  return [
    ...new Set(
      raw
        .split(",")
        .map((name) => name.trim().toLowerCase())
        .filter((name) => name !== ""),
    ),
  ];
}

/**
 * Reads the options from the command line and the environment.
 *
 * The key is also accepted from `GPT_VIDEO_API_KEY`, and that is the form to prefer: a process
 * argument is visible to anyone who can run `ps` on the same machine.
 *
 * `--version` and `--help` return `{ info }`: text for the user and nothing to bridge.
 *
 * @param {string[]} argv
 * @param {Record<string, string | undefined>} env
 * @returns {{ url: string, apiKey: string, edition: Edition, toolsets: string[] } | { error: string } | { info: string }}
 */
export function parseArgs(argv, env) {
  if (argv.includes("--version") || argv.includes("-v")) return { info: VERSION };
  if (argv.includes("--help") || argv.includes("-h")) return { info: helpText() };
  const flags = readFlags(argv);

  const apiKey = flags["api-key"] || env.GPT_VIDEO_API_KEY || "";
  if (!apiKey) return { error: "No API key. Pass --api-key gvk_… or set GPT_VIDEO_API_KEY." };

  const rawEdition = (flags.edition || env.GPT_VIDEO_EDITION || "").trim().toLowerCase();
  if (rawEdition !== "" && rawEdition !== "directory" && rawEdition !== "full") {
    return { error: `Unknown edition "${rawEdition.slice(0, 40)}". Use --edition directory or --edition full.` };
  }
  const toolsets = toolsetNames(flags.toolsets || env.GPT_VIDEO_TOOLSETS || "");
  // the names are checked by the server, which knows the current list; here only the shape
  if (toolsets.some((name) => !/^[a-z][a-z0-9_-]*$/.test(name))) {
    return { error: "--toolsets takes names separated by commas, such as --toolsets clips,studio." };
  }

  const resolved = resolveUrl({
    url: flags.url || env.GPT_VIDEO_URL || "",
    edition: rawEdition === "" ? undefined : /** @type {Edition} */ (rawEdition),
    toolsets,
  });
  if ("error" in resolved) return resolved;
  return { url: resolved.url, apiKey, edition: resolved.edition, toolsets: resolved.toolsets };
}

/**
 * The line printed on stderr at start: which edition runs, so a user who expected more tools sees
 * why they got eight.
 *
 * @param {{ edition: Edition, toolsets: string[] }} options
 */
export function describeEdition(options) {
  if (options.edition === "directory") return "edition: directory (8 tools). Use --edition full for the whole catalogue.";
  if (options.toolsets.length === 0) return "edition: full (all toolsets).";
  // core is always on: named once, first, whether or not it was asked for
  const others = options.toolsets.filter((name) => name !== "core");
  return `edition: full (toolsets: ${["core", ...others].join(", ")}).`;
}

function helpText() {
  return [
    `gpt-video-mcp ${VERSION}: connect GPT-Video to an AI assistant that speaks MCP over stdio.`,
    "",
    "Usage: gpt-video-mcp [--edition directory|full] [--toolsets a,b] [--url URL] [--api-key KEY]",
    "",
    "  --edition   directory (8 tools, the default) or full (the whole catalogue)",
    "  --toolsets  with full only: core, clips, studio, editor, files. core is always on",
    "  --url       the endpoint, if you use another one",
    "  --api-key   your key; prefer the GPT_VIDEO_API_KEY environment variable",
    "  --version   print the version",
    "",
    `Create a key on ${KEYS_PAGE}.`,
  ].join(NEWLINE);
}

/**
 * The loop: every line that arrives starts at once, without waiting for the previous one.
 *
 * IN PARALLEL AND NOT IN SEQUENCE, and it is not premature optimization: JSON-RPC matches an
 * answer to a request by `id`, not by order, and a host that sends `tools/list` while waiting for
 * a `tools/call` that takes three minutes would stand still for three minutes on a request that
 * costs ten milliseconds. Writes stay atomic because each one is a single `write`, newline included.
 *
 * @param {{ input: NodeJS.ReadableStream, output: { write(chunk: string): unknown }, url: string, apiKey: string, fetch?: typeof globalThis.fetch, log?: (message: string) => void }} options
 * @returns {Promise<void>}
 */
export function run(options) {
  const reader = lineReader();
  /** @type {Set<Promise<void>>} */
  const inFlight = new Set();

  return new Promise((resolve, reject) => {
    options.input.setEncoding("utf8");
    options.input.on("data", (chunk) => {
      for (const line of reader.push(String(chunk))) {
        const task = forward(line, options)
          .then((answer) => {
            if (answer !== undefined) options.output.write(answer.endsWith(NEWLINE) ? answer : answer + NEWLINE);
          })
          // The write can really fail: if the host dies while an answer is in flight, stdout gives
          // EPIPE. Without this `catch` that rejection reaches `Promise.all` on close, the promise
          // of the loop never resolves and the process hangs: a zombie bridge that the host does
          // not know it left running.
          .catch((error) => {
            (options.log ?? ((m) => process.stderr.write(`${m}${NEWLINE}`)))(
              `gpt-video-mcp: could not write a reply: ${error instanceof Error ? error.message : String(error)}`,
            );
          })
          .finally(() => inFlight.delete(task));
        inFlight.add(task);
      }
    });
    // A closed stdin is how the host says "I am done": the answers still in flight are awaited, or
    // the last call of a session would be lost just while the client waits for it.
    options.input.on("end", () => {
      void Promise.all([...inFlight]).then(() => resolve());
    });
    options.input.on("error", reject);
  });
}
