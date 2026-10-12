//! Logging policy.
//!
//! Logs go to the OS log directory (and stdout in debug builds) at `Info`. They describe what
//! the app does, never what the user sees or types: usage data, IPC payloads, file contents and
//! secrets (the dashboard's sign-in token) must never be logged. The filter drops the targets that
//! could carry payloads, and the webview cannot log at all (the log plugin's `log` command is not
//! granted). The dashboard server's stderr is logged with token-like text removed (see `sidecar`).

use tauri::Runtime;
use tauri::plugin::TauriPlugin;
use tauri_plugin_log::log::{LevelFilter, Metadata};
use tauri_plugin_log::{RotationStrategy, Target, TargetKind, WEBVIEW_TARGET};

/// Log targets that may carry IPC payloads or webview console output.
const PAYLOAD_TARGETS: &[&str] = &["tauri::ipc", WEBVIEW_TARGET];

/// Size at which the log file is rotated.
const MAX_LOG_FILE_BYTES: u128 = 1024 * 1024;

/// Number of rotated log files kept.
const KEPT_LOG_FILES: usize = 3;

/// The configured log plugin.
pub fn plugin<R: Runtime>() -> TauriPlugin<R> {
    let mut targets = vec![Target::new(TargetKind::LogDir { file_name: None })];

    if cfg!(debug_assertions) {
        targets.push(Target::new(TargetKind::Stdout));
    }

    tauri_plugin_log::Builder::new()
        .clear_targets()
        .targets(targets)
        .level(LevelFilter::Info)
        // zbus logs every single-instance D-Bus call (including its argv signature) at info.
        .level_for("zbus", LevelFilter::Warn)
        .filter(is_payload_free)
        .max_file_size(MAX_LOG_FILE_BYTES)
        .rotation_strategy(RotationStrategy::KeepSome(KEPT_LOG_FILES))
        .build()
}

fn is_payload_free(metadata: &Metadata) -> bool {
    let target = metadata.target();

    !PAYLOAD_TARGETS.iter().any(|blocked| target.starts_with(blocked))
}
