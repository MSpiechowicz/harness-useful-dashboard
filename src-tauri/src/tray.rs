//! The system tray (menu bar on macOS) icon: the dashboard's mark without its tile. Closing the
//! window only hides it, so the server keeps running and budget alerts still fire; the tray brings
//! the window back or quits. Quitting goes through the normal exit path, so the server is stopped
//! first (see `lifecycle`). A left click on the icon brings the window back where the platform
//! reports clicks (Linux tray indicators only open the menu).
//!
//! The menu is in the dashboard's UI language, which the server reports at startup; it starts in
//! English until then.

use tauri::image::Image;
use tauri::menu::{Menu, MenuEvent, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent};
use tauri::{App, AppHandle, Manager, Runtime};

use crate::window::{MAIN_WINDOW, focus_main_window};

/// 64 px render of `icons/source/tray.svg` (the dashboard mark, see `scripts/icons.ts`).
const ICON: &[u8] = include_bytes!("../icons/tray.png");

const SHOW: &str = "show";
const HIDE: &str = "hide";
const QUIT: &str = "quit";

/// The menu texts in one language.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Labels {
    show: &'static str,
    hide: &'static str,
    quit: &'static str,
}

/// The menu texts in `lang` (`en`, `de`, `es`, `fr`, `pl`); English for anything else.
fn labels(lang: &str) -> Labels {
    match lang {
        "de" => Labels {
            show: "Harness Dashboard anzeigen",
            hide: "Fenster ausblenden",
            quit: "Harness Dashboard beenden",
        },
        "es" => Labels {
            show: "Mostrar Harness Dashboard",
            hide: "Ocultar ventana",
            quit: "Salir de Harness Dashboard",
        },
        "fr" => Labels {
            show: "Afficher Harness Dashboard",
            hide: "Masquer la fenêtre",
            quit: "Quitter Harness Dashboard",
        },
        "pl" => Labels {
            show: "Pokaż Harness Dashboard",
            hide: "Ukryj okno",
            quit: "Zamknij Harness Dashboard",
        },
        _ => Labels {
            show: "Show Harness Dashboard",
            hide: "Hide window",
            quit: "Quit Harness Dashboard",
        },
    }
}

/// The menu items whose texts follow the UI language. Managed as app state.
struct TrayMenu<R: Runtime> {
    show: MenuItem<R>,
    hide: MenuItem<R>,
    quit: MenuItem<R>,
}

/// Adds the tray icon. Failing to create it is not fatal: the app works without a tray.
pub fn create_tray<R: Runtime>(app: &App<R>) {
    // On Linux the indicator library is loaded on first use, and `libappindicator-sys` panics when no
    // usable copy loads (missing, or built against a newer GLib than the AppImage bundles).
    match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| build(app))) {
        Ok(Ok(_)) => {}
        Ok(Err(error)) => tracing::warn!(%error, "cannot create the tray icon"),
        Err(_) => tracing::warn!("cannot create the tray icon: the system tray library failed to load"),
    }
}

fn build<R: Runtime>(app: &App<R>) -> tauri::Result<TrayIcon<R>> {
    let labels = labels("en");
    let show = MenuItem::with_id(app, SHOW, labels.show, true, None::<&str>)?;
    let hide = MenuItem::with_id(app, HIDE, labels.hide, true, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, QUIT, labels.quit, true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &hide, &separator, &quit])?;

    let tray = TrayIconBuilder::with_id("main")
        .icon(Image::from_bytes(ICON)?)
        .tooltip("Harness Dashboard")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(on_menu_event)
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                focus_main_window(tray.app_handle());
            }
        })
        .build(app)?;

    app.manage(TrayMenu { show, hide, quit });

    Ok(tray)
}

/// True once the tray icon exists: without it, a hidden window could not be brought back.
pub fn is_ready<R: Runtime, M: Manager<R>>(manager: &M) -> bool {
    manager.try_state::<TrayMenu<R>>().is_some()
}

/// Shows the menu in `lang`, the UI language the server reported.
pub fn set_language<R: Runtime>(app: &AppHandle<R>, lang: &str) {
    let Some(menu) = app.try_state::<TrayMenu<R>>() else {
        return;
    };

    let labels = labels(lang);

    let renamed = menu
        .show
        .set_text(labels.show)
        .and_then(|()| menu.hide.set_text(labels.hide))
        .and_then(|()| menu.quit.set_text(labels.quit));

    if let Err(error) = renamed {
        tracing::warn!(%error, "cannot translate the tray menu");
    }
}

fn on_menu_event<R: Runtime>(app: &AppHandle<R>, event: MenuEvent) {
    match event.id().as_ref() {
        SHOW => focus_main_window(app),
        HIDE => {
            if let Some(window) = app.get_webview_window(MAIN_WINDOW)
                && let Err(error) = window.hide()
            {
                tracing::warn!(%error, "cannot hide the main window");
            }
        }
        QUIT => app.exit(0),
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_ui_language_has_its_own_menu_and_others_get_english() {
        let english = labels("en");

        for lang in ["de", "es", "fr", "pl"] {
            assert_ne!(labels(lang), english, "{lang}");
        }

        assert_eq!(labels("xx"), english);
        assert_eq!(labels(""), english);
    }
}
