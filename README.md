# Harness Dashboard

**Token usage across your AI coding tools, in one local app.** Harness Dashboard reads the sessions that
Claude Code, Codex, Gemini CLI, GitHub Copilot CLI, OpenCode, pi, omp (oh-my-pi), Zed and the Cline, Roo Code and Kilo
Code extensions already write to disk, plus Cursor usage from cursor.com or its CSV export. It stores
everything in a local SQLite database and shows clear, interactive charts of where your tokens and money go.

https://github.com/user-attachments/assets/1f4de765-6d69-4945-9c48-84678b2a6624

<sub>A one-minute tour with sound: where the tokens go, one prompt in full, trimming an expensive skill, and the settings.
Made with demo data. [Download the full-quality video](docs/video/harness-dashboard-tour.mp4?raw=true) (23 MB).</sub>

- **Overall usage**: tokens, API-equivalent cost, sessions, prompts and cache hit rate, compared with the previous period
- **By project, user, model, provider, skill, agent, session and prompt**: every dimension is a filter
- **Who used what**: where the money goes from tool to model to project in one flow chart, every project side by side on
  one scale, and on each breakdown page a network of what used what, with lights running along the busiest links
- **Trends**: hourly/daily/weekly/monthly series, a 7-day moving average, cumulative spend, peak day and a 30-day projection
- **Chart notes**: mark a day on the usage chart, then compare the days before and after it
- **Per-prompt cost analytics**: what each request really consumed, call by call, including the subagents it spawned, and
  in a session how much context each prompt added
- **Tool and file heatmaps**: tools × projects, tools × hour of day, and the files that get read or edited most
- **Subagent attribution**: Claude Code subagents, Codex spawned/guardian threads, OpenCode subagent sessions, Gemini CLI subagent chats and omp subagents are tied back to the spawning prompt or parent session
- **Billed via**: which plan or account usage ran through (a ChatGPT plan, GitHub Copilot with its premium requests, an API key)
- **Cache analytics**: hit rate over time, money saved by caching, and what cache writes cost
- **What-if pricing**: what a range would have cost on another model
- **Compactions**: when Claude Code compacted a session, how much context that dropped and what it cost
- **Branches**: what each piece of work cost, per git branch, with its sessions, the files it changed, and the commits and pull requests the agents made on it
- **Lines changed**: the lines the agents' edits added and removed, per project, branch, model, provider, session and day, and what 100 changed lines cost
- **Time**: how long the agents worked, how many sessions ran at once, and the cost per active hour
- **Friction**: failed and declined tool calls and interrupted prompts, by tool, model and session
- **Model drift**: whether a model got slower, clumsier or more error-prone than it usually is, API errors included
- **Plans**: what each subscription is worth at API prices against what you pay, and how full its limits got over time
- **Rule-based tips**: low cache hit rate, context bloat, premium models on small prompts, tool loops, spikes, and more
- **Live view**: tokens per minute as you work, the sessions running now and the ones that closed, and how much of your plan limits is left
  (Claude's 5-hour and weekly limits, Codex, and every plan omp is logged in to, such as GitHub Copilot)
- **Budgets and alerts**: daily, monthly and per-project spending caps, with desktop notifications at 80% and 100% and when a plan limit is 80% used
- **Export**: every table and chart's data as CSV or JSON, following the current filters
- **Claude Code status line**: this session's cost, today's cost and the 5-hour limit, right in Claude Code
- **MCP server**: agents in Claude Code, Codex, Cursor, Zed or OpenCode can read your usage, budgets and plan limits themselves
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
    <td colspan="2"><img src="docs/screenshots/note-compare.png" alt="Chart notes: a note on the usage chart, and the 14 days after it against the 14 days before"><br><sub><b>Chart notes</b>: mark a day on Trends, then compare the days after it with the days before</sub></td>
  </tr>
  <tr>
    <td width="50%"><img src="docs/screenshots/flow.png" alt="Where the money goes: from tool to model to project"><br><sub><b>Where the money goes</b>: from tool to model to project</sub></td>
    <td width="50%"><img src="docs/screenshots/network.png" alt="Models by project: a network of what used what, with lights along the busiest links"><br><sub><b>Who used what</b>: models and the projects they worked on, as a network</sub></td>
  </tr>
  <tr>
    <td colspan="2"><img src="docs/screenshots/project-tiles.png" alt="Projects side by side: every project's usage on one scale"><br><sub><b>Projects side by side</b>: every project's usage on one scale</sub></td>
  </tr>
  <tr>
    <td width="50%"><img src="docs/screenshots/projects.png" alt="Projects: where the tokens go, project by project"><br><sub><b>Projects</b>: where the tokens go, project by project</sub></td>
    <td width="50%"><img src="docs/screenshots/branches.png" alt="Branches: what each piece of work cost, with the lines it changed and its commits"><br><sub><b>Branches</b>: what each piece of work cost, with the lines it changed and its commits</sub></td>
  </tr>
  <tr>
    <td width="50%"><img src="docs/screenshots/branch-git.png" alt="Commits and pull requests: what the agents committed and opened on one branch"><br><sub><b>Commits and pull requests</b>: what the agents committed and opened on a branch</sub></td>
    <td width="50%"><img src="docs/screenshots/compactions.png" alt="Compactions: where Claude Code compacted a session, on its context chart"><br><sub><b>Compactions</b>: where Claude Code compacted a session, on its context chart</sub></td>
  </tr>
  <tr>
    <td width="50%"><img src="docs/screenshots/models.png" alt="Models: which models do the work and what they cost"><br><sub><b>Models</b>: which models do the work and what they cost</sub></td>
    <td width="50%"><img src="docs/screenshots/model-drift.png" alt="Model drift: whether a model got slower or clumsier than it usually is"><br><sub><b>Model drift</b>: whether a model got slower or clumsier than it usually is</sub></td>
  </tr>
  <tr>
    <td width="50%"><img src="docs/screenshots/whatif.png" alt="What-if pricing: what each model's usage would have cost on another model"><br><sub><b>What-if pricing</b>: what the same usage would have cost on another model</sub></td>
    <td width="50%"><img src="docs/screenshots/api-errors.png" alt="API errors: failed model requests over time by cause, and by model"><br><sub><b>API errors</b>: failed model requests over time by cause, and by model</sub></td>
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
    <td width="50%"><img src="docs/screenshots/tags.png" alt="Tags: what each client, experiment or billing label cost"><br><sub><b>Tags</b>: what each client, experiment or billing label cost</sub></td>
    <td width="50%"><img src="docs/screenshots/sessions.png" alt="Sessions: cost against tokens per session, and every session"><br><sub><b>Sessions</b>: cost against tokens per session, and every session</sub></td>
  </tr>
  <tr>
    <td width="50%"><img src="docs/screenshots/session-detail.png" alt="Session detail: every model call, prompt and spawned agent of one session"><br><sub><b>Session detail</b>: every model call, prompt and spawned agent of one session</sub></td>
    <td width="50%"><img src="docs/screenshots/prompts.png" alt="Prompts: what each request really cost, and where the spend concentrates"><br><sub><b>Prompts</b>: what each request really cost, and where the spend concentrates</sub></td>
  </tr>
  <tr>
    <td width="50%"><img src="docs/screenshots/prompt-detail.png" alt="Prompt detail: one prompt call by call, subagents included"><br><sub><b>Prompt detail</b>: one prompt call by call, subagents included</sub></td>
    <td width="50%"><img src="docs/screenshots/time.png" alt="Time: how long agents worked for you, and how often several ran at once"><br><sub><b>Time</b>: how long agents worked for you, and how often several ran at once</sub></td>
  </tr>
  <tr>
    <td width="50%"><img src="docs/screenshots/tools.png" alt="Tools: most used tools by project, and the kinds of work they do"><br><sub><b>Tools</b>: most used tools by project, and the kinds of work they do</sub></td>
    <td width="50%"><img src="docs/screenshots/files.png" alt="Files: the files that get read and edited most"><br><sub><b>Files</b>: the files that get read and edited most</sub></td>
  </tr>
  <tr>
    <td width="50%"><img src="docs/screenshots/friction.png" alt="Friction: why calls failed, and where requests and prompts got stuck"><br><sub><b>Friction</b>: why calls failed, and where requests and prompts got stuck</sub></td>
    <td width="50%"><img src="docs/screenshots/cache.png" alt="Cache: hit rate over time and what caching saves"><br><sub><b>Cache</b>: hit rate over time and what caching saves</sub></td>
  </tr>
  <tr>
    <td width="50%"><img src="docs/screenshots/tips.png" alt="Tips: rule-based suggestions from your own usage"><br><sub><b>Tips</b>: rule-based suggestions from your own usage</sub></td>
    <td width="50%"><img src="docs/screenshots/palette.png" alt="Search: jump to any page, session or prompt with Ctrl+K"><br><sub><b>Search</b>: jump to any page, session or prompt with Ctrl+K</sub></td>
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

This installs `harness-dashboard` to `~/.local/bin`, adds that directory to your `PATH` (via your shell profile:
`~/.zshrc`, `~/.bashrc`/`~/.bash_profile`, fish `conf.d` or `~/.profile`) if it isn't already, verifies the release
checksum (and installs nothing without one) and adds a launcher: an applications-menu entry on Linux, or
`~/Applications/Harness Dashboard.app` on macOS.

**Windows (PowerShell)**

```powershell
powershell -ExecutionPolicy Bypass -c "irm https://raw.githubusercontent.com/MSpiechowicz/harness-useful-dashboard/main/install.ps1 | iex"
```

This installs to `%LOCALAPPDATA%\Programs\harness-dashboard`, adds it to your `PATH` and creates a Start menu
shortcut.

Installer options (environment variables): `HARNESS_DASHBOARD_VERSION=v0.2.0` pins a release,
`HARNESS_DASHBOARD_INSTALL_DIR=…` picks a custom install directory, `HARNESS_DASHBOARD_NO_SHORTCUT=1` skips the launcher,
and `HARNESS_DASHBOARD_NO_MODIFY_PATH=1` leaves your shell profile untouched (macOS/Linux).

### Updating

The app checks GitHub releases every 5 minutes while a window is open. When a new version is out, a banner in the sidebar offers **Install & restart**:
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
harness-dashboard mcp            # MCP server over stdio, started by an agent
harness-dashboard today          # today's cost and usage against yesterday
harness-dashboard report --range 7d --by model --csv
harness-dashboard limits --check # exit code 10 near a plan limit or budget, 11 at it
harness-dashboard digest         # last week as a short Markdown report
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
| Gemini CLI | `~/.gemini/tmp/<project>/chats/` (or `$GEMINI_CLI_HOME/.gemini`) | per-response usage with cached and thinking tokens, prompts, tools and their errors, subagent chats, session summaries as titles. The project comes from the folder's `.project_root`. Chats from before v0.39 (one JSON file each) are read too |
| GitHub Copilot CLI | `~/.copilot/session-state/<id>/events.jsonl` and `~/.copilot/session-store.db` (or `$COPILOT_HOME`) | prompts, tools and their errors, and the tokens and premium requests per model and agent that Copilot writes when a session ends, as one row per model on that moment. When `session-store.db` exists, its `assistant_usage_events` table gives the tokens of each call, opened read-only. A session with rows there keeps only its premium requests from the end-of-session totals, so nothing is counted twice. GitHub does not document that database, so support is best effort and was tested with made-up data only. A session whose store holds only some of its calls is undercounted. Without the file, or for a session that never ended cleanly, there are no tokens per call. Compactions Copilot runs itself show up as compactions. Billed through GitHub Copilot, cost shown at API prices |
| Cursor | cursor.com, asked with the login the Cursor editor keeps on the machine (`~/.config/Cursor/User/globalStorage/state.vscdb`, macOS `~/Library/Application Support/Cursor/…`, Windows `%APPDATA%\Cursor\…`), or the CSV export from cursor.com → Dashboard → Usage | Cursor keeps usage server-side. Turn on **Settings → Sync Cursor usage** (off by default) to fetch it every 6 hours, or import the CSV in **Settings** or with `import-cursor`. A row per model call with its tokens and the cost Cursor charged. A call that is both synced and imported counts once. The login is read from Cursor's database each time (read-only), never stored, logged or renewed, and sent to cursor.com only. An expired one is reported until Cursor signs in again |

Folders can be changed, or extra ones added, in **Settings → Data sources**. Ingestion is incremental: each scan only reads
bytes appended since the last one, so rescans take milliseconds.

### Plan limits

The **Live** view shows how much of each plan limit is left, only for the plans the sessions in its time window run on:
Claude Code counts against the Claude plan of its login, Codex against the ChatGPT plan it uses, Copilot CLI against the
GitHub Copilot plan of its login, and OpenCode, pi and omp against whatever they billed a call through, read with their own logins.

| Plan | Where the limits come from |
|---|---|
| Claude (Pro, Max) | Anthropic, asked with the login Claude Code keeps on the machine (`~/.claude/.credentials.json`, or the macOS keychain). The same numbers Claude Code's `/usage` shows. An expired login is reported, never renewed, so Claude Code stays signed in. |
| Codex (ChatGPT plans) | The rate limits Codex writes into its session logs, read while ingesting. No network request. A reading is as fresh as the last Codex session. |
| GitHub Copilot (Copilot CLI) | GitHub, asked with the login Copilot CLI keeps: the `copilot-cli` entry in the OS keychain (macOS Keychain, Linux libsecret), `~/.copilot/config.json` (or `$COPILOT_HOME`) when it was stored there, or the GitHub CLI's login as Copilot CLI itself falls back to. Shows premium requests used this month. Never renewed. Windows Credential Manager is not read yet |
| Everything omp is logged in to | `omp usage --json`: Claude, ChatGPT/Codex, GitHub Copilot premium requests, Gemini and more |
| Everything OpenCode or pi is logged in to | Their logins (`~/.local/share/opencode/auth.json`, `~/.pi/agent/auth.json`), each asked at its own provider: Anthropic for a Claude plan, ChatGPT for a Codex plan, GitHub for Copilot premium requests. Logins are never renewed, so an expired one is reported until the tool is used again |

Each source can be switched off in **Settings → Plan limits**. Network sources are asked at most every 5 minutes. When a
provider says it's asked too often, the dashboard waits at least 5 minutes (doubling up to 30) and keeps showing the
last reading, also right after a restart, when that reading comes from the stored history.

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

### Reports from the command line

Three commands print reports for a terminal, a script or cron. They read the database only, never scan and make no
network request, so the numbers are as fresh as the last scan of the running dashboard. Add `--scan` to scan the local
logs first, which writes the database.

```sh
harness-dashboard today                              # today against yesterday, top projects and models, budgets, Claude 5h limit
harness-dashboard report                             # cost by project, last 30 days
harness-dashboard report --range 7d --by model
harness-dashboard report --from 2026-09-01 --to 2026-09-30 --by day --csv > september.csv
harness-dashboard report --by week --provider claude --json
harness-dashboard limits                             # latest plan-limit readings and budgets
harness-dashboard limits --check --warn 90
```

```text
Today  Wed, Oct 7, 2026

          Today  Yesterday  Change
Cost      $6.19     $42.40    -85%
Tokens    17.3M       134M    -87%
Sessions      3         17    -82%
Prompts      12         61    -80%

Top projects
  docs-site    $3.40  55%
  billing-api  $1.71  28%
  storefront   $1.08  17%
```

| Option | What it does |
|---|---|
| `--range <range>` | `today`, `7d`, `30d`, `month` or `all`. Default `30d` for `report` |
| `--from`, `--to <date>` | A custom range in local days (`YYYY-MM-DD`), both included. Use instead of `--range` |
| `--by <what>` | `report` rows: `project` (default), `model`, `provider`, `user`, `day`, `week` or `month` |
| `--provider`, `--project`, `--model`, `--user` | Only this harness, project (path or folder name), model or user |
| `--json`, `--csv` | Machine-readable output. CSV is for `report` only |
| `--limit <n>` | Rows in the `report` table, 25 by default, `0` for all. JSON and CSV always have every row |
| `--check` | `limits` ends with an exit code (below) |
| `--warn <percent>` | The `--check` threshold for plan limits and budgets, 80 by default |
| `--no-color` | Plain text. Setting `NO_COLOR` or piping the output does the same |
| `--db <path>` | Read this database instead of the configured one |

JSON and CSV rows use the field names of the dashboard's table export: `cost` in USD at API-equivalent prices, token
counts, `share` as a fraction, times in ISO 8601. CSV follows RFC 4180, without a byte order mark, and text a
spreadsheet would run as a formula starts with an apostrophe.

`limits --check` exit codes:

| Code | Meaning |
|---|---|
| `0` | Every plan limit and budget is below `--warn` |
| `10` | A plan limit or budget is at or above `--warn` |
| `11` | A plan limit or budget is used up (100% or more) |
| `2` | No plan-limit reading from the last 15 minutes and nothing above the threshold, or bad options or no database |

Plan-limit readings come from the running dashboard, which refreshes them every few minutes. Budgets are the caps from
**Settings → Budgets and alerts**.

A weekly report to a file, every Monday at 8:00 (crontab):

```sh
0 8 * * 1  harness-dashboard report --range 7d --by project --csv > "$HOME/reports/ai-usage-$(date +\%F).csv"
```

A mark in the shell prompt (bash) when a limit or budget is close:

```sh
limit_mark() {
  harness-dashboard limits --check >/dev/null 2>&1
  code=$?
  [ "$code" = 10 ] && printf '[limit near] '
  [ "$code" = 11 ] && printf '[limit hit] '
}
PS1='$(limit_mark)'"$PS1"
```

### Weekly digest

A short Markdown report of a week of usage, for people who would rather read one page on Monday than open the dashboard.
It has the cost and tokens against the week before (with the change in percent), sessions, prompts, lines changed and
what 100 changed lines cost, the top 5 projects, models and providers, how the monthly budgets stand with their pace,
the peak of each plan limit, the most common causes of tool failures with the API error count, and the 3 tips with the
most at stake. It is written in the language of the dashboard and reads as well as plain text as in a Markdown viewer.

```text
# Weekly digest: 2026-09-28 to 2026-10-04

| | Last week | Week before | Change |
|---|---:|---:|---:|
| Cost | $187.74 | $125.07 | +50% |
| Tokens | 612M | 408M | +50% |
| Sessions | 73 | 71 | +3% |
| Prompts | 285 | 221 | +29% |
| Lines changed | 46.2k | | |
| Cost per 100 lines | $0.41 | $0.38 | +6% |

## Top projects

- `storefront`: $63.65 (34%)
- `billing-api`: $36.29 (19%)
```

Turn it on in **Settings → Weekly digest**. It is off by default. Pick the day and hour (Monday at 9:00 local time
unless you change it) and a folder. The folder is `digests` in the app data folder unless you set one. The dashboard
writes `<year>-W<week>.md` there, for the Monday to Sunday before, and shows one desktop notification when it is ready.
Nothing is sent anywhere. A digest is written once a week. If the dashboard was not running at that hour, it is written
when it starts again, but never for a week older than the last one. **Write one now** covers the last 7 days up to now,
and **View** shows the latest one in the app.

On the command line it prints to the terminal and reads the database only, like the reports above:

```sh
harness-dashboard digest                          # the previous Monday to Sunday
harness-dashboard digest --week this              # the last 7 days up to now
harness-dashboard digest --out ~/digests/week.md  # write a file instead of printing
harness-dashboard digest --json                   # the numbers as JSON
```

A digest every Monday at 8:00 from cron, without the dashboard running (it reads what the last scan stored):

```sh
0 8 * * 1  harness-dashboard digest --out "$HOME/reports/ai-usage-$(date +\%G-W\%V).md"
```

### MCP server

`harness-dashboard mcp` is a local [MCP](https://modelcontextprotocol.io) server over stdio. With it an agent can check
what a session or branch cost, how a budget stands or how much of a plan limit is left, for example before a large
refactor. It is optional and runs only while a client has it started. It reads the database only: it never scans,
writes, or makes a network request, and needs no sign-in. It finds the database like the other commands (`--db`,
`HARNESS_DASHBOARD_DB`, then the config), so the numbers are as fresh as the last scan of the running dashboard.

| Tool | What it returns |
|---|---|
| `usage_summary` | Cost, tokens by type, sessions, prompts and cache hit rate for a range (`today`, `7d`, `30d`, `month`, `all` or `custom`), compared with the period before |
| `breakdown` | Cost and tokens by project, model, provider, user, skill or agent |
| `session_cost` | One session with its subagents, the lines their edits changed, its commits and pull requests with the cost per commit and per PR, and its compactions. Without an id, the current Claude Code session when known, else the latest one in the working directory |
| `branch_cost` | A git branch over its whole life, with the lines changed on it and the cost per 100 of them, its commits and pull requests with the cost per commit and per PR. Without a name, the branch checked out in the working directory |
| `limits` | The latest stored plan-limit readings, with the share used, the reset time and their age |
| `budget_status` | Today's and this month's spend against the caps from **Settings → Budgets and alerts** |
| `failures` | Why tool calls failed, the tools that fail most, and the latest errors as stored (redacted, shortened) |
| `tips` | The rule-based tips, largest monthly impact first |

Times are ISO 8601. Costs are USD at API-equivalent prices. Range tools also filter by provider, project, model and user.

Every harness the dashboard reads can use it. Each one keeps its MCP servers in its own settings, so add it once per
harness you use. The dashboard keeps nothing for the MCP server: removing it from a harness is all there is to undo,
and the dashboard works the same with or without it. The entry is called `harness-dashboard` below, which is the name harnesses then list. Any name works.

**Claude Code**

```sh
claude mcp add --scope user harness-dashboard -- harness-dashboard mcp   # add
claude mcp remove --scope user harness-dashboard                     # remove
```

**Codex**

```sh
codex mcp add harness-dashboard -- harness-dashboard mcp   # add
codex mcp remove harness-dashboard                       # remove
```

Or by hand in `~/.codex/config.toml` (remove the table to take it out again):

```toml
[mcp_servers.harness-dashboard]
command = "harness-dashboard"
args = ["mcp"]
```

**omp (oh-my-pi)**: in `~/.omp/agent/mcp.json` (or `.omp/mcp.json` in a project), or with `/mcp add` inside omp:

```json
{
  "mcpServers": {
    "harness-dashboard": { "command": "harness-dashboard", "args": ["mcp"] }
  }
}
```

To remove it, delete the entry and run `/mcp reload`, or turn it off with `/mcp disable`.

**pi**: recent versions read `~/.pi/agent/mcp.json` (or `.pi/mcp.json` in a project), with the same `mcpServers` entry as
omp above. Older ones need the adapter first: `pi install npm:pi-mcp-adapter`. To remove it, delete the entry.

**Gemini CLI**

```sh
gemini mcp add --scope user harness-dashboard harness-dashboard mcp   # add
gemini mcp remove --scope user harness-dashboard                   # remove
```

Or by hand in `~/.gemini/settings.json`, under `mcpServers`, with the same entry as omp above.

**GitHub Copilot CLI**: in `~/.copilot/mcp-config.json`, or with `/mcp add` inside Copilot:

```json
{
  "mcpServers": {
    "harness-dashboard": { "type": "local", "command": "harness-dashboard", "args": ["mcp"], "tools": ["*"] }
  }
}
```

To remove it: `copilot mcp remove harness-dashboard`, or delete the entry.

**OpenCode** (`~/.config/opencode/opencode.json`, or `opencode.json` in a project) and **Kilo Code** 7
(`~/.config/kilo/kilo.jsonc`, or `kilo.jsonc` in a project):

```json
{
  "mcp": {
    "harness-dashboard": { "type": "local", "command": ["harness-dashboard", "mcp"] }
  }
}
```

To remove it, delete the entry, or set `"enabled": false` to keep it but turn it off.

**Cline** and **Roo Code** (and Kilo Code up to 5.x): open the extension's **MCP Servers** panel, then its configure
button, which opens its settings file (Cline's `cline_mcp_settings.json`, Roo Code's `mcp_settings.json`, or `.roo/mcp.json`
in a project), and add the same `mcpServers` entry as omp above. To remove it, use the delete button next to the server in
that panel, or delete the entry. `"disabled": true` keeps it but turns it off.

**Cursor**: in `~/.cursor/mcp.json` (or `.cursor/mcp.json` in a project), the same `mcpServers` entry as omp above. To
remove it, delete the entry.

**Zed** (`settings.json`):

```json
{
  "context_servers": {
    "harness-dashboard": { "command": "harness-dashboard", "args": ["mcp"], "env": {} }
  }
}
```

To remove it, delete the entry.

To read another database, add `--db <path>` after `mcp`. The server speaks MCP 2026-07-28 and the
handshake-based versions before it (2025-11-25, 2025-06-18, 2025-03-26 and 2024-11-05).

### Budgets and alerts

In **Settings → Budgets and alerts**, set a daily or monthly cap, or a monthly cap per project. Caps count your own
usage (the name in **Settings → Your name**) at API-equivalent prices, and **Overview** shows how each stands, with the
month's pace. The dashboard sends a desktop notification when a budget reaches 80% and when it's used up, and when a
plan limit is 80% used. Each one once per day, month or limit window. Notifications come from the background server, so
they arrive with no dashboard window open: through `notify-send` on Linux (from libnotify), the Notification Center on
macOS and a toast on Windows. **Send test** checks that your system lets them through.

### Tags and notes

Open a session and add tags such as a client name (`acme`), `experiment` or `billable`, and a short note. While you
type, the tags you already use are suggested, the most used first. Tags are
lowercase, up to 32 characters of letters, digits and `. _ : / -`. Then filter by **Tag** like by any other dimension,
see what each tag cost under **Tags** (with sessions and lines changed, and an export), and group a report with
`report --by tag` or filter it with `--tag acme`. A subagent's session takes its parent's tags. In **Settings → Tags**,
give every session of a project a tag automatically. A session with several tags counts in each of them, so totals
across tags can be higher than the overall total.

Tags and notes are kept in the database, never trimmed by retention. On a shared database every machine sees them.
Secrets in a note are removed when it is saved.

### Chart notes and before and after

On **Trends**, mark a day (or a moment) with a one-line note of up to 200 characters, such as a new model, a changed
prompt or a switch of plan. It shows as a marker on the usage chart. Notes live in the database, so every machine on a
shared database sees them.

Pick a note to compare the 7, 14 or 30 days before it with the same number of days after it: cost, prompts, cost per
prompt, tokens per prompt, cache hit rate, tool error rate and API error rate. The comparison follows the current
filters, so you can look at one project or model.

### Commits and pull requests

**Branches** shows the commits and pull requests made on each branch, and the cost per commit. They come from the
agents' own logs, so no git process runs and no repository is read. Claude Code's PR links count, and so do successful
`git commit` and `gh pr create` runs in Claude Code, Codex, omp, pi, OpenCode and Kilo Code 7, and on a best effort basis
in Gemini CLI and Copilot CLI. Cline, Roo Code, Kilo Code up to 5.x, Zed and Cursor are not covered.

Commits in throwaway repositories (scripts that run `git init` or `mktemp`, or work under a temp folder) and runs that
had nothing to commit are ignored. A quiet `git commit -q` still counts. A commit made by hand in a terminal is not seen.
The branch page lists its commits and pull requests with links, and a session's page lists its pull requests. A commit
links to GitHub only when its branch has a GitHub pull request.

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

When a newer version of the app upgrades a shared database, an older app that opens it does so read-only and says to
update. Upgrade every machine. After this upgrade each machine re-reads its logs once on its first start, to fill in the
commits, pull requests and compactions.

For non-default paths the database uses SQLite's rollback journal instead of WAL, because WAL doesn't work on
network or synced filesystems. Sync services don't lock files across machines, so avoid scanning from two machines at the
exact same moment. The default 30-second rescan interval with a 15-second busy timeout handles normal use.

### Session labels (AI)

Off by default. Turn it on in **Settings → Session labels (AI)** and the dashboard has a model write a short title and a
kind of work (feature, bugfix, refactor, tests, docs, research, ops or other) for each session. You then get a **Kind**
filter, a **Kinds of work** table on the Tags page with the cost, tokens and changed lines of each kind, a kind pill in the
Sessions list, `report --by kind` and `--kind` on the command line, and a `kind` dimension and filter in the MCP tools.
A title is only shown for a session its harness left without one and carries an **AI** marker. On a session's page you can
change its kind, label it again or remove the label.

It runs your own `claude` (Claude Code, default model Haiku) or `codex` program with your own login, whichever you choose,
and only one that is found on your `PATH` is offered. Per session it sends the project folder name, up to the first three
prompts as stored (secrets removed, paths cut to the file name and shortened), the names of the tools used and the number
of changed lines. No file contents and no other paths. Sessions go in batches of ten, one call per batch, with the prompt on
stdin. Claude Code runs without tools, skills or MCP servers and saves no session. Codex cannot run without its shell
tool, so it gets a read-only sandbox in an empty folder. Both run in the folder `labeler` inside the app data folder with the
environment variable `HARNESS_DASHBOARD_LABELER=1`, and have two minutes per call.

The answer is checked strictly. Only a title of up to 60 plain characters and one of the fixed kinds are taken from it, and
anything else is dropped. New sessions are labelled in the background after 15 quiet minutes, at most every 30 minutes and up
to a daily cap (50 by default). **Label now** works through the waiting sessions at once. Failures show a fixed reason in
Settings and back off. A session the model leaves out twice is not sent again by itself. Nothing is ever sent while the
setting is off or when **Stored prompt length** is `0`.

Runs of the labeler leave their own transcripts. They are recognised by their folder and by their prompt, tagged
`ai-labeling` so their cost stays visible, and never labelled.

### Prometheus metrics

For Grafana, Home Assistant or any Prometheus scraper, the dashboard can serve its totals at `GET /metrics` in the
Prometheus text format. It is off by default. Turn it on in **Settings → Prometheus metrics**, which makes a token of its
own (copy it there, or make a new one). The token is not the app's sign-in token: it opens `/metrics` and nothing else.
Without it the endpoint answers `401`, and while the setting is off there is no such route.

What it exports, all from the local database:

| Metric | Type | Labels |
| --- | --- | --- |
| `harness_tokens_total` | counter | `provider`, `model`, `project`, `user`, `type` (`input`, `output`, `cache_read`, `cache_write`, `reasoning`) |
| `harness_cost_usd_total`, `harness_requests_total` | counter | `provider`, `model`, `project`, `user` |
| `harness_sessions_total`, `harness_prompts_total` | counter | `provider`, `project`, `user` |
| `harness_tool_calls_total` | counter | `provider`, `tool`, `outcome` (`ok`, `error`, `declined`) |
| `harness_tool_failures_total` | counter | `provider`, `tool`, `reason` |
| `harness_api_errors_total` | counter | `provider`, `model`, `class` |
| `harness_lines_added_total`, `harness_lines_removed_total` | counter | `provider`, `model`, `project` |
| `harness_tag_cost_usd_total` | counter | `tag` |
| `harness_plan_limit_used_ratio`, `harness_plan_limit_resets_at_seconds` | gauge | `provider`, `plan`, `window` |
| `harness_budget_spent_usd`, `harness_budget_cap_usd` | gauge | `scope` (`daily`, `monthly`, `project`), `project` |
| `harness_live_sessions` | gauge | `status` (`working`, `idle`, `error`) |
| `harness_last_scan_timestamp_seconds`, `harness_build_info` | gauge | `version` on the build info |

Counters are totals since the first row in the database. A re-pricing (new prices, a changed price rule) or trimmed
history can lower them, so prefer `rate()` and `increase()` over raw values: Prometheus treats the drop as a counter
reset. Projects are labelled with their folder name, never the full path, and **Project labels** in Settings turns even
that off. Plan limits come from the readings the app stored, so `/metrics` never asks a provider. They fill in while
the dashboard runs with the limit checks on. Answers are kept until new data arrives, so a scrape every 15 to 60 seconds
costs next to nothing.

Add the endpoint to `prometheus.yml`, with the token from Settings:

```yaml
scrape_configs:
  - job_name: harness-dashboard
    scrape_interval: 60s
    authorization: { type: Bearer, credentials: "<token from Settings>" }
    static_configs: [{ targets: ["127.0.0.1:4317"] }]
```

A few queries to start from:

```promql
sum by (model) (increase(harness_cost_usd_total[1h]))
sum(rate(harness_tool_calls_total{outcome="error"}[1h])) / sum(rate(harness_tool_calls_total[1h]))
harness_plan_limit_used_ratio{provider="claude", window="5h"}
sum(increase(harness_lines_added_total[1d])) + sum(increase(harness_lines_removed_total[1d]))
```

The server listens on `127.0.0.1` only, so a Prometheus on another machine needs a reverse proxy in front of it or an SSH
tunnel (`ssh -L 4317:127.0.0.1:4317 your-machine`). In Home Assistant, the Prometheus integration is for exporting its
own data, so read this endpoint with a REST sensor instead, sending the token in an `Authorization: Bearer` header.

### Database size

Two months of heavy use come to about 250 MB, mostly one row per tool call and per tool result with its indexes. To keep
that in check, successful tool results older than 7 days are folded into daily counts per session. Every total stays the
same. In the hourly charts, the successful calls of a folded day land at midnight. Each machine folds its own rows and
leaves the rows of other machines on a shared database alone. A database from before this version gives the space back
with **Settings → Compact**.

In **Settings → Database**, *Keep details for* (off by default) trims older detail once a day: prompt text (each session keeps
the start of its first prompt as its title), error messages, file paths and response times. Usage rows are never touched,
so totals, costs, trends and budgets stay exactly the same. Prompts, Files, Friction and Time show less for older dates.
The setting is per machine and only trims rows that machine ingested, so on a shared database each machine decides for
its own history. Trimming runs in small batches, and a full rescan doesn't bring the trimmed detail back.

*Compact* rewrites the file without its free space (SQLite `VACUUM`) and shows the size before and after. It pauses scans
until done and holds the file the whole time, so on a shared database run it while the other machines are off. New
databases, and older ones after one Compact, give the space that trimming frees back to the disk by themselves.

## How the numbers are computed

- **Tokens.** Claude Code writes one line per content block, repeating the same message id, so rows are deduplicated by
  message id, keeping the largest counts seen. Codex input tokens include cached tokens. The dashboard stores them as
  *uncached input* plus *cache read*, so the token types add up the same way for every provider. omp reports them
  that way already.
- **Cost** is the *API-equivalent* list price: what the tokens would cost on the provider's API.
  Subscription plans (Claude Max, ChatGPT Pro, Cursor Pro) don't bill this way, but it is the fairest way to compare.
  Cache writes are priced at 1.25× input (5-minute TTL) or 2× input (1-hour TTL), and cache reads use the model's read price.
  Claude fast mode is priced at 2×. Cursor rows use the cost Cursor charged when there is one, and Cline, Roo Code and Kilo
  Code rows the cost the extension worked out for each call (Roo and Kilo don't always record the model). Model ids are priced as the
  model they name, whatever router they came through: `github-copilot/claude-opus-5.5` is `claude-opus-5-5`.
  GitHub Copilot doesn't bill per token either. Its calls keep their premium-request count, shown per plan or account
  under **Providers → Billed via**.
  Models without a known list price get a fallback rate and are marked **estimated**. Add their prices under
  **Settings → Pricing**, which re-prices your whole history.
- **Prices.** The built-in prices ship with the app, which never fetches prices itself. A weekly GitHub Action checks
  them in this order and opens a pull request when something changed, which is reviewed before it is merged. First the
  maker's own pricing page, which wins outright when it lists the model. Then, only for models the official page has no
  price for or that have no readable page, LiteLLM and OpenRouter, where the higher price is used when they differ. Every case where LiteLLM or OpenRouter differs from an official price is listed in
  the pull request for review, and so are price changes an official page announces for later. A model only one
  aggregator knows is added only from the maker's own LiteLLM entry. Rules you set under **Settings → Pricing** always win over the built-in ones.
- **Projects.** A session counts toward the git repository it ran in, even when it started in a subfolder. Linked
  worktrees count toward their main repository, and folders outside git are their own project. Temp folders, Codex app
  chats (`~/Documents/Codex/<date>/…`) and Claude desktop scratch workspaces are grouped as **No project**.
- **Prompts.** Each human prompt starts a turn. Every model call until the next prompt, including the subagents it
  spawned, is attributed to it.
- **Skills.** From the moment a skill is invoked until the next prompt, calls count toward that skill. Claude Code invokes
  one with the `Skill` tool or a `/skill` command, Codex with `$skill`, an injected `<skill>` block or a `SKILL.md` read,
  and omp by reading `skill://<name>`.
- **Lines changed.** Counted per edit tool call from what the harness logged: Claude Code's Edit, MultiEdit, Write and
  NotebookEdit, Codex's `apply_patch`, omp's and pi's edit and write, OpenCode's and Kilo Code's edit, write and patch,
  Gemini CLI's replace and write_file, Copilot CLI's edit and create, and Cline's and Roo Code's file edits. Where the
  result carries the diff (Claude Code, omp, OpenCode, Gemini CLI) the count is exact, as `git diff --numstat` would
  count it. Otherwise it comes from the call's input: replaced text is diffed line by line and a new file counts all its
  lines. Only edits that succeeded count. Edits by hand, by shell commands (`sed -i`, scripts, `git checkout`) and in
  Zed and Cursor are not counted, a file a Codex patch deletes counts no removed lines, and a file written over counts
  its new content when the harness logs no diff. Only the numbers are stored, never the text. **Cost per 100 lines** is
  all spend in the same scope divided by the lines changed, so planning, reviews and questions count too.
- **Users.** The name in **Settings → Your name** (defaults to your OS user name), stored with every row this machine
  ingests.
- **Model drift.** Each model's last 7 days are compared with the 28 days before, one measure at a time: output token speed,
  time to first token, tool error rate, interrupts, steps per prompt and output per response. Every measure is taken per
  response, tool call or prompt, so doing more or less work doesn't read as a change. A median is flagged when the last
  days fall outside the range its days usually spread over (median ± 3 median absolute deviations) and it moved at least
  10%. A rate is flagged when its counts differ by 3 standard errors and it moved at least 20%. Each window needs 50
  samples. The API error rate is the share of model requests that failed per model and day, judged by the same rate rule
  as tool errors, and the `<synthetic>` placeholder rows are left out. Response time is exact for omp, pi and OpenCode.
  For Claude Code and Codex it runs from the last input the model got to the end of its response. Tool calls the user or the harness stopped don't count as errors. Client
  updates are marked on the charts, since a new harness version can change these numbers too. Cursor's export has
  none of this.
- **Compactions.** Claude Code writes a record each time it compacts a session. The dashboard keeps its trigger (auto or
  manual), the tokens before and after, the duration and an estimated cost. The estimate prices the tokens before as
  cache reads and the tokens after as output, at the session's model. It is never added to the spend totals.
  Compactions show as markers on the session's context chart, in a list on its page and as a column in **Sessions**. The summary Claude Code writes after a compaction no longer
  counts as a prompt, so prompt counts drop slightly. The **Tips** page suggests a change when a range has 5 or more
  compactions costing at least $1.
- **Commits and pull requests.** Read from what the agents logged, as described under Commits and pull requests above.
  **Cost per commit** is all spend on the branch divided by its commits. A commit subject is stored only when prompt text
  is kept, and pull request links are stored with the pull request.
- **Live status.** A session is working, idle or closed. A Claude Code session on this machine is closed as soon as its
  process is gone, which the dashboard learns from `~/.claude/sessions/<pid>.json`. Every other session is closed after
  30 minutes without activity. Closed sessions are grey and don't count in **Sessions idle**. The process check is off on
  Windows for now.
- **What-if pricing.** On **Models**, the range is priced again as if each call had gone to another model, and set
  against the actual cost, per current model, with an export. Costs the provider reported (Cursor, Cline, Roo Code and
  Kilo Code) are priced again from tokens too, so both sides compare list prices. Token counts are taken as they are,
  though makers' tokenizers differ, so the same text can be more or fewer tokens on another model.

### Colors

Every data color comes from one palette (`web/src/lib/palette.ts`), and each color means one thing:

- **Reserved.** Each harness has its own color: Claude Code orange, Codex blue, Cursor gold, omp plum, pi teal,
  OpenCode crimson, Zed indigo, Cline lime, Roo Code magenta, Kilo Code amber, Gemini CLI cyan (slate blue in the dark
  theme) and Copilot CLI wine. Models wear their maker's color whichever harness or plan they ran under (a Claude model through
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
expensive prompts. API keys, tokens and private keys in it are replaced with `[redacted]` before anything is stored. Set **Stored prompt length** to `0` to keep no prompt text at all. Commit subjects are stored only when prompt text is kept. The
URLs of pull requests the agents opened are stored.

A few files outside the agents' logs are read, all on this machine. For Live, the files `~/.claude/sessions/*.json` are
read for the process id and session id only, never the `.key` files next to them. Copilot's `session-store.db` is opened
read-only.

The app makes three kinds of outbound request, and never sends your usage in any: the optional update check against
the GitHub releases API, while the Live view is open the plan-limit checks: with Anthropic, ChatGPT and GitHub,
each with the login Claude Code, OpenCode or pi keeps for it and sent to that provider only, and through `omp usage`,
and, only once you turn on **Sync Cursor usage**, a request to cursor.com every 6 hours for your Cursor usage, with the
login the Cursor editor keeps on this machine. That login stays in Cursor: it is read when needed and sent to cursor.com
only. Opt-in: session labels, sent to the model of the CLI you choose, with your own login (see Session labels (AI)). Every plan-limit source, the Cursor sync and the session labels can be switched off in **Settings**.

The Prometheus endpoint sends nothing: it is off by default, and once on it only answers a request that carries its own
token. Nothing leaves the machine unless something scrapes it.

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
bun run screenshots                     # retake docs/screenshots from demo data (needs build:web and Chrome or Chromium)
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
