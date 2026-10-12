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
  checkedAt: number;
  error?: string;
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

/** How long an answer from GitHub is reused before asking again. */
export const UPDATE_CHECK_MS = 5 * 60_000;

let cached: UpdateStatus | null = null;

export async function checkForUpdate(force = false): Promise<UpdateStatus> {
  // 5 minutes, so a release shows within minutes: at most 12 requests an hour however many windows are open, well inside
  // the 60 an hour GitHub allows without a token.
  if (!force && cached && Date.now() - cached.checkedAt < UPDATE_CHECK_MS) return cached;
  try {
    const rel = await fetchLatestRelease();
    cached = {
      current: VERSION,
      latest: rel.version,
      available: compareVersions(rel.version, VERSION) > 0,
      releaseUrl: rel.url,
      notes: rel.notes,
      checkedAt: Date.now(),
    };
  } catch (err) {
    cached = { current: VERSION, latest: null, available: false, releaseUrl: null, notes: null, checkedAt: Date.now(), error: (err as Error).message };
  }
  return cached;
}
