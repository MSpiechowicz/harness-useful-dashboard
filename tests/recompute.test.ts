import type { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { recomputeCosts } from "../src/core/ingest/writer.ts";
import { PriceBook } from "../src/core/pricing.ts";
import { memDb } from "./helpers.ts";

/** The row-by-row version recomputeCosts replaced: the reference it must agree with to the last bit. */
function recomputeRowByRow(db: Database, prices: PriceBook): number {
  const rows = db
    .query<
      { id: string; model: string | null; input_tokens: number; output_tokens: number; cache_read_tokens: number; cache_write_tokens: number; cache_write_1h_tokens: number; speed: string | null },
      []
    >(
      `SELECT id, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cache_write_1h_tokens, speed
       FROM usage WHERE provider NOT IN ('cursor', 'cline', 'roo', 'kilo') OR cost_estimated = 1`,
    )
    .all();
  const upd = db.prepare("UPDATE usage SET cost_usd = ?, cost_estimated = ? WHERE id = ?");
  db.transaction(() => {
    for (const r of rows) {
      const c = prices.cost(
        r.model,
        { input: r.input_tokens, output: r.output_tokens, cacheRead: r.cache_read_tokens, cacheWrite: r.cache_write_tokens, cacheWrite1h: r.cache_write_1h_tokens },
        r.speed,
      );
      upd.run(c.usd, c.estimated ? 1 : 0, r.id);
    }
  })();
  return rows.length;
}

const MODELS = [
  "claude-opus-5-5", "claude-sonnet-4-5-20250929", "claude-haiku-4.5", "github-copilot/claude-opus-5.5", "gpt-5", "gpt-5-mini",
  "gpt-4.1-nano", "o3", "gemini-2.5-pro", "deepseek-chat", "some-new-model", "<synthetic>", null, "my-custom",
];
const PROVIDERS = ["claude", "codex", "omp", "cursor", "cline", "kilo"];

function fixture(): Database {
  const db = memDb();
  let seed = 7;
  const rand = (n: number) => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed % n;
  };
  const ins = db.prepare(
    `INSERT INTO usage (id, provider, session_id, ts, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
                        cache_write_1h_tokens, total_tokens, cost_usd, cost_estimated, speed)
     VALUES (?, ?, 's', ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
  );
  db.transaction(() => {
    for (let i = 0; i < 3000; i++) {
      ins.run(
        `u${i}`, PROVIDERS[rand(PROVIDERS.length)]!, 1_700_000_000_000 + i, MODELS[rand(MODELS.length)] ?? null,
        rand(50_000), rand(20_000), rand(2_000_000), rand(300_000), rand(3) ? 0 : rand(100_000),
        rand(1000) / 7, rand(2), [null, "fast", "standard"][rand(3)] ?? null,
      );
    }
  })();
  db.query("INSERT INTO pricing (pattern, input, output, cache_read) VALUES ('my-custom', 0.3, 1.7, 0.03)").run();
  return db;
}

const snapshot = (db: Database) => db.query<{ id: string; cost_usd: number; cost_estimated: number }, []>("SELECT id, cost_usd, cost_estimated FROM usage ORDER BY id").all();

describe("recomputeCosts", () => {
  test("gives the same costs as pricing every row in JS", () => {
    const a = fixture();
    const b = fixture();
    const prices = PriceBook.fromDb(a);
    const n = recomputeCosts(a, prices);
    expect(n).toBe(recomputeRowByRow(b, prices));
    expect(n).toBeGreaterThan(1000);
    expect(snapshot(a)).toEqual(snapshot(b));
  });
});
