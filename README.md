# Harness Dashboard

**Token usage across your AI coding tools, in one local app.** Harness Dashboard reads the transcripts that
Claude Code, Codex and omp (oh-my-pi) already write to disk, plus Cursor usage exports. It stores everything in a
local SQLite database and shows clear, interactive charts of where your tokens and money go.

- **Overall usage**: tokens, API-equivalent cost, sessions, prompts and cache hit rate, compared with the previous period
- **By project, user, model, provider, skill, agent, session and prompt**: every dimension is a filter
- **Trends**: hourly/daily/weekly/monthly series, a 7-day moving average, cumulative spend, peak day and a 30-day projection
- **Per-prompt cost analytics**: what each request really consumed, call by call, including the subagents it spawned
- **Tool and file heatmaps**: tools × projects, tools × hour of day, and the files that get read or edited most
- **Subagent attribution**: Claude Code subagents, Codex spawned/guardian threads and omp subagents are tied back to the spawning prompt or parent session
- **Billed via**: which plan or account usage ran through (a ChatGPT plan, GitHub Copilot with its premium requests, an API key)
- **Cache analytics**: hit rate over time, money saved by caching, and what cache writes cost
- **Rule-based tips**: low cache hit rate, context bloat, premium models on small prompts, tool loops, spikes, and more
- **Live**: new usage shows up within seconds while you work
- **English and German UI** (English by default), light and dark themes, responsive layout
- **Shared database**: point several machines at one SQLite file on iCloud Drive, Dropbox, OneDrive or a network share

Everything runs locally. Nothing is uploaded anywhere.

## Install

**macOS and Linux**

```sh
curl -fsSL https://raw.githubusercontent.com/MSpiechowicz/harness-useful-dashboard/main/install.sh | sh
```

This installs `harness-dashboard` to `~/.local/bin`, verifies the release checksum and adds a launcher: an
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

### Uninstalling

```sh
rm ~/.local/bin/harness-dashboard
rm -rf ~/.local/share/applications/harness-dashboard.desktop ~/Applications/"Harness Dashboard.app"
# data + config (optional):
rm -rf ~/.config/harness-dashboard                          # Linux
rm -rf ~/Library/Application\ Support/harness-dashboard     # macOS
```

On Windows, delete `%LOCALAPPDATA%\Programs\harness-dashboard`, the Start menu shortcut and `%APPDATA%\harness-dashboard`.

## Usage

```sh
harness-dashboard                # start in the background and open the app window
harness-dashboard --browser      # open in your default browser instead
harness-dashboard --no-open      # just run the server (http://localhost:4317)
harness-dashboard --db ~/iCloud/harness/usage.db
harness-dashboard scan [--full]  # ingest once and exit (cron-friendly)
harness-dashboard import-cursor usage.csv
harness-dashboard config get | path | set <key> <value>
```

The dashboard runs a small local server on `127.0.0.1` and opens it in a chrome-less **app window** when a
Chromium-based browser (Chrome, Edge, Brave, Chromium, Vivaldi) is installed. Otherwise it opens a normal browser tab.
Starting it again while it's running just opens another window. Use **Settings → Quit dashboard** to stop it.

### Data sources

| Provider | Where data comes from | Notes |
|---|---|---|
| Claude Code | `~/.claude/projects/**/*.jsonl` (or `$CLAUDE_CONFIG_DIR`) | per-message usage, prompts, tools, skills, subagent transcripts |
| Codex | `~/.codex/sessions/**` and `archived_sessions/**` (or `$CODEX_HOME`) | per-response records or cumulative token counts, spawned and guardian threads, thread titles |
| omp (oh-my-pi) | `~/.omp/agent/sessions/**/*.jsonl` (or `$PI_CODING_AGENT_DIR/sessions`) | per-message usage with the plan or account it was billed through (ChatGPT plan, GitHub Copilot, API keys), Copilot premium requests, prompts, tools, `skill://` reads, subagent transcripts |
| Cursor | CSV export from cursor.com → Dashboard → Usage | Cursor keeps usage server-side; import the CSV in **Settings** or with `import-cursor` |

Folders can be changed, or extra ones added, in **Settings → Data sources**. Ingestion is incremental: each scan only reads
bytes appended since the last one, so rescans take milliseconds.

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
  Claude fast mode is priced at 2×. Cursor rows use the cost from the export when present. Model ids are priced as the
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
- **Skills.** From the moment a skill is invoked (Claude `Skill` tool or `/skill` command; Codex `$skill`, an injected
  `<skill>` block or a `SKILL.md` read; omp reading `skill://<name>`) until the next prompt, calls count toward that skill.
- **Users.** The name in **Settings → Your name** (defaults to your OS user name), stored with every row this machine
  ingests.

### Colors

Every data color comes from one palette (`web/src/lib/palette.ts`), and each color means one thing:

- **Reserved.** Each provider has its own color. Models wear their maker's color whichever harness or plan they ran
  under (a Claude model through omp or Copilot is still Claude orange), with shades generated from it so models of
  one maker stay apart in a stacked chart. The four token types have their own set (teal, olive, lilac, purple).
- **General pool.** Projects, users, skills, agents and sources take the top values' colors by hue first (green, sky,
  violet, pink), then a strong variant of each, then *Other*.

`tests/palette.test.ts` fails the build when a color is used twice, when a general color comes close to a reserved one,
or when colors shown together get too similar, also for colour-blind readers.

## Privacy

The database lives on your machine, or wherever you point it. The server only listens on `127.0.0.1`. It rejects
requests whose `Host` header isn't a loopback name (DNS-rebinding protection), and it requires a custom header on
state-changing requests (CSRF protection). Prompt text is stored truncated to 2,000 characters so you can recognise
expensive prompts. Set **Stored prompt length** to `0` to keep no prompt text at all. The only outbound request is the
optional update check against the GitHub releases API.

## Development

Requires [Bun](https://bun.sh) ≥ 1.2.

```sh
bun install
bun run dev        # API on :4317 (watch mode) + Vite UI on http://localhost:5173
bun test           # unit + integration tests
bun run check      # TypeScript + svelte-check
bun run build      # standalone binary for this platform → dist/
bun run build:all  # all platforms + dist/checksums.txt
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
    ingest/              incremental JSONL scanner, Claude/Codex/omp parsers, Cursor CSV importer
    queries.ts           all aggregations behind the API
    tips.ts              rule-based tips engine
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
