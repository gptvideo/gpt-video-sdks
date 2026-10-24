// @ts-check
/**
 * A fetch for tests that answers from a script and records every request it was sent. Its timers are the
 * global ones, so a test with fake timers decides when each answer arrives. Like a real fetch it rejects with
 * an AbortError when its signal fires, unless the entry says it never listens (`network: "deaf"`).
 */

/**
 * One scripted answer.
 * @typedef {object} Scripted
 * @property {number} [status] 200 by default
 * @property {Record<string, string>} [headers]
 * @property {unknown} [json] a body sent as JSON
 * @property {string} [text] a body sent as it is
 * @property {number} [afterMs] how long the server takes, 0 by default
 * @property {"hang" | "connection_failed" | "deaf"} [network] hang: never answers but stops on abort;
 *   connection_failed: fails at once; deaf: never settles, whatever the signal does
 * @property {boolean} [opaqueRedirect] answers like a browser does to a redirect with redirect: "manual"
 * @property {string} [redirectedTo] answers like a fetch that followed a redirect to this address, whatever
 *   `redirect` said: `redirected` is true and `url` is the address; an empty string leaves `url` unknown
 */

/**
 * What a request carried.
 * @typedef {object} Recorded
 * @property {string} url
 * @property {string} method
 * @property {Record<string, string>} headers with lower-case names
 * @property {unknown} body as it was handed to fetch
 * @property {string | undefined} redirect
 * @property {AbortSignal | null} signal
 * @property {number} at Date.now() when it was sent
 */

/**
 * @param {readonly Scripted[] | ((request: Recorded, index: number) => Scripted | Promise<Scripted>)} script
 *   a list answered in order, or a function that answers each request
 */
export function scriptedFetch(script) {
  const queue = typeof script === "function" ? null : [...script];
  /** @type {Recorded[]} */
  const calls = [];

  /**
   * @param {string} url
   * @param {RequestInit} init
   * @returns {Promise<Response>}
   */
  async function fetch(url, init) {
    /** @type {Record<string, string>} */
    const headers = {};
    for (const [name, value] of Object.entries(/** @type {Record<string, string>} */ (init.headers ?? {}))) headers[name.toLowerCase()] = value;
    /** @type {Recorded} */
    const request = { url, method: init.method ?? "GET", headers, body: init.body ?? null, redirect: init.redirect, signal: init.signal ?? null, at: Date.now() };
    const index = calls.push(request) - 1;
    /** @type {Scripted | undefined} */
    let entry;
    if (queue) entry = queue.shift();
    else if (typeof script === "function") entry = await script(request, index);
    if (!entry) throw new Error(`the script has no answer for request ${index + 1}: ${request.method} ${url}`);
    const signal = init.signal ?? null;

    if (entry.network === "deaf") return new Promise(() => {});
    if (entry.network === "connection_failed") throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
    if (entry.network === "hang") return abortedBy(signal);
    await delay(entry.afterMs ?? 0, signal);
    return responseOf(entry);
  }

  return {
    fetch,
    calls,
    /** answers of the list that no request used */
    get left() {
      return queue ? queue.length : 0;
    },
  };
}

/** @param {AbortSignal | null} signal @returns {Promise<never>} */
function abortedBy(signal) {
  return new Promise((_, reject) => {
    if (!signal) return;
    if (signal.aborted) reject(abortError());
    signal.addEventListener("abort", () => reject(abortError()), { once: true });
  });
}

/** @param {number} ms @param {AbortSignal | null} signal @returns {Promise<void>} */
function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(abortError());
      },
      { once: true },
    );
  });
}

function abortError() {
  return new DOMException("This operation was aborted", "AbortError");
}

/** @param {Scripted} entry @returns {Response} */
export function responseOf(entry) {
  if (entry.opaqueRedirect) {
    return /** @type {Response} */ (/** @type {unknown} */ ({ type: "opaqueredirect", status: 0, headers: new Headers(), body: null, text: async () => "" }));
  }
  const status = entry.status ?? 200;
  /** @type {Record<string, string>} */
  const headers = { ...(entry.headers ?? {}) };
  /** @type {Response} */
  let res;
  if ("json" in entry) {
    if (!Object.keys(headers).some((h) => h.toLowerCase() === "content-type")) headers["Content-Type"] = "application/json";
    res = new Response(JSON.stringify(entry.json), { status, headers });
  } else {
    res = new Response(entry.text ?? "", { status, headers });
  }
  if (entry.redirectedTo !== undefined) {
    Object.defineProperty(res, "redirected", { value: true });
    Object.defineProperty(res, "url", { value: entry.redirectedTo });
  }
  return res;
}

/**
 * The entries of retry.json with `repeat: n` written out.
 * @param {readonly (Scripted & { repeat?: number })[]} responses
 * @returns {Scripted[]}
 */
export function expand(responses) {
  /** @type {Scripted[]} */
  const out = [];
  for (const { repeat = 1, ...one } of responses) for (let i = 0; i < repeat; i++) out.push(one);
  return out;
}
