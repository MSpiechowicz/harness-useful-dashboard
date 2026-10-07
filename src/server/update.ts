import { chmodSync, existsSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { BIN_NAME, REPO, VERSION } from "../version.ts";

export interface ReleaseInfo {
  version: string;
  url: string;
  notes: string;
  publishedAt: string;
  assets: { name: string; url: string; size: number }[];
}

export interface UpdateStatus {
  current: string;
  latest: string | null;
  available: boolean;
  releaseUrl: string | null;
  notes: string | null;
  canSelfUpdate: boolean;
  checkedAt: number;
  error?: string;
}

/** Asset name for this platform, e.g. harness-dashboard-darwin-arm64 or harness-dashboard-windows-x64.exe. */
export function assetName(platform = process.platform, arch = process.arch): string {
  const os = platform === "win32" ? "windows" : platform;
  const cpu = arch === "arm64" ? "arm64" : "x64";
  return `${BIN_NAME}-${os}-${cpu}${platform === "win32" ? ".exe" : ""}`;
}

/** Compares dotted versions (ignores a leading "v" and any pre-release suffix ordering beyond numeric parts). */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => v.replace(/^v/, "").split(/[.-]/).map((x) => (/^\d+$/.test(x) ? Number(x) : x));
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x === y) continue;
    if (typeof x === "number" && typeof y === "number") return x - y;
    // A pre-release tag sorts before the release ("1.0.0-beta" < "1.0.0").
    if (typeof x === "string" && typeof y === "number") return -1;
    if (typeof x === "number" && typeof y === "string") return 1;
    return String(x).localeCompare(String(y));
  }
  return 0;
}

/** True when running as a `bun build --compile` binary (as opposed to `bun src/cli.ts`). */
export function isCompiledBinary(): boolean {
  return Bun.main.startsWith("/$bunfs/") || /[\\/]~BUN[\\/]/.test(Bun.main);
}

/**
 * Where the dashboard is installed. Once its file is replaced while it runs, Linux reports the running program as
 * "<path> (deleted)": the install path is still the one without that suffix.
 */
export function installedPath(execPath = process.execPath): string {
  return execPath.replace(/ \(deleted\)$/, "");
}

/** The version of the binary installed at `path`, which is newer than this process after an update from the CLI. */
export function installedVersion(path = installedPath()): string | null {
  try {
    const r = Bun.spawnSync([path, "version"], { stdout: "pipe", stderr: "ignore", timeout: 10_000 });
    const v = r.stdout.toString().trim();
    return r.exitCode === 0 && /^\d+\.\d+\.\d+/.test(v) ? v : null;
  } catch {
    return null;
  }
}

export async function fetchLatestRelease(fetchImpl: typeof fetch = fetch): Promise<ReleaseInfo> {
  const res = await fetchImpl(`https://api.github.com/repos/${REPO}/releases/latest`, {
    headers: { Accept: "application/vnd.github+json", "User-Agent": `${BIN_NAME}/${VERSION}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`GitHub API responded ${res.status}`);
  const r = (await res.json()) as {
    tag_name: string;
    html_url: string;
    body: string | null;
    published_at: string;
    assets: { name: string; browser_download_url: string; size: number }[];
  };
  return {
    version: r.tag_name.replace(/^v/, ""),
    url: r.html_url,
    notes: r.body ?? "",
    publishedAt: r.published_at,
    assets: r.assets.map((a) => ({ name: a.name, url: a.browser_download_url, size: a.size })),
  };
}

let cached: UpdateStatus | null = null;

export async function checkForUpdate(force = false): Promise<UpdateStatus> {
  // An hour, so a release shows within the hour the app checks again, well inside GitHub's 60 requests an hour.
  if (!force && cached && Date.now() - cached.checkedAt < 3600_000) return cached;
  try {
    const rel = await fetchLatestRelease();
    cached = {
      current: VERSION,
      latest: rel.version,
      available: compareVersions(rel.version, VERSION) > 0,
      releaseUrl: rel.url,
      notes: rel.notes,
      canSelfUpdate: isCompiledBinary() && rel.assets.some((a) => a.name === assetName()),
      checkedAt: Date.now(),
    };
  } catch (err) {
    cached = {
      current: VERSION, latest: null, available: false, releaseUrl: null, notes: null,
      canSelfUpdate: false, checkedAt: Date.now(), error: (err as Error).message,
    };
  }
  return cached;
}

async function sha256(buf: ArrayBuffer): Promise<string> {
  return new Bun.CryptoHasher("sha256").update(buf).digest("hex");
}

/**
 * Downloads the latest release binary for this platform, verifies it against checksums.txt and
 * atomically replaces the running executable. Returns the installed version.
 */
export async function applyUpdate(log: (msg: string) => void = () => {}): Promise<{ version: string; path: string }> {
  if (!isCompiledBinary()) throw new Error("Self-update only works for the installed binary. Use `git pull && bun run build` for source checkouts.");
  const target = installedPath();
  const rel = await fetchLatestRelease();
  if (compareVersions(rel.version, VERSION) <= 0) return { version: VERSION, path: target };
  // Already installed from the command line while this one kept running: restarting is all that's left.
  const onDisk = installedVersion(target);
  if (onDisk && compareVersions(onDisk, rel.version) >= 0) {
    log(`${onDisk} is already installed at ${target}`);
    return { version: onDisk, path: target };
  }
  const name = assetName();
  const asset = rel.assets.find((a) => a.name === name);
  if (!asset) throw new Error(`Release ${rel.version} has no asset named ${name}`);

  log(`Downloading ${name} (${(asset.size / 1e6).toFixed(1)} MB)…`);
  const res = await fetch(asset.url, { signal: AbortSignal.timeout(300_000) });
  if (!res.ok) throw new Error(`Download failed: HTTP ${res.status}`);
  const buf = await res.arrayBuffer();

  // Nothing is installed without a checksum to compare against.
  const sums = rel.assets.find((a) => a.name === "checksums.txt");
  if (!sums) throw new Error(`Release ${rel.version} has no checksums.txt, so ${name} can't be verified`);
  const sumsRes = await fetch(sums.url, { signal: AbortSignal.timeout(30_000) });
  if (!sumsRes.ok) throw new Error(`Download of checksums.txt failed: HTTP ${sumsRes.status}`);
  const expected = (await sumsRes.text()).split("\n").map((l) => l.trim().split(/\s+/)).find((p) => p[1]?.replace(/^\*/, "") === name)?.[0];
  if (!expected) throw new Error(`checksums.txt has no entry for ${name}`);
  const actual = await sha256(buf);
  if (actual !== expected) throw new Error(`Checksum mismatch for ${name}`);
  log("Checksum verified.");

  const dir = dirname(target);
  const tmp = join(dir, `.${BIN_NAME}.new`);
  writeFileSync(tmp, new Uint8Array(buf));
  if (process.platform !== "win32") chmodSync(tmp, 0o755);
  if (process.platform === "darwin") {
    // Keep Apple Silicon happy if the downloaded binary lost its signature.
    Bun.spawnSync(["codesign", "--force", "--sign", "-", tmp], { stdio: ["ignore", "ignore", "ignore"] });
  }
  if (process.platform === "win32") {
    // A running .exe can be renamed but not overwritten.
    const old = `${target}.old`;
    if (existsSync(old)) rmSync(old, { force: true });
    renameSync(target, old);
  }
  renameSync(tmp, target);
  log(`Installed ${rel.version} at ${target}`);
  return { version: rel.version, path: target };
}

/** Removes a leftover `<exe>.old` from a previous Windows update. */
export function cleanupOldBinary(): void {
  if (process.platform !== "win32" || !isCompiledBinary()) return;
  try {
    rmSync(`${installedPath()}.old`, { force: true });
  } catch {
    /* still locked; try again next start */
  }
}
