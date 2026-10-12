//! Build script: generates the Tauri context and the app ACL manifest.
//!
//! Listing the commands in an [`AppManifest`] makes Tauri generate `allow-<command>` /
//! `deny-<command>` permissions for them and enforce the ACL on app commands. No static
//! capability grants them: the shell grants them at runtime to the dashboard's exact origin once
//! the server reported it (see `src/window.rs`).

use tauri_build::{AppManifest, Attributes};

/// Every `#[tauri::command]` in `src/commands`; keep in sync with `generate_handler!` in `lib.rs`
/// and `REMOTE_PERMISSIONS` in `src/window.rs`.
const COMMANDS: &[&str] = &["update_check", "update_install", "app_relaunch", "launch_sound"];

fn main() {
    let attributes = Attributes::new().app_manifest(AppManifest::new().commands(COMMANDS));

    if let Err(error) = tauri_build::try_build(attributes) {
        // Build scripts report failures by panicking; `{error:#}` keeps the whole cause chain.
        panic!("tauri build script failed: {error:#}");
    }
}
