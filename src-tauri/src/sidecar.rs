//! The dashboard server: the Bun binary bundled next to the app (`bundle.externalBin`), run as
//! `harness-dashboard serve --shell`.
//!
//! The server reports on its stdout, one line each (the contract, also described in `src/cli.ts`):
//!
//! - `HARNESS_DASHBOARD_LANG <en|de|es|fr|pl>` first: the UI language, for the tray menu and the
//!   loading page's error text;
//! - `HARNESS_DASHBOARD_READY <sign-in link>`: this process serves the dashboard and keeps running;
//! - `HARNESS_DASHBOARD_ERROR <localized text>`: it cannot start, and exits non-zero.
//!
//! Any other line is ignored. The app always owns its server: a dashboard that already runs on the
//! port is stopped by the server before it starts, or reported as an `ERROR`.
//!
//! The sign-in link is `http://127.0.0.1:<port>/?k=<64 hex>`; it carries the API token, so it is
//! never logged. Everything the server prints for people (its banner, scan summaries, warnings and
//! errors) goes to its stderr, which the app logs. The app keeps the server's stdin open while it runs: closing it asks the server
//! to shut down cleanly (it is killed after [`STOP_GRACE`]). stdout and stderr are read to the end
//! on their own threads, so a full pipe never blocks the server.
//!
//! Once the server is ready, it belongs to the app: when it ends (Settings > Quit, or a crash), the
//! app quits too. Without a link within [`STARTUP_TIMEOUT`], or when the server fails before
//! sending one, the loading page shows the error.

use std::io::{self, BufRead, BufReader, Read};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, ExitStatus, Stdio};
use std::sync::mpsc::{self, RecvTimeoutError, Sender};
use std::sync::{Mutex, MutexGuard, PoisonError};
use std::thread;
use std::time::{Duration, Instant};

use tauri::{AppHandle, Manager, Runtime, Url};

use crate::{tray, window};

/// The server binary's name next to the app's own executable (`bundle.externalBin` without the
/// target triple, which the bundler drops).
pub const SERVER_BIN: &str = "harness-dashboard";

/// Longest wait for the server's sign-in link. A first start on a large history imports it first.
pub const STARTUP_TIMEOUT: Duration = Duration::from_secs(60);

/// How long the server gets to shut down after its stdin closed, before it is killed.
pub const STOP_GRACE: Duration = Duration::from_secs(3);

/// How often a stopping server is checked.
const POLL: Duration = Duration::from_millis(50);

/// The UI languages the server may report.
const LANGUAGES: &[&str] = &["en", "de", "es", "fr", "pl"];

/// Longest stderr line kept in the log.
const MAX_LOGGED_LINE: usize = 1000;

/// The prefixes the server's background jobs report their failures with (`console.error("[scan]",
/// error)` in `src/`). `[retention]` and `[rollup]` report their results too, so they are not here.
const PROBLEM_PREFIXES: &[&str] = &[
    "[http]", "[scan]", "[alerts]", "[limits]", "[cursor]", "[labels]", "[digest]", "[db]", "[config]",
];

/// Words that mark any other stderr line as a problem, matched without case.
const PROBLEM_WORDS: &[&str] = &["error", "fail", "warn", "cannot", "can't", "could not"];

/// A line of the server's stdout that is part of the contract.
#[derive(Debug, PartialEq, Eq)]
pub enum Line {
    /// The UI language.
    Lang(String),
    /// The server serves the dashboard at the link.
    Ready(Url),
    /// The server cannot start; the text is already in the UI language.
    Error(Option<String>),
}

/// The contract line `line` carries, or `None` for any other output (and for a link that is not
/// exactly `http://127.0.0.1:<port>/?k=<64 lowercase hex>`).
pub fn parse_line(line: &str) -> Option<Line> {
    let line = line.trim_end_matches(['\r', '\n']);
    let (kind, value) = line.split_once(' ').unwrap_or((line, ""));

    match kind {
        "HARNESS_DASHBOARD_LANG" => LANGUAGES.contains(&value).then(|| Line::Lang(value.to_owned())),
        "HARNESS_DASHBOARD_READY" => sign_in_link(value).map(Line::Ready),
        "HARNESS_DASHBOARD_ERROR" => {
            let text = value.trim();

            Some(Line::Error((!text.is_empty()).then(|| text.to_owned())))
        }
        _ => None,
    }
}

fn sign_in_link(raw: &str) -> Option<Url> {
    let url = Url::parse(raw).ok()?;
    let token = url.query()?.strip_prefix("k=")?;

    let valid = url.scheme() == "http"
        && url.host_str() == Some("127.0.0.1")
        && url.port().is_some()
        && url.username().is_empty()
        && url.password().is_none()
        && url.path() == "/"
        && url.fragment().is_none()
        && is_token(token);

    valid.then_some(url)
}

fn is_token(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
}

/// Where the server is in its life, as far as the app knows.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Phase {
    /// Started, no link yet.
    Starting,
    /// This app's server runs the dashboard.
    Owned,
    /// It could not start; the loading page shows why.
    Failed,
    /// The app is quitting or updating.
    Stopping,
}

/// The server process and what it reported. Managed as app state.
pub struct Sidecar {
    inner: Mutex<Inner>,
}

struct Inner {
    phase: Phase,
    lang: String,
    child: Option<Child>,
    /// Kept open while the server runs; dropping it is the shutdown request.
    stdin: Option<ChildStdin>,
}

impl Default for Sidecar {
    fn default() -> Self {
        Self {
            inner: Mutex::new(Inner {
                phase: Phase::Starting,
                lang: "en".to_owned(),
                child: None,
                stdin: None,
            }),
        }
    }
}

impl Sidecar {
    /// The current phase.
    pub fn phase(&self) -> Phase {
        self.lock().phase
    }

    /// Stops a server this app started: closes its stdin, waits up to [`STOP_GRACE`], then kills
    /// it. Nothing to do on a second call.
    pub fn stop(&self) {
        let (child, stdin) = {
            let mut inner = self.lock();
            inner.phase = Phase::Stopping;

            (inner.child.take(), inner.stdin.take())
        };

        if let Some(child) = child {
            let status = reap(child, stdin);
            tracing::info!(?status, "dashboard server stopped");
        }
    }

    /// Moves from `Starting` to `next`; false when startup was already settled (a late line, or the
    /// timeout won).
    fn settle(&self, next: Phase) -> bool {
        let mut inner = self.lock();

        if inner.phase != Phase::Starting {
            return false;
        }

        inner.phase = next;
        true
    }

    fn lang(&self) -> String {
        self.lock().lang.clone()
    }

    fn lock(&self) -> MutexGuard<'_, Inner> {
        // Every update is a single assignment, so a panic elsewhere cannot leave it half-written.
        self.inner.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

/// The server binary next to the app's executable.
pub fn server_path() -> io::Result<PathBuf> {
    let exe = tauri::utils::platform::current_exe()?;
    let dir = exe
        .parent()
        .ok_or_else(|| io::Error::other("the app's executable has no folder"))?;

    Ok(dir.join(format!("{SERVER_BIN}{}", std::env::consts::EXE_SUFFIX)))
}

/// Starts the server and the threads that follow it. Needs the [`Sidecar`] state.
pub fn start<R: Runtime>(app: &AppHandle<R>) {
    let Some(sidecar) = app.try_state::<Sidecar>() else {
        return;
    };

    let mut child = match spawn() {
        Ok(child) => child,
        Err(error) => {
            tracing::error!(%error, "cannot start the dashboard server");

            if sidecar.settle(Phase::Failed) {
                window::show_startup_error(app, &sidecar.lang(), None);
            }

            return;
        }
    };

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();

    {
        let mut inner = sidecar.lock();
        inner.stdin = child.stdin.take();
        inner.child = Some(child);
    }

    let (settled, startup) = mpsc::channel();

    if let Some(stdout) = stdout {
        let app = app.clone();
        spawn_thread("server-stdout", move || follow(&app, stdout, &settled));
    }

    if let Some(stderr) = stderr {
        spawn_thread("server-stderr", move || log_stderr(stderr));
    }

    let app = app.clone();
    spawn_thread("server-startup", move || {
        // A sent signal or a closed channel (stdout ended) both mean startup was settled.
        if startup.recv_timeout(STARTUP_TIMEOUT) == Err(RecvTimeoutError::Timeout) {
            timed_out(&app);
        }
    });
}

fn spawn() -> io::Result<Child> {
    let mut command = Command::new(server_path()?);

    command
        .args(["serve", "--shell"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    // The server is a console program: without this, Windows opens a console window for it.
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;

        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }

    command.spawn()
}

fn spawn_thread(name: &str, task: impl FnOnce() + Send + 'static) {
    if let Err(error) = thread::Builder::new().name(name.to_owned()).spawn(task) {
        tracing::error!(%error, name, "cannot start a server thread");
    }
}

/// Acts on the server's stdout lines until it ends, then on its exit.
fn follow<R: Runtime>(app: &AppHandle<R>, stdout: impl Read, settled: &Sender<()>) {
    let Some(sidecar) = app.try_state::<Sidecar>() else {
        return;
    };

    for line in lines(stdout) {
        let Some(line) = parse_line(&line) else {
            continue;
        };

        let settles_to = match &line {
            Line::Lang(lang) => {
                tray::set_language(app, lang);
                sidecar.lock().lang = lang.clone();
                continue;
            }
            Line::Ready(_) => Phase::Owned,
            Line::Error(_) => Phase::Failed,
        };

        // The first link or error settles startup; a late or repeated one changes nothing.
        if !sidecar.settle(settles_to) {
            continue;
        }

        settled.send(()).ok();

        match line {
            Line::Ready(url) => window::open_dashboard(app, &url),
            Line::Error(text) => {
                tracing::error!("the dashboard server reported a startup error");
                window::show_startup_error(app, &sidecar.lang(), text.as_deref());
            }
            Line::Lang(_) => {}
        }
    }

    exited(app, &sidecar);
}

/// The server's stdout ended: it exited (or is about to).
fn exited<R: Runtime>(app: &AppHandle<R>, sidecar: &Sidecar) {
    let (phase, child, stdin) = {
        let mut inner = sidecar.lock();
        let phase = inner.phase;

        if phase == Phase::Starting {
            inner.phase = Phase::Failed;
        }

        (phase, inner.child.take(), inner.stdin.take())
    };

    let status = child.map(|child| reap(child, stdin));

    match phase {
        Phase::Starting => {
            tracing::error!(?status, "the dashboard server exited before it was ready");
            window::show_startup_error(app, &sidecar.lang(), None);
        }
        Phase::Owned => {
            tracing::info!(?status, "the dashboard server stopped; quitting");
            app.exit(0);
        }
        Phase::Failed | Phase::Stopping => {}
    }
}

/// No link within [`STARTUP_TIMEOUT`]: the loading page shows the error and the server is stopped.
fn timed_out<R: Runtime>(app: &AppHandle<R>) {
    let Some(sidecar) = app.try_state::<Sidecar>() else {
        return;
    };

    if !sidecar.settle(Phase::Failed) {
        return;
    }

    tracing::error!(
        timeout_s = STARTUP_TIMEOUT.as_secs(),
        "the dashboard server did not start in time"
    );
    window::show_startup_error(app, &sidecar.lang(), None);

    let (child, stdin) = {
        let mut inner = sidecar.lock();
        (inner.child.take(), inner.stdin.take())
    };

    if let Some(child) = child {
        reap(child, stdin);
    }
}

/// Closes the server's stdin, waits up to [`STOP_GRACE`] for it to exit, then kills it.
fn reap(mut child: Child, stdin: Option<ChildStdin>) -> Option<ExitStatus> {
    drop(stdin);

    let deadline = Instant::now() + STOP_GRACE;

    loop {
        match child.try_wait() {
            Ok(Some(status)) => return Some(status),
            Ok(None) if Instant::now() < deadline => thread::sleep(POLL),
            Ok(None) => break,
            Err(error) => {
                tracing::warn!(%error, "cannot check on the dashboard server");
                break;
            }
        }
    }

    tracing::warn!("the dashboard server did not stop in time; killing it");

    if let Err(error) = child.kill() {
        tracing::warn!(%error, "cannot kill the dashboard server");
    }

    child.wait().ok()
}

/// Logs the server's stderr, with anything token-like removed: a problem (see [`is_problem`]) as a
/// warning, the rest (its banner, scan summaries) as information.
fn log_stderr(stderr: impl Read) {
    for line in lines(stderr) {
        let line = redact(line.trim_end());

        if line.is_empty() {
            continue;
        }

        if is_problem(&line) {
            tracing::warn!(target: "dashboard_server", "{line}");
        } else {
            tracing::info!(target: "dashboard_server", "{line}");
        }
    }
}

/// Whether a stderr line reports a problem: a failed job's prefix, a stack frame (`at ...`), or an
/// error or warning word.
fn is_problem(line: &str) -> bool {
    let line = line.trim_start();

    if line.starts_with("at ") || PROBLEM_PREFIXES.iter().any(|prefix| line.starts_with(prefix)) {
        return true;
    }

    let lower = line.to_lowercase();

    PROBLEM_WORDS.iter().any(|word| lower.contains(word))
}

/// The lines of `stream` until it ends, invalid UTF-8 replaced, so output never stops the reading.
fn lines(stream: impl Read) -> impl Iterator<Item = String> {
    let mut reader = BufReader::new(stream);

    std::iter::from_fn(move || {
        let mut bytes = Vec::new();

        match reader.read_until(b'\n', &mut bytes) {
            Ok(0) | Err(_) => None,
            Ok(_) => Some(String::from_utf8_lossy(&bytes).into_owned()),
        }
    })
}

/// `line` cut to [`MAX_LOGGED_LINE`] characters, with every run of 32 or more hex digits (the API
/// token, other secrets) replaced.
fn redact(line: &str) -> String {
    let mut out = String::with_capacity(line.len());
    let mut run = String::new();

    for char in line.chars().take(MAX_LOGGED_LINE) {
        if char.is_ascii_hexdigit() {
            run.push(char);
            continue;
        }

        flush_run(&mut out, &mut run);
        out.push(char);
    }

    flush_run(&mut out, &mut run);
    out
}

fn flush_run(out: &mut String, run: &mut String) {
    if run.len() >= 32 {
        out.push_str("[redacted]");
    } else {
        out.push_str(run);
    }

    run.clear();
}

#[cfg(test)]
mod tests {
    use super::*;

    const TOKEN: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    fn link(raw: &str) -> Url {
        Url::parse(raw).expect("valid test URL")
    }

    #[test]
    fn the_contract_lines_are_recognized() {
        let ready = format!("http://127.0.0.1:4317/?k={TOKEN}");

        assert_eq!(
            parse_line("HARNESS_DASHBOARD_LANG pl\n"),
            Some(Line::Lang("pl".to_owned()))
        );
        assert_eq!(
            parse_line(&format!("HARNESS_DASHBOARD_READY {ready}\r\n")),
            Some(Line::Ready(link(&ready)))
        );
        assert_eq!(
            parse_line("HARNESS_DASHBOARD_ERROR Port 4317 jest zajęty"),
            Some(Line::Error(Some("Port 4317 jest zajęty".to_owned())))
        );
        assert_eq!(parse_line("HARNESS_DASHBOARD_ERROR"), Some(Line::Error(None)));
    }

    #[test]
    fn other_output_is_ignored() {
        for line in [
            "",
            "open: http://localhost:4317/?k=abc",
            "HARNESS_DASHBOARD_LANG",
            "HARNESS_DASHBOARD_LANG xx",
            "HARNESS_DASHBOARD_LANG en extra",
            "harness_dashboard_ready http://127.0.0.1:4317/",
            "HARNESS_DASHBOARD_READYhttp://127.0.0.1:4317/",
        ] {
            assert_eq!(parse_line(line), None, "{line:?}");
        }
    }

    #[test]
    fn an_attached_line_is_not_part_of_the_contract() {
        let line = format!("HARNESS_DASHBOARD_ATTACHED http://127.0.0.1:4317/?k={TOKEN}");

        assert_eq!(parse_line(&line), None);
    }

    #[test]
    fn only_an_exact_loopback_sign_in_link_is_used() {
        let upper = TOKEN.to_uppercase();
        let short = &TOKEN[..63];

        for raw in [
            format!("http://localhost:4317/?k={TOKEN}"),
            format!("https://127.0.0.1:4317/?k={TOKEN}"),
            format!("http://127.0.0.2:4317/?k={TOKEN}"),
            format!("http://127.0.0.1/?k={TOKEN}"),
            format!("http://user@127.0.0.1:4317/?k={TOKEN}"),
            format!("http://127.0.0.1:4317/settings?k={TOKEN}"),
            format!("http://127.0.0.1:4317/?k={TOKEN}#x"),
            format!("http://127.0.0.1:4317/?k={TOKEN}&next=https://example.com"),
            format!("http://127.0.0.1:4317/?k={upper}"),
            format!("http://127.0.0.1:4317/?k={short}"),
            "http://127.0.0.1:4317/".to_owned(),
            format!("javascript:alert(1)//?k={TOKEN}"),
        ] {
            assert_eq!(parse_line(&format!("HARNESS_DASHBOARD_READY {raw}")), None, "{raw}");
        }
    }

    #[test]
    fn logged_lines_never_carry_the_token() {
        let line = format!("GET /?k={TOKEN} failed");

        assert_eq!(redact(&line), "GET /?k=[redacted] failed");
        assert_eq!(redact("port 4317 in use (deadbeef)"), "port 4317 in use (deadbeef)");
        assert_eq!(redact(&"x".repeat(5000)).len(), MAX_LOGGED_LINE);
    }

    #[test]
    fn only_problems_are_logged_as_warnings() {
        for line in [
            "harness-dashboard 1.25.1",
            "  database: /home/ada/.config/harness-dashboard/usage.db",
            "  listening: http://localhost:4317",
            "  scanned 120 files (3 changed, +42 usage rows) in 81 ms",
            "[retention] trimmed 500 rows in 2 batches, freed 12 pages",
            "[rollup] counted 9 tool results of 3 days in 4 rows, freed 0 pages",
        ] {
            assert!(!is_problem(line), "{line:?}");
        }

        for line in [
            "[http] TypeError: undefined is not an object",
            "[scan] SQLiteError: database is locked",
            "[labels] failed: 401",
            "[db] Can't read the schema version, nothing is written:",
            "[retention] error: disk I/O error",
            "error: Port 4317 is in use",
            "Warning: the config file could not be parsed",
            "      at scanNow (src/server/app.ts:317:20)",
        ] {
            assert!(is_problem(line), "{line:?}");
        }
    }

    #[test]
    fn output_is_read_to_the_end_whatever_its_bytes() {
        let output: &[u8] = b"HARNESS_DASHBOARD_LANG de\n\xff\xfe broken\nlast line without newline";

        let read: Vec<String> = lines(output).collect();

        assert_eq!(read.len(), 3);
        assert_eq!(parse_line(&read[0]), Some(Line::Lang("de".to_owned())));
        assert_eq!(read[2], "last line without newline");
    }

    #[cfg(unix)]
    #[test]
    fn a_server_that_ignores_its_closed_stdin_is_killed_after_the_grace() {
        let child = Command::new("sh")
            .args(["-c", "trap '' TERM; while true; do sleep 1; done"])
            .stdin(Stdio::piped())
            .spawn()
            .expect("sh runs");
        let started = Instant::now();

        let status = reap(child, None);

        assert!(status.is_some_and(|status| !status.success()));
        assert!(started.elapsed() >= STOP_GRACE);
    }

    #[cfg(unix)]
    #[test]
    fn a_server_that_quits_on_stdin_eof_is_not_killed() {
        let mut child = Command::new("sh")
            .args(["-c", "cat >/dev/null; exit 0"])
            .stdin(Stdio::piped())
            .spawn()
            .expect("sh runs");
        let stdin = child.stdin.take();

        let status = reap(child, stdin);

        assert!(status.is_some_and(|status| status.success()));
    }
}
