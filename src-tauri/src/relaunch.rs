//! What the app does when its dashboard server ends.
//!
//! The server belongs to the app once it is ready. It ends in one of three ways:
//!
//! - the app stopped it (quit, update): the phase is `Stopping`, nothing is left to do;
//! - the dashboard asked to quit (Settings > Quit): the server said so first, and the app quits;
//! - anything else, such as `install.sh` stopping it before an upgrade, a `kill`, or a crash: the app
//!   relaunches itself, so it comes back (as the newly installed version after an upgrade).
//!
//! A relaunch that keeps failing must not loop: at most [`LIMIT`] relaunches within [`WINDOW`]. The
//! times are kept in a small file in the app's data folder, because they have to survive the restart
//! (the app forbids `unsafe`, so an environment variable cannot be handed on).

use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use tauri::{AppHandle, Manager, Runtime};

use crate::sidecar::Phase;

/// Most relaunches allowed within [`WINDOW`].
pub const LIMIT: usize = 3;

/// The period [`LIMIT`] counts in.
pub const WINDOW: Duration = Duration::from_secs(10 * 60);

/// Wait before relaunching, so an installer that stopped the server can finish replacing the app.
pub const SETTLE: Duration = Duration::from_secs(3);

/// The file with the times of the latest relaunches, one Unix second per line.
const HISTORY_FILE: &str = "relaunches";

/// What to do when the server ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Next {
    /// Nothing: startup already failed, or the app is stopping the server itself.
    Nothing,
    /// Quit the app.
    Quit,
    /// Start the app again.
    Relaunch,
}

/// Why the app does not relaunch, when it quits.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Cause {
    /// The dashboard asked to quit.
    Asked,
    /// Too many relaunches lately.
    TooMany,
}

/// The decision for a server that ended in `phase`. `asked` is whether it said it was quitting on
/// purpose; `history` holds the Unix seconds of earlier relaunches and `now` the current one.
pub fn decide(phase: Phase, asked: bool, history: &[u64], now: u64) -> (Next, Option<Cause>) {
    if phase != Phase::Owned {
        return (Next::Nothing, None);
    }

    if asked {
        return (Next::Quit, Some(Cause::Asked));
    }

    if recent(history, now).count() >= LIMIT {
        return (Next::Quit, Some(Cause::TooMany));
    }

    (Next::Relaunch, None)
}

/// The times in `history` that still count: within [`WINDOW`] before `now`. A time after `now`
/// (the clock was set back) does not.
fn recent(history: &[u64], now: u64) -> impl Iterator<Item = u64> + '_ {
    history
        .iter()
        .copied()
        .filter(move |&time| time <= now && now - time < WINDOW.as_secs())
}

/// The times in the history file's text; a line that is not a number is skipped.
fn parse_history(text: &str) -> Vec<u64> {
    text.lines().filter_map(|line| line.trim().parse().ok()).collect()
}

/// The times that still count at `now`, followed by `now`, as the history file's text.
fn render_history(history: &[u64], now: u64) -> String {
    recent(history, now)
        .chain([now])
        .map(|time| format!("{time}\n"))
        .collect()
}

fn unix_now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_secs())
}

fn history_path<R: Runtime>(app: &AppHandle<R>) -> io::Result<PathBuf> {
    let dir = app.path().app_local_data_dir().map_err(io::Error::other)?;

    Ok(dir.join(HISTORY_FILE))
}

/// The recorded relaunch times; none when the file is missing or unreadable.
fn read_history(path: &Path) -> Vec<u64> {
    fs::read_to_string(path)
        .map(|text| parse_history(&text))
        .unwrap_or_default()
}

/// Adds a relaunch at `now` to the file at `path`, dropping the ones that no longer count.
fn record(path: &Path, now: u64) -> io::Result<()> {
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir)?;
    }

    fs::write(path, render_history(&read_history(path), now))
}

/// Acts on the end of the server, which was in `phase`. `asked` is whether it announced its quit.
pub fn on_server_exit<R: Runtime>(app: &AppHandle<R>, phase: Phase, asked: bool) {
    let path = history_path(app);
    let now = unix_now();
    let history = path.as_deref().map(read_history).unwrap_or_default();

    match decide(phase, asked, &history, now) {
        (Next::Nothing, _) => {}
        (Next::Quit, Some(Cause::TooMany)) => {
            tracing::warn!(
                limit = LIMIT,
                minutes = WINDOW.as_secs() / 60,
                "the dashboard server stopped again and the app was relaunched too often lately; quitting"
            );
            app.exit(0);
        }
        (Next::Quit, _) => {
            tracing::info!("the dashboard server stopped; quitting");
            app.exit(0);
        }
        (Next::Relaunch, _) => relaunch(app, path, now),
    }
}

fn relaunch<R: Runtime>(app: &AppHandle<R>, path: io::Result<PathBuf>, now: u64) {
    // Without a record the limit cannot hold, so the app quits as before rather than risk a loop.
    let recorded = path.and_then(|path| record(&path, now));

    if let Err(error) = recorded {
        tracing::warn!(%error, "cannot record the relaunch; quitting");
        app.exit(0);
        return;
    }

    tracing::info!("the dashboard server was stopped from outside; relaunching");
    std::thread::sleep(SETTLE);
    app.request_restart();
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::TempDir;

    const NOW: u64 = 1_000_000;

    #[test]
    fn a_server_stopped_from_outside_relaunches_the_app() {
        assert_eq!(decide(Phase::Owned, false, &[], NOW), (Next::Relaunch, None));
    }

    #[test]
    fn a_quit_the_dashboard_asked_for_quits_the_app() {
        assert_eq!(decide(Phase::Owned, true, &[], NOW), (Next::Quit, Some(Cause::Asked)));
    }

    #[test]
    fn a_server_the_app_stopped_or_that_never_started_needs_nothing() {
        for phase in [Phase::Starting, Phase::Failed, Phase::Stopping] {
            for asked in [false, true] {
                assert_eq!(
                    decide(phase, asked, &[], NOW),
                    (Next::Nothing, None),
                    "{phase:?} {asked}"
                );
            }
        }
    }

    #[test]
    fn the_app_relaunches_up_to_the_limit_within_the_window_then_quits() {
        let within = WINDOW.as_secs() - 1;
        let history: Vec<u64> = (0..LIMIT as u64).map(|n| NOW - within + n).collect();

        assert_eq!(
            decide(Phase::Owned, false, &history[..LIMIT - 1], NOW).0,
            Next::Relaunch
        );
        assert_eq!(
            decide(Phase::Owned, false, &history, NOW),
            (Next::Quit, Some(Cause::TooMany))
        );
    }

    #[test]
    fn relaunches_older_than_the_window_do_not_count() {
        let old = NOW - WINDOW.as_secs();
        let history = vec![old; LIMIT];

        assert_eq!(decide(Phase::Owned, false, &history, NOW), (Next::Relaunch, None));
    }

    #[test]
    fn times_after_now_do_not_count() {
        let history = vec![NOW + 5; LIMIT];

        assert_eq!(decide(Phase::Owned, false, &history, NOW), (Next::Relaunch, None));
    }

    #[test]
    fn the_history_keeps_what_counts_and_skips_what_is_not_a_time() {
        let old = NOW - WINDOW.as_secs();
        let text = format!("{old}\nnonsense\n\n {}\n", NOW - 5);

        assert_eq!(parse_history(&text), vec![old, NOW - 5]);
        assert_eq!(
            parse_history(&render_history(&parse_history(&text), NOW)),
            vec![NOW - 5, NOW]
        );
    }

    #[test]
    fn recorded_relaunches_are_seen_by_the_next_start() {
        let dir = TempDir::new("relaunch");
        let path = dir.path().join("data").join(HISTORY_FILE);

        assert!(read_history(&path).is_empty());

        for step in 0..LIMIT as u64 {
            let history = read_history(&path);
            assert_eq!(decide(Phase::Owned, false, &history, NOW + step).0, Next::Relaunch);
            record(&path, NOW + step).expect("record");
        }

        let history = read_history(&path);
        assert_eq!(decide(Phase::Owned, false, &history, NOW + 10).0, Next::Quit);
        assert_eq!(
            decide(Phase::Owned, false, &history, NOW + WINDOW.as_secs() + 1).0,
            Next::Relaunch
        );
    }
}
