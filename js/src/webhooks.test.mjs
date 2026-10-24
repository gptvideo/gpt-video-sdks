// @ts-check
// Webhook verification: the specification's own vectors, the shared vectors every GPT-Video SDK runs, an
// independent HMAC from node:crypto, and the guards that a functional test cannot see (no early exit).
import { createHmac, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { inspect } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GptVideoError, WEBHOOK_FAILURE_REASONS } from "./errors.mjs";
import { Webhook, WebhookVerificationError, constructEvent, verifyWebhook } from "./webhooks.mjs";
import { readVectors } from "./testing/data.js";

/** @import { WebhookEventType } from "./types.generated.js" */
/** @typedef {import("./webhooks.mjs").VerifyWebhookInput} VerifyWebhookInput */

// A whole secret written in a file of this package fails scripts/sdk/layout.test.mjs, even a public test
// secret: every secret here is put together at run time.
const PREFIX = "whsec_";

/**
 * The vectors of the specification's JavaScript library: standard-webhooks/standard-webhooks, commit
 * 4bcfffba157053dfe35bbcf4eb082a2e776e2825 (2026-08-28), libraries/javascript/src/webhook.test.ts.
 * https://github.com/standard-webhooks/standard-webhooks/blob/4bcfffba157053dfe35bbcf4eb082a2e776e2825/libraries/javascript/src/webhook.test.ts
 */
const SPEC = {
  secret: PREFIX + "MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw",
  id: "msg_p5jXN8AQM9LWM0D4loKWxJek",
  timestampSec: 1614265330,
  payload: '{"test": 2432232314}',
  /** "sign function works" */
  signature: "v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=",
  /** "multi sig payload is valid": the wrong signatures around the right one */
  wrong: "Ceo5qEr07ixe2NLpvHk3FH9bwy/WavXrAFQ/9tdO6mc=",
  /** "invalid signature throws error" */
  invalid: "v1,dawfeoifkpqwoekfpqoekf",
};
const TOLERANCE_MS = 5 * 60 * 1000;

const specHeaders = (/** @type {Record<string, string>} */ over = {}) => ({
  "webhook-id": SPEC.id,
  "webhook-timestamp": String(SPEC.timestampSec),
  "webhook-signature": SPEC.signature,
  ...over,
});

/** @param {Promise<unknown>} promise @param {(typeof WEBHOOK_FAILURE_REASONS)[number]} reason */
async function refusedFor(promise, reason) {
  const err = await promise.then(
    () => null,
    (/** @type {unknown} */ e) => e,
  );
  expect(err).toBeInstanceOf(WebhookVerificationError);
  expect(/** @type {WebhookVerificationError} */ (err).reason).toBe(reason);
  return /** @type {WebhookVerificationError} */ (err);
}

/** Webhook.verify reads the clock: these tests set it, and only Date is faked (crypto.subtle keeps working). */
function clockAt(/** @type {number} */ ms) {
  if (!vi.isFakeTimers()) vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(ms);
}
afterEach(() => {
  vi.useRealTimers();
});

describe("the specification's vectors, run through the Standard Webhooks form", () => {
  it("empty key raises error: '', undefined, null and whsec_ alone are refused when the Webhook is made", () => {
    for (const secret of ["", undefined, null, PREFIX]) {
      expect(() => new Webhook(/** @type {any} */ (secret)), String(secret)).toThrow(WebhookVerificationError);
    }
  });

  it("missing id, timestamp or signature raises error", async () => {
    clockAt(SPEC.timestampSec * 1000);
    const wh = new Webhook(SPEC.secret);
    for (const name of /** @type {const} */ (["webhook-id", "webhook-timestamp", "webhook-signature"])) {
      const { [name]: _gone, ...headers } = specHeaders();
      await refusedFor(wh.verify(SPEC.payload, headers), "missing_headers");
    }
  });

  it("invalid timestamp throws error", async () => {
    clockAt(SPEC.timestampSec * 1000);
    await refusedFor(new Webhook(SPEC.secret).verify(SPEC.payload, specHeaders({ "webhook-timestamp": "hello" })), "bad_timestamp");
  });

  it("invalid signature and partial signature throw error", async () => {
    clockAt(SPEC.timestampSec * 1000);
    const wh = new Webhook(SPEC.secret);
    for (const signature of [SPEC.invalid, SPEC.signature.slice(0, 8), "v1,"]) {
      await refusedFor(wh.verify(SPEC.payload, specHeaders({ "webhook-signature": signature })), "no_matching_signature");
    }
  });

  it("valid signature is valid and returns valid json", async () => {
    clockAt(SPEC.timestampSec * 1000);
    expect(await new Webhook(SPEC.secret).verify(SPEC.payload, specHeaders())).toEqual({ test: 2432232314 });
  });

  it("old timestamp fails and new timestamp fails, one second past the tolerance", async () => {
    const wh = new Webhook(SPEC.secret);
    clockAt(SPEC.timestampSec * 1000 + TOLERANCE_MS + 1000);
    await refusedFor(wh.verify(SPEC.payload, specHeaders()), "timestamp_outside_tolerance");
    clockAt(SPEC.timestampSec * 1000 - TOLERANCE_MS - 1000);
    await refusedFor(wh.verify(SPEC.payload, specHeaders()), "timestamp_outside_tolerance");
  });

  it("multi sig payload is valid", async () => {
    clockAt(SPEC.timestampSec * 1000);
    const list = [`v1,${SPEC.wrong}`, `v2,${SPEC.wrong}`, SPEC.signature, `v1,${SPEC.wrong}`].join(" ");
    expect(await new Webhook(SPEC.secret).verify(SPEC.payload, specHeaders({ "webhook-signature": list }))).toEqual({ test: 2432232314 });
  });

  it("differs from the library on purpose: a secret without whsec_ is refused, so an API key or a typo never becomes a key", () => {
    expect(() => new Webhook(SPEC.secret.slice(PREFIX.length))).toThrow(WebhookVerificationError);
  });
});

// ------------------------------------------------------------------------------------------ the shared vectors

/**
 * @typedef {{
 *   name: string, secretNames: string[], secretText: string | null, headers: Record<string, string | string[]>,
 *   body: string | null, bodyBase64: string | null, bodyParsed: Record<string, unknown> | null, nowSec: number,
 *   toleranceSec: number | null,
 *   expect: { ok: true, id: string, timestamp: number } | { ok: false, reason: (typeof WEBHOOK_FAILURE_REASONS)[number] },
 *   reference: boolean | null,
 * }} VectorCase
 */
/** @type {{ secretPrefix: string, defaultToleranceSec: number, secrets: Record<string, string>, cases: VectorCase[] }} */
const VECTORS = readVectors("webhooks.generated.json");

/** The bodies a case runs with: its text and the UTF-8 bytes of the text, or its bytes, or its parsed object. */
function bodiesOf(/** @type {VectorCase} */ c) {
  if (c.body !== null) return [["text", c.body], ["bytes", new TextEncoder().encode(c.body)]];
  if (c.bodyBase64 !== null) return [["bytes", Uint8Array.from(Buffer.from(c.bodyBase64, "base64"))]];
  return [["parsed", c.bodyParsed]];
}

/** @param {VectorCase} c */
function secretsOf(c) {
  return c.secretText !== null ? { secret: c.secretText } : c.secretNames.length === 1 ? { secret: VECTORS.secretPrefix + VECTORS.secrets[c.secretNames[0] ?? ""] } : { secrets: c.secretNames.map((n) => VECTORS.secretPrefix + VECTORS.secrets[n]) };
}

describe("webhooks.generated.json of the shared vectors", () => {
  it("has many cases, each reason from the closed list, and the default tolerance of this SDK", () => {
    expect(VECTORS.cases.length).toBeGreaterThan(40);
    expect(VECTORS.defaultToleranceSec).toBe(300);
    for (const c of VECTORS.cases) if (!c.expect.ok) expect(WEBHOOK_FAILURE_REASONS, c.name).toContain(c.expect.reason);
  });

  for (const c of VECTORS.cases) {
    for (const [form, body] of bodiesOf(c)) {
      it(`${c.name} (body as ${form})`, async () => {
        /** @type {VerifyWebhookInput} */
        const input = /** @type {any} */ ({ ...secretsOf(c), headers: c.headers, body, now: c.nowSec * 1000, ...(c.toleranceSec === null ? {} : { toleranceSec: c.toleranceSec }) });
        if (c.expect.ok) {
          expect(await verifyWebhook(input)).toEqual({ id: c.expect.id, timestamp: c.expect.timestamp });
        } else {
          await refusedFor(verifyWebhook(input), c.expect.reason);
        }
      });
    }
  }

  it("every accepted case is also accepted by the Standard Webhooks form, against the clock", async () => {
    let ran = 0;
    for (const c of VECTORS.cases) {
      if (!c.expect.ok) continue;
      clockAt(c.nowSec * 1000);
      const secrets = secretsOf(c);
      const wh = new Webhook(/** @type {any} */ (secrets).secret ?? /** @type {any} */ (secrets).secrets, c.toleranceSec === null ? {} : { toleranceSec: c.toleranceSec });
      for (const [, body] of bodiesOf(c)) {
        const bytes = typeof body === "string" ? new TextEncoder().encode(body) : /** @type {Uint8Array} */ (body);
        let expected;
        try {
          expected = { value: JSON.parse(new TextDecoder().decode(bytes)) };
        } catch {
          expected = null;
        }
        const verified = wh.verify(/** @type {any} */ (body), c.headers);
        if (expected) expect(await verified, c.name).toEqual(expected.value);
        else await expect(verified, c.name).rejects.toBeInstanceOf(SyntaxError);
        ran++;
      }
    }
    expect(ran).toBeGreaterThan(20);
  });

  it("constructEvent returns the event of the delivery the server sends, the same as JSON.parse of its body", async () => {
    const c = /** @type {VectorCase} */ (VECTORS.cases.find((x) => x.name === "a delivery as the server sends it"));
    const event = await constructEvent({ ...secretsOf(c), headers: c.headers, body: /** @type {string} */ (c.body), now: c.nowSec * 1000 });
    expect(event).toEqual(JSON.parse(/** @type {string} */ (c.body)));
    expect(Object.keys(event).sort()).toEqual(["data", "timestamp", "type"]);
    // the generated union narrows on type: this line typechecks only while WebhookEvent is that union
    /** @type {WebhookEventType} */
    const type = event.type;
    expect(typeof type).toBe("string");
  });
});

// -------------------------------------------------------------------------------------- an independent HMAC

/** A signature computed by node:crypto, a second implementation of the formula. */
function nodeSign(/** @type {string} */ secret, /** @type {string} */ id, /** @type {number} */ ts, /** @type {Uint8Array} */ body) {
  const mac = createHmac("sha256", Buffer.from(secret.slice(PREFIX.length), "base64"));
  mac.update(`${id}.${ts}.`);
  mac.update(body);
  return mac.digest();
}

describe("bytes, against an independent HMAC", () => {
  const secret = PREFIX + randomBytes(24).toString("base64");
  const id = "msg_independent";
  const ts = 1_800_000_000;
  const at = ts * 1000;

  it("accepts random bodies of random bytes signed by node:crypto, as Buffer, Uint8Array, ArrayBuffer and DataView", async () => {
    for (let n = 0; n < 20; n++) {
      const body = randomBytes(n * 13);
      const headers = { "webhook-id": id, "webhook-timestamp": String(ts), "webhook-signature": `v1,${nodeSign(secret, id, ts, body).toString("base64")}` };
      const copy = Uint8Array.from(body);
      for (const form of [body, copy, copy.buffer, new DataView(copy.buffer)]) {
        expect(await verifyWebhook({ secret, headers, body: form, now: at })).toEqual({ id, timestamp: ts });
      }
    }
  });

  it("verifies only the bytes a view shows, not the whole buffer behind it", async () => {
    const whole = Buffer.from("PREFIX{\"a\":1}SUFFIX");
    const view = whole.subarray(6, 13);
    const headers = { "webhook-id": id, "webhook-timestamp": String(ts), "webhook-signature": `v1,${nodeSign(secret, id, ts, view).toString("base64")}` };
    expect(await verifyWebhook({ secret, headers, body: view, now: at })).toEqual({ id, timestamp: ts });
    expect(await constructEvent({ secret, headers, body: view, now: at })).toEqual({ a: 1 });
  });

  it("refuses every one-bit change of the signature: each of its 256 bits counts", async () => {
    const body = new TextEncoder().encode('{"flip":true}');
    const good = nodeSign(secret, id, ts, body);
    for (let bit = 0; bit < 256; bit++) {
      const bad = Buffer.from(good);
      bad[bit >> 3] = /** @type {number} */ (bad[bit >> 3]) ^ (1 << (bit & 7));
      const headers = { "webhook-id": id, "webhook-timestamp": String(ts), "webhook-signature": `v1,${bad.toString("base64")}` };
      await refusedFor(verifyWebhook({ secret, headers, body, now: at }), "no_matching_signature");
    }
  });

  it("refuses every one-bit change of the body", async () => {
    const body = new TextEncoder().encode('{"x":1}');
    const headers = { "webhook-id": id, "webhook-timestamp": String(ts), "webhook-signature": `v1,${nodeSign(secret, id, ts, body).toString("base64")}` };
    for (let bit = 0; bit < body.length * 8; bit++) {
      const changed = Uint8Array.from(body);
      changed[bit >> 3] = /** @type {number} */ (changed[bit >> 3]) ^ (1 << (bit & 7));
      await refusedFor(verifyWebhook({ secret, headers, body: changed, now: at }), "no_matching_signature");
    }
  });
});

// --------------------------------------------------------------------------------------------------- headers

describe("the forms of the headers", () => {
  const at = SPEC.timestampSec * 1000;

  it("reads a Fetch Headers object, whatever case the names were set in", async () => {
    const headers = new Headers({ "Webhook-Id": SPEC.id, "Webhook-Timestamp": String(SPEC.timestampSec), "Webhook-Signature": SPEC.signature });
    expect(await verifyWebhook({ secret: SPEC.secret, headers, body: SPEC.payload, now: at })).toEqual({ id: SPEC.id, timestamp: SPEC.timestampSec });
  });

  it("reads two signature headers that Fetch joined with a comma", async () => {
    const headers = new Headers({ "webhook-id": SPEC.id, "webhook-timestamp": String(SPEC.timestampSec) });
    headers.append("webhook-signature", `v1,${SPEC.wrong}`);
    headers.append("webhook-signature", SPEC.signature);
    expect(await verifyWebhook({ secret: SPEC.secret, headers, body: SPEC.payload, now: at })).toEqual({ id: SPEC.id, timestamp: SPEC.timestampSec });
  });

  it("refuses headers that are not there at all", async () => {
    for (const headers of [undefined, null, "webhook-id: x", {}]) {
      await refusedFor(verifyWebhook({ secret: SPEC.secret, headers: /** @type {any} */ (headers), body: SPEC.payload, now: at }), "missing_headers");
    }
  });

  it("treats the same id written twice as one id, and two different ones as a refusal", async () => {
    const same = { ...specHeaders(), "webhook-id": [SPEC.id, SPEC.id] };
    expect(await verifyWebhook({ secret: SPEC.secret, headers: same, body: SPEC.payload, now: at })).toEqual({ id: SPEC.id, timestamp: SPEC.timestampSec });
    const both = { ...specHeaders(), "Webhook-Id": `${SPEC.id}x` };
    await refusedFor(verifyWebhook({ secret: SPEC.secret, headers: both, body: SPEC.payload, now: at }), "missing_headers");
  });
});

// ------------------------------------------------------------------------------------------------ the call

describe("a verification called the wrong way", () => {
  const at = SPEC.timestampSec * 1000;
  const base = { secret: SPEC.secret, headers: specHeaders(), body: SPEC.payload, now: at };

  it("refuses a parsed body, null and undefined as body_not_raw, before reading anything else", async () => {
    for (const body of [{ test: 2432232314 }, null, undefined, 42, [1, 2]]) {
      await refusedFor(verifyWebhook(/** @type {any} */ ({ ...base, headers: {}, body })), "body_not_raw");
    }
    clockAt(at);
    await refusedFor(new Webhook(SPEC.secret).verify(/** @type {any} */ ({ test: 1 }), specHeaders()), "body_not_raw");
  });

  it("refuses an API key, a secret that is not standard base64, and a list with a bad secret in it", async () => {
    const apiKey = await refusedFor(verifyWebhook({ ...base, secret: "gvk_" + "A".repeat(43) }), "bad_secret");
    expect(apiKey.message).toContain("This is an API key (gvk_), not a webhook signing secret.");
    expect(apiKey.message).not.toContain("A".repeat(43));
    for (const secret of [PREFIX + "abc-def_", PREFIX + "abcd efgh", PREFIX + "abcde", PREFIX + "ab==cd", `${SPEC.secret}\n`]) {
      await refusedFor(verifyWebhook({ ...base, secret }), "bad_secret");
    }
    // the usual cause, a line break left by a file or an env loader, is named in the message
    const newline = await refusedFor(verifyWebhook({ ...base, secret: `${SPEC.secret}\n` }), "bad_secret");
    expect(newline.message).toContain("line break");
    expect(newline.message).not.toContain(SPEC.secret.slice(PREFIX.length));
    await refusedFor(verifyWebhook({ ...base, secret: undefined, secrets: [SPEC.secret, /** @type {any} */ (7)] }), "bad_secret");
    await refusedFor(verifyWebhook({ ...base, secret: undefined, secrets: [] }), "bad_secret");
    await refusedFor(verifyWebhook({ ...base, secret: undefined }), "bad_secret");
  });

  it("refuses a bad secret even when the headers are missing: a wrong setup shows on the first delivery", async () => {
    await refusedFor(verifyWebhook({ ...base, headers: {}, secret: "not a secret" }), "bad_secret");
  });

  it("rejects options that would turn a check off, with INVALID_ARGUMENT", async () => {
    for (const toleranceSec of [Infinity, NaN, -1, "300"]) {
      const err = await verifyWebhook(/** @type {any} */ ({ ...base, toleranceSec })).catch((/** @type {unknown} */ e) => e);
      expect(err).toBeInstanceOf(GptVideoError);
      expect(err).not.toBeInstanceOf(WebhookVerificationError);
      expect(/** @type {GptVideoError} */ (err).code).toBe("INVALID_ARGUMENT");
    }
    for (const now of [NaN, new Date("x"), "now"]) {
      await expect(verifyWebhook(/** @type {any} */ ({ ...base, now }))).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    }
    await expect(verifyWebhook(/** @type {any} */ ({ ...base, secrets: [SPEC.secret] }))).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    await expect(verifyWebhook(/** @type {any} */ (null))).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    expect(() => new Webhook(SPEC.secret, { toleranceSec: Infinity })).toThrow(GptVideoError);
  });

  it("takes now as a Date as well as milliseconds, and a tolerance of 0 accepts only the same second", async () => {
    expect(await verifyWebhook({ ...base, now: new Date(at) })).toEqual({ id: SPEC.id, timestamp: SPEC.timestampSec });
    expect(await verifyWebhook({ ...base, now: at + 999, toleranceSec: 0 })).toBeDefined();
    await refusedFor(verifyWebhook({ ...base, now: at + 1000, toleranceSec: 0 }), "timestamp_outside_tolerance");
  });

  it("compares whole seconds, like the specification's libraries: the clock is rounded down to its second", async () => {
    expect(await verifyWebhook({ ...base, now: at + 300_999 })).toBeDefined();
    await refusedFor(verifyWebhook({ ...base, now: at + 301_000 }), "timestamp_outside_tolerance");
    expect(await verifyWebhook({ ...base, now: at - 300_000 })).toBeDefined();
    await refusedFor(verifyWebhook({ ...base, now: at - 300_001 }), "timestamp_outside_tolerance");
  });

  it("always rejects a promise, never throws in the caller's hands", async () => {
    const calls = [verifyWebhook(/** @type {any} */ ({})), constructEvent(/** @type {any} */ ({}))];
    const settled = await Promise.allSettled(calls);
    for (const call of calls) expect(call).toBeInstanceOf(Promise);
    expect(settled.map((s) => s.status)).toEqual(["rejected", "rejected"]);
  });
});

// --------------------------------------------------------------------------------------------- what it says

describe("what an error and a Webhook show", () => {
  const at = SPEC.timestampSec * 1000;

  it("a refusal has the one shape of message, and never repeats the secret, the signature or the body", async () => {
    const body = '{"private":"customer data"}';
    const err = await refusedFor(verifyWebhook({ secret: SPEC.secret, headers: specHeaders(), body, now: at }), "no_matching_signature");
    expect(err.message).toMatch(/^WEBHOOK_VERIFICATION_FAILED: No v1 signature/);
    expect(err.code).toBe("WEBHOOK_VERIFICATION_FAILED");
    const everything = `${err.message}\n${err.stack}\n${JSON.stringify(err)}\n${inspect(err)}`;
    for (const secretPart of [SPEC.secret.slice(PREFIX.length), SPEC.signature.slice(3, 20), "customer data"]) expect(everything).not.toContain(secretPart);
  });

  it("a Webhook never shows its secret", () => {
    const wh = new Webhook(SPEC.secret);
    const shown = `${inspect(wh)}\n${JSON.stringify(wh)}\n${String(wh)}\n${Object.keys(wh).join(",")}`;
    expect(shown).not.toContain(SPEC.secret.slice(PREFIX.length));
    expect(inspect(wh)).toBe("Webhook { secret: [redacted] }");
  });
});

// --------------------------------------------------------------------------- what a functional test cannot see

// The time a comparison takes cannot be tested reliably, so its shape is: the byte loop has no exit, and
// the loop over signatures and secrets has none either. Rewriting either with an early exit makes this red.
describe("the comparison has no early exit", () => {
  const source = readFileSync(new URL("./webhooks.mjs", import.meta.url), "utf8");
  const bodyOf = (/** @type {string} */ name) => {
    const start = source.indexOf(`function ${name}(`);
    expect(start, name).toBeGreaterThan(-1);
    const open = source.indexOf("{", source.indexOf(")", start));
    let depth = 0;
    for (let i = open; i < source.length; i++) {
      if (source[i] === "{") depth++;
      if (source[i] === "}" && --depth === 0) return source.slice(open, i + 1);
    }
    throw new Error(`no body for ${name}`);
  };

  it("equalBytes folds every byte with XOR and OR, and returns only after the loop", () => {
    const body = bodyOf("equalBytes");
    const loop = body.slice(body.indexOf("for ("), body.indexOf(";", body.indexOf("diff |=")) + 1);
    expect(loop).toMatch(/diff \|= .*\^/);
    expect(loop).not.toMatch(/\breturn\b|\bbreak\b|&&|\|\||\?/);
    expect(body).not.toMatch(/===\s*[ab]\[|[ab]\[i\]\s*!==/);
  });

  it("verifyWithKeys compares every signature with every secret, with no exit inside the loops", () => {
    const body = bodyOf("verifyWithKeys");
    const loops = body.slice(body.indexOf("let matched"), body.indexOf("if (matched"));
    expect(loops).toMatch(/matched \|= equalBytes\(/);
    expect(loops).not.toMatch(/\breturn\b|\bbreak\b|\bsome\(|\bfind\(|\bevery\(|&&|\|\|/);
  });

  it("signatures are compared as decoded bytes, never as base64 text", () => {
    expect(bodyOf("signaturesOf")).toMatch(/fromStandardBase64\(signature\)/);
  });
});
