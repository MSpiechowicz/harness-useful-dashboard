# Harness Dashboard

**Token usage across your AI coding tools, in one local app.** Harness Dashboard reads the sessions that
Claude Code, Codex, OpenCode, pi, omp (oh-my-pi), Zed and the Cline, Roo Code and Kilo Code extensions already write to
disk, plus Cursor usage exports. It stores
everything in a local SQLite database and shows clear, interactive charts of where your tokens and money go.

- **Overall usage**: tokens, API-equivalent cost, sessions, prompts and cache hit rate, compared with the previous period
- **By project, user, model, provider, skill, agent, session and prompt**: every dimension is a filter
- **Trends**: hourly/daily/weekly/monthly series, a 7-day moving average, cumulative spend, peak day and a 30-day projection
- **Per-prompt cost analytics**: what each request really consumed, call by call, including the subagents it spawned
- **Tool and file heatmaps**: tools × projects, tools × hour of day, and the files that get read or edited most
- **Subagent attribution**: Claude Code subagents, Codex spawned/guardian threads, OpenCode subagent sessions and omp subagents are tied back to the spawning prompt or parent session
- **Billed via**: which plan or account usage ran through (a ChatGPT plan, GitHub Copilot with its premium requests, an API key)
- **Cache analytics**: hit rate over time, money saved by caching, and what cache writes cost
- **Branches**: what each piece of work cost, per git branch, with its sessions and the files it changed
- **Time**: how long the agents worked, how many sessions ran at once, and the cost per active hour
- **Friction**: failed and declined tool calls and interrupted prompts, by tool, model and session
- **Plans**: what each subscription is worth at API prices against what you pay, and how full its limits got over time
- **Rule-based tips**: low cache hit rate, context bloat, premium models on small prompts, tool loops, spikes, and more
- **Live view**: tokens per minute as you work, the sessions running right now, and how much of your plan limits is left
  (Claude's 5-hour and weekly limits, Codex, and every plan omp is logged in to, such as GitHub Copilot)
- **Budgets and alerts**: daily, monthly and per-project spending caps, with desktop notifications at 80% and 100% and when a plan limit is 80% used
- **Export**: every table and chart's data as CSV or JSON, following the current filters
- **Claude Code status line**: this session's cost, today's cost and the 5-hour limit, right in Claude Code
- **English, German, Spanish, French and Polish UI** (English by default), light and dark themes, responsive layout
- **Shared database**: point several machines at one SQLite file on iCloud Drive, Dropbox, OneDrive or a network share

Everything runs locally. Your usage is never uploaded anywhere.

![Overview: cost and token KPIs, usage over time by token type, top projects and models](docs/screenshots/overview.png)

![Overview, further down: provider split, when you work, your rhythm and the daily activity calendar](docs/screenshots/overview-activity.png)

<table>
  <tr>
    <td width="50%"><img src="docs/screenshots/live.png" alt="Live: tokens per minute, plan limits left and the sessions running now"><br><sub><b>Live</b>: tokens per minute, plan limits left and the sessions running now</sub></td>
    <td width="50%"><img src="docs/screenshots/trends.png" alt="Trends: daily usage, a moving average and the running total"><br><sub><b>Trends</b>: daily usage, a moving average and the running total</sub></td>
  </tr>
  <tr>
    <td width="50%"><img src="docs/screenshots/projects.png" alt="Projects: where the tokens go, project by project"><br><sub><b>Projects</b>: where the tokens go, project by project</sub></td>
    <td width="50%"><img src="docs/screenshots/models.png" alt="Models: which models do the work and what they cost"><br><sub><b>Models</b>: which models do the work and what they cost</sub></td>
  </tr>
  <tr>
    <td colspan="2"><img src="docs/screenshots/model-drift.png" alt="Model drift: whether a model got slower or clumsier than it usually is"><br><sub><b>Model drift</b>: whether a model got slower or clumsier than it usually is</sub></td>
  </tr>
  <tr>
    <td width="50%"><img src="docs/screenshots/providers.png" alt="Providers: Claude Code, Codex, omp, OpenCode and pi side by side"><br><sub><b>Providers</b>: Claude Code, Codex, omp, OpenCode and pi side by side</sub></td>
    <td width="50%"><img src="docs/screenshots/users.png" alt="Users: everyone on a shared database"><br><sub><b>Users</b>: everyone on a shared database</sub></td>
  </tr>
  <tr>
    <td width="50%"><img src="docs/screenshots/skills.png" alt="Skills: what each skill costs from the moment it's invoked"><br><sub><b>Skills</b>: what each skill costs from the moment it's invoked</sub></td>
    <td width="50%"><img src="docs/screenshots/agents.png" alt="Agents: main sessions against the subagents they start"><br><sub><b>Agents</b>: main sessions against the subagents they start</sub></td>
  </tr>
  <tr>
    <td width="50%"><img src="docs/screenshots/sessions.png" alt="Sessions: cost against tokens per session, and every session"><br><sub><b>Sessions</b>: cost against tokens per session, and every session</sub></td>
    <td width="50%"><img src="docs/screenshots/session-detail.png" alt="Session detail: every model call, prompt and spawned agent of one session"><br><sub><b>Session detail</b>: every model call, prompt and spawned agent of one session</sub></td>
  </tr>
  <tr>
    <td width="50%"><img src="docs/screenshots/prompts.png" alt="Prompts: what each request really cost, and where the spend concentrates"><br><sub><b>Prompts</b>: what each request really cost, and where the spend concentrates</sub></td>
    <td width="50%"><img src="docs/screenshots/prompt-detail.png" alt="Prompt detail: one prompt call by call, subagents included"><br><sub><b>Prompt detail</b>: one prompt call by call, subagents included</sub></td>
  </tr>
  <tr>
    <td width="50%"><img src="docs/screenshots/tools.png" alt="Tools: most used tools by project, and the kinds of work they do"><br><sub><b>Tools</b>: most used tools by project, and the kinds of work they do</sub></td>
    <td width="50%"><img src="docs/screenshots/files.png" alt="Files: the files that get read and edited most"><br><sub><b>Files</b>: the files that get read and edited most</sub></td>
  </tr>
  <tr>
    <td width="50%"><img src="docs/screenshots/cache.png" alt="Cache: hit rate over time and what caching saves"><br><sub><b>Cache</b>: hit rate over time and what caching saves</sub></td>
    <td width="50%"><img src="docs/screenshots/tips.png" alt="Tips: rule-based suggestions from your own usage"><br><sub><b>Tips</b>: rule-based suggestions from your own usage</sub></td>
  </tr>
  <tr>
    <td colspan="2"><img src="docs/screenshots/settings.png" alt="Settings: general options, the shared database, data sources and plan limits"><br><sub><b>Settings</b>: general options, the shared database, data sources and plan limits</sub></td>
  </tr>
</table>

<sub>Screenshots show made-up demo data (`bun scripts/demo-data.ts`).</sub>

## Install

**macOS and Linux**

```sh
curl -fsSL https://raw.githubusercontent.com/MSpiechowicz/harness-useful-dashboard/main/install.sh | sh
```

This installs `harness-dashboard` to `~/.local/bin`, verifies the release checksum (and installs nothing without one) and adds a launcher: an
applications-menu entry on Linux, or `~/Applications/Harness Dashboard.app` on macOS.

**Windows (PowerShell)**

```powershell
powershell -ExecutionPolicy Bypass -c "irm https://raw.githubusercontent.com/MSpiechowicz/harness-useful-dashboard/main/install.ps1 | iex"
```

This installs to `%LOCALAPPDATA%\Programs\harness-dashboard`, adds it to your `PATH` and creates a Start menu
shortcut.

Installer options (environment variables): `HARNESS_DASHBOARD_VERSION=v0.2.0` pins a release,
`HARNESS_DASHBOARD_INSTALL_DIR=…` picks a custom install directory, and `HARNESS_DASHBOARD_NO_SHORTCUT=1` skips the launcher.

### Updating

The app checks GitHub releases. When a new version is out, a banner in the sidebar offers **Install & restart**:
it downloads the new binary for your platform, verifies its SHA-256 against `checksums.txt`, swaps it in
place and restarts. Open windows reload on their own. From a terminal:

```sh
harness-dashboard update          # install the latest release
harness-dashboard update --check  # only report whether one is available
```

Re-running the install command also upgrades.

Every release binary has a signed build provenance attestation, which proves it was built by this repository's
release workflow from the tagged commit. To check one yourself:

```sh
gh attestation verify ~/.local/bin/harness-dashboard --repo MSpiechowicz/harness-useful-dashboard
```

### Uninstalling

```sh
rm ~/.local/bin/harness-dashboard
rm -rf ~/Applications/"Harness Dashboard.app"                                       # macOS
grep -l '^Icon=harness-dashboard$' ~/.local/share/applications/*.desktop | xargs rm -f  # Linux launchers
rm -f ~/.local/share/icons/hicolor/scalable/apps/harness-dashboard.svg               # Linux icon
# data + config (optional):
rm -rf ~/.config/harness-dashboard                          # Linux
rm -rf ~/Library/Application\ Support/harness-dashboard     # macOS
```

On Windows, delete `%LOCALAPPDATA%\Programs\harness-dashboard`, the Start menu shortcut and `%APPDATA%\harness-dashboard`.

## Usage

```sh
harness-dashboard                # start in the background and open the app window
harness-dashboard --browser      # open in your default browser instead
harness-dashboard --no-open      # just run the server, and print the link to open it with
harness-dashboard --db ~/iCloud/harness/usage.db
harness-dashboard scan [--full]  # ingest once and exit (cron-friendly)
harness-dashboard import-cursor usage.csv
harness-dashboard config get | path | set <key> <value>
```

The dashboard runs a small local server on `127.0.0.1` and opens it in a chrome-less **app window** when a
Chromium-based browser (Chrome, Edge, Brave, Chromium, Vivaldi) is installed. Otherwise it opens a normal browser tab.
Starting it again while it's running just opens another window. Use **Settings → Quit dashboard** to stop it.
Windows open through a sign-in link (`/api/auth?k=…`), which `--no-open` prints instead. A browser that didn't come in
through it sees the page but none of your data.

### Data sources

| Provider | Where data comes from | Notes |
|---|---|---|
| Claude Code | `~/.claude/projects/**/*.jsonl` (or `$CLAUDE_CONFIG_DIR`) | per-message usage, prompts, tools, skills, subagent transcripts |
| Codex | `~/.codex/sessions/**` and `archived_sessions/**` (or `$CODEX_HOME`) | per-response records or cumulative token counts, spawned and guardian threads, thread titles |
| omp (oh-my-pi) | `~/.omp/agent/sessions/**/*.jsonl` (or `$PI_CODING_AGENT_DIR/sessions`) | per-message usage with the plan or account it was billed through (ChatGPT plan, GitHub Copilot, API keys), Copilot premium requests, prompts, tools, `skill://` reads, subagent transcripts |
| OpenCode | `~/.local/share/opencode/opencode.db` (or `$XDG_DATA_HOME/opencode`, also on macOS and Windows) | the SQLite database OpenCode keeps since v1.2: one row per model call with the provider it was billed through, prompts, tools (files from `apply_patch` too), and subagent sessions tied back to the task call that started them. Read-only, from where the last scan stopped. Older JSON storage is moved into the database by OpenCode itself |
| pi | `~/.pi/agent/sessions/**/*.jsonl` | the same format as omp (omp is a fork of pi): per-message usage with the plan or account it was billed through, usage logged outside messages (cache warming, compactions), prompts, tools and session names. History copied into a fork counts once. A folder set up for both pi and omp (they share `$PI_CODING_AGENT_DIR`) is read once, as omp's |
| Zed | `~/.local/share/zed/threads/threads.db` (macOS `~/Library/Application Support/Zed`, Windows `%LOCALAPPDATA%\Zed`, also the Flatpak's) | threads of Zed's own agent: model, prompts, tools and their errors, subagent threads. Zed keeps one running total of tokens per thread and no times per message, so a thread counts as one row, on the day it started. Claude Code or Codex run inside Zed write their own logs and count under those |
| Cline | its folder in VS Code's extension storage (`~/.config/Code/User/globalStorage/saoudrizwan.claude-dev`, also Insiders, VSCodium, Cursor, Windsurf and JetBrains IDEs) and `~/.cline/data` (or `$CLINE_DATA_DIR`) | task folders (`tasks/<id>/ui_messages.json`) of Cline up to 3.x and Cline 4's session store: a row per model call with the cost Cline worked out, prompts, tools and subagents |
| Roo Code | its folder in VS Code's extension storage (`…/globalStorage/rooveterinaryinc.roo-cline`, also the forks) | task folders: a row per model call with the cost Roo worked out, prompts, tools and subtasks |
| Kilo Code | its folder in VS Code's extension storage (`…/globalStorage/kilocode.kilo-code`, also the forks) and `~/.local/share/kilo` | task folders of Kilo Code up to 5.x and Kilo Code 7's database: a row per model call with the cost Kilo worked out |
| Cursor | CSV export from cursor.com → Dashboard → Usage | Cursor keeps usage server-side. Import the CSV in **Settings** or with `import-cursor` |

Folders can be changed, or extra ones added, in **Settings → Data sources**. Ingestion is incremental: each scan only reads
bytes appended since the last one, so rescans take milliseconds.

### Plan limits

The **Live** view shows how much of each plan limit is left, only for the plans the sessions in its time window run on:
Claude Code counts against the Claude plan of its login, Codex against the ChatGPT plan it uses, and OpenCode, pi and
omp against whatever they billed a call through, read with their own logins.

| Plan | Where the limits come from |
|---|---|
| Claude (Pro, Max) | Anthropic, asked with the login Claude Code keeps on the machine (`~/.claude/.credentials.json`, or the macOS keychain). The same numbers Claude Code's `/usage` shows. An expired login is reported, never renewed, so Claude Code stays signed in. |
| Codex (ChatGPT plans) | The rate limits Codex writes into its session logs, read while ingesting. No network request. A reading is as fresh as the last Codex session. |
| Everything omp is logged in to | `omp usage --json`: Claude, ChatGPT/Codex, GitHub Copilot premium requests, Gemini and more |
| Everything OpenCode or pi is logged in to | Their logins (`~/.local/share/opencode/auth.json`, `~/.pi/agent/auth.json`), each asked at its own provider: Anthropic for a Claude plan, ChatGPT for a Codex plan, GitHub for Copilot premium requests. Logins are never renewed, so an expired one is reported until the tool is used again |

Each source can be switched off in **Settings → Plan limits**. Network sources are asked at most every 2 minutes. When a
provider says it's asked too often, the dashboard waits at least 5 minutes (doubling up to 30) and keeps showing the
last reading.

### Claude Code status line

`harness-dashboard statusline` prints one line for Claude Code's status line: the model, this session's cost, what you
spent today across every harness, and how much of the Claude 5-hour limit is used.

```text
Opus 5.5 · session $1.74 · today $18.40 · 5h 42% (resets 1h20m)
```

Add it to `~/.claude/settings.json`:

```json
{
  "statusLine": {
    "type": "command",
    "command": "harness-dashboard statusline"
  }
}
```

It reads the database only and never scans, so it takes a few milliseconds. The numbers are as fresh as the last
scan, every 30 seconds while the dashboard runs. A session not scanned yet shows the cost Claude Code reports. The
5-hour limit comes from Claude Code itself when it reports one, otherwise from a reading the dashboard took in the last
15 minutes. Parts with no value are left out.

| Option | What it does |
|---|---|
| `--format <template>` | The line's layout. Placeholders: `{model}`, `{session}`, `{today}`, `{limit}`. Default `{model} · {session} · {today} · {limit}` |
| `--no-color` | Plain text. Setting `NO_COLOR` does the same |
| `--db <path>` | Read this database instead of the configured one |

"Today" starts at local midnight and counts your own usage, by the user name in **Settings**.

### Budgets and alerts

In **Settings → Budgets and alerts**, set a daily or monthly cap, or a monthly cap per project. Caps count your own
usage (the name in **Settings → Your name**) at API-equivalent prices, and **Overview** shows how each stands, with the
month's pace. The dashboard sends a desktop notification when a budget reaches 80% and when it's used up, and when a
plan limit is 80% used. Each one once per day, month or limit window. Notifications come from the background server, so
they arrive with no dashboard window open: through `notify-send` on Linux (from libnotify), the Notification Center on
macOS and a toast on Windows. **Send test** checks that your system lets them through.

### Shared database (iCloud, Dropbox, network share)

In **Settings → Database**, pick one of the synced folders found on the machine (iCloud Drive, Dropbox, OneDrive, Google
Drive, Box, Nextcloud, Syncthing) or type the path of any synced folder or network share. The dashboard keeps `usage.db`
in it (a path ending in `.db` names the file itself), and says before you save whether that starts a new database or joins
one another machine already keeps there. It's a folder path, not a URL: sync apps keep a local copy of the folder on
every machine. `--db` and `HARNESS_DASHBOARD_DB` take a file path too.

Leave *Copy the history of this machine* on for a new database to keep usage whose transcripts are already gone. Then
choose the same folder on every other machine. Each machine ingests its own logs into the shared file,
tagged with your user name and host name, so **Users** shows everyone side by side. Ingest bookkeeping is kept per host, and
usage rows are deduplicated by message id, so machines never double count.

For non-default paths the database uses SQLite's rollback journal instead of WAL, because WAL doesn't work on
network or synced filesystems. Sync services don't lock files across machines, so avoid scanning from two machines at the
exact same moment. The default 30-second rescan interval with a 15-second busy timeout handles normal use.

## How the numbers are computed

- **Tokens.** Claude Code writes one line per content block, repeating the same message id, so rows are deduplicated by
  message id, keeping the largest counts seen. Codex input tokens include cached tokens. The dashboard stores them as
  *uncached input* plus *cache read*, so the token types add up the same way for every provider. omp reports them
  that way already.
- **Cost** is the *API-equivalent* list price: what the tokens would cost on the provider's API.
  Subscription plans (Claude Max, ChatGPT Pro, Cursor Pro) don't bill this way, but it is the fairest way to compare.
  Cache writes are priced at 1.25× input (5-minute TTL) or 2× input (1-hour TTL), and cache reads use the model's read price.
  Claude fast mode is priced at 2×. Cursor rows use the cost from the export when present, and Cline, Roo Code and Kilo
  Code rows the cost the extension worked out for each call (Roo and Kilo don't always record the model). Model ids are priced as the
  model they name, whatever router they came through: `github-copilot/claude-opus-5.5` is `claude-opus-5-5`.
  GitHub Copilot doesn't bill per token either. Its calls keep their premium-request count, shown per plan or account
  under **Providers → Billed via**.
  Models without a known list price get a fallback rate and are marked **estimated**. Add their prices under
  **Settings → Pricing**, which re-prices your whole history.
- **Projects.** A session counts toward the git repository it ran in, even when it started in a subfolder. Linked
  worktrees count toward their main repository, and folders outside git are their own project. Temp folders, Codex app
  chats (`~/Documents/Codex/<date>/…`) and Claude desktop scratch workspaces are grouped as **No project**.
- **Prompts.** Each human prompt starts a turn. Every model call until the next prompt, including the subagents it
  spawned, is attributed to it.
- **Skills.** From the moment a skill is invoked until the next prompt, calls count toward that skill. Claude Code invokes
  one with the `Skill` tool or a `/skill` command, Codex with `$skill`, an injected `<skill>` block or a `SKILL.md` read,
  and omp by reading `skill://<name>`.
- **Users.** The name in **Settings → Your name** (defaults to your OS user name), stored with every row this machine
  ingests.
- **Model drift.** Each model's last 7 days are compared with the 28 days before, one measure at a time: output token speed,
  time to first token, tool error rate, interrupts, steps per prompt and output per response. Every measure is taken per
  response, tool call or prompt, so doing more or less work doesn't read as a change. A median is flagged when the last
  days fall outside the range its days usually spread over (median ± 3 median absolute deviations) and it moved at least
  10%. A rate is flagged when its counts differ by 3 standard errors and it moved at least 20%. Each window needs 50
  samples. Response time is exact for omp, pi and OpenCode. For Claude Code and Codex it runs from the last input the
  model got to the end of its response. Tool calls the user or the harness stopped don't count as errors. Client
  updates are marked on the charts, since a new harness version can change these numbers too. Cursor's export has
  none of this.

### Colors

Every data color comes from one palette (`web/src/lib/palette.ts`), and each color means one thing:

- **Reserved.** Each harness has its own color: Claude Code orange, Codex blue, Cursor gold, omp plum, pi teal,
  OpenCode crimson, Zed indigo, Cline lime, Roo Code magenta and Kilo Code amber. Models wear their maker's color whichever harness or plan they ran under (a Claude model through
  omp or Copilot is still Claude orange), with shades generated from it so models of one maker stay apart in a stacked
  chart. The four token types have their own set (green-teal, olive, lilac, purple).
- **General pool.** Projects, users, skills, agents and sources take the top values' colors by hue first (green, sky,
  violet, pink), then a strong variant of each, then *Other*.

`tests/palette.test.ts` fails the build when a color is used twice, when a general color comes close to a reserved one,
or when colors shown together get too similar, also for colour-blind readers.

## Privacy

The database lives on your machine, or wherever you point it. The app data folder and its files are readable by your
account only. The server only listens on `127.0.0.1`, and its API answers only a browser that came in through the
sign-in link (an `HttpOnly`, `SameSite=Strict` cookie) or a program that sends the token kept in the app data folder,
so other accounts on the machine can't read your usage. It rejects requests whose `Host` header isn't a loopback name
(DNS-rebinding protection) and requests a browser marks as coming from another site, requires a custom header on
state-changing requests (CSRF protection), and sends a Content-Security-Policy that forbids other pages to frame the
app. Updates install only when the binary matches the release's `checksums.txt`. Prompt text is stored truncated to 2,000 characters so you can recognise
expensive prompts. API keys, tokens and private keys in it are replaced with `[redacted]` before anything is stored. Set **Stored prompt length** to `0` to keep no prompt text at all.

The app makes two kinds of outbound request, and never sends your usage in either: the optional update check against
the GitHub releases API, and, while the Live view is open, the plan-limit checks: with Anthropic, ChatGPT and GitHub,
each with the login Claude Code, OpenCode or pi keeps for it and sent to that provider only, and through `omp usage`.
Every plan-limit source can be switched off in **Settings**.

## Development

Requires [Bun](https://bun.sh) ≥ 1.2.

```sh
bun install
bun run dev        # API on :4318 (watch mode) + Vite UI on http://localhost:5173
bun test           # unit + integration tests
bun run check      # TypeScript + svelte-check
bun run build      # standalone binary for this platform → dist/
bun run build:all  # all platforms + dist/checksums.txt
bun scripts/demo-data.ts /tmp/demo.db   # made-up usage for screenshots: run with --db /tmp/demo.db
bun scripts/icons.ts                    # app icons for the installers, from web/public/favicon.svg
```

**Stack:** a TypeScript backend on Bun (`bun:sqlite`, `Bun.serve`, `Bun.Glob`), and a Svelte 5 + Vite + Tailwind CSS 4 frontend
with Apache ECharts. `bun build --compile` embeds the built UI and produces one self-contained executable per
OS and architecture (macOS x64/arm64, Linux x64/arm64, Windows x64). No runtime dependencies.

```
src/
  cli.ts                 entry point: serve / scan / import-cursor / update / config
  core/
    config.ts paths.ts   per-OS config + data locations
    db.ts                schema + migrations
    pricing.ts           price book (built-in list prices + user overrides)
    models.ts            model id normalization and makers, shared with the UI
    ingest/              incremental JSONL scanner, Claude/Codex/pi/omp parsers, OpenCode database reader, Cursor CSV importer
    queries.ts           all aggregations behind the API
    tips.ts              rule-based tips engine
    limits.ts            plan limits: Claude login, omp, Codex logs
  server/
    app.ts               state, background scanner, live events
    http.ts              REST + SSE API, static UI, request guards
    update.ts            GitHub release check + verified self-update
    open.ts              app-window / browser launcher
web/src/
  pages/ components/ lib/   Svelte UI, ECharts builders, i18n (lib/locales/en.ts, de.ts)
```

**Adding a language:** copy `web/src/lib/locales/en.ts` to a new file, translate the values, and register the file in
`web/src/lib/i18n.svelte.ts`. TypeScript flags any missing key.

### Releasing

Releases are fully automated with [semantic-release](https://semantic-release.gitbook.io/). Every push to `main` runs
the *Release* workflow. It reads the [Conventional Commits](https://www.conventionalcommits.org/) since the last tag and
decides the next version:

| Commit | Release |
|---|---|
| `fix: …`, `perf: …` | patch (1.2.3 → 1.2.4) |
| `feat: …` | minor (1.2.3 → 1.3.0) |
| `feat!: …` or a `BREAKING CHANGE:` footer | major (1.2.3 → 2.0.0) |
| `docs:`, `chore:`, `refactor:`, `test:`, `ci:`, `style:` | no release |

When a release is due, the workflow bumps `package.json`, updates `CHANGELOG.md`, cross-compiles every binary with the
new version, ad-hoc signs the macOS builds and commits `chore(release): x.y.z [skip ci]`. It then tags `vX.Y.Z` and
publishes a GitHub release with the binaries and `checksums.txt`. Installed apps pick it up through the update banner.
Configuration lives in `.releaserc.json`. To preview the next version locally, run
`GITHUB_TOKEN=$(gh auth token) npx semantic-release --dry-run --no-ci`.

## License

GPL-3.0. See [LICENSE](LICENSE).
