import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { appDataDir, ensureAppDataDir } from "../core/paths.ts";

/**
 * Who may send usage to the OTLP listener (ingest.ts): tokens, each with a label that becomes the user of its rows, and
 * one username and password for senders that can only do basic auth. Kept in its own file next to the config, never in
 * config.json: the settings API and `config get` show that one in full. Only hashes are stored, so the file doesn't
 * give a token away. The CLI edits the same file: a running server reads it again once it changed on disk, and a save
 * made on top of a file another process changed since it was read is made again on top of that change.
 *
 * A file that is there but can't be read lets nobody in, and is never written over: every change throws
 * IngestAuthUnreadable until it is repaired or deleted.
 */

export const AUTH_FILE = "ingest-auth.json";

/** The most tokens kept: each one is compared on every request. */
export const MAX_TOKENS = 100;
export const MIN_PASSWORD = 12;
const MAX_PASSWORD = 1024;
const MAX_NAME = 100;
/** The longest name taken before NFKC, which can make one character eighteen: a longer one is too long anyway. */
const RAW_NAME = 1024;

const TOKEN_PATTERN = /^hd_ing_[0-9a-f]{64}$/;
/** What a token's prefix shows of it: "hd_ing_" and the first 4 hex digits, enough to tell tokens apart. */
const PREFIX_CHARS = 11;
/** Control characters and line or paragraph separators: a name with one is refused. */
const CONTROL = /[\p{Cc}\p{Zl}\p{Zp}]/u;
/** Format characters (zero-width spaces and joiners, direction marks): invisible, so left out of a name. */
const INVISIBLE = /\p{Cf}/gu;

/** Password checks (argon2: slow and CPU-heavy on purpose) running at once, and waiting: past that, the server is busy. */
const MAX_VERIFYING = 2;
const MAX_WAITING = 8;
/** Saves made again when another process changed the file in between, each after a short random wait. */
const SAVE_TRIES = 10;
const SAVE_BACKOFF_MS = 5;

/** How long a basic auth header that passed is taken without hashing the password again (argon2 is slow on purpose). */
const VERIFIED_MS = 10 * 60_000;
const MAX_VERIFIED = 100;
/** A token's last use is kept in memory and written to the file at most this often. */
const PERSIST_MS = 60 * 60_000;

/** A token as Settings and the CLI list it: never the token or its hash. */
export interface IngestToken {
  id: string;
  label: string;
  prefix: string;
  createdAt: number;
  lastUsedAt: number | null;
}

interface StoredToken extends IngestToken {
  /** sha256 of the token, hex. */
  hash: string;
}

interface AuthFile {
  tokens: StoredToken[];
  /** The password as Bun.password hashed it (argon2id). */
  basic: { user: string; hash: string } | null;
}

/**
 * Who sent a request: its rows are labelled with the token's label or the basic auth user, and their ids namespaced
 * with `key` ("t<token id>", "b:<user>"), so one sender never overwrites another's rows.
 */
export interface IngestCredential {
  kind: "token" | "basic";
  label: string;
  key: string;
}

/** The file is there but can't be read: nobody is let in, and no change is written over it. */
export class IngestAuthUnreadable extends Error {
  constructor(
    readonly path: string,
    readonly reason: string,
  ) {
    super("ingest-auth-unreadable");
  }
}

/** Too many password checks running and waiting: the sender is told to try again later (503). */
export class IngestAuthBusy extends Error {
  constructor() {
    super("ingest-auth-busy");
  }
}

export type VerifyPassword = (password: string, hash: string) => Promise<boolean>;

/** A hash of no password at all, as Bun.password makes one: what a wrong user is checked against. */
export type MakeDecoy = () => Promise<string>;

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

function sameHex(a: string, b: string): boolean {
  return a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

/**
 * A label or username: no control characters or line separators, in NFKC form without invisible characters, runs of
 * whitespace as one space, 1 to 100 characters once trimmed. One of more than RAW_NAME characters is refused before
 * it is normalized.
 */
function cleanName(v: unknown): string | null {
  if (typeof v !== "string" || v.length > RAW_NAME || CONTROL.test(v)) return null;

  const name = v.normalize("NFKC").replace(INVISIBLE, "").replace(/\s+/g, " ").trim();
  if (!name || name.length > MAX_NAME || CONTROL.test(name)) return null;
  return name;
}

const BEARER = /^Bearer\s+(\S+)$/i;
const BASIC = /^Basic\s+([A-Za-z0-9+/=]+)$/i;

/**
 * What an Authorization header tries: a token of the form tokens have, basic auth, or neither (null: no sign-in at
 * all, or a token no token could be). The listener limits failures of each kind apart (ingest.ts).
 */
export function signInKind(header: string | null): "token" | "basic" | null {
  if (!header) return null;

  const bearer = BEARER.exec(header)?.[1];
  if (bearer) return TOKEN_PATTERN.test(bearer) ? "token" : null;
  return BASIC.test(header) ? "basic" : null;
}

/** The basic auth user as part of an id: letters, digits and a few marks, anything else as "_". */
const basicKey = (user: string) => `b:${user.replace(/[^\p{L}\p{N}._@-]+/gu, "_")}`;

/** Runs at most `max` tasks at once with at most `queue` more waiting their turn: one more throws IngestAuthBusy. */
class Gate {
  private running = 0;
  private waiting: (() => void)[] = [];

  constructor(
    private max: number,
    private queue: number,
  ) {}

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.running < this.max) {
      this.running++;
    } else {
      if (this.waiting.length >= this.queue) throw new IngestAuthBusy();
      // The slot is handed over by the task that ends: `running` stays as it is.
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    }

    try {
      return await task();
    } finally {
      const next = this.waiting.shift();
      if (next) next();
      else this.running--;
    }
  }
}

/** What the file holds, with anything of the wrong shape left out. Throws when it is no JSON object. */
function parseFile(text: string): AuthFile {
  const raw = JSON.parse(text) as Partial<Record<keyof AuthFile, unknown>> | null;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("not a JSON object");

  const tokens: StoredToken[] = [];
  for (const t of Array.isArray(raw.tokens) ? (raw.tokens as Record<string, unknown>[]) : []) {
    if (!t || typeof t !== "object") continue;
    if (typeof t.id !== "string" || !/^[0-9a-f]{16}$/.test(t.id)) continue;
    if (typeof t.hash !== "string" || !/^[0-9a-f]{64}$/.test(t.hash)) continue;
    const label = cleanName(t.label);
    if (!label || typeof t.createdAt !== "number") continue;

    const lastUsedAt = typeof t.lastUsedAt === "number" ? t.lastUsedAt : null;
    tokens.push({ id: t.id, label, hash: t.hash, prefix: typeof t.prefix === "string" ? t.prefix.slice(0, PREFIX_CHARS) : "", createdAt: t.createdAt, lastUsedAt });
  }

  const b = raw.basic as Record<string, unknown> | null | undefined;
  const user = cleanName(b?.user);
  const basic = user && typeof b?.hash === "string" && b.hash.startsWith("$") ? { user, hash: b.hash } : null;

  return { tokens, basic };
}

export class IngestAuth {
  readonly path: string;
  private data: AuthFile = { tokens: [], basic: null };
  /** The file's identity on disk when it was read: another one means the CLI (or another server) changed it. */
  private stamp: string | null = null;
  /** Why the file on disk can't be read, null when it can (or isn't there). */
  private broken: string | null = null;
  /** Last uses not written to the file yet, by token id. */
  private used = new Map<string, number>();
  /** When the last uses were written, null before the first. */
  private persistedAt: number | null = null;
  /** Basic auth headers that passed, by their sha256: when each one may be taken until, its user and the hash it passed. */
  private verified = new Map<string, { user: string; hash: string; until: number }>();
  /** Password checks, a few at a time for every sender together. */
  private verifying = new Gate(MAX_VERIFYING, MAX_WAITING);
  /** A hash of no password, checked when the user is wrong: a wrong user takes as long as a wrong password. */
  private decoy: Promise<string> | null = null;

  constructor(
    private dir = appDataDir(),
    private now: () => number = Date.now,
    private verify: VerifyPassword = (password, hash) => Bun.password.verify(password, hash),
    private makeDecoy: MakeDecoy = () => Bun.password.hash(randomBytes(32).toString("hex"), { algorithm: "argon2id" }),
  ) {
    this.path = join(dir, AUTH_FILE);
  }

  /** The tokens, newest last, with their last use. */
  tokens(): IngestToken[] {
    return this.current().tokens.map((t) => ({ id: t.id, label: t.label, prefix: t.prefix, createdAt: t.createdAt, lastUsedAt: this.lastUse(t) }));
  }

  basic(): { user: string } | null {
    const b = this.current().basic;
    return b ? { user: b.user } : null;
  }

  /** Why the file can't be read, or null when it can (or isn't there): nobody is let in then, and nothing saved. */
  readError(): string | null {
    this.current();
    return this.broken;
  }

  /** Makes a token. It is returned this once: only its hash is kept. */
  addToken(label: unknown): { token: string; item: IngestToken } | { error: string } {
    const name = cleanName(label);
    if (!name) return { error: "invalid value for label" };

    const token = `hd_ing_${randomBytes(32).toString("hex")}`;
    const stored: StoredToken = { id: randomBytes(8).toString("hex"), label: name, hash: sha256(token), prefix: token.slice(0, PREFIX_CHARS), createdAt: this.now(), lastUsedAt: null };
    let full = false;
    this.update((data) => {
      full = data.tokens.length >= MAX_TOKENS;
      return full ? null : { ...data, tokens: [...data.tokens, stored] };
    });
    if (full) return { error: `at most ${MAX_TOKENS} tokens` };

    const { hash: _, ...item } = stored;
    return { token, item };
  }

  /** Revokes a token: false when there is none with that id. */
  revokeToken(id: unknown): boolean {
    const revoked = this.update((data) => {
      const tokens = data.tokens.filter((t) => t.id !== id);
      return tokens.length === data.tokens.length ? null : { ...data, tokens };
    });
    if (revoked) this.used.delete(id as string);
    return revoked;
  }

  /** Sets the basic auth user and password, replacing the ones before. */
  async setBasic(user: unknown, password: unknown): Promise<{ user: string } | { error: string }> {
    const name = cleanName(user);
    if (!name || name.includes(":")) return { error: "invalid value for user" };
    if (typeof password !== "string" || password.length < MIN_PASSWORD || password.length > MAX_PASSWORD) return { error: `the password must be ${MIN_PASSWORD} to ${MAX_PASSWORD} characters` };

    // Refused before the slow hash when the file can't be written anyway.
    this.writable();
    const hash = await Bun.password.hash(password, { algorithm: "argon2id" });
    this.update((data) => ({ ...data, basic: { user: name, hash } }));
    return { user: name };
  }

  clearBasic(): void {
    this.update((data) => (data.basic ? { ...data, basic: null } : null));
  }

  /**
   * Who an Authorization header belongs to: a token, the basic auth user, or nobody (null). Throws IngestAuthBusy when
   * too many password checks are running and waiting already.
   */
  async authenticate(header: string | null): Promise<IngestCredential | null> {
    if (!header) return null;

    const data = this.current();
    const bearer = BEARER.exec(header)?.[1];
    if (bearer) return this.byToken(data, bearer);

    return (await this.checkBasic(header)).cred;
  }

  /**
   * The basic auth user an Authorization header signs in as, or null, and whether a password was checked for it
   * (argon2, against the user's hash or the decoy): none is for a header that passed lately, one of no user and
   * password, or when no basic auth user is set. Throws IngestAuthBusy like `authenticate`.
   */
  async checkBasic(header: string): Promise<{ cred: IngestCredential | null; checked: boolean }> {
    const stored = this.current().basic;
    const encoded = BASIC.exec(header)?.[1];
    if (!encoded || !stored) return { cred: null, checked: false };

    return this.byPassword(stored, header, encoded);
  }

  /**
   * The basic auth user, when this very header passed a password check within VERIFIED_MS (and the user and password
   * are the same since): no password is checked again. Null for any other header.
   */
  cachedBasic(header: string): IngestCredential | null {
    const stored = this.current().basic;
    if (!stored || !BASIC.test(header)) return null;

    if (!this.passedLately(sha256(header), stored)) return null;
    return { kind: "basic", label: stored.user, key: basicKey(stored.user) };
  }

  /** Whether the header with this sha256 passed a check within VERIFIED_MS against the user and hash set now. */
  private passedLately(key: string, stored: { user: string; hash: string }): boolean {
    const hit = this.verified.get(key);
    if (!hit || hit.until <= this.now()) return false;
    return hit.user === stored.user && hit.hash === stored.hash;
  }

  private byToken(data: AuthFile, token: string): IngestCredential | null {
    if (!TOKEN_PATTERN.test(token)) return null;

    // Every token is compared, so the time taken says nothing about which one came close.
    const hash = sha256(token);
    let found: StoredToken | null = null;
    for (const t of data.tokens) if (sameHex(t.hash, hash)) found = t;
    if (!found) return null;

    this.used.set(found.id, this.now());
    if (this.persistedAt == null || this.now() - this.persistedAt >= PERSIST_MS) this.persistUse();
    return { kind: "token", label: found.label, key: `t${found.id}` };
  }

  private async byPassword(stored: { user: string; hash: string }, header: string, encoded: string): Promise<{ cred: IngestCredential | null; checked: boolean }> {
    const cred: IngestCredential = { kind: "basic", label: stored.user, key: basicKey(stored.user) };
    const key = sha256(header);
    const now = this.now();
    if (this.passedLately(key, stored)) return { cred, checked: false };

    const decoded = Buffer.from(encoded, "base64").toString("utf8");
    const colon = decoded.indexOf(":");
    if (colon < 0) return { cred: null, checked: false };

    // A wrong user is checked against the decoy: it takes as long as the right user with a wrong password.
    const user = decoded.slice(0, colon);
    const password = decoded.slice(colon + 1);
    const rightUser = sameHex(sha256(user), sha256(stored.user));
    const hash = rightUser ? stored.hash : await this.decoyHash();
    const ok = await this.verifying.run(() => this.check(password, hash));
    if (!ok || !rightUser) return { cred: null, checked: true };

    // The user or password may have changed, or basic auth been turned off, while it was checked: a pass against what
    // was set before lets nobody in.
    const after = this.current().basic;
    if (after?.user !== stored.user || after.hash !== stored.hash) return { cred: null, checked: true };

    this.verified.delete(key);
    if (this.verified.size >= MAX_VERIFIED) this.verified.delete(this.verified.keys().next().value!);
    this.verified.set(key, { user: stored.user, hash: stored.hash, until: now + VERIFIED_MS });
    return { cred, checked: true };
  }

  private async check(password: string, hash: string): Promise<boolean> {
    try {
      return await this.verify(password, hash);
    } catch {
      return false; // a hash Bun can't read: nobody gets in with it
    }
  }

  /**
   * The decoy, made once and kept. Making it is argon2 work like a password check, so it waits its turn with them. When
   * making it failed (or the checks were all busy), it is made again on the next wrong user.
   */
  private decoyHash(): Promise<string> {
    if (this.decoy) return this.decoy;

    const made = this.verifying.run(this.makeDecoy);
    this.decoy = made;
    made.catch(() => {
      if (this.decoy === made) this.decoy = null;
    });
    return made;
  }

  private lastUse(t: StoredToken): number | null {
    const mem = this.used.get(t.id);
    if (mem == null) return t.lastUsedAt;
    return Math.max(mem, t.lastUsedAt ?? 0);
  }

  /** Writes the last uses kept in memory into the file. */
  private persistUse(): void {
    this.persistedAt = this.now();
    try {
      this.update((data) => ({ ...data, tokens: data.tokens.map((t) => ({ ...t, lastUsedAt: this.lastUse(t) })) }));
    } catch (err) {
      console.error("[ingest] Can't save when tokens were last used:", err);
    }
  }

  /** The file as it is on disk now: read again when it changed since the last read. */
  private current(): AuthFile {
    const stamp = fileStamp(this.path);
    if (stamp === this.stamp) return this.data;

    let data: AuthFile = { tokens: [], basic: null };
    let broken: string | null = null;
    if (stamp !== "missing") {
      try {
        data = parseFile(readFileSync(this.path, "utf8"));
      } catch (err) {
        broken = (err as Error).message;
        // Once per change of the file: it is read again only when it changes.
        console.warn(`[ingest] Can't read ${this.path}, no sender is let in and nothing is saved until it is repaired or deleted: ${broken}`);
      }
    }

    this.keepVerified(data);
    this.data = data;
    this.broken = broken;
    this.stamp = stamp;
    return data;
  }

  /** Forgets the basic auth headers that passed when the user or password is no longer the same: other changes keep them. */
  private keepVerified(next: AuthFile): void {
    const before = this.data.basic;
    const after = next.basic;
    if (before?.user !== after?.user || before?.hash !== after?.hash) this.verified.clear();
  }

  /** Throws IngestAuthUnreadable when the file is there but can't be read: it is never written over. */
  private writable(): void {
    this.current();
    if (this.broken != null) throw new IngestAuthUnreadable(this.path, this.broken);
  }

  /**
   * Saves `change` of the file as it is on disk: false when it changes nothing (null). Written whole, through a
   * temporary file renamed over it, so a reader never sees half of it. When another process saved since the file was
   * read, its change is read and `change` made again on top of it, a few times at most.
   */
  private update(change: (data: AuthFile) => AuthFile | null): boolean {
    for (let attempt = 0; attempt < SAVE_TRIES; attempt++) {
      this.writable();
      const read = this.stamp;
      const next = change(this.data);
      if (!next) return false;

      ensureAppDataDir(this.dir);
      const tmp = `${this.path}.${randomBytes(4).toString("hex")}.tmp`;
      try {
        writeFileSync(tmp, JSON.stringify(next, null, 2) + "\n", { mode: 0o600 });
        if (fileStamp(this.path) !== read) {
          rmSync(tmp, { force: true });
          Bun.sleepSync(1 + Math.random() * SAVE_BACKOFF_MS * (attempt + 1));
          continue;
        }
        renameSync(tmp, this.path);
      } catch (err) {
        rmSync(tmp, { force: true });
        throw err;
      }

      this.keepVerified(next);
      this.data = next;
      this.stamp = fileStamp(this.path);
      return true;
    }
    throw new Error(`${this.path} kept changing while it was saved`);
  }
}

/** A file's inode, modification time and size: a rename over it gives it a new inode, so even a same-millisecond edit shows. */
function fileStamp(path: string): string {
  try {
    const st = statSync(path);
    return `${st.ino}:${st.mtimeMs}:${st.size}`;
  } catch {
    return "missing";
  }
}
