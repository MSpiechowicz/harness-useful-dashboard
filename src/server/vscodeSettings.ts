import { closeSync, fchmodSync, fstatSync, lstatSync, openSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { applyEdits, type FormattingOptions, modify, type ParseError, parse, parseTree } from "jsonc-parser";
import type { IngestConfig } from "../core/config.ts";
import { INGEST_TOKEN_PATTERN, type IngestAuth } from "./ingestAuth.ts";

/**
 * Connect VS Code: points GitHub Copilot Chat's OpenTelemetry export at this machine's OTLP listener (ingest.ts) by
 * writing six keys into the editor's user settings.json. The file is the user's own, so it is edited in place (comments,
 * trailing commas, indentation and line endings stay), backed up first, replaced atomically, and left alone when it
 * can't be read as a settings object. The token that goes into it is never returned or logged.
 */

/** The editors that run Copilot Chat, by the folder they keep their settings in. Cursor and Windsurf are left out. */
export const FLAVORS = ["Code", "Code - Insiders", "Code - OSS", "VSCodium"] as const;
export type Flavor = (typeof FLAVORS)[number];

/** What the paths depend on: the home folder and the OS, like the readers' config. */
export interface FlavorEnv {
  home: string;
  platform: NodeJS.Platform;
  /** %APPDATA% on Windows. */
  appData?: string;
  /** $XDG_CONFIG_HOME on Linux. */
  xdgConfig?: string;
}

export interface FlavorInfo {
  id: Flavor;
  userDir: string;
  settingsPath: string;
  /** The editor's User folder exists. */
  installed: boolean;
}

export type VscodeState = "not-installed" | "off" | "connected" | "stale" | "other-endpoint" | "unparsable";

/** Why a connection wasn't made or taken out. "duplicate-keys": the file names one of our settings twice, so which one the editor uses is unclear. "symlinked": settings.json is a symlink and nobody confirmed writing through it. */
export type VscodeError = "not-installed" | "unparsable" | "other-endpoint" | "not-local-bind" | "write-failed" | "duplicate-keys" | "symlinked";

export type VscodeResult = { ok: true } | { error: VscodeError };

/** What these functions need of the token store. */
export type VscodeAuth = Pick<IngestAuth, "findToken" | "addToken" | "revokeToken" | "vscodeTokens">;

const PREFIX = "github.copilot.chat.otel.";
const KEY_ENABLED = `${PREFIX}enabled`;
const KEY_EXPORTER = `${PREFIX}exporterType`;
const KEY_ENDPOINT = `${PREFIX}otlpEndpoint`;
const KEY_HEADERS = `${PREFIX}headers`;
const KEY_CONTENT = `${PREFIX}captureContent`;
const KEY_MAX_CHARS = `${PREFIX}maxAttributeSizeChars`;

/** The six settings Connect VS Code writes, and adds to Settings Sync's ignore list so the token isn't synced. */
export const OTEL_KEYS = [KEY_ENABLED, KEY_EXPORTER, KEY_ENDPOINT, KEY_HEADERS, KEY_CONTENT, KEY_MAX_CHARS] as const;

const KEY_IGNORED = "settingsSync.ignoredSettings";

const BACKUP_INFIX = ".harness-dashboard-";
const BACKUPS_KEPT = 3;
/** A settings file larger than this is not read: real ones are a few KB. */
const MAX_SETTINGS_BYTES = 16 * 1024 * 1024;

/** The editors' paths on this machine. */
export function systemEnv(): FlavorEnv {
  return { home: homedir(), platform: process.platform, appData: process.env.APPDATA, xdgConfig: process.env.XDG_CONFIG_HOME };
}

/** Each editor with the User folder it keeps its settings in: per OS, and on Linux also its Flatpak's. */
export function findFlavors(env: FlavorEnv): FlavorInfo[] {
  return FLAVORS.map((id) => {
    const candidates = userDirs(env, id);
    const userDir = candidates.find((d) => isDirectory(d)) ?? candidates[0]!;
    return { id, userDir, settingsPath: join(userDir, "settings.json"), installed: isDirectory(userDir) };
  });
}

function userDirs(env: FlavorEnv, flavor: Flavor): string[] {
  if (env.platform === "darwin") return [join(env.home, "Library", "Application Support", flavor, "User")];
  if (env.platform === "win32") return [join(env.appData ?? join(env.home, "AppData", "Roaming"), flavor, "User")];

  const dirs = [join(env.xdgConfig ?? join(env.home, ".config"), flavor, "User")];
  for (const app of ["com.visualstudio.code", "com.vscodium.codium"]) dirs.push(join(env.home, ".var", "app", app, "config", flavor, "User"));
  return dirs;
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * The address the editor sends to: loopback names and 0.0.0.0 become 127.0.0.1, "::" and "::1" become [::1]. A listener
 * on one specific other address is not reachable the same way from the editor's settings, so there is no address.
 */
export function vscodeEndpoint(ingest: Pick<IngestConfig, "bind" | "port">): string | null {
  const bind = ingest.bind.trim().toLowerCase();

  if (bind === "localhost" || bind === "0.0.0.0" || bind.startsWith("127.")) return `http://127.0.0.1:${ingest.port}`;
  if (bind === "::" || bind === "::1") return `http://[::1]:${ingest.port}`;
  return null;
}

/** A setting the object has itself: "__proto__" and the like are no settings. */
const ownValue = (settings: Record<string, unknown>, key: string): unknown => (Object.hasOwn(settings, key) ? settings[key] : undefined);

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** The settings file as it was read. */
interface Snapshot {
  /** settings.json itself: backups go next to it. */
  link: string;
  /** The file settings are written to: a symlinked settings.json is followed. */
  target: string;
  exists: boolean;
  /** The file's bytes, which a backup copies. */
  bytes: Buffer;
  /** The text without a byte order mark. */
  text: string;
  bom: boolean;
  /** Changes when the file does, to notice an edit made while ours was being prepared. */
  signature: string | null;
}

/**
 * Whether settings.json lives elsewhere than where it seems to (a dotfiles repo, say): it, its User folder or the
 * editor's folder is a symlink, so writing it changes files outside the editor's own folders. Folders further up are
 * not looked at: system links like /tmp or /home would flag every path on some systems.
 */
export function isSymlinked(settingsPath: string): boolean {
  const user = dirname(settingsPath);

  for (const path of [settingsPath, user, dirname(user)]) {
    try {
      if (lstatSync(path).isSymbolicLink()) return true;
    } catch {
      // Not there (yet).
    }
  }
  return false;
}

function signatureOf(target: string): string | null {
  try {
    const s = statSync(target);
    return `${s.mtimeMs}:${s.size}`;
  } catch {
    return null;
  }
}

/**
 * The file behind settings.json. "unsuitable" when it is not a regular file of a sane size (a FIFO or device would block
 * or never end, a symlink to nowhere has nothing to edit), "failed" when it can't be read.
 */
function readSnapshot(settingsPath: string): Snapshot | "unsuitable" | "failed" {
  let target = settingsPath;
  const missing: Snapshot = { link: settingsPath, target, exists: false, bytes: Buffer.alloc(0), text: "", bom: false, signature: null };

  let link;
  try {
    link = lstatSync(settingsPath);
  } catch (err) {
    // Not there: to be created (a symlinked User folder is no reason to refuse, the caller asks for confirmation).
    return (err as NodeJS.ErrnoException).code === "ENOENT" ? missing : "failed";
  }

  if (link.isSymbolicLink()) {
    try {
      target = realpathSync(settingsPath);
    } catch {
      return "unsuitable";
    }
  }

  let fd: number | null = null;
  try {
    // Checked before opening: opening a FIFO for reading waits for a writer.
    const before = statSync(target);
    if (!before.isFile() || before.size > MAX_SETTINGS_BYTES) return "unsuitable";

    fd = openSync(target, "r");
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_SETTINGS_BYTES) return "unsuitable";

    const bytes = readFileSync(fd);
    const raw = bytes.toString("utf8");
    const bom = raw.startsWith("\uFEFF");
    return { link: settingsPath, target, exists: true, bytes, text: bom ? raw.slice(1) : raw, bom, signature: `${stat.mtimeMs}:${stat.size}` };
  } catch {
    return "failed";
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

/** The settings object a file holds, or null when it isn't one. An empty file counts as `{}`, as it does for the editor. */
function parseSettings(text: string): Record<string, unknown> | null {
  try {
    const errors: ParseError[] = [];
    const value: unknown = parse(text.trim() === "" ? "{}" : text, errors, { allowTrailingComma: true });
    return errors.length > 0 || !isObject(value) ? null : value;
  } catch {
    // Nested deeper than the parser goes.
    return null;
  }
}

/** The dotted prefixes of our keys, which the editor reads as nested objects: "github", "github.copilot", and so on. */
const PREFIXES = new Set<string>([...OTEL_KEYS, KEY_IGNORED].flatMap((key) => key.split(".").slice(0, -1).map((_, i, parts) => parts.slice(0, i + 1).join("."))));

/**
 * Whether the top-level object says anything about our settings in a way an edit would not reach: it names one of them
 * twice (the parser and the editor keep the last, an edit lands on the first), or sets them in a dotted form the editor
 * expands into the same settings: a value under a prefix of one ("github.copilot.chat": { "otel.enabled": true }) or a
 * key below one ("github.copilot.chat.otel.headers.Authorization"). Language overrides like "[python]" are none of that.
 */
function hasConflictingKeys(text: string): boolean {
  const root = parseTree(text.trim() === "" ? "{}" : text, [], { allowTrailingComma: true });
  if (root?.type !== "object") return false;

  const watched = new Set<string>([...OTEL_KEYS, KEY_IGNORED]);
  const seen = new Set<string>();
  for (const property of root.children ?? []) {
    const key = property.children?.[0]?.value;
    if (typeof key !== "string") continue;

    // "__proto__" would set the parsed object's prototype, not a setting.
    if (key === "__proto__") return true;

    // Whatever the editor would read as part of our settings: a prefix of one with any value, or a path below one.
    if (PREFIXES.has(key)) return true;
    if (key.startsWith(`${KEY_IGNORED}.`) || OTEL_KEYS.some((k) => key.startsWith(`${k}.`))) return true;
    if (!watched.has(key)) continue;

    if (seen.has(key)) return true;
    seen.add(key);
  }
  return false;
}

/** The settings of a snapshot, or the reason they can't be used. */
function settingsOf(snap: Snapshot): { settings: Record<string, unknown> } | { error: "unparsable" | "duplicate-keys" } {
  try {
    const settings = parseSettings(snap.text);
    if (!settings) return { error: "unparsable" };
    return hasConflictingKeys(snap.text) ? { error: "duplicate-keys" } : { settings };
  } catch {
    return { error: "unparsable" };
  }
}

/** The token a headers setting sends, if it sends a bearer one. */
function bearerToken(headers: unknown): string | null {
  if (!isObject(headers)) return null;

  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() !== "authorization" || typeof value !== "string") continue;
    return /^Bearer\s+(\S+)$/i.exec(value)?.[1] ?? null;
  }
  return null;
}

interface Ownership {
  enabled: boolean;
  /** An OTel endpoint is set at all. */
  hasEndpoint: boolean;
  /** The endpoint is this listener's current one. */
  atOurs: boolean;
  /** The headers carry a token this server made for VS Code. */
  knownToken: boolean;
  /**
   * Made by Connect VS Code, whatever has changed since: our endpoint, or a loopback one whose headers carry a token of
   * our format (a port that moved and a token that was revoked since still leave the config ours).
   */
  ours: boolean;
}

function ownership(settings: Record<string, unknown>, ingest: IngestConfig, auth: VscodeAuth): Ownership {
  const raw = ownValue(settings, KEY_ENDPOINT);
  const endpoint = typeof raw === "string" ? raw.trim().replace(/\/+$/, "") : null;

  const token = bearerToken(ownValue(settings, KEY_HEADERS));
  const knownToken = token !== null && auth.findToken(token)?.purpose === "vscode";
  const ourFormat = token !== null && INGEST_TOKEN_PATTERN.test(token);

  const atOurs = endpoint !== null && endpoint === vscodeEndpoint(ingest);
  const onLoopback = endpoint !== null && /^http:\/\/(127\.0\.0\.1|\[::1\]|localhost):\d+$/i.test(endpoint);

  return { enabled: ownValue(settings, KEY_ENABLED) === true, hasEndpoint: raw !== undefined, atOurs, knownToken, ours: atOurs || (onLoopback && (knownToken || ourFormat)) };
}

export function readState(flavor: FlavorInfo, auth: VscodeAuth, ingest: IngestConfig): VscodeState {
  // One editor's odd file must not break the rest: whatever goes wrong reading it, it is unusable.
  try {
    return stateOf(flavor, auth, ingest);
  } catch {
    return "unparsable";
  }
}

function stateOf(flavor: FlavorInfo, auth: VscodeAuth, ingest: IngestConfig): VscodeState {
  if (!flavor.installed) return "not-installed";

  const snap = readSnapshot(flavor.settingsPath);
  if (typeof snap === "string") return "unparsable";
  if (!snap.exists) return "off";

  const read = settingsOf(snap);
  if ("error" in read) return "unparsable";

  const own = ownership(read.settings, ingest, auth);
  if (!own.enabled) return "off";
  if (!own.ours) return "other-endpoint";

  return own.atOurs && own.knownToken ? "connected" : "stale";
}

/** The file's indentation and line ending, so an edit looks like the rest. */
function formatting(text: string): FormattingOptions {
  const eol = text.includes("\r\n") ? "\r\n" : text.includes("\n") ? "\n" : process.platform === "win32" ? "\r\n" : "\n";
  const indent = /^([\t ]+)"/m.exec(text)?.[1];

  if (indent?.startsWith("\t")) return { insertSpaces: false, tabSize: 4, eol };
  return { insertSpaces: true, tabSize: indent ? indent.length : 4, eol };
}

/** Sets (or, with undefined, removes) the value at `path`. With `insert`, the last path element is an array index to insert at. */
const edit = (text: string, path: (string | number)[], value: unknown, options: FormattingOptions, insert = false): string =>
  applyEdits(text, modify(text, path, value, { formattingOptions: options, isArrayInsertion: insert }));

/** The text with the six settings written and listed in Settings Sync's ignore list. */
function withConnection(text: string, options: FormattingOptions, values: Record<(typeof OTEL_KEYS)[number], unknown>): string {
  let next = text.trim() === "" ? "{}" : text;
  for (const key of OTEL_KEYS) next = edit(next, [key], values[key], options);

  const ignored = ownValue(parseSettings(next) ?? {}, KEY_IGNORED);
  if (!Array.isArray(ignored)) return edit(next, [KEY_IGNORED], [...OTEL_KEYS], options);

  let length = ignored.length;
  for (const key of OTEL_KEYS) {
    if (ignored.includes(key)) continue;
    next = edit(next, [KEY_IGNORED, length], key, options, true);
    length++;
  }
  return next;
}

/** The text without the six settings and their ignore entries: whatever else is there stays. */
function withoutConnection(text: string, options: FormattingOptions): string {
  let next = text;
  for (const key of OTEL_KEYS) {
    if (Object.hasOwn(parseSettings(next) ?? {}, key)) next = edit(next, [key], undefined, options);
  }

  const ignored = ownValue(parseSettings(next) ?? {}, KEY_IGNORED);
  if (!Array.isArray(ignored)) return next;

  const ours = new Set<unknown>(OTEL_KEYS);
  const indexes = ignored.flatMap((entry, i) => (ours.has(entry) ? [i] : []));
  for (const i of indexes.reverse()) next = edit(next, [KEY_IGNORED, i], undefined, options);

  if (indexes.length > 0 && indexes.length === ignored.length) next = edit(next, [KEY_IGNORED], undefined, options);
  return next;
}

/** Creates a file nobody else made first, readable by its owner only, and writes `data` into it. */
function createPrivate(path: string, data: string | Buffer): void {
  // "wx" fails on anything already there, a symlink included, instead of following it. On Windows it follows a
  // symlink that points nowhere and creates its target, so a name with anything at it is refused first.
  if (lstatSync(path, { throwIfNoEntry: false })) throw Object.assign(new Error(`${path} exists`), { code: "EEXIST" });
  const fd = openSync(path, "wx", 0o600);
  try {
    fchmodSync(fd, 0o600);
    writeFileSync(fd, data);
  } finally {
    closeSync(fd);
  }
}

/** Writes `next` over the file, after backing the old one up. "changed" when the file was edited since it was read. */
function commit(snap: Snapshot, next: string): "ok" | "changed" {
  // The temp file is in the target's folder, so the rename stays on one file system.
  const temp = join(dirname(snap.target), `.${basename(snap.target)}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);

  try {
    createPrivate(temp, (snap.bom ? "\uFEFF" : "") + next);

    if (signatureOf(snap.target) !== snap.signature) {
      rmSync(temp, { force: true });
      return "changed";
    }

    if (snap.exists) backUp(snap);
    renameSync(temp, snap.target);
    return "ok";
  } catch (err) {
    rmSync(temp, { force: true });
    throw err;
  }
}

/** Copies the file as it was to settings.json.harness-dashboard-<ms>.bak next to settings.json, owner-only, and keeps the newest few. */
function backUp(snap: Snapshot): void {
  const dir = dirname(snap.link);
  const name = basename(snap.link);
  const path = (stamp: number) => join(dir, `${name}${BACKUP_INFIX}${stamp}.bak`);

  // Thirteen digits of milliseconds sort by age, and a name that is taken (the same millisecond, or something planted) gets the next one.
  let stamp = Date.now();
  for (let tries = 0; ; tries++) {
    try {
      createPrivate(path(stamp), snap.bytes);
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST" || tries >= 20) throw err;
      stamp++;
    }
  }

  pruneBackups(dir, name, stamp);
}

/** Keeps the newest few of the backups made here. Best effort: the backup is made already, and the write goes on. */
function pruneBackups(dir: string, name: string, newest: number): void {
  // Only names this function makes, none newer than the one just made (a planted name can't push the new one out), and only files.
  const ours = new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}${BACKUP_INFIX.replace(/[.-]/g, "\\$&")}(\\d{13})\\.bak$`);

  let backups: string[];
  try {
    backups = readdirSync(dir)
      .filter((f) => {
        const made = ours.exec(f)?.[1];
        if (made === undefined || Number(made) > newest) return false;

        try {
          return lstatSync(join(dir, f)).isFile();
        } catch {
          return false;
        }
      })
      .sort();
  } catch {
    return;
  }

  for (const old of backups.slice(0, Math.max(0, backups.length - BACKUPS_KEPT))) {
    try {
      rmSync(join(dir, old), { force: true });
    } catch {
      // Left for the next time.
    }
  }
}

/**
 * Reads the file, checks it with `check`, and writes what `build` makes of it once `verify` agrees with the text read
 * back from it. The file is read again once when it was edited in between, and the write fails when it was edited again.
 */
function rewrite(
  flavor: FlavorInfo,
  confirmSymlink: boolean,
  check: (settings: Record<string, unknown>) => VscodeError | "skip" | null,
  build: (text: string, options: FormattingOptions) => string,
  verify: (written: Record<string, unknown>) => boolean,
): VscodeResult {
  for (let attempt = 0; attempt < 2; attempt++) {
    // Looked at again: the file may have become a link since the caller looked.
    if (!confirmSymlink && isSymlinked(flavor.settingsPath)) return { error: "symlinked" };

    const snap = readSnapshot(flavor.settingsPath);
    if (snap === "unsuitable") return { error: "unparsable" };
    if (snap === "failed") return { error: "write-failed" };

    const read = settingsOf(snap);
    if ("error" in read) return read;

    const refused = check(read.settings);
    if (refused === "skip") return { ok: true };
    if (refused) return { error: refused };

    let next: string;
    try {
      next = build(snap.text, formatting(snap.text));
    } catch {
      return { error: "write-failed" };
    }
    if (snap.exists && next === snap.text) return { ok: true };

    // What the editor will read from the new text must be what was meant, whatever the old text held.
    const written = parseSettings(next);
    if (!written || !verify(written)) return { error: "write-failed" };

    try {
      if (commit(snap, next) === "ok") return { ok: true };
    } catch {
      return { error: "write-failed" };
    }
  }
  return { error: "write-failed" };
}

/** Revokes a token and says whether that worked: a broken token file is no reason to fail what was written already. */
function revoke(auth: VscodeAuth, id: string): void {
  try {
    auth.revokeToken(id);
  } catch {
    // The token stays valid until it is revoked in Settings.
  }
}

/**
 * Makes a token for the editor and writes the six settings. A foreign OTel endpoint is only replaced with `overwrite`.
 * The previous tokens made for this editor are revoked once the file is written, the new one if it can't be.
 */
export function connect(flavor: FlavorInfo, auth: VscodeAuth, ingest: IngestConfig, opts: { overwrite?: boolean; confirmSymlink?: boolean } = {}): VscodeResult {
  try {
    return connectTo(flavor, auth, ingest, opts);
  } catch {
    return { error: "write-failed" };
  }
}

function connectTo(flavor: FlavorInfo, auth: VscodeAuth, ingest: IngestConfig, opts: { overwrite?: boolean; confirmSymlink?: boolean }): VscodeResult {
  if (!isDirectory(flavor.userDir)) return { error: "not-installed" };

  const endpoint = vscodeEndpoint(ingest);
  if (!endpoint) return { error: "not-local-bind" };

  if (isSymlinked(flavor.settingsPath) && !opts.confirmSymlink) return { error: "symlinked" };

  // Everything that can be refused is checked before a token is made.
  const probe = readSnapshot(flavor.settingsPath);
  if (probe === "unsuitable") return { error: "unparsable" };
  if (probe === "failed") return { error: "write-failed" };

  const read = settingsOf(probe);
  if ("error" in read) return read;
  if (foreign(read.settings, ingest, auth) && !opts.overwrite) return { error: "other-endpoint" };

  const previous = auth.vscodeTokens().filter((t) => t.flavor === flavor.id);

  const made = auth.addToken(`VS Code (${flavor.id})`, { purpose: "vscode", flavor: flavor.id });
  if ("error" in made) return { error: "write-failed" };

  const values = {
    [KEY_ENABLED]: true,
    [KEY_EXPORTER]: "otlp-http",
    [KEY_ENDPOINT]: endpoint,
    [KEY_HEADERS]: { Authorization: `Bearer ${made.token}` },
    [KEY_CONTENT]: false,
    [KEY_MAX_CHARS]: 64,
  };

  let result: VscodeResult;
  try {
    result = rewrite(
      flavor,
      opts.confirmSymlink === true,
      (settings) => (foreign(settings, ingest, auth) && !opts.overwrite ? "other-endpoint" : null),
      (text, options) => withConnection(text, options, values),
      (written) => {
        const ignored = ownValue(written, KEY_IGNORED);
        return OTEL_KEYS.every((key) => Object.hasOwn(written, key) && isDeepStrictEqual(ownValue(written, key), values[key])) && Array.isArray(ignored) && OTEL_KEYS.every((key) => ignored.includes(key));
      },
    );
  } catch {
    result = { error: "write-failed" };
  }

  if ("error" in result) {
    revoke(auth, made.item.id);
    return result;
  }

  for (const old of previous) revoke(auth, old.id);
  return result;
}

/** Another program's OTel export is on: enabled, and not set by Connect VS Code. */
function foreign(settings: Record<string, unknown>, ingest: IngestConfig, auth: VscodeAuth): boolean {
  const own = ownership(settings, ingest, auth);
  return own.enabled && !own.ours;
}

/** Takes the six settings out when they point at this app and, only then, revokes the editor's tokens. */
export function disconnect(flavor: FlavorInfo, auth: VscodeAuth, ingest: IngestConfig): VscodeResult {
  try {
    return disconnectFrom(flavor, auth, ingest);
  } catch {
    return { error: "write-failed" };
  }
}

function disconnectFrom(flavor: FlavorInfo, auth: VscodeAuth, ingest: IngestConfig): VscodeResult {
  if (!isDirectory(flavor.userDir)) return { error: "not-installed" };

  let removed = false;
  const result = rewrite(
    flavor,
    true,
    (settings) => {
      const own = ownership(settings, ingest, auth);
      removed = own.ours;
      if (own.ours) return null;

      // Settings Connect VS Code didn't write are none of its business: a foreign endpoint is refused, anything else skipped.
      return own.hasEndpoint ? "other-endpoint" : "skip";
    },
    (text, options) => withoutConnection(text, options),
    (written) => OTEL_KEYS.every((key) => !Object.hasOwn(written, key)),
  );
  if ("error" in result || !removed) return result;

  try {
    for (const token of auth.vscodeTokens()) if (token.flavor === flavor.id) revoke(auth, token.id);
  } catch {
    // As above.
  }
  return result;
}
