import { describe, expect, test } from "bun:test";
import type { UsageRecord } from "../src/core/ingest/types.ts";
import { DbWriter } from "../src/core/ingest/writer.ts";
import { PriceBook } from "../src/core/pricing.ts";
import { generateTips } from "../src/core/tips.ts";
import { ID, memDb } from "./helpers.ts";

const T0 = new Date(2026, 8, 1, 12).getTime();

function seed(rows: { id: string; partial: boolean; provider?: UsageRecord["provider"] }[]) {
  const db = memDb();
  const prices = new PriceBook();
  const w = new DbWriter(db, prices, ID);
  rows.forEach((r, i) => {
    const provider = r.provider ?? "copilot-chat";
    w.usage({
      id: r.id, provider, sessionId: `${provider}:s1`, promptId: null, ts: T0 + i * 60_000, project: "/work/alpha", model: "gpt-6-luna",
      skill: null, agent: "main", isSubagent: false, input: 1000, output: 100, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, reasoning: 0,
      billing: "github-copilot", partial: r.partial,
    });
  });
  return { db, prices, w };
}

const tip = (db: ReturnType<typeof memDb>, prices: PriceBook, f = {}) => generateTips(db, f, prices).find((t) => t.id === "copilot-chat-partial");

describe("Copilot Chat partial tip", () => {
  test("shown when the range has partial Copilot Chat calls, pointing at the settings", () => {
    const { db, prices } = seed([{ id: "copilot-chat:s1:f:r1", partial: true }, { id: "copilot-chat:s1:o:r2", partial: false }, { id: "copilot-chat:s1:f:r3", partial: true }]);

    expect(tip(db, prices)).toMatchObject({
      severity: "info",
      category: "models",
      params: { messages: 2 },
      link: "#/settings",
      key: "copilot-chat-partial",
    });
  });

  test("gone when every Copilot Chat call is complete, or the partial ones fall outside the range", () => {
    const complete = seed([{ id: "copilot-chat:s1:o:r1", partial: false }]);
    expect(tip(complete.db, complete.prices)).toBeUndefined();

    const old = seed([{ id: "copilot-chat:s1:f:r1", partial: true }, { id: "copilot-chat:s1:o:r2", partial: false }]);
    expect(tip(old.db, old.prices, { from: T0 + 30_000 })).toBeUndefined();
  });

  test("replacing the partial row removes the tip", () => {
    const { db, prices, w } = seed([{ id: "copilot-chat:s1:f:r1", partial: true }]);
    expect(tip(db, prices)).toBeDefined();

    // The same call, read again complete: a complete reading is never made partial again.
    w.usage({
      id: "copilot-chat:s1:f:r1", provider: "copilot-chat", sessionId: "copilot-chat:s1", promptId: null, ts: T0, project: "/work/alpha", model: "gpt-6-luna",
      skill: null, agent: "main", isSubagent: false, input: 1000, output: 100, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, reasoning: 0, partial: false,
    });
    expect(tip(db, prices)).toBeUndefined();
  });

  test("other harnesses' partial-looking rows don't count", () => {
    const { db, prices } = seed([{ id: "u1", partial: true, provider: "claude" }]);
    expect(tip(db, prices)).toBeUndefined();
  });
});
