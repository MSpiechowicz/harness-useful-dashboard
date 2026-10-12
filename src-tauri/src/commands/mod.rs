//! IPC commands the dashboard page may call in the app (see `web/src/lib/shell.ts`). Each must
//! also be listed in `build.rs` and granted in `window::REMOTE_PERMISSIONS`.

pub mod sound;
pub mod updates;

use crate::error::{CommandError, CommandResult};

/// Runs blocking work (installing an update) off the async runtime's worker threads.
async fn blocking<T, F>(task: F) -> CommandResult<T>
where
    T: Send + 'static,
    F: FnOnce() -> CommandResult<T> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(task)
        .await
        .map_err(|error| CommandError::internal(format!("background task failed: {error}")))?
}
