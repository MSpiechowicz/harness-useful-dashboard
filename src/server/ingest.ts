import { SQLiteError } from "bun:sqlite";
import { networkInterfaces } from "node:os";
import { type AppConfig, type IngestConfig, retentionMonths } from "../core/config.ts";
import { MAX_HOSTS, MAX_IDENTITIES } from "../core/otlp/map.ts";
import { decodeOtlp, MAX_BYTES, OtlpDecodeError, OtlpTooLarge, type SkipReason, writeOtlp, type WriteResult } from "../core/otlp/write.ts";
import { detailCutoff } from "../core/retention.ts";
import type { App } from "./app.ts";
import { type IngestAuth, IngestAuthBusy, type IngestCredential, signInKind } from "./ingestAuth.ts";

/**
 * The OTLP/HTTP listener remote agents send their usage to (Hermes over traces, Claude Code over logs). A server of its
 * own, apart from the dashboard's: it may listen on other networks, so it serves nothing but POST /v1/traces, /v1/logs
 * and /v1/metrics, each only with a token or the basic auth user (ingestAuth.ts), and gives no data out. Metrics are
 * taken and dropped: they carry nothing the logs and traces don't.
 *
 * A request goes through, in this order: path and method, sign-in (with limits on failures per address), content type
 * and encoding, whether the database may be written, then, MAX_RECEIVING requests at a time, the body's size on the
 * wire and inflated, decoding, writing. A body not read whole within BODY_TIMEOUT_MS is answered 408, so a sender
 * trickling it in never holds a place for long.
 *
 * Sign-ins are limited per address, an IPv6 one by its /64 (what one machine is given), and by what they try:
 * - A token is checked at once (its hash compared), and a valid one always passes. An address that sent MAX_FAILURES
 *   wrong ones in a minute gets 429 rather than 401 for the next wrong ones.
 * - Basic auth costs a password check (argon2, slow on purpose): an address may fail MAX_FAILURES a minute, with one
 *   check at a time, and every address together MAX_BASIC_FAILURES password checks a minute, past which basic auth
 *   answers 503 until the minute is over. A failure that checked no password (no basic auth user set, a header of no
 *   user and password) costs nothing and is never counted. Password checks are few at a time for every address
 *   together too (ingestAuth.ts). A header that passed a check a few minutes ago passes without one, and nothing holds
 *   it back.
 * - No sign-in, or one of no known form, gets 401 and is never counted: a web page posting at the listener can't lock
 *   anyone out.
 * An address is forgotten once its last failure is a minute old, or past MAX_ADDRESSES addresses that failed after
 * it. With at most MAX_BASIC_FAILURES password checks failing a minute (the only basic auth failures counted), an
 * address held back for its failed passwords is never pushed out by other addresses' failures while it waits.
 */

/** The largest body taken on the wire, and inflated from gzip (what the decoder takes). */
export const MAX_BODY = 4 * 1024 * 1024;
export const MAX_INFLATED = MAX_BYTES;
/** What Bun itself takes, a little over MAX_BODY: the check here answers with a 413 of its own. */
const SERVE_BODY_LIMIT = MAX_BODY + 64 * 1024;

/** Failed sign-ins an address may make within the window before it has to wait. */
const MAX_FAILURES = 10;
const FAILURE_WINDOW_MS = 60_000;
/** Addresses remembered with their failures, of each kind: past that, the one that failed longest ago is forgotten. */
const MAX_ADDRESSES = 10_000;
/** Failed password checks within the window, of every address together, before basic auth has to wait. */
const MAX_BASIC_FAILURES = 600;
/** What a sender is told to wait when the password checks are all busy, in seconds. */
const BUSY_RETRY_S = 5;
/** Requests whose bodies are read, inflated, decoded and written at once, and what one more is told to wait, in seconds. */
const MAX_RECEIVING = 4;
const RECEIVING_RETRY_S = 2;
/** How long a body may take to come in whole. */
const BODY_TIMEOUT_MS = 30_000;

/** Records skipped are told in the server log at most this often, with how many were since it last told. */
const SKIP_LOG_MS = 60_000;
/** Why records were skipped, as the server log tells it. */
const SKIP_WORDS: Record<SkipReason, string> = {
  hosts: `of new hosts past ${MAX_HOSTS} per credential`,
  identities: `of machines and users past ${MAX_IDENTITIES} per request`,
  time: "with no time or one out of range",
  other: "that are no remote usage (Claude Code spans, this machine's Claude Code logs, calls with no session)",
};

/** How often a listener that couldn't bind (port in use, address not there yet) tries again. */
const RETRY_BIND_MS = 30_000;

/** Open windows hear about new remote usage at most this often. */
const EMIT_MS = 2000;

const SIGNALS: Record<string, "traces" | "logs" | "metrics"> = { "/v1/traces": "traces", "/v1/logs": "logs", "/v1/metrics": "metrics" };

/** What the listener needs of the app. */
export type IngestApp = Pick<App, "cfg" | "db" | "identity" | "writable" | "priceBook" | "emit">;

export type IngestErrorCode = "in-use" | "address" | "port-conflict" | "other";

export interface IngestStatus {
  state: "off" | "listening" | "error";
  /** Where it listens: "127.0.0.1:4319", "[::]:4319". */
  address: string | null;
  error: IngestErrorCode | null;
  /** The system's own words for an error. */
  message: string | null;
  /** When it got into this state. */
  since: number;
}

/** What came in since the server started. */
export interface IngestStats {
  lastAt: number | null;
  lastHost: string | null;
  /** Usage rows written. */
  usage: number;
  /** Requests refused: not signed in, too large, not OTLP, and so on. */
  rejected: number;
  /** Metrics came in but no logs or traces: a sender set up for metrics only. */
  metricsOnly: boolean;
  /** Records of requests taken that were left out (mapBatch). */
  skipped: number;
  /** Why most records of the last request with skipped ones were left out, null before any was. */
  lastSkipReason: SkipReason | null;
  /** When a request from a vscode token (Connect VS Code) was last accepted, null before any was. */
  lastVscodeAt: number | null;
}

export interface IngestDeps {
  app: IngestApp;
  auth: IngestAuth;
  now?: () => number;
  /** Told each time the status changes: listening, an error, off. */
  onStatus?: (status: IngestStatus) => void;
  /** How often binding is tried again after the port was in use or the address not there. */
  retryBindMs?: number;
  /** How long a body may take to come in whole. */
  bodyTimeoutMs?: number;
}

/** Whether a bind address is reachable from this machine only. */
export function isLoopback(bind: string): boolean {
  return bind === "localhost" || bind === "::1" || bind.startsWith("127.");
}

/**
 * Whether a peer address is on this machine: 127.0.0.0/8, ::1, or an IPv4 loopback address mapped into IPv6. Anything
 * else, including "unknown" (no peer address known), is not.
 */
export function isLoopbackPeer(ip: string): boolean {
  const addr = ip.trim().toLowerCase().replace(/%.*$/, "");
  if (!addr.includes(":")) return /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.test(addr) && addr.split(".").every((n) => Number(n) <= 255);

  const groups = ipv6Groups(addr);
  if (!groups) return false;

  if (groups.slice(0, 7).every((g) => g === "0") && groups[7] === "1") return true;
  if (groups.slice(0, 5).every((g) => g === "0") && groups[5] === "ffff") return dottedIPv4(groups[6]!, groups[7]!).startsWith("127.");
  return false;
}

const hostPort = (host: string, port: number) => (host.includes(":") ? `[${host}]:${port}` : `${host}:${port}`);

/**
 * The key an address's sign-ins are counted under: an IPv4 address as it is (also one mapped into IPv6), an IPv6
 * address by its /64, since one machine is given a whole /64 and could change addresses within it at will.
 */
export function addressKey(ip: string): string {
  const addr = ip.trim().toLowerCase().replace(/%.*$/, "");
  if (!addr.includes(":")) return addr;

  const groups = ipv6Groups(addr);
  if (!groups) return addr;

  // An IPv4 address mapped into IPv6 (::ffff:1.2.3.4, also written in hex as ::ffff:102:304) is that IPv4 address.
  if (groups.slice(0, 5).every((g) => g === "0") && groups[5] === "ffff") return dottedIPv4(groups[6]!, groups[7]!);

  return `${groups.slice(0, 4).join(":")}::/64`;
}

/** Two IPv6 groups as the IPv4 address they hold ("102", "304" → 1.2.3.4). */
function dottedIPv4(high: string, low: string): string {
  const n = (parseInt(high, 16) << 16) | parseInt(low, 16);
  return [n >>> 24, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff].join(".");
}

/** The eight groups of an IPv6 address, written out ("2001:db8::1" → 2001, db8, 0, … 1), or null when it is none. */
function ipv6Groups(addr: string): string[] | null {
  const halves = addr.split("::");
  if (halves.length > 2) return null;

  const part = (s: string) => (s ? s.split(":") : []);
  const head = part(halves[0]!);
  const tail = halves.length === 2 ? part(halves[1]!) : [];
  // A dotted IPv4 tail (::ffff:1.2.3.4, 64:ff9b::1.2.3.4) is two groups.
  const last = tail.length ? tail : head;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(last[last.length - 1] ?? "");
  if (v4) {
    const [a, b, c, d] = v4.slice(1).map(Number) as [number, number, number, number];
    if (Math.max(a, b, c, d) > 255) return null;

    last.splice(last.length - 1, 1, ((a << 8) | b).toString(16), ((c << 8) | d).toString(16));
  }

  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;

  const groups = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill("0"), ...tail];
  if (!groups.every((g) => /^[0-9a-f]{1,4}$/.test(g))) return null;
  return groups.map((g) => g.replace(/^0+(?=.)/, ""));
}

function text(status: number, body: string, headers: Record<string, string> = {}): Response {
  return new Response(body, { status, headers: { "Content-Type": "text/plain; charset=utf-8", ...headers } });
}

/** What an exporter is told when the export was taken: an empty ExportServiceResponse in its own format. */
function accepted(format: "protobuf" | "json"): Response {
  if (format === "json") return new Response("{}", { headers: { "Content-Type": "application/json" } });

  return new Response(null, { headers: { "Content-Type": "application/x-protobuf" } });
}

function formatOf(contentType: string | null): "protobuf" | "json" | null {
  const type = (contentType ?? "").split(";")[0]!.trim().toLowerCase();
  if (type === "application/x-protobuf") return "protobuf";
  if (type === "application/json") return "json";
  return null;
}

/** A body that didn't come in whole within its time. */
class BodyTimeout extends Error {}

/**
 * A stream read whole, or null once it runs past `cap` bytes (it is cancelled then, nothing more is read). Throws
 * BodyTimeout when it isn't read whole within `timeoutMs`, cancelling it without waiting for it.
 */
async function readCapped(stream: ReadableStream<Uint8Array> | null, cap: number, timeoutMs = Infinity): Promise<Uint8Array | null> {
  if (!stream) return new Uint8Array(0);

  const reader = stream.getReader();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    if (Number.isFinite(timeoutMs)) timer = setTimeout(() => reject(new BodyTimeout()), timeoutMs);
  });
  // The deadline may pass while nothing waits on it: that is no unhandled rejection.
  expired.catch(() => {});

  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await Promise.race([reader.read(), expired]);
      if (done) break;

      size += value.length;
      if (size > cap) {
        await reader.cancel().catch(() => {});
        return null;
      }
      chunks.push(value);
    }
  } catch (err) {
    if (err instanceof BodyTimeout) reader.cancel().catch(() => {});
    throw err;
  } finally {
    clearTimeout(timer);
  }
  return Buffer.concat(chunks, size);
}

/** A gzip body inflated a chunk at a time, so a small body that inflates to gigabytes stops at the cap. Throws when it isn't gzip. */
function gunzip(body: Uint8Array): Promise<Uint8Array | null> {
  return readCapped(new Blob([body]).stream().pipeThrough(new DecompressionStream("gzip")), MAX_INFLATED);
}

const unauthorized = () => text(401, "unauthorized", { "WWW-Authenticate": 'Basic realm="harness-dashboard"' });
const tooMany = (waitS: number) => text(429, "too many failed sign-ins", { "Retry-After": String(waitS) });
const checksBusy = () => text(503, "busy checking passwords", { "Retry-After": String(BUSY_RETRY_S) });

/** Seconds until `first` is out of the window, at least 1. */
const waitFor = (first: number, now: number) => Math.max(1, Math.ceil((first + FAILURE_WINDOW_MS - now) / 1000));

/**
 * Failed sign-ins by address key, in a Map kept in the order the keys last failed: a failure moves its key to the end,
 * so the front holds the keys that failed longest ago. Keys whose last failure is past the window are swept from the
 * front as the log is used, and past `max` keys the one at the front is forgotten. Each step takes about the same
 * time however many keys there are.
 */
class FailureLog {
  private keys = new Map<string, number[]>();

  constructor(private max = MAX_ADDRESSES) {}

  /** Seconds `key` has to wait: 0 while it failed fewer than MAX_FAILURES times within the window. */
  wait(key: string, now: number): number {
    this.sweep(now);
    const recent = this.recent(key, now);
    return recent.length < MAX_FAILURES ? 0 : waitFor(recent[0]!, now);
  }

  add(key: string, now: number): void {
    this.sweep(now);
    const recent = this.recent(key, now);
    recent.push(now);

    this.keys.delete(key);
    if (this.keys.size >= this.max) this.keys.delete(this.keys.keys().next().value!);
    this.keys.set(key, recent.slice(-MAX_FAILURES));
  }

  private recent(key: string, now: number): number[] {
    return (this.keys.get(key) ?? []).filter((t) => now - t < FAILURE_WINDOW_MS);
  }

  /** Forgets the keys whose last failure is past the window: all at the front. */
  private sweep(now: number): void {
    for (const [key, times] of this.keys) {
      if (now - times[times.length - 1]! < FAILURE_WINDOW_MS) break;
      this.keys.delete(key);
    }
  }
}

/** Whether a bind address is one this machine listens on: any, loopback, or one of its interfaces. */
function ownAddress(bind: string): boolean {
  const host = bind.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || host === "0.0.0.0" || host === "::" || host === "::1" || host.startsWith("127.")) return true;
  return Object.values(networkInterfaces()).some((list) => list?.some((i) => i.address.toLowerCase() === host));
}

/**
 * Why Bun.serve couldn't listen. On macOS and Windows Bun reports every failed bind as EADDRINUSE, so a port "in use"
 * on an address this machine doesn't have is told as the address it is.
 */
export function bindError(err: unknown, bind: string): IngestErrorCode {
  const code = (err as { code?: unknown })?.code;
  if (code === "EADDRNOTAVAIL" || code === "ENOTFOUND" || code === "EINVAL") return "address";
  if (code === "EADDRINUSE") return ownAddress(bind) ? "in-use" : "address";
  return "other";
}

export class IngestServer {
  readonly auth: IngestAuth;
  private app: IngestApp;
  private now: () => number;
  private server: ReturnType<typeof Bun.serve> | null = null;
  /** The settings the server was last asked to listen with, and the address and port it listens on. */
  private config: IngestConfig | null = null;
  private boundTo: { bind: string; port: number } | null = null;
  private state: IngestStatus;

  /** Failed password checks by address key, and of every address together (the newest last). */
  private basicFailures = new FailureLog();
  private basicFailedAt: number[] = [];
  /** Wrong tokens by address key. */
  private tokenFailures = new FailureLog();
  /** The password check in progress of each address key, and the header it checks: one at a time each. */
  private signingIn = new Map<string, { header: string; check: Promise<IngestCredential | null> }>();
  /** Requests reading, decoding or writing a body now, and how long a body may take to come in. */
  private receiving = 0;
  private bodyTimeoutMs: number;

  private onStatus: (status: IngestStatus) => void;
  private retryBindMs: number;
  /** The next try to bind, after the port was in use or the address not there. */
  private retryTimer: ReturnType<typeof setTimeout> | null = null;

  private lastAt: number | null = null;
  private lastHost: string | null = null;
  private usage = 0;
  private rejected = 0;
  private metricsSeen = false;
  private dataSeen = false;
  private skipped = 0;
  private lastSkipReason: SkipReason | null = null;
  private lastVscodeAt: number | null = null;
  /** Records skipped that the server log hasn't told of yet, by reason, and when it last did. */
  private unloggedSkips: Partial<Record<SkipReason, number>> = {};
  private skipsLoggedAt: number | null = null;

  /** What open windows haven't heard of yet, and when they last did. */
  private pending = { usage: 0, prompts: 0, tools: 0 };
  private emittedAt = 0;
  private emitTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(deps: IngestDeps) {
    this.app = deps.app;
    this.auth = deps.auth;
    this.now = deps.now ?? Date.now;
    this.onStatus = deps.onStatus ?? (() => {});
    this.retryBindMs = deps.retryBindMs ?? RETRY_BIND_MS;
    this.bodyTimeoutMs = deps.bodyTimeoutMs ?? BODY_TIMEOUT_MS;
    this.state = { state: "off", address: null, error: null, message: null, since: this.now() };
  }

  /**
   * Listens as the settings say: starts, stops or moves the server. Never throws: a server that can't listen says why
   * in its status. The dashboard's own port is refused before anything is tried. A port in use or an address not
   * there (yet) is tried again every retryBindMs, until it binds or the settings change.
   */
  reconcile(cfg: AppConfig, dashboardPort: number): IngestStatus {
    const c = cfg.ingest;
    this.config = { ...c };
    this.cancelRetry();

    if (!c.enabled) {
      this.close();
      this.setState({ state: "off", address: null, error: null, message: null });
      return this.status();
    }

    if (c.port === dashboardPort) {
      this.close();
      this.setState({ state: "error", address: null, error: "port-conflict", message: null });
      return this.status();
    }

    if (this.server && this.boundTo?.bind === c.bind && this.boundTo.port === c.port) return this.status();

    this.listen(c);
    return this.status();
  }

  /** Binds to the settings' address and port, or says why it can't, and tries again later when that may pass. */
  private listen(c: IngestConfig): void {
    this.close();
    try {
      this.server = Bun.serve({
        hostname: c.bind,
        port: c.port,
        maxRequestBodySize: SERVE_BODY_LIMIT,
        idleTimeout: 30,
        fetch: (req, server) => this.handle(req, server.requestIP(req)?.address ?? "unknown"),
      });
      this.boundTo = { bind: c.bind, port: c.port };
      this.setState({ state: "listening", address: hostPort(c.bind, this.server.port ?? c.port), error: null, message: null });
    } catch (err) {
      this.server = null;
      const error = bindError(err, c.bind);
      this.setState({ state: "error", address: null, error, message: (err as Error)?.message ?? String(err) });
      if (error === "in-use" || error === "address") this.retryLater(c);
    }
  }

  private retryLater(c: IngestConfig): void {
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (this.config?.enabled) this.listen(c);
    }, this.retryBindMs);
    // A retry alone doesn't keep the process running.
    this.retryTimer.unref?.();
  }

  private cancelRetry(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  /** Stops listening: the shutdown, or the listener turned off. */
  stop(): void {
    this.cancelRetry();
    this.close();
    this.setState({ state: "off", address: null, error: null, message: null });
  }

  status(): IngestStatus {
    return { ...this.state };
  }

  stats(): IngestStats {
    return {
      lastAt: this.lastAt,
      lastHost: this.lastHost,
      usage: this.usage,
      rejected: this.rejected,
      metricsOnly: this.metricsSeen && !this.dataSeen,
      skipped: this.skipped,
      lastSkipReason: this.lastSkipReason,
      lastVscodeAt: this.lastVscodeAt,
    };
  }

  /**
   * The addresses a remote agent can send to: the bind address, or for every network (0.0.0.0, ::) each address this
   * machine has on one, IPv4 first. Link-local IPv6 addresses are left out: they only work with the interface named.
   */
  endpoints(): string[] {
    const { bind, port: wanted } = this.config ?? this.app.cfg.ingest;
    const port = this.server?.port ?? wanted;
    if (bind !== "0.0.0.0" && bind !== "::") return [`http://${hostPort(bind, port)}`];

    const v4: string[] = [];
    const v6: string[] = [];
    for (const list of Object.values(networkInterfaces())) {
      for (const a of list ?? []) {
        if (a.internal) continue;

        const family = String(a.family);
        if (family === "IPv4" || family === "4") v4.push(a.address);
        else if (bind === "::" && !a.address.toLowerCase().startsWith("fe80:")) v6.push(a.address);
      }
    }
    return [...v4, ...v6].map((a) => `http://${hostPort(a, port)}`);
  }

  /** Answers one request from `ip`. Kept apart from the server so tests can call it. */
  async handle(req: Request, ip: string): Promise<Response> {
    let res: Response;
    try {
      res = await this.respond(req, ip);
    } catch (err) {
      console.error("[ingest]", err);
      res = text(500, "internal error");
    }

    if (res.status >= 400 && res.status !== 404) this.rejected++;
    return res;
  }

  private async respond(req: Request, ip: string): Promise<Response> {
    const signal = SIGNALS[new URL(req.url).pathname];
    if (!signal) return text(404, "not found");
    if (req.method !== "POST") return text(405, "method not allowed", { Allow: "POST" });

    const cred = await this.signIn(req.headers.get("authorization"), ip);
    if (cred instanceof Response) return cred;

    const format = formatOf(req.headers.get("content-type"));
    if (!format) return text(415, "expected application/x-protobuf or application/json");
    const encoding = (req.headers.get("content-encoding") ?? "identity").trim().toLowerCase();
    if (encoding !== "identity" && encoding !== "gzip") return text(415, "expected gzip or no content encoding");

    // A database a newer app migrated is read-only for this one: the exporter keeps its data and tries again later.
    if (!this.app.writable()) return text(409, "database-newer");

    if (Number(req.headers.get("content-length")) > MAX_BODY) return text(413, "body too large");

    // A few bodies at a time: each one held inflated and decoded takes memory and time.
    if (this.receiving >= MAX_RECEIVING) return text(503, "busy receiving", { "Retry-After": String(RECEIVING_RETRY_S) });
    this.receiving++;
    try {
      return await this.receive(req, signal, format, encoding, cred, ip);
    } finally {
      this.receiving--;
    }
  }

  /** Reads, inflates, decodes and writes a body that passed the checks of `respond`. */
  private async receive(
    req: Request,
    signal: "traces" | "logs" | "metrics",
    format: "protobuf" | "json",
    encoding: string,
    cred: IngestCredential,
    ip: string,
  ): Promise<Response> {
    let wire: Uint8Array | null;
    try {
      wire = await readCapped(req.body, MAX_BODY, this.bodyTimeoutMs);
    } catch (err) {
      if (err instanceof BodyTimeout) return text(408, "body not received in time");
      throw err;
    }
    if (!wire) return text(413, "body too large");

    let body = wire;
    if (encoding === "gzip") {
      let inflated: Uint8Array | null;
      try {
        inflated = await gunzip(wire);
      } catch {
        return text(400, "invalid gzip body");
      }
      if (!inflated) return text(413, "inflated body too large");
      body = inflated;
    }

    if (signal === "metrics") {
      this.metricsSeen = true;
      this.noteVscode(cred);
      return accepted(format);
    }

    let batch;
    try {
      batch = decodeOtlp(signal, body, format);
    } catch (err) {
      if (err instanceof OtlpTooLarge) return text(413, err.message);
      if (err instanceof OtlpDecodeError) return text(400, err.message);
      throw err;
    }

    let result: WriteResult;
    try {
      result = this.write(batch, cred, ip);
    } catch (err) {
      if (!(err instanceof SQLiteError)) throw err;
      // Locked by another machine on a shared database, or the disk is full: worth another try.
      console.error("[ingest]", err.message);
      return text(503, "database unavailable", { "Retry-After": "10" });
    }

    this.dataSeen = true;
    this.lastAt = this.now();
    this.noteVscode(cred);
    if (result.hosts.length) this.lastHost = result.hosts[result.hosts.length - 1]!;
    this.usage += result.usage;
    if (result.skipped) this.noteSkipped(result.skippedFor);
    if (result.usage || result.prompts || result.tools) this.changed(result);
    return accepted(format);
  }

  /** Notes the time of an accepted request from a vscode token, for Settings to show. */
  private noteVscode(cred: IngestCredential): void {
    if (cred.purpose === "vscode") this.lastVscodeAt = this.now();
  }

  /**
   * Counts a request's skipped records, takes the reason most of them were skipped for as the last one, and tells the
   * server log of the records skipped since it last did, at most every SKIP_LOG_MS.
   */
  private noteSkipped(skippedFor: WriteResult["skippedFor"]): void {
    let most = 0;
    for (const [reason, n] of Object.entries(skippedFor) as [SkipReason, number][]) {
      this.skipped += n;
      this.unloggedSkips[reason] = (this.unloggedSkips[reason] ?? 0) + n;
      if (n > most) {
        most = n;
        this.lastSkipReason = reason;
      }
    }

    const now = this.now();
    if (this.skipsLoggedAt != null && now - this.skipsLoggedAt < SKIP_LOG_MS) return;

    const told = Object.entries(this.unloggedSkips) as [SkipReason, number][];
    const total = told.reduce((sum, [, n]) => sum + n, 0);
    const reasons = told.map(([reason, n]) => `${n} ${SKIP_WORDS[reason]}`).join(", ");
    console.warn(`[ingest] Skipped ${total} ${total === 1 ? "record" : "records"}: ${reasons}`);
    this.skipsLoggedAt = now;
    this.unloggedSkips = {};
  }

  /**
   * Writes an export with this machine's settings: prompt text only when kept, and no detail older than retention keeps.
   * An export from a vscode token over loopback is VS Code on this machine: it is written as this machine's own.
   */
  private write(batch: ReturnType<typeof decodeOtlp>, cred: IngestCredential, ip: string): WriteResult {
    const cfg = this.app.cfg;
    const { host, user } = this.app.identity;
    const local = cred.purpose === "vscode" && isLoopbackPeer(ip) ? { host, user } : null;
    const opts = {
      storeText: cfg.ingest.storeText,
      promptTextLimit: cfg.promptTextLimit,
      detailBefore: detailCutoff(retentionMonths(cfg.detailRetentionMonths)) ?? 0,
      localHost: host,
      local,
    };
    return writeOtlp(this.app.db, this.app.priceBook(), batch, cred, opts);
  }

  /** Tells open windows about new usage like a scan does, at most every EMIT_MS: what comes in between goes with the next. */
  private changed(r: WriteResult): void {
    this.pending.usage += r.usage;
    this.pending.prompts += r.prompts;
    this.pending.tools += r.tools;
    if (this.emitTimer) return;

    const wait = this.emittedAt + EMIT_MS - this.now();
    if (wait <= 0) return this.flush();
    this.emitTimer = setTimeout(() => this.flush(), wait);
  }

  private flush(): void {
    this.emitTimer = null;
    this.emittedAt = this.now();
    const { usage, prompts, tools } = this.pending;
    this.pending = { usage: 0, prompts: 0, tools: 0 };
    this.app.emit({ type: "scan", result: { filesSeen: 0, filesParsed: 1, usageRows: usage, prompts, tools, errors: [], durationMs: 0 } });
  }

  /** Who sent a request from the address `ip`, or the response that refuses it (see the top of this file). */
  private async signIn(header: string | null, ip: string): Promise<IngestCredential | Response> {
    const kind = signInKind(header);
    if (kind === "token") return this.tokenSignIn(header!, ip);
    if (kind === "basic") return this.basicSignIn(header!, addressKey(ip));
    return unauthorized();
  }

  /**
   * A token: a valid one always passes, a wrong one is counted against the address's wrong tokens. A vscode token is
   * for VS Code on this machine only: from any other address it is refused like a wrong one.
   */
  private async tokenSignIn(header: string, ip: string): Promise<IngestCredential | Response> {
    const key = addressKey(ip);
    const cred = await this.auth.authenticate(header);
    if (cred && (cred.purpose !== "vscode" || isLoopbackPeer(ip))) return cred;

    const now = this.now();
    const wait = this.tokenFailures.wait(key, now);
    if (wait > 0) return tooMany(wait);

    this.tokenFailures.add(key, now);
    return unauthorized();
  }

  /**
   * Basic auth: a header that passed a check lately passes at once. Otherwise a password check, one at a time per
   * address, so a burst can't run past the failure limit: the same header sent again meanwhile (an exporter sending
   * logs and traces at once) takes that check's answer, another one gets 429.
   */
  private async basicSignIn(header: string, key: string): Promise<IngestCredential | Response> {
    const cached = this.auth.cachedBasic(header);
    if (cached) return cached;

    const now = this.now();
    const wait = this.basicFailures.wait(key, now);
    if (wait > 0) return tooMany(wait);

    const running = this.signingIn.get(key);
    if (running && running.header !== header) return text(429, "a sign-in from this address is in progress", { "Retry-After": "1" });

    const allWait = this.basicWaitAll(now);
    if (!running && allWait > 0) return text(503, "too many failed sign-ins", { "Retry-After": String(allWait) });

    let cred: IngestCredential | null;
    try {
      cred = await (running?.check ?? this.checkPassword(header, key));
    } catch (err) {
      if (err instanceof IngestAuthBusy) return checksBusy();
      throw err;
    }
    return cred ?? unauthorized();
  }

  /** Checks a basic auth header, noted as the address's check in progress, its failure counted once. */
  private checkPassword(header: string, key: string): Promise<IngestCredential | null> {
    const check = this.auth
      .checkBasic(header)
      .then(({ cred, checked }) => {
        if (!cred) this.basicFailed(key, checked);
        return cred;
      })
      .finally(() => this.signingIn.delete(key));
    this.signingIn.set(key, { header, check });
    return check;
  }

  /**
   * Counts a failed password check against its address and against every address together. A failure that checked no
   * password costs nothing and isn't counted: a flood of them can't push out an address held back for its passwords.
   */
  private basicFailed(key: string, checked: boolean): void {
    if (!checked) return;

    const now = this.now();
    this.basicFailures.add(key, now);
    this.basicFailedAt.push(now);
    if (this.basicFailedAt.length > MAX_BASIC_FAILURES) this.basicFailedAt.shift();
  }

  /** Seconds basic auth has to wait for every address: 0 while all of them failed fewer than MAX_BASIC_FAILURES checks in the window. */
  private basicWaitAll(now: number): number {
    while (this.basicFailedAt.length && now - this.basicFailedAt[0]! >= FAILURE_WINDOW_MS) this.basicFailedAt.shift();
    return this.basicFailedAt.length < MAX_BASIC_FAILURES ? 0 : waitFor(this.basicFailedAt[0]!, now);
  }

  private setState(next: Omit<IngestStatus, "since">): void {
    const s = this.state;
    const same = s.state === next.state && s.address === next.address && s.error === next.error && s.message === next.message;
    if (same) return;

    this.state = { ...next, since: this.now() };
    this.onStatus(this.status());
  }

  /** Closes the server. What open windows haven't heard of yet is told now. */
  private close(): void {
    this.server?.stop(true);
    this.server = null;
    this.boundTo = null;
    if (this.emitTimer) {
      clearTimeout(this.emitTimer);
      this.flush();
    }
  }
}
