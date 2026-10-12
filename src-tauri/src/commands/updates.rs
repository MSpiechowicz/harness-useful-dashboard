//! Update commands: check the release manifest, install the update it announces, relaunch.
//!
//! The page applies the update policy (`web/src/lib/update.svelte.ts`): automatic checks honor the
//! dashboard's "check for updates" setting, a check the user asks for always runs, and nothing is
//! installed without the user's click. Every request goes to [`UPDATE_ENDPOINT`] or the HTTPS
//! download it lists, with nothing but the updater's standard headers. A download is installed
//! only when its signature matches the public key built into the app, was made for the announced
//! version (`requireSignedVersion`) and that version is newer than the running one. Releases must
//! be signed by `tauri build` (tauri-action), which binds each signature to the app version; a
//! signature made by hand without `--app-version` is refused as `forbidden`.
//!
//! The dashboard server is stopped before the new version starts: on Windows right before the
//! installer takes over (it replaces the server binary, which must not be running), elsewhere as
//! part of the relaunch, which exits the app the normal way (see `lifecycle`).

use std::time::Duration;

use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, State, Url};
use tauri_plugin_updater::{Error as UpdaterError, Update, Updater, UpdaterExt};
use time::format_description::well_known::Rfc3339;

use super::blocking;
use crate::error::{CommandError, CommandResult, ErrorCode};
use crate::sidecar::Sidecar;
use crate::update::{ProgressTracker, UPDATE_ENDPOINT, UpdateInfo, UpdateProgress};
use crate::updates::Updates;

/// Longest wait for a connection to the update server.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);

/// Longest wait for the next bytes of a response; a stalled check or download fails after it.
const READ_TIMEOUT: Duration = Duration::from_secs(30);

/// The newer release the manifest announces, or `null` when this version is current.
/// `unsupported` when this build has no updater public key (nothing is requested then).
#[tauri::command]
pub async fn update_check(app: AppHandle, updates: State<'_, Updates>) -> CommandResult<Option<UpdateInfo>> {
    check(&updates, |pubkey| updater(&app, pubkey)).await
}

/// Downloads, verifies and installs the update the last `update_check` found, reporting progress
/// on `on_progress`. On Windows the installer takes over and the app exits; elsewhere the new
/// version runs after `app_relaunch`. One install runs at a time.
#[tauri::command]
pub async fn update_install(updates: State<'_, Updates>, on_progress: Channel<UpdateProgress>) -> CommandResult<()> {
    install(&updates, &on_progress).await
}

/// Restarts the app (after an update was installed). The dashboard server is stopped first, as on
/// any exit.
#[tauri::command]
pub async fn app_relaunch(app: AppHandle) {
    tracing::info!("relaunching");
    app.request_restart();
}

/// The updater for this build: the fixed endpoint, `pubkey`, and a client that speaks HTTPS only.
fn updater(app: &AppHandle, pubkey: &str) -> Result<Updater, UpdaterError> {
    let endpoint = Url::parse(UPDATE_ENDPOINT)?;
    let exiting = app.clone();

    app.updater_builder()
        .pubkey(pubkey)
        .endpoints(vec![endpoint])?
        .configure_client(|client| {
            client
                .https_only(true)
                .connect_timeout(CONNECT_TIMEOUT)
                .read_timeout(READ_TIMEOUT)
        })
        // Windows only: runs before the installer starts and the app exits without the usual exit
        // events. Replaces the plugin's default hook, so its cleanup is called here as well.
        .on_before_exit(move || {
            if let Some(sidecar) = exiting.try_state::<Sidecar>() {
                sidecar.stop();
            }

            exiting.cleanup_before_exit();
        })
        .build()
}

async fn check(
    updates: &Updates,
    build: impl FnOnce(&str) -> Result<Updater, UpdaterError>,
) -> CommandResult<Option<UpdateInfo>> {
    let pubkey = updates.pubkey()?;
    let updater = build(pubkey).map_err(|error| updater_error("cannot check for updates", error))?;

    let found = updater
        .check()
        .await
        .map_err(|error| updater_error("cannot check for updates", error))?;

    let info = found.as_ref().map(announced);
    tracing::info!(available = ?info.as_ref().map(|info| &info.version), "update check finished");

    updates.set_pending(found);
    Ok(info)
}

fn announced(update: &Update) -> UpdateInfo {
    let date = update.date.and_then(|date| date.format(&Rfc3339).ok());

    UpdateInfo::announced(
        update.version.clone(),
        update.current_version.clone(),
        date,
        update.body.clone(),
    )
}

async fn install(updates: &Updates, on_progress: &Channel<UpdateProgress>) -> CommandResult<()> {
    updates.pubkey()?;

    let Ok(_installing) = updates.installing.try_lock() else {
        return Err(CommandError::new(
            ErrorCode::InvalidInput,
            "an update is already being installed",
        ));
    };

    let update = updates
        .pending()
        .ok_or_else(|| CommandError::new(ErrorCode::NotFound, "no update to install; check for updates first"))?;

    let mut tracker = ProgressTracker::default();
    let report = |progress: UpdateProgress| {
        // A closed channel only means the page went away; the install goes on.
        on_progress.send(progress).ok();
    };

    // `download` verifies the signature before returning the bytes.
    let bytes = update
        .download(
            |len, total| {
                if let Some(progress) = tracker.chunk(len, total) {
                    report(progress);
                }
            },
            || {},
        )
        .await
        .map_err(|error| updater_error("cannot download the update", error))?;

    report(tracker.installing());

    let installer = update.clone();
    blocking(move || {
        installer
            .install(bytes)
            .map_err(|error| updater_error("cannot install the update", error))
    })
    .await?;

    tracing::info!(version = %update.version, "update installed");
    updates.set_pending(None);
    report(tracker.done());

    Ok(())
}

/// Maps an updater failure onto the IPC error the page shows. Signature failures are `forbidden`;
/// the details go to the log only.
fn updater_error(context: &str, error: UpdaterError) -> CommandError {
    tracing::warn!(%error, "{context}");

    let code = match error {
        UpdaterError::Minisign(_)
        | UpdaterError::Base64(_)
        | UpdaterError::SignatureUtf8(_)
        | UpdaterError::SignedVersionMismatch { .. }
        | UpdaterError::MissingSignedVersion => ErrorCode::Forbidden,

        UpdaterError::ReleaseNotFound
        | UpdaterError::Serialization(_)
        | UpdaterError::Semver(_)
        | UpdaterError::TargetNotFound(_)
        | UpdaterError::TargetsNotFound(_)
        | UpdaterError::InvalidUpdaterFormat
        | UpdaterError::BinaryNotFoundInArchive => ErrorCode::Protocol,

        UpdaterError::UnsupportedArch
        | UpdaterError::UnsupportedOs
        | UpdaterError::FailedToDetermineExtractPath
        | UpdaterError::EmptyEndpoints
        | UpdaterError::InsecureTransportProtocol => ErrorCode::Unsupported,

        UpdaterError::AuthenticationFailed | UpdaterError::DebInstallFailed | UpdaterError::PackageInstallFailed => {
            ErrorCode::Process
        }

        UpdaterError::Reqwest(ref request) if request.is_timeout() => ErrorCode::Timeout,

        _ => ErrorCode::Io,
    };

    if code == ErrorCode::Forbidden {
        return CommandError::new(code, format!("{context}: the signature does not match this app"));
    }

    CommandError::new(code, format!("{context}: {error}"))
}

#[cfg(test)]
mod tests {
    use std::sync::PoisonError;

    use tauri::async_runtime::block_on;

    use super::*;
    use crate::test_support::collecting_channel;

    fn never_built(_pubkey: &str) -> Result<Updater, UpdaterError> {
        panic!("an updater was built, so the network could have been used");
    }

    fn configured() -> Updates {
        Updates::new(Some("a key the config check accepted".to_owned()))
    }

    fn nothing_reported(received: &std::sync::Mutex<Vec<serde_json::Value>>) -> bool {
        received.lock().unwrap_or_else(PoisonError::into_inner).is_empty()
    }

    #[test]
    fn without_a_key_checking_is_unsupported_and_requests_nothing() {
        let error = block_on(check(&Updates::new(None), never_built)).expect_err("updates are off");

        assert_eq!(error.code(), ErrorCode::Unsupported);
    }

    #[test]
    fn without_a_key_installing_is_unsupported_and_reports_nothing() {
        let (channel, received) = collecting_channel();

        let error = block_on(install(&Updates::new(None), &channel)).expect_err("updates are off");

        assert_eq!(error.code(), ErrorCode::Unsupported);
        assert!(nothing_reported(&received));
    }

    #[test]
    fn installing_needs_an_update_found_by_a_check() {
        let (channel, received) = collecting_channel();

        let error = block_on(install(&configured(), &channel)).expect_err("nothing to install");

        assert_eq!(error.code(), ErrorCode::NotFound);
        assert!(nothing_reported(&received));
    }

    #[test]
    fn a_second_install_is_refused_while_one_runs() {
        let updates = configured();
        let (channel, _received) = collecting_channel();
        let _running = updates.installing.try_lock().expect("no install yet");

        let error = block_on(install(&updates, &channel)).expect_err("one install at a time");

        assert_eq!(error.code(), ErrorCode::InvalidInput);
    }

    #[test]
    fn updater_failures_map_to_the_codes_the_page_shows() {
        let mismatch = UpdaterError::SignedVersionMismatch {
            signed: "0.1.0".to_owned(),
            announced: "0.2.0".to_owned(),
        };

        let cases = [
            (mismatch, ErrorCode::Forbidden),
            (UpdaterError::MissingSignedVersion, ErrorCode::Forbidden),
            (UpdaterError::ReleaseNotFound, ErrorCode::Protocol),
            (
                UpdaterError::TargetNotFound("linux-x86_64".to_owned()),
                ErrorCode::Protocol,
            ),
            (UpdaterError::UnsupportedOs, ErrorCode::Unsupported),
            (UpdaterError::InsecureTransportProtocol, ErrorCode::Unsupported),
            (UpdaterError::PackageInstallFailed, ErrorCode::Process),
            (UpdaterError::Network("status 503".to_owned()), ErrorCode::Io),
        ];

        for (error, code) in cases {
            let description = error.to_string();

            assert_eq!(updater_error("checking", error).code(), code, "{description}");
        }
    }
}
