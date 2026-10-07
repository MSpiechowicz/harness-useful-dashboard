import { describe, expect, test } from "bun:test";
import { setMeta } from "../src/core/db.ts";
import { truncate } from "../src/core/ingest/types.ts";
import { REDACTED, redact, redactStored } from "../src/core/redact.ts";
import { memDb } from "./helpers.ts";

// Made-up keys, put together at runtime so no file holds a whole key-shaped string for secret scanners to flag.
const fake = (...parts: string[]) => parts.join("");
const ANT = fake("sk-", "ant-api03-", "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789");
const OPENAI = fake("sk-", "proj-", "abcdefghijklmnopqrstuvwxyz0123456789ABCD");
const GITHUB = fake("ghp", "_", "abcdefghijklmnopqrstuvwxyz0123456789AB");
const AWS = fake("AKIA", "IOSFODNN7EXAMPLE");
const SLACK = fake("xoxb", "-1234567890-abcdefghij");

describe("redact", () => {
  test.each([
    [`use ${ANT} here`, `use ${REDACTED} here`],
    [`key ${OPENAI}`, `key ${REDACTED}`],
    [`token ${GITHUB}`, `token ${REDACTED}`],
    [`AWS ${AWS} id`, `AWS ${REDACTED} id`],
    [`slack ${SLACK}`, `slack ${REDACTED}`],
    ["Authorization: Bearer abcdefghijklmnopqrstuvwxyz.012345", `Authorization: ${REDACTED}`],
    ["-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\n-----END OPENSSH PRIVATE KEY-----\nthanks", `${REDACTED}\nthanks`],
  ])("hides %p", (input, expected) => {
    expect(redact(input)).toBe(expected);
  });

  test.each(["fix the sk-learn import", "rename task-runner to sk-runner", "the AKIA prefix", "Bearer of bad news", "eyJhbGciOi is how a JWT starts"])(
    "leaves ordinary text alone: %p",
    (text) => {
      expect(redact(text)).toBe(text);
    },
  );

  test("a key is hidden before the text is cut, so half of one can't be stored", () => {
    const text = "x".repeat(10) + ` ${ANT}`;
    expect(truncate(text, 30)).toBe(`${"x".repeat(10)} ${REDACTED}`);
  });

  test("text stored before is gone over once", () => {
    const db = memDb();
    db.run(`INSERT INTO prompts (id, session_id, provider, ts, text) VALUES ('p1', 's', 'claude', 1, 'key ${ANT}'), ('p2', 's', 'claude', 1, 'hello')`);
    expect(redactStored(db)).toBe(1);
    expect(db.query<{ text: string }, []>("SELECT text FROM prompts WHERE id = 'p1'").get()!.text).toBe(`key ${REDACTED}`);
    db.run(`UPDATE prompts SET text = '${ANT}' WHERE id = 'p2'`);
    expect(redactStored(db)).toBe(0);
    setMeta(db, "redacted", "0");
    expect(redactStored(db)).toBe(1);
  });
});
