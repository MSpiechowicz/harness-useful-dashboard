//! App lifecycle: closing the window hides it, quitting stops the dashboard server.
//!
//! The app is meant to keep running in the tray: the server it started sends the budget alerts,
//! so closing the main window only hides it (the tray, a second launch or the macOS Dock bring it
//! back). The exceptions are a server that could not start and a tray icon that could not be
//! created, where closing the window quits, and an explicit quit (tray menu, Settings > Quit,
//! Cmd+Q / the app menu), which exits the app.
//!
//! On exit (including a relaunch after an update) the server this app started is stopped before
//! the process ends: its stdin is closed and it is killed after `sidecar::STOP_GRACE`.

use tauri::{AppHandle, Manager, RunEvent, Runtime, Window, WindowEvent};

use crate::sidecar::{Phase, Sidecar};
use crate::tray;
use crate::window::MAIN_WINDOW;

/// `Builder::on_window_event` hook.
pub fn on_window_event<R: Runtime>(window: &Window<R>, event: &WindowEvent) {
    let WindowEvent::CloseRequested { api, .. } = event else {
        return;
    };

    if window.label() != MAIN_WINDOW {
        return;
    }

    let server_failed = window
        .try_state::<Sidecar>()
        .is_some_and(|sidecar| sidecar.phase() == Phase::Failed);

    if !closing_hides(server_failed, tray::is_ready(window)) {
        return;
    }

    api.prevent_close();

    if let Err(error) = window.hide() {
        tracing::warn!(%error, "cannot hide the main window");
    }
}

/// Whether closing the main window only hides it. It quits instead when no server runs that
/// would need the tray, or when there is no tray to bring the window back.
fn closing_hides(server_failed: bool, has_tray: bool) -> bool {
    has_tray && !server_failed
}

/// `App::run` callback.
pub fn on_run_event<R: Runtime>(app: &AppHandle<R>, event: RunEvent) {
    match event {
        RunEvent::Exit => {
            if let Some(sidecar) = app.try_state::<Sidecar>() {
                sidecar.stop();
            }
        }
        // A click on the Dock icon while the window is hidden.
        #[cfg(target_os = "macos")]
        RunEvent::Reopen { .. } => crate::window::focus_main_window(app),
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn closing_hides_the_window_only_while_the_tray_can_bring_it_back() {
        assert!(closing_hides(false, true));
        assert!(!closing_hides(false, false), "no tray: closing quits");
        assert!(!closing_hides(true, true), "failed server: closing quits");
        assert!(!closing_hides(true, false));
    }
}
