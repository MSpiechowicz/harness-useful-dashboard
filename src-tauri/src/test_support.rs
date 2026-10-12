//! Test helpers for the shell's unit tests.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex, PoisonError};

use serde_json::Value;
use tauri::ipc::{Channel, InvokeResponseBody};

/// A uniquely named directory under the OS temp dir, removed on drop.
pub struct TempDir(PathBuf);

impl TempDir {
    /// Creates `harness-dashboard-app-<label>-<pid>-<n>`.
    pub fn new(label: &str) -> Self {
        static NEXT: AtomicU32 = AtomicU32::new(0);

        let name = format!(
            "harness-dashboard-app-{label}-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        );
        let path = std::env::temp_dir().join(name);
        std::fs::create_dir_all(&path).expect("create temp dir");

        Self(path)
    }

    /// The directory.
    pub fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        std::fs::remove_dir_all(&self.0).ok();
    }
}

/// A channel that keeps every message it receives, parsed as JSON.
pub fn collecting_channel<T>() -> (Channel<T>, Arc<Mutex<Vec<Value>>>) {
    let received = Arc::new(Mutex::new(Vec::new()));
    let messages = received.clone();

    let channel = Channel::new(move |body| {
        if let InvokeResponseBody::Json(json) = body {
            let message = serde_json::from_str(&json).expect("channel messages are JSON");
            messages.lock().unwrap_or_else(PoisonError::into_inner).push(message);
        }
        Ok(())
    });

    (channel, received)
}
