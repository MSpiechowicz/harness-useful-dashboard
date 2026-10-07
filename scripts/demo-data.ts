/**
 * Writes a database of made-up usage for screenshots and demos: three people on a shared database, six projects,
 * Claude Code, Codex and omp sessions over the last ten weeks, and a busy last hour for the Live view.
 * Nothing in it comes from a real machine.
 *
 *   bun scripts/demo-data.ts /tmp/demo.db
 */
import { rmSync } from "node:fs";
import { openDb } from "../src/core/db.ts";
import { apiErrorOf } from "../src/core/apiErrors.ts";
import { failureOf } from "../src/core/failures.ts";
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

/**
 * The lines an Edit or Write changed. Worked out from the response's output and the call's place rather than drawn, so
 * the rest of the demo stays as it was: longer answers make bigger edits, and a Write adds a whole file. Zed logs no
 * edit text, so its edits count none.
 */
function demoLines(tool: string, output: number, k: number): { linesAdded: number; linesRemoved: number } | null {
  if (tool === "Edit") return { linesAdded: 1 + ((output * (k + 3)) % 37), linesRemoved: (output * (k + 7)) % 19 };
  if (tool === "Write") return { linesAdded: 20 + (output % 160), linesRemoved: 0 };
  return null;
}

/**
 * What a failed call said, per tool, and what it was given. Drawn from a generator of its own, so the rest of the
 * picture stays the same as before failures had reasons.
 */
let failSeed = 7;
const failRand = () => {
  failSeed = (Math.imul(failSeed, 1103515245) + 12345) | 0;
  return ((failSeed >>> 0) % 1_000_003) / 1_000_003;
};
const failPick = <T>(xs: readonly T[]): T => xs[Math.floor(failRand() * xs.length)]!;
const FAILURES: Record<string, string[]> = {
  Bash: [
    "npm test\tExit code 1\nFAIL tests/checkout.spec.ts\n  ● checkout › applies the coupon once\n    expect(received).toBe(expected)\n    Expected: 90\n    Received: 81",
    "go test ./...\tExit code 1\n--- FAIL: TestInvoiceTotals (0.00s)\n    service_test.go:42: got 1200, want 1180\nFAIL\tbilling-api/internal/invoice\t0.41s",
    "pnpm build\tExit code 2\nsrc/lib/pricing.ts(14,7): error TS2322: Type 'string' is not assignable to type 'number'.",
    "git push origin HEAD\tExit code 1\n ! [rejected]        HEAD -> feature/checkout (fetch first)\nerror: failed to push some refs to 'github.com:demo/storefront.git'",
    "npx playwright test\tCommand timed out after 2m 0.0s",
    "make lint\tExit code 127\nbash: line 1: golangci-lint: command not found",
    "npm install -g pnpm\tExit code 1\nnpm error code EACCES\nnpm error syscall mkdir\nnpm error path /usr/local/lib/node_modules\nnpm error Error: EACCES: permission denied",
  ],
  Edit: [
    "<tool_use_error>String to replace not found in file.\nString: const total = items.reduce((sum, i) => sum + i.price, 0)</tool_use_error>",
    "<tool_use_error>File has been modified since read, either by the user or by a linter. Read it again before attempting to write it.</tool_use_error>",
    "<tool_use_error>Found 3 matches of the string to replace, but replace_all is false. To replace all occurrences, set replace_all to true.</tool_use_error>",
  ],
  Read: [
    "File does not exist. Note: your current working directory is the project root.",
    "File does not exist. Note: your current working directory is the project root.",
    "File does not exist. Note: your current working directory is the project root.",
    "File content (31204 tokens) exceeds maximum allowed tokens (25000). Use offset and limit to read part of it.",
  ],
  Write: ["<tool_use_error>File has not been read yet. Read it first before writing to it.</tool_use_error>"],
  Grep: ["Ripgrep search timed out after 20 seconds", "rg: regex parse error:\n    applyCoupon(\n               ^\nerror: unclosed group"],
  Glob: ["<tool_use_error>InputValidationError: Glob failed due to the following issue: The required parameter `pattern` is missing</tool_use_error>"],
  TodoWrite: ["<tool_use_error>InputValidationError: TodoWrite failed due to the following issue: todos[2].status is required</tool_use_error>"],
  WebFetch: ["Request failed with status code 403 Forbidden", "Request to https://docs.stripe.com timed out after 60 seconds"],
  mcp__github__create_pull_request: ["MCP error -32603: Resource not accessible by integration (permission denied)", "Validation Failed: A pull request already exists for demo:feature/checkout."],
};
const DECLINED = "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). STOP what you are doing and wait for the user to tell you how to proceed.";
function demoFailure(kind: string, tool: string, file: string | null) {
  if (kind === "tool_ok" || kind === "interrupt") return {};
  // A command's failure names the command it ran ("command\terror").
  const [command, error] = tool === "Bash" ? failPick(FAILURES.Bash!).split("\t") : [null, failPick(FAILURES[tool] ?? ["Unexpected error"])];
  const input = command ?? file ?? (tool === "Grep" ? "applyCoupon" : tool === "WebFetch" ? "https://docs.stripe.com/api/credit_notes" : null);
  return failureOf(kind, tool, kind === "tool_rejected" ? DECLINED : error!, input, 2000);
}

/**
 * Model requests that failed, as each harness words them: drawn from a generator of their own too, so the rest of the
 * picture stays the same as before API errors were read.
 */
let apiSeed = 11;
const apiRand = () => {
  apiSeed = (Math.imul(apiSeed, 1103515245) + 12345) | 0;
  return ((apiSeed >>> 0) % 1_000_003) / 1_000_003;
};
const API_ERRORS: Partial<Record<Provider, [weight: number, message: string][]>> = {
  claude: [
    [5, 'API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}'],
    [3, 'API Error: 429 {"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed the rate limit for your organization of 80,000 output tokens per minute."}}'],
    [2, "API Error: Request timed out."],
    [1, 'API Error: 500 {"type":"error","error":{"type":"api_error","message":"Internal server error"}}'],
    [1, "API Error: Connection error."],
    [1, 'API Error: 400 {"type":"error","error":{"type":"invalid_request_error","message":"prompt is too long: 204512 tokens > 200000 maximum"}}'],
  ],
  codex: [
    [3, "stream disconnected before completion: error sending request for url (https://chatgpt.com/backend-api/codex/responses)"],
    [2, "exceeded retry limit, last status: 429 Too Many Requests"],
    [1, "You've hit your usage limit. Upgrade to Pro or try again in 2 hours."],
    [1, "unexpected status 503 Service Unavailable: upstream connect error or disconnect/reset before headers"],
  ],
  omp: [
    [2, "Codex error event: The usage limit has been reached (code=usage_limit_reached)"],
    [1, "getaddrinfo ENOTFOUND chatgpt.com"],
  ],
  opencode: [
    [2, "Provider returned error: 429 rate_limit_exceeded"],
    [1, "Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits."],
  ],
};
function demoApiError(provider: Provider, drifting: boolean) {
  const options = API_ERRORS[provider] ?? API_ERRORS.claude!;
  if (apiRand() >= (drifting ? 0.03 : 0.012)) return null;
  let r = apiRand() * options.reduce((a, [w]) => a + w, 0);
  const message = options.find(([w]) => (r -= w) < 0)?.[1] ?? options[0]![1];
  return apiErrorOf(null, null, message, 2000);
}

/** Who works where, with what: each person has their own tools and habits. */
const PEOPLE = [
  { user: "alex", host: "alex-mbp", weight: 5, harness: [["claude", 6], ["codex", 2], ["omp", 1], ["pi", 1]] as [Provider, number][] },
  { user: "sam", host: "sam-desktop", weight: 3, harness: [["codex", 5], ["claude", 2], ["opencode", 1], ["cline", 1], ["kilo", 1], ["gemini", 2]] as [Provider, number][] },
  { user: "priya", host: "priya-laptop", weight: 2, harness: [["omp", 3], ["opencode", 2], ["claude", 2], ["zed", 1], ["roo", 1], ["copilot", 2]] as [Provider, number][] },
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
  roo: [["claude-sonnet-5-5", 2], ["gpt-5", 1]],
  kilo: [["claude-sonnet-5-5", 1], ["gpt-5-codex", 1]],
  gemini: [["gemini-3.5-flash", 3], ["gemini-3.1-pro-preview", 2]],
  copilot: [["claude-sonnet-5-5", 3], ["gpt-5", 2]],
};
/** Output tokens per second each model usually streams at, for the drift view. */
const SPEED: Record<string, number> = {
  "claude-opus-5-5": 55, "claude-sonnet-5-5": 80, "claude-haiku-4-5": 140, "gpt-5-codex": 50, "gpt-5": 60, "gpt-5-mini": 120,
  "gemini-3.5-flash": 150, "gemini-3.1-pro-preview": 70,
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
  copilot: [["github-copilot", 1]],
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
      // Now and then the request failed first and was sent again.
      const failed = demoApiError(provider, drifting);
      if (failed) w.outcome({ id: `${usageId}:api`, provider, sessionId, ts: started - 2_000, project: project.path, model, agent: "main", effort, ...failed });
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
        const filePath = tool.file ? `${project.path}/${pick(project.files)}` : null;
        w.tool({ id: `${usageId}:t${k}`, usageId, sessionId, promptId, provider, ts, project: project.path, tool: tool.name, filePath, skill, agent: "main", ...(provider !== "zed" ? demoLines(tool.name, output, k) : null) });
        const roll = rand();
        const kind = roll < (drifting ? 0.11 : 0.04) ? "tool_error" : roll < (drifting ? 0.12 : 0.05) ? "tool_rejected" : "tool_ok";
        w.outcome({ id: `${usageId}:t${k}`, provider, sessionId, ts, project: project.path, model, agent: "main", effort, kind, ...demoFailure(kind, tool.name, filePath) });
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

/**
 * A Claude Code session handing work to subagents in parallel right now, as Claude Code logs it: each subagent's calls
 * are in the parent's own session, tied to the Agent call that started it and named by what that call asked.
 */
function fanOut() {
  const w = writers.get(PEOPLE[0]!.user)!;
  const native = id();
  const sessionId = `claude:${native}`;
  const project = PROJECTS[1];
  const start = NOW - 26 * MINUTE;
  const model = "claude-opus-5-5";
  w.session({ id: sessionId, provider: "claude", nativeId: native, project: project.path, title: "Audit the invoice service before the release", gitBranch: "release/2.4", client: "claude", clientVersion: "2.1.42", startedAt: start });
  const promptId = `${sessionId}:p0`;
  w.prompt({ id: promptId, sessionId, provider: "claude", ts: start, text: "Audit the invoice service before the release", skill: null, isCommand: false });
  // The main agent plans, starts the subagents, and waits on them.
  let ts = start;
  for (let c = 0; c < 6; c++) {
    ts += int(20, 50) * 1000;
    const usageId = `${sessionId}:u${c}`;
    w.usage({ id: usageId, provider: "claude", sessionId, promptId, ts, project: project.path, model, skill: null, agent: "main", isSubagent: false,
      input: int(20, 400), output: int(200, 1_500), cacheRead: 20_000 + c * 3_000, cacheWrite: int(500, 3_000), cacheWrite1h: 0, reasoning: 0 });
    w.responseMeta({ usageId, startTs: ts - 8_000, endTs: ts, stopReason: "tool_use" });
  }
  const RUNS: [string, string, number, number, boolean][] = [
    // agent, what it was asked, started and last active (minutes ago), stopped with a failed call
    ["Explore", "Map the invoice handlers and their callers", 22, 0.25, false],
    ["Explore", "Find every place credits are applied", 21, 0.6, false],
    ["general-purpose", "Review the 0042 credits migration", 20, 1, true],
    ["Plan", "Draft the rollout steps for the credits change", 19, 9, false],
    ["general-purpose", "Check the Stripe webhook retries and their backoff", 18, 12, true],
    ["Explore", "List the tests that touch invoices", 17, 14, false],
  ];
  RUNS.forEach(([agent, brief, from, to, failing], i) => {
    const spawn = `${sessionId}:spawn-${i}`;
    const spawnTs = NOW - from * MINUTE;
    w.tool({ id: spawn, usageId: `${sessionId}:u5`, sessionId, promptId, provider: "claude", ts: spawnTs, project: project.path, tool: "Agent", filePath: null, skill: null, agent: "main", brief });
    const end = NOW - to * MINUTE;
    let t = spawnTs;
    for (let c = 0; t < end; c++) {
      t = Math.min(end, t + int(25, 60) * 1000);
      const usageId = `${sessionId}:a${i}.${c}`;
      w.usage({ id: usageId, provider: "claude", sessionId, promptId: null, ts: t, project: project.path, model: "claude-sonnet-5-5", skill: null, agent,
        isSubagent: true, spawnRef: spawn, input: int(20, 300), output: int(100, 900), cacheRead: 8_000 + c * 1_500, cacheWrite: int(300, 1_500), cacheWrite1h: 0, reasoning: 0 });
      w.responseMeta({ usageId, startTs: t - 6_000, endTs: t, stopReason: t >= end && to > 2 ? "end_turn" : "tool_use" });
      const tool = pick(["Read", "Grep", "Glob", "Bash"]);
      const toolId = `${usageId}:t`;
      w.tool({ id: toolId, usageId, sessionId, promptId: null, provider: "claude", ts: t, project: project.path, tool, filePath: tool === "Read" ? `${project.path}/${pick(project.files)}` : null, skill: null, agent, spawnRef: spawn });
      const kind = failing && c % 8 === 3 ? "tool_error" : "tool_ok";
      w.outcome({ id: toolId, provider: "claude", sessionId, ts: t, project: project.path, model: "claude-sonnet-5-5", agent, kind, ...demoFailure(kind, tool, null) });
    }
  });
  w.session({ id: sessionId, provider: "claude", nativeId: native, endedAt: NOW - 15_000 });
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
  fanOut();
  // Codex's own reading of its plan limits, as it logs them.
  writers.get("sam")!.limit({ provider: "codex", windowId: "primary", windowMinutes: 300, usedPercent: 38, resetsAt: NOW + 2 * HOUR + 40 * MINUTE, plan: "pro", ts: NOW - 2 * MINUTE });
  writers.get("sam")!.limit({ provider: "codex", windowId: "secondary", windowMinutes: 10_080, usedPercent: 61, resetsAt: NOW + 3 * DAY, plan: "pro", ts: NOW - 2 * MINUTE });
})();
resolveSpawnRefs(db);
db.close();
console.log(`demo database written to ${out}`);
