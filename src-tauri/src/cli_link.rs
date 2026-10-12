//! Keeps the `harness-dashboard` command in step with the app, and removes what the releases
//! before the app installed.
//!
//! The server binary the app bundles is the command line tool as well (`harness-dashboard today`,
//! `statusline`, `mcp`, ...). After every start, and so after every in-app update, it is copied to
//! the place the installers put the command on PATH (see [`cli_target`]), unless that copy is
//! already identical. The copy is written to a new file next to the target and renamed over it, so
//! a terminal never runs a half-written file. A target that is a symbolic link (a developer's link
//! to a local build, say) is left alone. A deb/rpm install puts the server in `/usr/bin`, already
//! on PATH, so nothing is copied there.
//!
//! The releases before the app opened the dashboard through a launcher that ran the command line
//! tool: a Linux `.desktop` entry (plus hidden entries for the Chromium app window's icon) and a
//! macOS script app in `~/Applications`. Those launchers would now start a headless server, so
//! they are removed. Only files exactly of that shape are touched.
//!
//! Debug builds leave all of this alone unless `HD_SHELL_SYNC_CLI=1`: a dev build must not replace
//! the installed command.

use std::ffi::OsStr;
use std::fs::{self, File, OpenOptions};
use std::io::{self, BufReader, Read, Write};
use std::path::{Path, PathBuf};

use tauri::{AppHandle, Manager, Runtime};

use crate::sidecar::{SERVER_BIN, server_path};

/// The command's file name on Windows.
const WINDOWS_CLI: &str = "harness-dashboard.exe";

/// The app bundle the old macOS installer created (a shell-script launcher).
const LEGACY_MAC_APP: &str = "Harness Dashboard.app";

/// How many temporary names [`sync`] tries before it gives up.
const TEMP_ATTEMPTS: u32 = 16;

/// How many names a running command on Windows may be moved aside to (see [`aside_path`]).
const ASIDE_ATTEMPTS: u32 = 16;

/// Where the command line tool belongs on `os` (`std::env::consts::OS`) for a server binary at
/// `server`: `~/.local/bin/harness-dashboard` on Linux and macOS (none when the server is already in
/// `/usr/bin`), `%LOCALAPPDATA%\Programs\harness-dashboard\harness-dashboard.exe` on Windows (the
/// folder `install.ps1` puts on PATH).
pub fn cli_target(os: &str, server: &Path, home: Option<&Path>, local_app_data: Option<&Path>) -> Option<PathBuf> {
    match os {
        "linux" | "macos" => {
            if server.parent() == Some(Path::new("/usr/bin")) {
                return None;
            }

            Some(home?.join(".local").join("bin").join(SERVER_BIN))
        }
        "windows" => Some(local_app_data?.join("Programs").join(SERVER_BIN).join(WINDOWS_CLI)),
        _ => None,
    }
}

/// Whether [`sync`] replaced the target.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Synced {
    /// The target already had the same contents.
    Unchanged,
    /// The target was written.
    Updated,
    /// The target is a symbolic link, which is not replaced.
    SymlinkKept,
}

/// Makes `target` an executable copy of `source`, unless it already is one or is a symbolic link.
pub fn sync(source: &Path, target: &Path) -> io::Result<Synced> {
    let is_symlink = fs::symlink_metadata(target).is_ok_and(|meta| meta.file_type().is_symlink());

    if is_symlink {
        return Ok(Synced::SymlinkKept);
    }

    if same_contents(source, target)? {
        return Ok(Synced::Unchanged);
    }

    let dir = target
        .parent()
        .ok_or_else(|| io::Error::other("the command's target has no folder"))?;
    fs::create_dir_all(dir)?;

    let (temp, file) = create_temp(dir, target)?;

    let written = write_copy(source, file).and_then(|()| make_executable(&temp));
    let replaced = written.and_then(|()| replace(&temp, target));

    if replaced.is_err() {
        fs::remove_file(&temp).ok();
    }

    replaced.map(|()| Synced::Updated)
}

/// Creates a new, empty file next to `target` in `dir`. It never opens an existing file or follows
/// a link someone placed under the name: a taken name is skipped for the next one.
fn create_temp(dir: &Path, target: &Path) -> io::Result<(PathBuf, File)> {
    let name = target.file_name().and_then(OsStr::to_str).unwrap_or(SERVER_BIN);
    let pid = std::process::id();

    for attempt in 0..TEMP_ATTEMPTS {
        let temp = dir.join(format!(".{name}.{pid}.{attempt}.tmp"));

        match OpenOptions::new().write(true).create_new(true).open(&temp) {
            Ok(file) => return Ok((temp, file)),
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
            Err(error) => return Err(error),
        }
    }

    Err(io::Error::new(
        io::ErrorKind::AlreadyExists,
        "no free temporary name next to the command",
    ))
}

/// Copies `source` into `file` and flushes it to disk.
fn write_copy(source: &Path, mut file: File) -> io::Result<()> {
    io::copy(&mut File::open(source)?, &mut file)?;
    file.flush()?;

    file.sync_all()
}

/// Renames `temp` over `target`. Windows cannot replace a running executable but can rename it,
/// so a running command is moved aside first (see [`aside_path`], removed on a later start).
fn replace(temp: &Path, target: &Path) -> io::Result<()> {
    match fs::rename(temp, target) {
        Ok(()) => Ok(()),
        Err(_) if cfg!(windows) && target.exists() => {
            let old = aside_path(target, |path| fs::symlink_metadata(path).is_ok()).ok_or_else(|| {
                io::Error::new(
                    io::ErrorKind::AlreadyExists,
                    "no free name to move the running command aside",
                )
            })?;
            fs::rename(target, &old)?;

            fs::rename(temp, target)
        }
        Err(error) => Err(error),
    }
}

/// The name a running command at `target` is moved aside to: `<name>.old`, or `<name>.old.<n>`
/// when an earlier one is still `taken` (a command that still runs, a long `mcp` session say, so
/// it could not be removed). `None` when all [`ASIDE_ATTEMPTS`] names are taken.
fn aside_path(target: &Path, taken: impl Fn(&Path) -> bool) -> Option<PathBuf> {
    let name = target.file_name().unwrap_or_default().to_string_lossy();

    (0..ASIDE_ATTEMPTS)
        .map(|attempt| match attempt {
            0 => target.with_file_name(format!("{name}.old")),
            n => target.with_file_name(format!("{name}.old.{n}")),
        })
        .find(|candidate| !taken(candidate))
}

/// Whether `file_name` is one of the names [`aside_path`] gives the command `name`.
fn is_aside(name: &str, file_name: &str) -> bool {
    let Some(suffix) = file_name.strip_prefix(name).and_then(|rest| rest.strip_prefix(".old")) else {
        return false;
    };

    match suffix.strip_prefix('.') {
        Some(number) => !number.is_empty() && number.bytes().all(|byte| byte.is_ascii_digit()),
        None => suffix.is_empty(),
    }
}

/// Removes the commands earlier runs moved aside next to `target`, as far as they no longer run.
fn remove_asides(target: &Path) {
    let (Some(dir), Some(name)) = (target.parent(), target.file_name().and_then(OsStr::to_str)) else {
        return;
    };

    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };

    for entry in entries.flatten() {
        let aside = entry
            .file_name()
            .to_str()
            .is_some_and(|file_name| is_aside(name, file_name));

        if aside {
            // One that still runs stays until a later start.
            fs::remove_file(entry.path()).ok();
        }
    }
}

#[cfg(unix)]
fn make_executable(path: &Path) -> io::Result<()> {
    use std::os::unix::fs::PermissionsExt;

    fs::set_permissions(path, fs::Permissions::from_mode(0o755))
}

#[cfg(not(unix))]
fn make_executable(_path: &Path) -> io::Result<()> {
    Ok(())
}

/// True when `target` exists with exactly the bytes of `source`.
fn same_contents(source: &Path, target: &Path) -> io::Result<bool> {
    let Ok(target_meta) = fs::metadata(target) else {
        return Ok(false);
    };

    if fs::metadata(source)?.len() != target_meta.len() {
        return Ok(false);
    }

    let mut source = BufReader::new(File::open(source)?);
    let mut target = BufReader::new(File::open(target)?);
    let mut left = [0u8; 64 * 1024];
    let mut right = [0u8; 64 * 1024];

    loop {
        let read = source.read(&mut left)?;

        if read == 0 {
            return Ok(true);
        }

        target.read_exact(&mut right[..read])?;

        if left[..read] != right[..read] {
            return Ok(false);
        }
    }
}

/// Copies the command and removes the old launchers on a background thread (release builds, or
/// debug builds with `HD_SHELL_SYNC_CLI=1`).
pub fn sync_in_background<R: Runtime>(app: &AppHandle<R>) {
    if cfg!(debug_assertions) && std::env::var_os("HD_SHELL_SYNC_CLI").as_deref() != Some(OsStr::new("1")) {
        tracing::info!("debug build: the installed command and launchers are left alone");
        return;
    }

    let home = app.path().home_dir().ok();
    let local_app_data = std::env::var_os("LOCALAPPDATA").map(PathBuf::from);
    let data_home = std::env::var_os("XDG_DATA_HOME")
        .map(PathBuf::from)
        .or_else(|| home.as_ref().map(|home| home.join(".local").join("share")));

    let spawned = std::thread::Builder::new().name("cli-link".to_owned()).spawn(move || {
        sync_cli(home.as_deref(), local_app_data.as_deref());
        remove_legacy_launchers(home.as_deref(), data_home.as_deref());
    });

    if let Err(error) = spawned {
        tracing::warn!(%error, "cannot start the command line sync");
    }
}

fn sync_cli(home: Option<&Path>, local_app_data: Option<&Path>) {
    let server = match server_path() {
        Ok(server) => server,
        Err(error) => {
            tracing::warn!(%error, "cannot find the server binary to install as a command");
            return;
        }
    };

    let Some(target) = cli_target(std::env::consts::OS, &server, home, local_app_data) else {
        return;
    };

    if cfg!(windows) {
        remove_asides(&target);
    }

    match sync(&server, &target) {
        Ok(Synced::Updated) => tracing::info!(path = %target.display(), "installed the harness-dashboard command"),
        Ok(Synced::Unchanged) => {}
        Ok(Synced::SymlinkKept) => {
            tracing::info!(path = %target.display(), "the harness-dashboard command is a symbolic link; it is left alone");
        }
        Err(error) => tracing::warn!(%error, path = %target.display(), "cannot install the harness-dashboard command"),
    }
}

fn remove_legacy_launchers(home: Option<&Path>, data_home: Option<&Path>) {
    if cfg!(target_os = "linux")
        && let Some(data_home) = data_home
    {
        remove_legacy_linux_entries(&data_home.join("applications"));
    }

    if cfg!(target_os = "macos")
        && let Some(home) = home
    {
        let bundle = home.join("Applications").join(LEGACY_MAC_APP);

        if is_legacy_mac_app(&bundle) {
            remove(&bundle, fs::remove_dir_all(&bundle));
        }
    }
}

/// Removes `harness-dashboard.desktop` when it runs the command line tool, and the hidden
/// Chromium window entries, from the applications folder `apps`.
fn remove_legacy_linux_entries(apps: &Path) {
    let launcher = apps.join(format!("{SERVER_BIN}.desktop"));

    if fs::read_to_string(&launcher).is_ok_and(|entry| is_legacy_launcher(&entry)) {
        remove(&launcher, fs::remove_file(&launcher));
    }

    let Ok(entries) = fs::read_dir(apps) else {
        return;
    };

    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name();

        let legacy = name
            .to_str()
            .is_some_and(|name| fs::read_to_string(&path).is_ok_and(|text| is_legacy_alias(name, &text)));

        if legacy {
            remove(&path, fs::remove_file(&path));
        }
    }
}

fn remove(path: &Path, result: io::Result<()>) {
    match result {
        Ok(()) => tracing::info!(path = %path.display(), "removed a launcher of an older release"),
        Err(error) => tracing::warn!(%error, path = %path.display(), "cannot remove a launcher of an older release"),
    }
}

/// A desktop entry whose `Exec` runs the command line tool itself (the old installer's launcher),
/// not the app or its AppImage.
fn is_legacy_launcher(entry: &str) -> bool {
    let Some(exec) = entry.lines().find_map(|line| line.trim().strip_prefix("Exec=")) else {
        return false;
    };

    let program = match exec.trim().strip_prefix('"') {
        Some(quoted) => quoted.split('"').next().unwrap_or_default(),
        None => exec.split_whitespace().next().unwrap_or_default(),
    };

    Path::new(program).file_name() == Some(OsStr::new(SERVER_BIN))
}

/// A hidden entry the old releases wrote so the Chromium app window got the dashboard icon:
/// `<browser>-<host>__-Default.desktop`, named Harness Dashboard, with its icon, hidden.
fn is_legacy_alias(file_name: &str, entry: &str) -> bool {
    const BROWSERS: &[&str] = &["chrome-", "msedge-", "brave-", "vivaldi-", "chromium-"];

    let named =
        file_name.ends_with("__-Default.desktop") && BROWSERS.iter().any(|prefix| file_name.starts_with(prefix));
    let has = |line: &str| entry.lines().any(|candidate| candidate.trim() == line);

    named && has("Name=Harness Dashboard") && has(&format!("Icon={SERVER_BIN}")) && has("NoDisplay=true")
}

/// The old macOS launcher: a bundle whose executable is the `launcher` script, not this app.
fn is_legacy_mac_app(bundle: &Path) -> bool {
    let executables = bundle.join("Contents").join("MacOS");

    executables.join("launcher").is_file() && !executables.join("harness-dashboard-app").exists()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::TempDir;

    #[test]
    fn the_command_goes_where_the_installers_put_it_on_path() {
        let home = Path::new("/home/ada");
        let local = Path::new("C:/Users/ada/AppData/Local");
        let appimage = Path::new("/tmp/.mount_Harness/usr/bin/harness-dashboard");
        let bundle = Path::new("/Applications/Harness Dashboard.app/Contents/MacOS/harness-dashboard");
        let windows = Path::new("C:/Users/ada/AppData/Local/Harness Dashboard/harness-dashboard.exe");

        let in_home = Some(home.join(".local").join("bin").join("harness-dashboard"));
        let in_programs = Some(
            local
                .join("Programs")
                .join("harness-dashboard")
                .join("harness-dashboard.exe"),
        );

        assert_eq!(cli_target("linux", appimage, Some(home), None), in_home);
        assert_eq!(cli_target("macos", bundle, Some(home), None), in_home);
        assert_eq!(cli_target("windows", windows, Some(home), Some(local)), in_programs);
    }

    #[test]
    fn nothing_is_copied_without_a_place_or_when_packaged_on_path() {
        let home = Path::new("/home/ada");
        let packaged = Path::new("/usr/bin/harness-dashboard");
        let windows = Path::new("C:/Program Files/Harness Dashboard/harness-dashboard.exe");

        assert_eq!(cli_target("linux", packaged, Some(home), None), None);
        assert_eq!(
            cli_target("linux", Path::new("/opt/x/harness-dashboard"), None, None),
            None
        );
        assert_eq!(cli_target("windows", windows, Some(home), None), None);
        assert_eq!(
            cli_target("freebsd", Path::new("/opt/x/harness-dashboard"), Some(home), None),
            None
        );
    }

    #[test]
    fn the_copy_is_written_once_and_again_after_a_change() {
        let dir = TempDir::new("cli-sync");
        let source = dir.path().join("server");
        let target = dir.path().join("bin").join("harness-dashboard");

        fs::write(&source, b"version 1").expect("write source");

        assert_eq!(sync(&source, &target).expect("first sync"), Synced::Updated);
        assert_eq!(fs::read(&target).expect("read target"), b"version 1");
        assert_eq!(sync(&source, &target).expect("second sync"), Synced::Unchanged);

        fs::write(&source, b"version 2").expect("rewrite source");

        assert_eq!(sync(&source, &target).expect("sync after a change"), Synced::Updated);
        assert_eq!(fs::read(&target).expect("read target"), b"version 2");

        let left_over: Vec<_> = fs::read_dir(dir.path().join("bin"))
            .expect("list bin")
            .flatten()
            .map(|entry| entry.file_name())
            .collect();
        assert_eq!(left_over, [OsStr::new("harness-dashboard")]);
    }

    #[test]
    fn a_same_size_copy_with_other_bytes_is_replaced() {
        let dir = TempDir::new("cli-same-size");
        let source = dir.path().join("server");
        let target = dir.path().join("harness-dashboard");

        fs::write(&source, b"aaaa").expect("write source");
        fs::write(&target, b"aaab").expect("write target");

        assert_eq!(sync(&source, &target).expect("sync"), Synced::Updated);
        assert_eq!(fs::read(&target).expect("read target"), b"aaaa");
    }

    #[cfg(unix)]
    #[test]
    fn a_symlinked_command_is_left_alone() {
        let dir = TempDir::new("cli-symlink");
        let source = dir.path().join("server");
        let dev_build = dir.path().join("dev-build");
        let target = dir.path().join("harness-dashboard");

        fs::write(&source, b"release").expect("write source");
        fs::write(&dev_build, b"dev").expect("write dev build");
        std::os::unix::fs::symlink(&dev_build, &target).expect("symlink");

        assert_eq!(sync(&source, &target).expect("sync"), Synced::SymlinkKept);
        assert!(
            fs::symlink_metadata(&target)
                .expect("metadata")
                .file_type()
                .is_symlink()
        );
        assert_eq!(fs::read_link(&target).expect("read link"), dev_build);
        assert_eq!(fs::read(&dev_build).expect("read dev build"), b"dev");
    }

    #[cfg(unix)]
    #[test]
    fn a_link_planted_at_a_temporary_name_is_never_written_through() {
        let dir = TempDir::new("cli-temp-link");
        let source = dir.path().join("server");
        let victim = dir.path().join("victim");
        let target = dir.path().join("harness-dashboard");

        fs::write(&source, b"release").expect("write source");
        fs::write(&victim, b"keep").expect("write victim");

        for attempt in 0..3 {
            let planted = dir
                .path()
                .join(format!(".harness-dashboard.{}.{attempt}.tmp", std::process::id()));
            std::os::unix::fs::symlink(&victim, planted).expect("plant link");
        }

        assert_eq!(sync(&source, &target).expect("sync"), Synced::Updated);
        assert_eq!(fs::read(&target).expect("read target"), b"release");
        assert_eq!(fs::read(&victim).expect("read victim"), b"keep");
        assert!(
            !fs::symlink_metadata(&target)
                .expect("metadata")
                .file_type()
                .is_symlink()
        );
    }

    #[cfg(unix)]
    #[test]
    fn the_copy_is_executable() {
        use std::os::unix::fs::PermissionsExt;

        let dir = TempDir::new("cli-mode");
        let source = dir.path().join("server");
        let target = dir.path().join("harness-dashboard");
        fs::write(&source, b"#!/bin/sh\n").expect("write source");

        sync(&source, &target).expect("sync");

        let mode = fs::metadata(&target).expect("metadata").permissions().mode();
        assert_eq!(mode & 0o777, 0o755);
    }

    #[test]
    fn a_running_command_is_moved_aside_to_a_free_name() {
        let target = Path::new("C:/Programs/harness-dashboard/harness-dashboard.exe");
        let old = target.with_file_name("harness-dashboard.exe.old");
        let second = target.with_file_name("harness-dashboard.exe.old.1");
        let third = target.with_file_name("harness-dashboard.exe.old.2");

        assert_eq!(aside_path(target, |_| false), Some(old.clone()));
        assert_eq!(aside_path(target, |path| path == old), Some(second.clone()));
        assert_eq!(aside_path(target, |path| path == old || path == second), Some(third));
        assert_eq!(aside_path(target, |_| true), None);
    }

    #[test]
    fn only_the_commands_moved_aside_are_removed() {
        let dir = TempDir::new("cli-asides");
        let target = dir.path().join("harness-dashboard.exe");

        for name in [
            "harness-dashboard.exe",
            "harness-dashboard.exe.old",
            "harness-dashboard.exe.old.3",
            "harness-dashboard.exe.older",
            "harness-dashboard.exe.old.x",
            "other.exe.old",
        ] {
            fs::write(dir.path().join(name), b"").expect("write");
        }

        remove_asides(&target);

        let mut left: Vec<_> = fs::read_dir(dir.path())
            .expect("list")
            .flatten()
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .collect();
        left.sort();

        assert_eq!(
            left,
            [
                "harness-dashboard.exe",
                "harness-dashboard.exe.old.x",
                "harness-dashboard.exe.older",
                "other.exe.old",
            ]
        );
    }

    // Checked by name only: Windows drops a trailing dot, so "….old." can't be made on disk there.
    #[test]
    fn a_name_is_an_aside_only_with_old_and_an_optional_number() {
        let name = "harness-dashboard.exe";

        assert!(is_aside(name, "harness-dashboard.exe.old"));
        assert!(is_aside(name, "harness-dashboard.exe.old.12"));
        assert!(!is_aside(name, "harness-dashboard.exe.old."));
        assert!(!is_aside(name, "harness-dashboard.exe.old.x"));
        assert!(!is_aside(name, "harness-dashboard.exe.older"));
        assert!(!is_aside(name, "other.exe.old"));
    }

    #[test]
    fn only_launchers_that_run_the_command_are_legacy() {
        let legacy = "[Desktop Entry]\nType=Application\nName=Harness Dashboard\nExec=/home/ada/.local/bin/harness-dashboard\nIcon=harness-dashboard\n";
        let quoted = "[Desktop Entry]\nExec=\"/home/ada lovelace/.local/bin/harness-dashboard\" serve\n";
        let appimage = "[Desktop Entry]\nExec=/home/ada/.local/lib/harness-dashboard/harness-dashboard.AppImage\nStartupWMClass=harness-dashboard-app\n";
        let app = "[Desktop Entry]\nExec=harness-dashboard-app\n";

        assert!(is_legacy_launcher(legacy));
        assert!(is_legacy_launcher(quoted));
        assert!(!is_legacy_launcher(appimage));
        assert!(!is_legacy_launcher(app));
        assert!(!is_legacy_launcher("[Desktop Entry]\nName=Harness Dashboard\n"));
    }

    #[test]
    fn only_the_hidden_chromium_entries_of_the_dashboard_are_legacy() {
        let entry = "[Desktop Entry]\nType=Application\nName=Harness Dashboard\nExec=/home/ada/.local/bin/harness-dashboard\nIcon=harness-dashboard\nNoDisplay=true\n";
        let other_app = entry.replace("Name=Harness Dashboard", "Name=Other");

        assert!(is_legacy_alias("chrome-localhost__-Default.desktop", entry));
        assert!(is_legacy_alias("brave-127.0.0.1__-Default.desktop", entry));
        assert!(!is_legacy_alias("chrome-localhost__-Default.desktop", &other_app));
        assert!(!is_legacy_alias("firefox-localhost__-Default.desktop", entry));
        assert!(!is_legacy_alias("harness-dashboard.desktop", entry));
    }

    #[test]
    fn the_linux_cleanup_removes_only_legacy_entries() {
        let dir = TempDir::new("cli-legacy-linux");
        let apps = dir.path();
        let alias = "[Desktop Entry]\nType=Application\nName=Harness Dashboard\nExec=/x/harness-dashboard\nIcon=harness-dashboard\nNoDisplay=true\n";
        let kept_alias = "[Desktop Entry]\nName=My web app\nNoDisplay=true\n";

        fs::write(
            apps.join("harness-dashboard.desktop"),
            "[Desktop Entry]\nExec=/x/harness-dashboard\n",
        )
        .expect("write");
        fs::write(apps.join("chromium-localhost__-Default.desktop"), alias).expect("write");
        fs::write(apps.join("chrome-example.com__-Default.desktop"), kept_alias).expect("write");

        remove_legacy_linux_entries(apps);

        assert!(!apps.join("harness-dashboard.desktop").exists());
        assert!(!apps.join("chromium-localhost__-Default.desktop").exists());
        assert!(apps.join("chrome-example.com__-Default.desktop").exists());

        let current = "[Desktop Entry]\nExec=/x/harness-dashboard.AppImage\n";
        fs::write(apps.join("harness-dashboard.desktop"), current).expect("write");

        remove_legacy_linux_entries(apps);

        assert!(apps.join("harness-dashboard.desktop").exists());
    }

    #[test]
    fn only_the_script_launcher_app_is_legacy() {
        let dir = TempDir::new("cli-legacy-mac");
        let legacy = dir.path().join("legacy.app");
        let current = dir.path().join("current.app");

        for (bundle, executable) in [(&legacy, "launcher"), (&current, "harness-dashboard-app")] {
            let executables = bundle.join("Contents").join("MacOS");
            fs::create_dir_all(&executables).expect("create bundle");
            fs::write(executables.join(executable), b"").expect("write executable");
        }

        assert!(is_legacy_mac_app(&legacy));
        assert!(!is_legacy_mac_app(&current));
        assert!(!is_legacy_mac_app(&dir.path().join("missing.app")));
    }
}
