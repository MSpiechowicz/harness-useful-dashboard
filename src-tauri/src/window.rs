//! The main window, created from its `tauri.conf.json` entry (`"create": false`) so that
//! navigation, pop-up and download guards are attached before any page loads.
//!
//! It opens on the bundled loading page and moves to the dashboard once the server reported its
//! sign-in link (see `sidecar`). From then on the window stays on the server's exact origin
//! (`http://127.0.0.1:<port>`), and only that origin is granted the app's IPC commands, through a
//! capability added at runtime. Links to anywhere else open in the default browser.

use std::ffi::OsStr;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock, PoisonError};

use tauri::ipc::CapabilityBuilder;
use tauri::webview::{DownloadEvent, NewWindowResponse, PageLoadEvent, PageLoadPayload};
use tauri::{App, AppHandle, Manager, Runtime, Url, Webview, WebviewWindow, WebviewWindowBuilder};
use tauri_plugin_opener::OpenerExt;

/// Label of the only window.
pub const MAIN_WINDOW: &str = "main";

/// Identifier of the runtime capability that grants the dashboard page its commands.
const DASHBOARD_CAPABILITY: &str = "dashboard";

/// The commands the dashboard page may call (`web/src/lib/shell.ts`); every command in `build.rs`.
/// No `core:*` or plugin permission is granted: Channel delivery is not ACL-gated, and the plugins
/// are driven from Rust only.
pub const REMOTE_PERMISSIONS: &[&str] = &[
    "allow-update-check",
    "allow-update-install",
    "allow-app-relaunch",
    "allow-launch-sound",
];

/// Release builds suppress the webview's default context menu (Reload, Back, Inspect, ...) except
/// over editable fields and selected text, where Copy/Paste stay useful. Tauri has no setting
/// for this; initialization scripts are injected by the webview itself, outside the page CSP.
const CONTEXT_MENU_SCRIPT: &str = r#"
window.addEventListener('contextmenu', (event) => {
  const target = event.target instanceof Element ? event.target : null;
  const editable = target?.closest('input, textarea, [contenteditable]:not([contenteditable="false"])');
  const selected = (window.getSelection()?.toString() ?? '') !== '';
  if (!editable && !selected) {
    event.preventDefault();
  }
}, { capture: true });
"#;

/// What the window's guards know about the dashboard. Managed as app state.
#[derive(Clone, Default)]
pub struct Dashboard(Arc<DashboardInner>);

#[derive(Default)]
struct DashboardInner {
    /// The server's origin, once it reported its link.
    origin: OnceLock<Url>,
    loading: Mutex<LoadingPage>,
}

/// The loading page can show a startup error only once it has loaded; an error that comes
/// earlier waits here.
#[derive(Default)]
struct LoadingPage {
    loaded: bool,
    error_script: Option<String>,
}

impl Dashboard {
    fn origin(&self) -> Option<&Url> {
        self.0.origin.get()
    }

    fn loading(&self) -> std::sync::MutexGuard<'_, LoadingPage> {
        self.0.loading.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn page_loaded<R: Runtime>(&self, window: &WebviewWindow<R>, payload: &PageLoadPayload<'_>) {
        if payload.event() != PageLoadEvent::Finished || !is_bundled_page(payload.url()) {
            return;
        }

        let script = {
            let mut loading = self.loading();
            loading.loaded = true;
            loading.error_script.clone()
        };

        if let Some(script) = script {
            run_script(window, &script);
        }
    }
}

/// Creates the main window on the loading page, with:
/// - a navigation guard that allows the loading page until the dashboard is known, then only the
///   dashboard's origin; other http(s) addresses open in the default browser;
/// - a pop-up guard that opens `window.open` / `target="_blank"` http(s) links in the default
///   browser and never in the app;
/// - a download guard that saves the dashboard's exports (blob URLs) to the Downloads folder;
/// - the context-menu script in release builds.
pub fn create_main_window<R: Runtime>(app: &App<R>) -> tauri::Result<WebviewWindow<R>> {
    let config = app
        .config()
        .app
        .windows
        .iter()
        .find(|window| window.label == MAIN_WINDOW)
        .cloned()
        .ok_or_else(|| tauri::Error::WindowNotFound)?;

    let dashboard = Dashboard::default();
    app.manage(dashboard.clone());

    let navigation = (app.handle().clone(), dashboard.clone());
    let popups = app.handle().clone();
    let downloads = dashboard.clone();
    let loads = dashboard;

    let mut builder = WebviewWindowBuilder::from_config(app.handle(), &config)?
        .on_navigation(move |url| allow_navigation(&navigation.0, &navigation.1, url))
        .on_new_window(move |url, _features| {
            open_outside(&popups, &url, "pop-up");
            NewWindowResponse::Deny
        })
        .on_download(move |webview, event| allow_download(&webview, &downloads, event))
        .on_page_load(move |window, payload| loads.page_loaded(&window, &payload));

    if !cfg!(debug_assertions) {
        builder = builder.initialization_script(CONTEXT_MENU_SCRIPT);
    }

    builder.build()
}

/// Brings the main window to the front (second launch, tray, macOS Dock).
pub fn focus_main_window<R: Runtime, M: Manager<R>>(manager: &M) {
    let Some(window) = manager.get_webview_window(MAIN_WINDOW) else {
        return;
    };

    let raised = window
        .unminimize()
        .and_then(|()| window.show())
        .and_then(|()| window.set_focus());

    if let Err(error) = raised {
        tracing::warn!(%error, "cannot focus the main window");
    }
}

/// Grants the dashboard at `link` its commands and opens it. `link` is the server's sign-in link,
/// already validated (`sidecar::parse_line`); it is never logged.
pub fn open_dashboard<R: Runtime>(app: &AppHandle<R>, link: &Url) {
    let Some(dashboard) = app.try_state::<Dashboard>() else {
        return;
    };

    let mut origin = link.clone();
    origin.set_query(None);

    // Set before navigating: the navigation guard allows the dashboard from now on.
    if dashboard.0.origin.set(origin.clone()).is_err() {
        tracing::warn!("the dashboard was already opened");
        return;
    }

    if let Err(error) = app.add_capability(dashboard_capability(&origin)) {
        tracing::error!(%error, "cannot grant the dashboard its commands; updates and the launch sound are off");
    }

    let Some(window) = app.get_webview_window(MAIN_WINDOW) else {
        return;
    };

    match window.navigate(link.clone()) {
        Ok(()) => tracing::info!(port = origin.port(), "opening the dashboard"),
        Err(error) => tracing::error!(%error, "cannot open the dashboard"),
    }
}

/// The runtime capability for the dashboard's origin: [`REMOTE_PERMISSIONS`] in the main window,
/// for pages of exactly that origin, and nothing for the loading page.
fn dashboard_capability(origin: &Url) -> CapabilityBuilder {
    let pattern = remote_pattern(origin);

    REMOTE_PERMISSIONS.iter().fold(
        CapabilityBuilder::new(DASHBOARD_CAPABILITY)
            .remote(pattern)
            .local(false)
            .window(MAIN_WINDOW),
        |capability, permission| capability.permission(*permission),
    )
}

/// `http://127.0.0.1:<port>/*`: every page of the origin, whatever its query.
fn remote_pattern(origin: &Url) -> String {
    format!("{}/*", origin.origin().ascii_serialization())
}

/// Shows `text` (or the page's own generic message) on the loading page, as soon as it has
/// loaded, and brings the window up so the error is seen.
pub fn show_startup_error<R: Runtime>(app: &AppHandle<R>, lang: &str, text: Option<&str>) {
    let Some(dashboard) = app.try_state::<Dashboard>() else {
        return;
    };

    let script = startup_error_script(lang, text);

    let loaded = {
        let mut loading = dashboard.loading();
        loading.error_script = Some(script.clone());
        loading.loaded
    };

    if loaded && let Some(window) = app.get_webview_window(MAIN_WINDOW) {
        run_script(&window, &script);
    }

    focus_main_window(app);
}

/// Calls the loading page's `showStartupError(lang, text)`; the values are JSON-encoded, so any
/// text is passed as data.
fn startup_error_script(lang: &str, text: Option<&str>) -> String {
    let lang = serde_json::Value::from(lang);
    let text = text.map_or(serde_json::Value::Null, serde_json::Value::from);

    format!("if (typeof window.showStartupError === 'function') window.showStartupError({lang}, {text});")
}

fn run_script<R: Runtime>(window: &WebviewWindow<R>, script: &str) {
    if let Err(error) = window.eval(script) {
        tracing::warn!(%error, "cannot show the startup error");
    }
}

fn allow_navigation<R: Runtime>(app: &AppHandle<R>, dashboard: &Dashboard, url: &Url) -> bool {
    if is_allowed(url, dashboard.origin()) {
        return true;
    }

    // The loading page once the dashboard is known (its first load can come late, or Back): stay.
    if is_bundled_page(url) {
        return false;
    }

    open_outside(app, url, "navigation");
    false
}

/// Before the dashboard is known, only the bundled loading page. After, only the dashboard's
/// origin (including its `blob:` URLs): going back to the loading page would wait forever.
fn is_allowed(url: &Url, dashboard: Option<&Url>) -> bool {
    match dashboard {
        Some(dashboard) => url.origin() == dashboard.origin(),
        None => is_bundled_page(url),
    }
}

/// True for the bundled loading page (`tauri://localhost` on Linux/macOS,
/// `http(s)://tauri.localhost` on Windows).
fn is_bundled_page(url: &Url) -> bool {
    match url.scheme() {
        "tauri" => url.host_str() == Some("localhost"),
        "http" | "https" => url.host_str() == Some("tauri.localhost"),
        _ => false,
    }
}

/// Opens an http(s) `url` in the default browser; anything else is only blocked.
fn open_outside<R: Runtime>(app: &AppHandle<R>, url: &Url, kind: &str) {
    if !matches!(url.scheme(), "http" | "https") {
        log_blocked(kind, url);
        return;
    }

    if let Err(error) = app.opener().open_url(url.as_str(), None::<&str>) {
        tracing::warn!(%error, kind, host = url.host_str().unwrap_or_default(), "cannot open a link in the browser");
    }
}

/// Saves downloads of the dashboard (its CSV/JSON exports are `blob:` URLs of its origin) to the
/// Downloads folder, under the file name the webview chose; refuses all others, and any download
/// without a Downloads folder or a usable file name.
fn allow_download<R: Runtime>(webview: &Webview<R>, dashboard: &Dashboard, event: DownloadEvent<'_>) -> bool {
    match event {
        DownloadEvent::Requested { url, destination } => {
            let from_dashboard = dashboard.origin().is_some_and(|origin| url.origin() == origin.origin());

            if !from_dashboard {
                log_blocked("download", &url);
                return false;
            }

            let downloads = match webview.path().download_dir() {
                Ok(downloads) => downloads,
                Err(error) => {
                    tracing::warn!(%error, "cannot find the Downloads folder; the download is refused");
                    return false;
                }
            };

            let Some(saved_to) = download_destination(&downloads, destination) else {
                tracing::warn!("the download has no usable file name; it is refused");
                return false;
            };

            *destination = saved_to;
            true
        }
        DownloadEvent::Finished { success, .. } => {
            tracing::info!(success, "download finished");
            true
        }
        _ => true,
    }
}

/// `downloads` joined with only the file name of `chosen`, whatever folders `chosen` names; `None`
/// when it has no file name, or one that is empty, `.` or `..`.
fn download_destination(downloads: &Path, chosen: &Path) -> Option<PathBuf> {
    let name = chosen.file_name()?;

    if name.is_empty() || name == OsStr::new(".") || name == OsStr::new("..") {
        return None;
    }

    Some(downloads.join(name))
}

/// Logs only scheme and host: paths and queries may carry user content or the token.
fn log_blocked(kind: &str, url: &Url) {
    tracing::warn!(
        kind,
        scheme = url.scheme(),
        host = url.host_str().unwrap_or_default(),
        "blocked a request to leave the app"
    );
}

#[cfg(test)]
mod tests {
    use std::str::FromStr;

    use tauri::ipc::RuntimeCapability;
    use tauri::utils::acl::RemoteUrlPattern;
    use tauri::utils::acl::capability::CapabilityFile;

    use super::*;

    fn url(raw: &str) -> Url {
        Url::parse(raw).expect("valid test URL")
    }

    fn dashboard() -> Url {
        url("http://127.0.0.1:4317/")
    }

    #[test]
    fn the_loading_page_is_allowed_until_the_dashboard_is_known() {
        for raw in [
            "tauri://localhost/index.html",
            "http://tauri.localhost/",
            "https://tauri.localhost/",
        ] {
            assert!(is_allowed(&url(raw), None), "{raw}");
            assert!(!is_allowed(&url(raw), Some(&dashboard())), "{raw}");
        }
    }

    #[test]
    fn the_dashboard_origin_is_allowed_with_any_path_and_its_blobs() {
        for raw in [
            "http://127.0.0.1:4317/?k=abc",
            "http://127.0.0.1:4317/settings",
            "blob:http://127.0.0.1:4317/6a1f0c2e-1111-4222-8333-444455556666",
        ] {
            assert!(is_allowed(&url(raw), Some(&dashboard())), "{raw}");
            assert!(!is_allowed(&url(raw), None), "{raw}");
        }
    }

    #[test]
    fn foreign_origins_are_blocked() {
        for raw in [
            "http://127.0.0.1:4318/",
            "http://localhost:4317/",
            "https://127.0.0.1:4317/",
            "https://github.com/MSpiechowicz/harness-useful-dashboard",
            "https://tauri.localhost.evil.com/",
            "tauri://evil/",
            "file:///etc/passwd",
            "data:text/html,hi",
            "javascript:alert(1)",
            "about:blank",
        ] {
            assert!(!is_allowed(&url(raw), Some(&dashboard())), "{raw}");
            assert!(!is_allowed(&url(raw), None), "{raw}");
        }
    }

    #[test]
    fn the_capability_grants_the_page_commands_to_exactly_the_dashboard_origin() {
        let CapabilityFile::Capability(capability) = dashboard_capability(&dashboard()).build() else {
            panic!("a single capability");
        };

        assert!(!capability.local);
        assert_eq!(capability.windows, [MAIN_WINDOW]);
        assert_eq!(capability.permissions.len(), REMOTE_PERMISSIONS.len());

        let urls = capability.remote.expect("remote").urls;
        assert_eq!(urls, ["http://127.0.0.1:4317/*"]);

        let pattern = RemoteUrlPattern::from_str(&urls[0]).expect("valid pattern");
        assert!(pattern.test(&url("http://127.0.0.1:4317/")));
        assert!(pattern.test(&url("http://127.0.0.1:4317/?k=abc")));
        assert!(pattern.test(&url("http://127.0.0.1:4317/settings#limits")));
        assert!(!pattern.test(&url("http://127.0.0.1:4318/")));
        assert!(!pattern.test(&url("http://localhost:4317/")));
        assert!(!pattern.test(&url("https://127.0.0.1:4317/")));
    }

    #[test]
    fn downloads_are_saved_in_the_downloads_folder_under_their_file_name_only() {
        let downloads = Path::new("/home/ada/Downloads");
        let saved = |chosen: &str| download_destination(downloads, Path::new(chosen));

        assert_eq!(
            saved("/home/ada/Downloads/usage.csv"),
            Some(downloads.join("usage.csv"))
        );
        assert_eq!(saved("usage.csv"), Some(downloads.join("usage.csv")));
        assert_eq!(saved("/tmp/elsewhere/usage.json"), Some(downloads.join("usage.json")));
        assert_eq!(
            saved("/home/ada/Downloads/../.bashrc"),
            Some(downloads.join(".bashrc")),
            "a prefix of the Downloads folder does not keep the folders after it"
        );
    }

    #[test]
    fn downloads_without_a_usable_file_name_are_refused() {
        let downloads = Path::new("/home/ada/Downloads");

        for chosen in ["", ".", "..", "/", "/home/ada/Downloads/.."] {
            assert_eq!(download_destination(downloads, Path::new(chosen)), None, "{chosen:?}");
        }
    }

    #[test]
    fn startup_errors_reach_the_page_as_data() {
        let script = startup_error_script("pl", Some("Port 4317 jest zajęty'); alert(1); ('"));

        assert_eq!(
            script,
            "if (typeof window.showStartupError === 'function') window.showStartupError(\"pl\", \"Port 4317 jest zajęty'); alert(1); ('\");"
        );
        assert!(startup_error_script("en", None).ends_with("window.showStartupError(\"en\", null);"));
    }
}
