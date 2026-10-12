//! The in-app updater's rules that do not depend on Tauri: where updates come from, whether this
//! build can verify them, what the page is told about a release, and how download progress is
//! reported.
//!
//! The update commands check [`UPDATE_ENDPOINT`] with `tauri-plugin-updater`, which verifies every
//! download against the public key built into the app before installing it. A build without a
//! usable key (see [`configured_pubkey`]) never contacts the endpoint.

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use minisign_verify::PublicKey;
use serde::Serialize;

/// The release manifest written by the release workflow (`tauri-action`, `includeUpdaterJson`).
/// The only URL the updater requests; the downloads it lists must be HTTPS as well.
pub const UPDATE_ENDPOINT: &str =
    "https://github.com/MSpiechowicz/harness-useful-dashboard/releases/latest/download/latest.json";

/// What `update_check` and `update_install` report when the build has no usable public key.
pub const UPDATES_NOT_CONFIGURED: &str = "updates are not configured for this build";

/// `plugins.updater.pubkey` in `tauri.conf.json` until the maintainer adds the real public key
/// (`docs/release-and-updater-keys.md`). It is not a key, so builds carrying it skip updates.
#[cfg(test)]
pub const PUBKEY_PLACEHOLDER: &str =
    "NOT_CONFIGURED: replace with the content of the updater .key.pub file (see docs/release-and-updater-keys.md)";

/// The configured updater public key when it is one the updater can verify signatures with:
/// the base64-encoded content of a minisign `.pub` file, as `tauri signer generate` writes it.
///
/// `None` for a missing or empty value, the placeholder, or anything else that does not decode to
/// a minisign public key. The updater decodes the key the same way.
pub fn configured_pubkey(value: Option<&str>) -> Option<&str> {
    let value = value?;

    let decoded = STANDARD.decode(value).ok()?;
    let text = std::str::from_utf8(&decoded).ok()?;

    PublicKey::decode(text).ok().map(|_| value)
}

/// An application update announced by the release manifest (`latest.json`).
///
/// Only announced: nothing is downloaded until `update_install`, and the download is installed
/// only when its signature matches the public key built into the app.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    /// The announced version (semver).
    pub version: String,
    /// The running version (semver).
    pub current_version: String,
    /// Publication time (RFC 3339), when the manifest has one.
    pub date: Option<String>,
    /// Release notes: the release body as plain text (usually Markdown), at most
    /// [`MAX_UPDATE_NOTES_BYTES`]. Untrusted: the page must render it as text or sanitized.
    pub notes: Option<String>,
}

/// Longest release notes kept in an [`UpdateInfo`]; longer notes are cut at a character boundary.
pub const MAX_UPDATE_NOTES_BYTES: usize = 64 * 1024;

impl UpdateInfo {
    /// The info shown for an announced release. Empty notes become `None`; notes longer than
    /// [`MAX_UPDATE_NOTES_BYTES`] are cut at a character boundary.
    pub fn announced(version: String, current_version: String, date: Option<String>, notes: Option<String>) -> Self {
        let notes = notes
            .filter(|notes| !notes.trim().is_empty())
            .map(|notes| cut_to(notes, MAX_UPDATE_NOTES_BYTES));

        Self {
            version,
            current_version,
            date,
            notes,
        }
    }
}

fn cut_to(mut text: String, max: usize) -> String {
    if text.len() <= max {
        return text;
    }

    let mut end = max;
    while !text.is_char_boundary(end) {
        end -= 1;
    }

    text.truncate(end);
    text
}

/// Stage of an update install.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum UpdatePhase {
    /// The update is being downloaded.
    Downloading,
    /// The download passed signature verification and is being installed.
    Installing,
    /// Installed; the new version runs after `app_relaunch`.
    Done,
}

/// Progress of an update install, sent over the `onProgress` channel of `update_install`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateProgress {
    /// The current stage.
    pub phase: UpdatePhase,
    /// Bytes downloaded so far.
    pub downloaded: u64,
    /// Size of the download in bytes, when the server reported a size that still holds.
    pub total: Option<u64>,
}

/// How many bytes pass between two download reports when the size is unknown.
pub const UNKNOWN_SIZE_REPORT_STEP: u64 = 512 * 1024;

/// Turns the updater's per-chunk download callbacks into [`UpdateProgress`] reports.
///
/// Downloads arrive in many small chunks, so [`chunk`](Self::chunk) reports at most once per
/// percent of a known size (or every [`UNKNOWN_SIZE_REPORT_STEP`] bytes otherwise), plus the first
/// chunk and the last one of a known size.
#[derive(Debug, Default)]
pub struct ProgressTracker {
    downloaded: u64,
    total: Option<u64>,
    reported_at: Option<u64>,
}

impl ProgressTracker {
    /// Records a downloaded chunk of `len` bytes; `total` is the size the server announced. Returns
    /// the report to send, if one is due.
    ///
    /// A size the download has outgrown is no longer trusted: `total` is `None` from then on.
    pub fn chunk(&mut self, len: usize, total: Option<u64>) -> Option<UpdateProgress> {
        let len = u64::try_from(len).unwrap_or(u64::MAX);
        self.downloaded = self.downloaded.saturating_add(len);
        self.total = total.filter(|total| *total >= self.downloaded);

        if !self.report_due() {
            return None;
        }

        self.reported_at = Some(self.downloaded);
        Some(self.progress(UpdatePhase::Downloading))
    }

    fn report_due(&self) -> bool {
        let Some(reported_at) = self.reported_at else {
            return true;
        };

        if self.total == Some(self.downloaded) {
            return true;
        }

        let step = match self.total {
            Some(total) => (total / 100).max(1),
            None => UNKNOWN_SIZE_REPORT_STEP,
        };

        self.downloaded - reported_at >= step
    }

    /// The report sent once the download is verified and installing starts.
    pub fn installing(&self) -> UpdateProgress {
        self.progress(UpdatePhase::Installing)
    }

    /// The report sent once the update is installed.
    pub fn done(&self) -> UpdateProgress {
        self.progress(UpdatePhase::Done)
    }

    fn progress(&self, phase: UpdatePhase) -> UpdateProgress {
        UpdateProgress {
            phase,
            downloaded: self.downloaded,
            total: self.total,
        }
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    /// A configured key as `tauri signer generate` writes it: the base64 of the whole `.pub` file.
    /// The key is the public example from the minisign documentation.
    fn pubkey_file(key_line: &str) -> String {
        STANDARD.encode(format!(
            "untrusted comment: minisign public key 37629A1A86B6E9F1\n{key_line}\n"
        ))
    }

    const EXAMPLE_KEY: &str = "RWQf6LRCGA9i53mlYecO4IzT51TGPpvWucNSCh1CBM0QTaLn73Y7GFO3";

    #[test]
    fn a_minisign_public_key_enables_updates() {
        let configured = pubkey_file(EXAMPLE_KEY);

        assert_eq!(configured_pubkey(Some(&configured)), Some(configured.as_str()));
    }

    #[test]
    fn builds_without_a_usable_key_have_no_updates() {
        let truncated_key = pubkey_file(&EXAMPLE_KEY[..40]);
        let raw_key_line = EXAMPLE_KEY.to_owned();
        let not_base64 = "-----BEGIN PUBLIC KEY-----".to_owned();

        for value in [
            None,
            Some(""),
            Some(PUBKEY_PLACEHOLDER),
            Some(truncated_key.as_str()),
            Some(raw_key_line.as_str()),
            Some(not_base64.as_str()),
        ] {
            assert_eq!(configured_pubkey(value), None, "{value:?}");
        }
    }

    #[test]
    fn announced_releases_drop_empty_notes_and_cut_long_ones() {
        let announced =
            |notes: Option<String>| UpdateInfo::announced("0.2.0".to_owned(), "0.1.0".to_owned(), None, notes).notes;

        assert_eq!(announced(None), None);
        assert_eq!(announced(Some(" \n".to_owned())), None);
        assert_eq!(announced(Some("## Fixes".to_owned())).as_deref(), Some("## Fixes"));

        let long = "é".repeat(MAX_UPDATE_NOTES_BYTES);
        let cut = announced(Some(long)).expect("notes");
        assert!(cut.len() <= MAX_UPDATE_NOTES_BYTES);
        assert!(cut.len() > MAX_UPDATE_NOTES_BYTES - 2);
        assert!(cut.chars().all(|char| char == 'é'));
    }

    #[test]
    fn the_page_gets_the_shapes_shell_ts_declares() {
        let info = UpdateInfo::announced("1.26.0".to_owned(), "1.25.1".to_owned(), None, None);
        let progress = UpdateProgress {
            phase: UpdatePhase::Downloading,
            downloaded: 10,
            total: None,
        };

        assert_eq!(
            serde_json::to_value(info).expect("serializable"),
            json!({ "version": "1.26.0", "currentVersion": "1.25.1", "date": null, "notes": null })
        );
        assert_eq!(
            serde_json::to_value(progress).expect("serializable"),
            json!({ "phase": "downloading", "downloaded": 10, "total": null })
        );
    }

    fn downloading(downloaded: u64, total: Option<u64>) -> UpdateProgress {
        UpdateProgress {
            phase: UpdatePhase::Downloading,
            downloaded,
            total,
        }
    }

    #[test]
    fn a_known_size_is_reported_once_per_percent_and_at_the_end() {
        let mut tracker = ProgressTracker::default();
        let total = Some(10_000);

        let reports: Vec<UpdateProgress> = (0..100).filter_map(|_| tracker.chunk(100, total)).collect();

        assert_eq!(reports.len(), 100);
        assert_eq!(reports[0], downloading(100, total));
        assert_eq!(reports[99], downloading(10_000, total));

        let mut tracker = ProgressTracker::default();
        let reports: Vec<UpdateProgress> = (0..1000).filter_map(|_| tracker.chunk(10, total)).collect();

        assert_eq!(reports.len(), 101, "the first chunk and every 100 bytes after it");
        assert_eq!(reports.last(), Some(&downloading(10_000, total)));
    }

    #[test]
    fn an_unknown_size_is_reported_every_step() {
        let mut tracker = ProgressTracker::default();
        let chunk = 64 * 1024;
        let chunks = 4 * UNKNOWN_SIZE_REPORT_STEP / chunk;

        let reports: Vec<UpdateProgress> = (0..chunks)
            .filter_map(|_| tracker.chunk(chunk as usize, None))
            .collect();

        let expected: Vec<UpdateProgress> = [
            chunk,
            chunk + UNKNOWN_SIZE_REPORT_STEP,
            chunk + 2 * UNKNOWN_SIZE_REPORT_STEP,
            chunk + 3 * UNKNOWN_SIZE_REPORT_STEP,
        ]
        .into_iter()
        .map(|downloaded| downloading(downloaded, None))
        .collect();
        assert_eq!(reports, expected);
    }

    #[test]
    fn a_size_the_download_outgrows_becomes_unknown() {
        let mut tracker = ProgressTracker::default();

        assert_eq!(tracker.chunk(80, Some(100)), Some(downloading(80, Some(100))));
        assert_eq!(tracker.chunk(20, Some(100)), Some(downloading(100, Some(100))));
        assert_eq!(
            tracker.chunk(UNKNOWN_SIZE_REPORT_STEP as usize, Some(100)),
            Some(downloading(100 + UNKNOWN_SIZE_REPORT_STEP, None))
        );
        assert_eq!(tracker.installing().total, None);
    }

    #[test]
    fn installing_and_done_carry_the_downloaded_size() {
        let mut tracker = ProgressTracker::default();
        tracker.chunk(4096, Some(4096));

        assert_eq!(
            tracker.installing(),
            UpdateProgress {
                phase: UpdatePhase::Installing,
                downloaded: 4096,
                total: Some(4096),
            }
        );
        assert_eq!(tracker.done().phase, UpdatePhase::Done);
        assert_eq!(tracker.done().downloaded, 4096);
    }
}
