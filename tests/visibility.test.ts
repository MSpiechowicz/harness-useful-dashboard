import { afterEach, beforeEach, describe, expect, setSystemTime, test } from "bun:test";

// The module uses the page's `document`, which the server's type check doesn't know: loaded by a path it doesn't follow.
const VISIBILITY = "../web/src/lib/visibility.ts";
const { everyMinuteWhileVisible } = (await import(VISIBILITY)) as { everyMinuteWhileVisible: (fn: () => void, lagMs?: number) => () => void };

// A page of its own: a document that can be hidden and timers that run only when the test says so.
type Timer = { id: number; at: number; fn: () => void };
let timers: Timer[] = [];
let nextId = 1;
let listeners: (() => void)[] = [];
const doc = { hidden: false, addEventListener: (_: string, f: () => void) => listeners.push(f), removeEventListener: (_: string, f: () => void) => (listeners = listeners.filter((l) => l !== f)) };
const real = { setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout, document: (globalThis as { document?: unknown }).document };

let clock = 0;
function at(iso: string) {
  clock = Date.parse(iso);
  setSystemTime(new Date(clock));
}
/** Runs the next timer at its time. */
function fire() {
  timers.sort((a, b) => a.at - b.at);
  const t = timers.shift()!;
  setSystemTime(new Date((clock = t.at)));
  t.fn();
}

beforeEach(() => {
  timers = [];
  listeners = [];
  doc.hidden = false;
  (globalThis as Record<string, unknown>).document = doc;
  (globalThis as Record<string, unknown>).setTimeout = (fn: () => void, ms: number) => {
    const t = { id: nextId++, at: clock + ms, fn };
    timers.push(t);
    return t.id;
  };
  (globalThis as Record<string, unknown>).clearTimeout = (id: number) => (timers = timers.filter((t) => t.id !== id));
});
afterEach(() => {
  globalThis.setTimeout = real.setTimeout;
  globalThis.clearTimeout = real.clearTimeout;
  if (real.document === undefined) delete (globalThis as Record<string, unknown>).document;
  else (globalThis as Record<string, unknown>).document = real.document;
  setSystemTime();
});

describe("everyMinuteWhileVisible", () => {
  test("runs 3 seconds after each minute starts", () => {
    at("2026-11-04T13:38:36Z");
    const runs: string[] = [];
    everyMinuteWhileVisible(() => runs.push(new Date(clock).toISOString().slice(11, 19)));
    fire();
    fire();
    expect(runs).toEqual(["13:39:03", "13:40:03"]);
  });

  test("waits for the next minute when started just before its turn", () => {
    at("2026-11-04T13:38:01Z");
    everyMinuteWhileVisible(() => {});
    expect(timers[0]!.at - clock).toBe(2_000);
  });

  test("lines up again after the machine slept", () => {
    at("2026-11-04T13:38:36Z");
    const runs: number[] = [];
    everyMinuteWhileVisible(() => runs.push(clock));
    // The timer fires late, long after its minute.
    timers[0]!.at = Date.parse("2026-11-04T13:52:40Z");
    fire();
    expect(timers[0]!.at).toBe(Date.parse("2026-11-04T13:53:03Z"));
    expect(runs).toHaveLength(1);
  });

  test("a hidden page skips its turns and runs once when shown again", () => {
    at("2026-11-04T13:38:36Z");
    let runs = 0;
    everyMinuteWhileVisible(() => runs++);
    doc.hidden = true;
    fire();
    fire();
    expect(runs).toBe(0);
    doc.hidden = false;
    for (const l of listeners) l();
    for (const l of listeners) l();
    expect(runs).toBe(1);
  });

  test("keeps going when a turn throws", () => {
    at("2026-11-04T13:38:36Z");
    let runs = 0;
    everyMinuteWhileVisible(() => {
      runs++;
      throw new Error("boom");
    });
    expect(() => fire()).toThrow("boom");
    expect(timers).toHaveLength(1);
    expect(() => fire()).toThrow("boom");
    expect(runs).toBe(2);
  });

  test("stopping clears the timer and the listener", () => {
    at("2026-11-04T13:38:36Z");
    const stop = everyMinuteWhileVisible(() => {});
    fire();
    stop();
    expect(timers).toHaveLength(0);
    expect(listeners).toHaveLength(0);
  });
});
