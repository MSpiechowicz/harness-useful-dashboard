//! In-app updater state: the public key this build verifies updates with, the update the last
//! check found, and the lock that allows one install at a time.
//!
//! The key is `plugins.updater.pubkey` of `tauri.conf.json`. A build without a usable key (the
//! placeholder starting with `NOT_CONFIGURED`) still starts: the updater plugin accepts any string
//! at startup, and the update commands refuse with `unsupported` before any network access.

use std::sync::{Mutex, PoisonError};

use tauri::async_runtime;
use tauri_plugin_updater::Update;

use crate::error::{CommandError, CommandResult, ErrorCode};
use crate::update::{UPDATES_NOT_CONFIGURED, configured_pubkey};

/// Updater state shared by the update commands.
pub struct Updates {
    pubkey: Option<String>,
    pending: Mutex<Option<Update>>,
    /// Held for the whole download and install.
    pub installing: async_runtime::Mutex<()>,
}

impl Updates {
    /// Updates verified with `pubkey`, or none when it is `None`.
    pub fn new(pubkey: Option<String>) -> Self {
        Self {
            pubkey,
            pending: Mutex::new(None),
            installing: async_runtime::Mutex::new(()),
        }
    }

    /// Updates as `config` (the app's `tauri.conf.json`) configures them.
    pub fn from_config(config: &tauri::Config) -> Self {
        let configured = config
            .plugins
            .0
            .get("updater")
            .and_then(|updater| updater.get("pubkey"))
            .and_then(|pubkey| pubkey.as_str());

        let pubkey = configured_pubkey(configured).map(str::to_owned);

        if pubkey.is_none() {
            tracing::info!("this build has no updater public key; updates are off");
        }

        Self::new(pubkey)
    }

    /// The public key, or `unsupported` when this build has none.
    pub fn pubkey(&self) -> CommandResult<&str> {
        match &self.pubkey {
            Some(pubkey) => Ok(pubkey),
            None => Err(CommandError::new(ErrorCode::Unsupported, UPDATES_NOT_CONFIGURED)),
        }
    }

    /// The update the last check found, if any.
    pub fn pending(&self) -> Option<Update> {
        self.lock().clone()
    }

    /// Replaces the update the last check found.
    pub fn set_pending(&self, update: Option<Update>) {
        *self.lock() = update;
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Option<Update>> {
        // Only whole values are stored, so a panic elsewhere cannot leave it half-written.
        self.pending.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

#[cfg(test)]
mod tests {
    use serde_json::{Value, json};

    use super::*;
    use crate::update::PUBKEY_PLACEHOLDER;

    /// The `plugins.updater` section this build ships with.
    fn shipped_updater_config() -> Value {
        let config: Value = serde_json::from_str(include_str!("../tauri.conf.json")).expect("tauri.conf.json is JSON");

        config["plugins"]["updater"].clone()
    }

    fn app_config(updater: Option<Value>) -> tauri::Config {
        let mut config = tauri::Config::default();

        if let Some(updater) = updater {
            config.plugins.0.insert("updater".to_owned(), updater);
        }

        config
    }

    #[test]
    fn the_shipped_config_starts_the_plugin_with_signed_versions_required() {
        let config: tauri_plugin_updater::Config =
            serde_json::from_value(shipped_updater_config()).expect("the plugin accepts the shipped config");

        assert!(config.require_signed_version);
        assert!(!config.allow_downgrades);
        assert!(!config.dangerous_accept_invalid_certs);
        assert!(!config.dangerous_accept_invalid_hostnames);
        assert!(config.endpoints.iter().all(|endpoint| endpoint.scheme() == "https"));
        assert_eq!(
            config
                .endpoints
                .iter()
                .map(|endpoint| endpoint.as_str())
                .collect::<Vec<_>>(),
            [crate::update::UPDATE_ENDPOINT]
        );
    }

    #[test]
    fn a_build_with_the_placeholder_or_no_key_has_updates_off() {
        let placeholder = app_config(Some(json!({ "pubkey": PUBKEY_PLACEHOLDER })));
        let without_section = app_config(None);
        let empty_key = app_config(Some(json!({ "pubkey": "" })));

        for config in [placeholder, without_section, empty_key] {
            let error = Updates::from_config(&config).pubkey().expect_err("updates are off");

            assert_eq!(error.code(), ErrorCode::Unsupported);
        }
    }
}
