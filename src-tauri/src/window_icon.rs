//! Gives the AppImage's window the app icon on Wayland.
//!
//! On Wayland a window names its desktop entry through its app id, and the desktop (KWin, GNOME
//! Shell) takes the window's icon from the entry of that name. The app's GTK window has the program
//! name, `harness-dashboard-app`, as its app id, while the installer's launcher is
//! `harness-dashboard.desktop` (its `StartupWMClass` only counts on X11). So next to that launcher
//! the app keeps a hidden entry named after the app id, with the same program and icon, and
//! refreshes the desktop's launcher caches whenever it writes one. `install.sh` writes the same
//! entry with the launcher, and the deb and rpm ship one of their own (see `src-tauri/linux`).
//!
//! Only an AppImage start does this, and only while the installer's launcher exists. An entry under
//! the alias name that is not such a hidden Harness Dashboard entry, or a symbolic link there, is
//! left alone.

use std::collections::HashSet;
use std::ffi::{OsStr, OsString};
use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use crate::cli_link::create_temp;
use crate::sidecar::SERVER_BIN;

/// The desktop entry name the window's app id points at: the program name.
const ALIAS: &str = "harness-dashboard-app.desktop";

/// The name the hidden entry and the launcher show.
const APP_NAME: &str = "Harness Dashboard";

/// The tools that rebuild the desktop's launcher caches. KDE reads launchers from its own cache.
const CACHE_TOOLS: &[&str] = &["kbuildsycoca6", "kbuildsycoca5", "update-desktop-database"];

/// How long one cache tool may run before it is stopped.
const CACHE_TIMEOUT: Duration = Duration::from_secs(10);

/// What [`sync_alias`] did.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Alias {
    /// The hidden entry was written.
    Written,
    /// The hidden entry already had these contents.
    Unchanged,
    /// Nothing to do: no installer launcher, or the name holds an entry that is not ours.
    Skipped,
}

/// Keeps the hidden entry next to the installer's launcher when this is an AppImage start, and
/// refreshes the launcher caches after writing it. `data_home` is `$XDG_DATA_HOME`.
pub fn link_window_icon(data_home: Option<&Path>) {
    let (Some(data_home), Some(appimage)) = (data_home, std::env::var_os("APPIMAGE")) else {
        return;
    };

    let Some(appimage) = appimage.to_str() else {
        tracing::info!("the AppImage path is not UTF-8; the window icon entry is not written");
        return;
    };

    let apps = data_home.join("applications");
    let alias = apps.join(ALIAS);

    match sync_alias(&apps, appimage) {
        Ok(Alias::Written) => {
            tracing::info!(path = %alias.display(), "linked the window to the launcher's icon");

            let appdir = std::env::var_os("APPDIR").map(PathBuf::from);
            refresh_caches(&apps, appdir.as_deref());
        }
        Ok(Alias::Unchanged | Alias::Skipped) => {}
        Err(error) => tracing::warn!(%error, path = %alias.display(), "cannot write the window icon entry"),
    }
}

/// Writes the hidden entry for the AppImage at `appimage` into the applications folder `apps`,
/// when the installer's launcher is there and the entry is missing or an older one of ours.
pub fn sync_alias(apps: &Path, appimage: &str) -> io::Result<Alias> {
    let Ok(launcher) = fs::read_to_string(apps.join(format!("{SERVER_BIN}.desktop"))) else {
        return Ok(Alias::Skipped);
    };

    let icon = launcher_icon(&launcher).unwrap_or(SERVER_BIN);

    let Some(wanted) = alias_entry(appimage, icon) else {
        return Ok(Alias::Skipped);
    };

    let alias = apps.join(ALIAS);
    let is_symlink = fs::symlink_metadata(&alias).is_ok_and(|meta| meta.file_type().is_symlink());

    if is_symlink {
        return Ok(Alias::Skipped);
    }

    let existing = fs::read_to_string(&alias).ok();

    if existing.as_deref() == Some(wanted.as_str()) {
        return Ok(Alias::Unchanged);
    }

    if !should_write(existing.as_deref(), &wanted) {
        return Ok(Alias::Skipped);
    }

    write_entry(apps, &alias, &wanted)?;

    Ok(Alias::Written)
}

/// Whether the hidden entry should be (re)written over `existing` to become `wanted`: when there is
/// none, or when it is an older entry of ours with other contents.
fn should_write(existing: Option<&str>, wanted: &str) -> bool {
    match existing {
        None => true,
        Some(entry) => entry != wanted && is_our_alias(entry),
    }
}

/// A hidden entry named Harness Dashboard: what this app, `install.sh` and older releases write.
fn is_our_alias(entry: &str) -> bool {
    let has = |line: &str| entry.lines().any(|candidate| candidate.trim() == line);

    has("[Desktop Entry]") && has(&format!("Name={APP_NAME}")) && has("NoDisplay=true")
}

/// The `Icon` of the `[Desktop Entry]` group of `launcher`, if it names one.
fn launcher_icon(launcher: &str) -> Option<&str> {
    let mut in_main_group = false;

    for line in launcher.lines().map(str::trim) {
        if line.starts_with('[') {
            in_main_group = line == "[Desktop Entry]";
            continue;
        }

        if !in_main_group {
            continue;
        }

        if let Some(icon) = line.strip_prefix("Icon=") {
            let icon = icon.trim();

            return (!icon.is_empty()).then_some(icon);
        }
    }

    None
}

/// The hidden entry that starts the AppImage at `appimage` and shows `icon`. `None` for a path a
/// desktop entry cannot hold (a control character, a line break say).
fn alias_entry(appimage: &str, icon: &str) -> Option<String> {
    if appimage.chars().chain(icon.chars()).any(char::is_control) {
        return None;
    }

    let exec = exec_argument(appimage);

    Some(format!(
        "[Desktop Entry]\nType=Application\nName={APP_NAME}\nExec={exec}\nIcon={icon}\nNoDisplay=true\n"
    ))
}

/// `path` as one quoted `Exec` argument. Inside the quotes `"`, `` ` ``, `$` and `\` take a
/// backslash, and the file's own string escaping doubles each backslash again. A literal `%` is
/// `%%`.
fn exec_argument(path: &str) -> String {
    let mut argument = String::from('"');

    for c in path.chars() {
        match c {
            '"' | '`' | '$' => {
                argument.push_str(r"\\");
                argument.push(c);
            }
            '\\' => argument.push_str(r"\\\\"),
            '%' => argument.push_str("%%"),
            _ => argument.push(c),
        }
    }

    argument.push('"');
    argument
}

/// Writes `entry` to a new file in `apps` and renames it over `alias`, so a cache tool never reads
/// a half-written entry.
fn write_entry(apps: &Path, alias: &Path, entry: &str) -> io::Result<()> {
    fs::create_dir_all(apps)?;

    let (temp, mut file) = create_temp(apps, alias)?;

    let written = file
        .write_all(entry.as_bytes())
        .and_then(|()| file.sync_all())
        .and_then(|()| fs::rename(&temp, alias));

    if written.is_err() {
        fs::remove_file(&temp).ok();
    }

    written
}

/// Runs the cache tools that are installed, each with [`CACHE_TIMEOUT`], ignoring their failures.
/// They run with the environment the AppImage started from (see [`host_env`]), so they use the
/// system's libraries and build the cache the desktop reads.
fn refresh_caches(apps: &Path, appdir: Option<&Path>) {
    let env = appdir
        .map(|appdir| host_env(std::env::vars_os(), appdir))
        .unwrap_or_default();

    for tool in CACHE_TOOLS {
        let mut command = Command::new(tool);

        if *tool == "update-desktop-database" {
            command.arg(apps);
        }

        for (name, value) in &env {
            match value {
                Some(value) => command.env(name, value),
                None => command.env_remove(name),
            };
        }

        run_quietly(command, CACHE_TIMEOUT);
    }
}

/// The changes that undo what the AppImage's start script added to the environment: every entry
/// under the mount `appdir` is dropped from a variable, and a variable left empty is removed.
/// `XDG_DATA_DIRS` also loses the `/usr/share` the script put in front of the inherited list, so
/// KDE's cache is built for the same folders as the desktop's.
fn host_env(vars: impl IntoIterator<Item = (OsString, OsString)>, appdir: &Path) -> Vec<(OsString, Option<String>)> {
    if !appdir.has_root() || appdir.parent().is_none() {
        return Vec::new();
    }

    let inside = |entry: &str| Path::new(entry).starts_with(appdir);
    let mut changes = Vec::new();

    for (name, value) in vars {
        let Some(value) = value.to_str() else {
            continue;
        };

        let entries: Vec<&str> = value.split(':').filter(|entry| !entry.is_empty()).collect();

        if !entries.iter().any(|entry| inside(entry)) {
            continue;
        }

        let mut kept: Vec<&str> = entries.into_iter().filter(|entry| !inside(entry)).collect();

        if name == OsStr::new("XDG_DATA_DIRS") {
            kept = without_earlier_duplicates(kept);
        }

        let value = (!kept.is_empty()).then(|| kept.join(":"));
        changes.push((name, value));
    }

    changes
}

/// `entries` with only the last of equal folders kept (a trailing `/` does not count).
fn without_earlier_duplicates(entries: Vec<&str>) -> Vec<&str> {
    let mut seen = HashSet::new();

    let mut kept: Vec<&str> = entries
        .into_iter()
        .rev()
        .filter(|entry| seen.insert(entry.trim_end_matches('/')))
        .collect();
    kept.reverse();

    kept
}

/// Runs `command` without input or output and waits for it at most `timeout`. A tool that is not
/// installed, fails or takes too long is ignored.
fn run_quietly(mut command: Command, timeout: Duration) {
    let spawned = command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn();

    let Ok(mut child) = spawned else {
        return;
    };

    let deadline = Instant::now() + timeout;

    loop {
        match child.try_wait() {
            Ok(Some(_)) => return,
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(50)),
            _ => {
                child.kill().ok();
                child.wait().ok();
                return;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::TempDir;

    const APPIMAGE: &str = "/home/ada/.local/lib/harness-dashboard/harness-dashboard.AppImage";

    const LAUNCHER: &str = "[Desktop Entry]\nType=Application\nName=Harness Dashboard\nExec=\"/home/ada/.local/lib/harness-dashboard/harness-dashboard.AppImage\"\nIcon=harness-dashboard\nStartupWMClass=harness-dashboard-app\n";

    fn vars(pairs: &[(&str, &str)]) -> Vec<(OsString, OsString)> {
        pairs
            .iter()
            .map(|(name, value)| (OsString::from(name), OsString::from(value)))
            .collect()
    }

    #[test]
    fn the_hidden_entry_starts_the_appimage_with_the_launchers_icon() {
        assert_eq!(
            alias_entry(APPIMAGE, "harness-dashboard").as_deref(),
            Some(
                "[Desktop Entry]\nType=Application\nName=Harness Dashboard\nExec=\"/home/ada/.local/lib/harness-dashboard/harness-dashboard.AppImage\"\nIcon=harness-dashboard\nNoDisplay=true\n"
            )
        );
    }

    #[test]
    fn special_characters_in_the_path_are_escaped_for_exec() {
        assert_eq!(
            exec_argument("/home/ada lovelace/a.AppImage"),
            "\"/home/ada lovelace/a.AppImage\""
        );
        assert_eq!(exec_argument("/x/$HOME`\"%"), r#""/x/\\$HOME\\`\\"%%""#);
        assert_eq!(exec_argument(r"/x\y"), r#""/x\\\\y""#);
    }

    #[test]
    fn a_path_with_a_line_break_gets_no_entry() {
        assert_eq!(alias_entry("/x/a\nExec=evil", "harness-dashboard"), None);
        assert_eq!(alias_entry(APPIMAGE, "icon\nNoDisplay=false"), None);
    }

    #[test]
    fn the_icon_comes_from_the_launchers_main_group() {
        let actions = "[Desktop Entry]\nName=Harness Dashboard\n\n[Desktop Action new]\nIcon=other\n";
        let custom = "[Desktop Entry]\nIcon = ignored\nIcon=/opt/icons/hd.png\n";

        assert_eq!(launcher_icon(LAUNCHER), Some("harness-dashboard"));
        assert_eq!(launcher_icon(actions), None);
        assert_eq!(launcher_icon(custom), Some("/opt/icons/hd.png"));
        assert_eq!(launcher_icon("[Desktop Entry]\nIcon=\n"), None);
    }

    #[test]
    fn only_a_missing_or_older_entry_of_ours_is_written() {
        let wanted = alias_entry(APPIMAGE, "harness-dashboard").expect("entry");
        let older = alias_entry("/old/path.AppImage", "harness-dashboard").expect("entry");
        let visible = "[Desktop Entry]\nName=Harness Dashboard\nExec=harness-dashboard-app --custom\n";
        let other = "[Desktop Entry]\nName=Something else\nNoDisplay=true\n";

        assert!(should_write(None, &wanted));
        assert!(should_write(Some(&older), &wanted));
        assert!(!should_write(Some(&wanted), &wanted));
        assert!(!should_write(Some(visible), &wanted));
        assert!(!should_write(Some(other), &wanted));
    }

    #[test]
    fn the_entry_is_written_next_to_the_launcher_once_and_again_after_a_move() {
        let dir = TempDir::new("window-icon-sync");
        let apps = dir.path();
        let alias = apps.join(ALIAS);

        fs::write(apps.join("harness-dashboard.desktop"), LAUNCHER).expect("write launcher");

        assert_eq!(sync_alias(apps, APPIMAGE).expect("first sync"), Alias::Written);
        assert_eq!(
            fs::read_to_string(&alias).expect("read alias"),
            alias_entry(APPIMAGE, "harness-dashboard").expect("entry")
        );
        assert_eq!(sync_alias(apps, APPIMAGE).expect("second sync"), Alias::Unchanged);

        assert_eq!(
            sync_alias(apps, "/elsewhere/hd.AppImage").expect("moved"),
            Alias::Written
        );
        assert!(
            fs::read_to_string(&alias)
                .expect("read alias")
                .contains("Exec=\"/elsewhere/hd.AppImage\"\n")
        );

        let mut left: Vec<_> = fs::read_dir(apps)
            .expect("list")
            .flatten()
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .collect();
        left.sort();
        assert_eq!(left, ["harness-dashboard-app.desktop", "harness-dashboard.desktop"]);
    }

    #[test]
    fn nothing_is_written_without_the_installers_launcher() {
        let dir = TempDir::new("window-icon-no-launcher");

        assert_eq!(sync_alias(dir.path(), APPIMAGE).expect("sync"), Alias::Skipped);
        assert!(!dir.path().join(ALIAS).exists());
    }

    #[test]
    fn an_entry_of_someone_else_under_the_name_is_kept() {
        let dir = TempDir::new("window-icon-foreign");
        let apps = dir.path();
        let custom = "[Desktop Entry]\nType=Application\nName=My dashboard\nExec=harness-dashboard-app\n";

        fs::write(apps.join("harness-dashboard.desktop"), LAUNCHER).expect("write launcher");
        fs::write(apps.join(ALIAS), custom).expect("write custom");

        assert_eq!(sync_alias(apps, APPIMAGE).expect("sync"), Alias::Skipped);
        assert_eq!(fs::read_to_string(apps.join(ALIAS)).expect("read"), custom);
    }

    #[cfg(unix)]
    #[test]
    fn a_symlink_under_the_name_is_not_written_through() {
        let dir = TempDir::new("window-icon-symlink");
        let apps = dir.path();
        let target = apps.join("target.txt");

        fs::write(apps.join("harness-dashboard.desktop"), LAUNCHER).expect("write launcher");
        fs::write(&target, "keep").expect("write target");
        std::os::unix::fs::symlink(&target, apps.join(ALIAS)).expect("symlink");

        assert_eq!(sync_alias(apps, APPIMAGE).expect("sync"), Alias::Skipped);
        assert_eq!(fs::read_to_string(&target).expect("read target"), "keep");
    }

    #[test]
    fn the_cache_tools_get_the_environment_from_before_the_appimage() {
        let appdir = Path::new("/tmp/.mount_harnesX");
        let env = vars(&[
            ("APPDIR", "/tmp/.mount_harnesX"),
            ("APPIMAGE", APPIMAGE),
            (
                "LD_LIBRARY_PATH",
                "/tmp/.mount_harnesX/usr/lib/:/tmp/.mount_harnesX/lib64/:",
            ),
            ("GTK_PATH", "/tmp/.mount_harnesX//usr/lib/gtk-3.0"),
            (
                "PATH",
                "/tmp/.mount_harnesX/usr/bin/:/home/ada/bin:/usr/bin:/home/ada/bin",
            ),
            (
                "XDG_DATA_DIRS",
                "/tmp/.mount_harnesX/usr/share/:/tmp/.mount_harnesX/usr/share:/usr/share:/usr/local/share:/usr/share/",
            ),
            ("GTK_THEME", "Adwaita:dark"),
            ("HOME", "/home/ada"),
        ]);

        let mut changes = host_env(env, appdir);
        changes.sort();

        assert_eq!(
            changes,
            [
                (OsString::from("APPDIR"), None),
                (OsString::from("GTK_PATH"), None),
                (OsString::from("LD_LIBRARY_PATH"), None),
                (
                    OsString::from("PATH"),
                    Some("/home/ada/bin:/usr/bin:/home/ada/bin".to_owned())
                ),
                (
                    OsString::from("XDG_DATA_DIRS"),
                    Some("/usr/local/share:/usr/share/".to_owned())
                ),
            ]
        );
    }

    #[test]
    fn a_mount_at_the_root_changes_nothing() {
        let env = vars(&[("PATH", "/usr/bin")]);

        assert!(host_env(env.clone(), Path::new("/")).is_empty());
        assert!(host_env(env, Path::new("relative")).is_empty());
    }
}
