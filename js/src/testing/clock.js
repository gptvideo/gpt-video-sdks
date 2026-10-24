// @ts-check
/**
 * A fake clock for the tests of the engine. Timers, Date and performance are fake; setImmediate and the
 * microtask queue stay real, because a Response body is read through them. `drive` runs the clock one timer
 * at a time until a promise settles, letting real callbacks run before each timer.
 */
import { vi } from "vitest";

/** @param {number} nowMs the wall-clock time the test starts at */
export function useClock(nowMs) {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date", "performance"], now: nowMs });
}

/**
 * Runs the fake clock until the promise settles, and says how and when it did.
 *
 * @template T
 * @param {Promise<T>} promise
 * @param {number} [rounds] how many rounds to try before saying the promise is stuck
 * @returns {Promise<{ value?: T, error?: unknown, at: number }>}
 */
export async function drive(promise, rounds = 20_000) {
  let settled = false;
  /** @type {{ value?: T, error?: unknown, at: number }} */
  let outcome = { at: -1 };
  promise.then(
    (value) => {
      settled = true;
      outcome = { value, at: Date.now() };
    },
    (error) => {
      settled = true;
      outcome = { error, at: Date.now() };
    },
  );
  for (let round = 0; round < rounds && !settled; round++) {
    await new Promise((resolve) => setImmediate(resolve));
    if (settled) break;
    if (vi.getTimerCount() > 0) await vi.advanceTimersToNextTimerAsync();
  }
  if (!settled) throw new Error("the promise never settled, and no timer was left to move it");
  return outcome;
}
