import type { Database } from "bun:sqlite";
import { getMeta, setMeta } from "./db.ts";

/**
 * Secrets people paste into prompts: API keys, tokens and private keys. Only shapes specific enough not to catch
 * ordinary text (a known prefix and a long run of key characters).
 */
const SECRETS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  /\bsk-ant-[A-Za-z0-9_-]{20,}/g, // Anthropic
  /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{32,}/g, // OpenAI
  /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})/g, // GitHub
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, // AWS access key ids
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g, // Slack
  /\bAIza[0-9A-Za-z_-]{35}/g, // Google
  /\b[rs]k_(?:live|test)_[A-Za-z0-9]{16,}/g, // Stripe
  /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, // JWTs
  /\bBearer [A-Za-z0-9._~+/-]{20,}=*/g,
];

export const REDACTED = "[redacted]";

/** Text with every secret it holds replaced, so the database never keeps one. */
export function redact(text: string): string {
  let out = text;
  for (const re of SECRETS) out = out.replace(re, REDACTED);
  return out;
}

/**
 * Bumped when SECRETS learns new shapes or another column holds text: what is stored is gone over once more. 2 added
 * commit subjects and chart notes.
 */
const REDACT_VERSION = 2;

/** The stored text redaction goes over, by table and column. */
const STORED_TEXT = [
  ["prompts", "text"],
  ["sessions", "brief"],
  ["outcomes", "detail"],
  ["outcomes", "input"],
  ["git_events", "subject"],
  ["chart_notes", "text"],
] as const;

/**
 * Goes over the prompt text, subagent briefs, error text, commit subjects and chart notes stored before redaction
 * existed (or before it knew today's shapes). Once per database, by version, so machines sharing one don't repeat it.
 */
export function redactStored(db: Database): number {
  if (Number(getMeta(db, "redacted") ?? 0) >= REDACT_VERSION) return 0;
  let changed = 0;
  db.transaction(() => {
    for (const [table, column] of STORED_TEXT) {
      const rows = db.query<{ id: string; v: string }, []>(`SELECT id, ${column} AS v FROM ${table} WHERE ${column} IS NOT NULL`).all();
      const upd = db.prepare(`UPDATE ${table} SET ${column} = ? WHERE id = ?`);
      for (const r of rows) {
        const clean = redact(r.v);
        if (clean !== r.v) {
          upd.run(clean, r.id);
          changed++;
        }
      }
    }
    setMeta(db, "redacted", String(REDACT_VERSION));
  })();
  return changed;
}
