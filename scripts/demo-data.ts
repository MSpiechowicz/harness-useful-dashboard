/**
 * Writes a database of made-up usage for screenshots and demos: three people on a shared database, six projects,
 * Claude Code, Codex and omp sessions over the last ten weeks, and a busy last hour for the Live view.
 * Nothing in it comes from a real machine.
 *
 *   bun scripts/demo-data.ts /tmp/demo.db
 */
import { rmSync } from "node:fs";
import { openDb } from "../src/core/db.ts";
import type { Provider } from "../src/core/ingest/types.ts";
import { DbWriter, resolveSpawnRefs } from "../src/core/ingest/writer.ts";
import { PriceBook } from "../src/core/pricing.ts";

const out = process.argv[2];
if (!out) {
  console.error("usage: bun scripts/demo-data.ts <out.db>");
  process.exit(1);
}

// A seeded generator, so every run draws the same picture (shifted to end now).
let seed = 20261005;
const rand = () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const int = (lo: number, hi: number) => Math.floor(lo + rand() * (hi - lo + 1));
const pick = <T>(xs: readonly T[], weights?: readonly number[]): T => {
  if (!weights) return xs[Math.floor(rand() * xs.length)]!;
  let r = rand() * weights.reduce((a, b) => a + b, 0);
  for (let i = 0; i < xs.length; i++) if ((r -= weights[i]!) < 0) return xs[i]!;
  return xs[xs.length - 1]!;
};
const id = () => Array.from({ length: 4 }, () => Math.floor(rand() * 0xffffffff).toString(16).padStart(8, "0")).join("-");

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const NOW = Date.now();
const DAYS = 70;

const PROJECTS = [
  { path: "/Users/demo/code/storefront", weight: 5, files: ["src/routes/checkout.tsx", "src/components/Cart.tsx", "src/lib/pricing.ts", "src/routes/product/[id].tsx", "tests/checkout.spec.ts", "package.json"] },
  { path: "/Users/demo/code/billing-api", weight: 4, files: ["internal/invoice/service.go", "internal/invoice/handler.go", "internal/stripe/webhook.go", "migrations/0042_credits.sql", "cmd/api/main.go"] },
  { path: "/Users/demo/code/mobile-app", weight: 3, files: ["app/screens/Home.tsx", "app/screens/Orders.tsx", "app/api/client.ts", "app/hooks/useAuth.ts", "ios/Podfile"] },
  { path: "/Users/demo/code/data-pipeline", weight: 2, files: ["pipeline/ingest.py", "pipeline/transform.py", "dags/daily_rollup.py", "tests/test_transform.py", "pyproject.toml"] },
  { path: "/Users/demo/code/infra", weight: 1.5, files: ["modules/vpc/main.tf", "envs/prod/main.tf", "modules/db/variables.tf", ".github/workflows/deploy.yml"] },
  { path: "/Users/demo/code/docs-site", weight: 1, files: ["docs/getting-started.md", "docs/api/invoices.md", "astro.config.mjs", "src/components/Search.astro"] },
] as const;

const PROMPTS = [
  "Add pagination to the orders table",
  "Fix the flaky checkout test on CI",
  "Why is the invoice total off by one cent?",
  "Refactor the cart store to use signals",
  "Write a migration for prepaid credits",
  "Add retries with backoff to the Stripe webhook",
  "Explain how the daily rollup DAG is scheduled",
  "Speed up the product page, it takes 3 seconds to load",
  "Add dark mode to the settings screen",
  "Review this diff before I open the PR",
  "Bump the Terraform AWS provider and fix the plan",
  "Write docs for the invoices endpoint",
  "Find where we leak the auth token in logs",
  "Add an index for the slow orders query",
  "Turn this script into a CLI with flags",
  "Make the search box keyboard friendly",
  "Split the transform step into smaller functions",
  "Add unit tests for the pricing rules",
  "Upgrade React Native to the latest version",
  "Set up a preview deploy for pull requests",
];
const BRANCHES = ["main", "feat/prepaid-credits", "fix/checkout-flake", "feat/dark-mode", "chore/deps", "feat/search", "fix/rounding"];
const SKILLS = ["frontend-design", "code-review", "ship-pr", "db-migration"];
const AGENTS = ["Explore", "general-purpose", "test-runner"];
const TOOLS = [
  { name: "Read", file: true, w: 30 },
  { name: "Edit", file: true, w: 16 },
  { name: "Grep", file: false, w: 12 },
  { name: "Bash", file: false, w: 16 },
  { name: "Glob", file: false, w: 5 },
  { name: "Write", file: true, w: 4 },
  { name: "TodoWrite", file: false, w: 4 },
  { name: "WebFetch", file: false, w: 2 },
  { name: "mcp__github__create_pull_request", file: false, w: 1 },
];

/** Who works where, with what: each person has their own tools and habits. */
const PEOPLE = [
  { user: "alex", host: "alex-mbp", weight: 5, harness: [["claude", 6], ["codex", 2], ["omp", 1], ["pi", 1]] as [Provider, number][] },
  { user: "sam", host: "sam-desktop", weight: 3, harness: [["codex", 5], ["claude", 2], ["opencode", 1], ["cline", 1]] as [Provider, number][] },
  { user: "priya", host: "priya-laptop", weight: 2, harness: [["omp", 3], ["opencode", 2], ["claude", 2], ["zed", 1]] as [Provider, number][] },
];
const MODELS: Record<Provider, [string, number][]> = {
  claude: [["claude-opus-5-5", 5], ["claude-sonnet-5-5", 4], ["claude-haiku-4-5", 1]],
  codex: [["gpt-5-codex", 6], ["gpt-5", 3], ["gpt-5-mini", 1]],
  omp: [["claude-sonnet-5-5", 4], ["gpt-5", 3], ["claude-opus-5-5", 2]],
  pi: [["claude-sonnet-5-5", 3], ["gpt-5", 2]],
  opencode: [["claude-sonnet-5-5", 3], ["gpt-5-codex", 2]],
  cursor: [["claude-sonnet-5-5", 1]],
  zed: [["claude-sonnet-5-5", 3], ["gpt-5", 1]],
  cline: [["claude-sonnet-5-5", 2], ["claude-opus-5-5", 1]],
};
/** Output tokens per second each model usually streams at, for the drift view. */
const SPEED: Record<string, number> = {
  "claude-opus-5-5": 55, "claude-sonnet-5-5": 80, "claude-haiku-4-5": 140, "gpt-5-codex": 50, "gpt-5": 60, "gpt-5-mini": 120,
};
const EFFORT: Partial<Record<Provider, [string, number][]>> = {
  claude: [["high", 3], ["xhigh", 2]],
  codex: [["medium", 2], ["high", 3]],
  omp: [["high", 1]],
  pi: [["medium", 1]],
};
/** One model quietly gets slower and clumsier in the last days, so the drift view has something to flag. */
const DRIFTING = "claude-sonnet-5-5";
const DRIFT_DAYS = 6;
const BILLING: Record<string, [string, number][]> = {
  omp: [["github-copilot", 5], ["anthropic", 3], ["openai-codex", 2]],
  pi: [["anthropic", 3], ["openai-codex", 1]],
  opencode: [["anthropic", 2], ["github-copilot", 2], ["openai", 1]],
};

rmSync(out, { force: true });
const db = openDb(out, { isDefaultPath: false });
const prices = PriceBook.fromDb(db);
const writers = new Map(PEOPLE.map((p) => [p.user, new DbWriter(db, prices, { user: p.user, host: p.host })]));

/** One session: prompts one after another, each answered by a run of model calls with tool calls in between. */
function session(person: (typeof PEOPLE)[number], start: number, opts: { prompts?: number; pace?: number; provider?: Provider; until?: number } = {}): number {
  const w = writers.get(person.user)!;
  const provider = opts.provider ?? pick(person.harness.map((h) => h[0]), person.harness.map((h) => h[1]));
  const project = pick(PROJECTS, PROJECTS.map((p) => p.weight));
  const model = pick(MODELS[provider].map((m) => m[0]), MODELS[provider].map((m) => m[1]));
  const billing = BILLING[provider] ? pick(BILLING[provider]!.map((b) => b[0]), BILLING[provider]!.map((b) => b[1])) : null;
  const native = id();
  const sessionId = `${provider}:${native}`;
  const ago = (NOW - start) / DAY;
  const drifting = model === DRIFTING && ago < DRIFT_DAYS;
  const effort = EFFORT[provider] ? pick(EFFORT[provider]!.map((e) => e[0]), EFFORT[provider]!.map((e) => e[1])) : null;
  // Claude Code updated a little over two weeks ago: a client update marker on the drift charts.
  const clientVersion = provider === "claude" ? (ago < 16 ? "2.1.42" : "2.1.38") : provider === "codex" ? "0.150.0" : null;
  // A session still running at `until` keeps prompting up to that moment.
  const prompts = opts.until ? Infinity : (opts.prompts ?? int(2, 9));
  const pace = opts.pace ?? 1;
  let ts = start;
  let context = int(8_000, 20_000);
  const first = pick(PROMPTS);
  w.session({ id: sessionId, provider, nativeId: native, project: project.path, title: first, gitBranch: pick(BRANCHES), client: provider, clientVersion, startedAt: start });

  for (let p = 0; p < prompts && !(opts.until && ts >= opts.until); p++) {
    const promptId = `${sessionId}:p${p}`;
    const skill = rand() < 0.12 ? pick(SKILLS) : null;
    w.prompt({ id: promptId, sessionId, provider, ts, text: p === 0 ? first : pick(PROMPTS), skill, isCommand: false });
    const calls = int(3, 22);
    for (let c = 0; c < calls; c++) {
      const output = int(150, 2_500);
      // How long the response took to stream, and (where the harness measures it) the wait for its first token.
      const ttft = (drifting ? 2.2 : 1.2) * (0.6 + rand() * 0.8);
      const speed = (SPEED[model] ?? 60) * (drifting ? 0.62 : 1) * (0.8 + rand() * 0.4);
      const took = Math.round((ttft + output / speed) * 1000);
      const started = ts + int(1, 8) * 1000 * pace;
      ts = started + took;
      if (opts.until && ts > opts.until) break;
      const usageId = `${sessionId}:u${p}.${c}`;
      const write = c === 0 ? int(2_000, 12_000) : int(200, 3_000);
      w.usage({
        id: usageId, provider, sessionId, promptId, ts, project: project.path, model, skill, agent: "main", isSubagent: false,
        input: int(20, 900), output, cacheRead: context, cacheWrite: write, cacheWrite1h: 0, reasoning: provider === "codex" ? Math.round(output * 0.4) : 0,
        billing, premiumRequests: billing === "github-copilot" && c === 0 ? 1 : 0,
      });
      context += write + output;
      w.responseMeta({ usageId, startTs: started, endTs: ts, ttftMs: provider === "omp" || provider === "pi" ? Math.round(ttft * 1000) : null, effort });
      const tools = int(0, 3);
      for (let k = 0; k < tools; k++) {
        const tool = pick(TOOLS, TOOLS.map((x) => x.w));
        w.tool({
          id: `${usageId}:t${k}`, usageId, sessionId, promptId, provider, ts, project: project.path, tool: tool.name,
          filePath: tool.file ? `${project.path}/${pick(project.files)}` : null, skill, agent: "main",
        });
        const roll = rand();
        const kind = roll < (drifting ? 0.11 : 0.04) ? "tool_error" : roll < (drifting ? 0.12 : 0.05) ? "tool_rejected" : "tool_ok";
        w.outcome({ id: `${usageId}:t${k}`, provider, sessionId, ts, project: project.path, model, agent: "main", effort, kind });
      }
    }
    if (rand() < (drifting ? 0.06 : 0.025)) w.outcome({ id: `${promptId}:interrupt`, provider, sessionId, ts, project: project.path, model, agent: "main", effort, kind: "interrupt" });
    // Now and then a prompt hands work to a subagent with its own, smaller context.
    if (provider === "claude" && rand() < 0.25) {
      const agent = pick(AGENTS);
      const subId = `${sessionId}:agent-${p}`;
      const spawn = `${sessionId}:spawn-${p}`;
      w.tool({ id: spawn, usageId: `${sessionId}:u${p}.0`, sessionId, promptId, provider, ts, project: project.path, tool: "Task", filePath: null, skill, agent: "main" });
      w.session({ id: subId, provider, nativeId: `${native}-agent-${p}`, project: project.path, parentSessionId: sessionId, agent, startedAt: ts });
      let sub = int(6_000, 15_000);
      for (let c = 0; c < int(4, 14); c++) {
        ts += int(3, 15) * 1000 * pace;
        if (opts.until && ts > opts.until) break;
        const output = int(100, 1_200);
        w.usage({
          id: `${subId}:u${c}`, provider, sessionId: subId, promptId: null, ts, project: project.path, model: "claude-haiku-4-5", skill: null, agent,
          isSubagent: true, spawnRef: spawn, input: int(20, 400), output, cacheRead: sub, cacheWrite: int(300, 2_000), cacheWrite1h: 0, reasoning: 0,
        });
        sub += output + 1_000;
        w.tool({ id: `${subId}:t${c}`, usageId: `${subId}:u${c}`, sessionId: subId, promptId: null, provider, ts, project: project.path, tool: pick(["Read", "Grep", "Glob", "Bash"]), filePath: null, skill: null, agent, spawnRef: spawn });
      }
    }
    // Time to read the answer and write the next prompt.
    ts += int(1, 12) * MINUTE * pace;
  }
  w.session({ id: sessionId, provider, nativeId: native, endedAt: ts });
  return ts;
}

db.transaction(() => {
  // Ten weeks of work days: busier on weekdays and lately, quiet at night and on most weekends.
  for (let d = DAYS; d >= 1; d--) {
    const day = new Date(NOW - d * DAY);
    day.setHours(0, 0, 0, 0);
    const weekend = day.getDay() === 0 || day.getDay() === 6;
    const ramp = 0.6 + 0.6 * (1 - d / DAYS);
    for (const person of PEOPLE) {
      if (weekend && rand() > 0.25) continue;
      const sessions = Math.round((weekend ? 1 : int(1, 4)) * ramp * (person.weight / 4) + rand());
      for (let s = 0; s < sessions; s++) session(person, day.getTime() + int(8, 21) * HOUR + int(0, 59) * MINUTE);
    }
  }
  // The last hour, for the Live view: a Claude Code and a Codex session running side by side right now.
  session(PEOPLE[0]!, NOW - 58 * MINUTE, { provider: "claude", pace: 0.5, until: NOW - 20_000 });
  session(PEOPLE[1]!, NOW - 35 * MINUTE, { provider: "codex", pace: 0.4, until: NOW - 40_000 });
  // Codex's own reading of its plan limits, as it logs them.
  writers.get("sam")!.limit({ provider: "codex", windowId: "primary", windowMinutes: 300, usedPercent: 38, resetsAt: NOW + 2 * HOUR + 40 * MINUTE, plan: "pro", ts: NOW - 2 * MINUTE });
  writers.get("sam")!.limit({ provider: "codex", windowId: "secondary", windowMinutes: 10_080, usedPercent: 61, resetsAt: NOW + 3 * DAY, plan: "pro", ts: NOW - 2 * MINUTE });
})();
resolveSpawnRefs(db);
db.close();
console.log(`demo database written to ${out}`);
