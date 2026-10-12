//! Harness Dashboard: the app shell. It starts the dashboard server (the Bun binary bundled next to
//! it, see `sidecar`), shows the dashboard in a native window, keeps running in the tray, and
//! updates itself. The dashboard itself lives in the server; the shell adds only the in-app
//! updater and the native launch sound as IPC commands.

mod cli_link;
mod commands;
mod error;
mod lifecycle;
mod logging;
mod sidecar;
#[cfg(test)]
mod test_support;
mod tray;
mod update;
mod updates;
mod window;
mod window_icon;

use std::process::ExitCode;

use tauri::Manager;
use tauri_plugin_window_state::StateFlags;

use crate::sidecar::Sidecar;
use crate::updates::Updates;

/// Builds and runs the app until it quits; the server it started is stopped first.
pub fn run() -> ExitCode {
    let result = tauri::Builder::default()
        // Must be registered first so a second launch exits before anything else starts.
        // Its argv is ignored: nothing from another process is forwarded to the webview.
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            window::focus_main_window(app);
        }))
        // Size, position and so on, but not visibility: the window was hidden whenever the app
        // was quit from the tray, and must still open on the next start.
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(StateFlags::all() - StateFlags::VISIBLE)
                .build(),
        )
        .plugin(tauri_plugin_opener::init())
        .plugin(logging::plugin())
        // Driven from the update commands only; its own JS commands are not granted to the webview.
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            app.manage(Updates::from_config(app.config()));
            app.manage(Sidecar::default());
            window::create_main_window(app)?;
            tray::create_tray(app);
            // Opens the audio device now, so the splash's sound starts without delay.
            commands::sound::warm_up();

            let version = app.package_info().version.to_string();
            tracing::info!(%version, "Harness Dashboard started");

            sidecar::start(app.handle());
            cli_link::sync_in_background(app.handle());

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::updates::update_check,
            commands::updates::update_install,
            commands::updates::app_relaunch,
            commands::sound::launch_sound,
        ])
        .on_window_event(lifecycle::on_window_event)
        .build(tauri::generate_context!());

    match result {
        Ok(app) => {
            // Exit stops the server this app started; see `lifecycle`.
            app.run(lifecycle::on_run_event);
            ExitCode::SUCCESS
        }
        Err(error) => {
            // The logger may not be running yet, so report on stderr as well.
            eprintln!("Harness Dashboard failed: {error}");
            tracing::error!(%error, "application failed");

            ExitCode::FAILURE
        }
    }
}
