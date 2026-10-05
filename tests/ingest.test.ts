import { describe, expect, test } from "bun:test";
import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { scan, splitLines } from "../src/core/ingest/index.ts";
import { claudeAssistant, claudeUser, CLAUDE_SESSION, ID, memDb, tempDir, testConfig, writeJsonl } from "./helpers.ts";

describe("splitLines", () => {
  test("returns complete lines with byte offsets and leaves a partial tail", () => {
    const buf = new TextEncoder().encode('{"a":1}\n{"b":"ü"}\n{"c":');
    const { lines, consumed } = splitLines(buf, 100);
    expect(lines.map((l) => l.text)).toEqual(['{"a":1}', '{"b":"ü"}']);
    expect(lines[0]!.offset).toBe(100);
    expect(lines[1]!.offset).toBe(108);
    expect(consumed).toBe(new TextEncoder().encode('{"a":1}\n{"b":"ü"}\n').length);
  });
});

describe("incremental scanning", () => {
  const file = (root: string) => join(root, "claude", "projects", "-work-alpha", `${CLAUDE_SESSION}.jsonl`);

  test("appended lines are picked up without re-reading or duplicating", async () => {
    const root = tempDir();
    const path = file(root);
    writeJsonl(path, [claudeUser("one", { uuid: "u1", ts: "2026-09-01T10:00:00.000Z" }), claudeAssistant({ id: "m1", ts: "2026-09-01T10:00:01.000Z" })]);
    const db = memDb();
    const cfg = testConfig(root);
    await scan(db, cfg, ID);
    expect(db.query<any, []>("SELECT COUNT(*) AS n FROM usage").get().n).toBe(1);

    appendFileSync(path, JSON.stringify(claudeAssistant({ id: "m2", ts: "2026-09-01T10:00:02.000Z" })) + "\n");
    const r = await scan(db, cfg, ID);
    expect(r.filesParsed).toBe(1);
    expect(r.usageRows).toBe(1); // only the new line was parsed
    const rows = db.query<any, []>("SELECT id, prompt_id FROM usage ORDER BY id").all();
    expect(rows.map((x) => x.id)).toEqual(["claude:m1", "claude:m2"]);
    // parser state (current prompt) survives across incremental passes
    expect(rows[1].prompt_id).toBe(rows[0].prompt_id);
  });

  test("a partially written trailing line is consumed only once complete", async () => {
    const root = tempDir();
    const path = file(root);
    const line = JSON.stringify(claudeAssistant({ id: "m1", ts: "2026-09-01T10:00:01.000Z" }));
    writeJsonl(path, [claudeUser("one", { uuid: "u1", ts: "2026-09-01T10:00:00.000Z" })]);
    appendFileSync(path, line.slice(0, 40));
    const db = memDb();
    const cfg = testConfig(root);
    await scan(db, cfg, ID);
    expect(db.query<any, []>("SELECT COUNT(*) AS n FROM usage").get().n).toBe(0);
    appendFileSync(path, line.slice(40) + "\n");
    await scan(db, cfg, ID);
    expect(db.query<any, []>("SELECT COUNT(*) AS n FROM usage").get().n).toBe(1);
  });

  test("a truncated/rewritten file is re-read from the start", async () => {
    const root = tempDir();
    const path = file(root);
    writeJsonl(path, [claudeUser("one", { uuid: "u1", ts: "2026-09-01T10:00:00.000Z" }), claudeAssistant({ id: "m1", ts: "2026-09-01T10:00:01.000Z" }), claudeAssistant({ id: "m2", ts: "2026-09-01T10:00:02.000Z" })]);
    const db = memDb();
    const cfg = testConfig(root);
    await scan(db, cfg, ID);
    writeFileSync(path, JSON.stringify(claudeAssistant({ id: "m9", ts: "2026-09-01T10:00:09.000Z" })) + "\n");
    await scan(db, cfg, ID);
    const ids = db.query<any, []>("SELECT id FROM usage ORDER BY id").all().map((r) => r.id);
    expect(ids).toEqual(["claude:m1", "claude:m2", "claude:m9"]);
  });

  test("malformed lines are skipped without failing the file", async () => {
    const root = tempDir();
    const path = file(root);
    writeJsonl(path, [claudeAssistant({ id: "m1", ts: "2026-09-01T10:00:01.000Z" })]);
    appendFileSync(path, "{not json}\n" + JSON.stringify(claudeAssistant({ id: "m2", ts: "2026-09-01T10:00:02.000Z" })) + "\n");
    const db = memDb();
    const r = await scan(db, testConfig(root), ID);
    expect(r.errors).toEqual([]);
    expect(db.query<any, []>("SELECT COUNT(*) AS n FROM usage").get().n).toBe(2);
  });

  test("ingest bookkeeping is per host, so machines sharing a DB don't skip each other's files", async () => {
    const root = tempDir();
    writeJsonl(file(root), [claudeAssistant({ id: "m1", ts: "2026-09-01T10:00:01.000Z" })]);
    const db = memDb();
    const cfg = testConfig(root);
    await scan(db, cfg, { user: "a", host: "laptop" });
    const r = await scan(db, cfg, { user: "a", host: "desktop" });
    expect(r.filesParsed).toBe(1);
    expect(db.query<any, []>("SELECT COUNT(*) AS n FROM ingest_files").get().n).toBe(2);
    expect(db.query<any, []>("SELECT COUNT(*) AS n FROM usage").get().n).toBe(1); // same message, deduped
  });

  test("disabled sources are not scanned", async () => {
    const root = tempDir();
    writeJsonl(file(root), [claudeAssistant({ id: "m1", ts: "2026-09-01T10:00:01.000Z" })]);
    const db = memDb();
    const cfg = testConfig(root);
    cfg.sources.enabled.claude = false;
    const r = await scan(db, cfg, ID);
    expect(r.filesSeen).toBe(0);
  });
});
