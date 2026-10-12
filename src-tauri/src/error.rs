//! The error type every IPC command returns.

use serde::Serialize;

/// Result of an IPC command.
pub type CommandResult<T> = Result<T, CommandError>;

/// Stable error category returned over IPC; the page may branch on this, never on the message.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ErrorCode {
    /// The request is not valid now (for example a second install while one runs).
    InvalidInput,
    /// Nothing to act on (for example no update found by a check).
    NotFound,
    /// Refused by a security rule (an update whose signature does not match).
    Forbidden,
    /// This build or platform does not support the operation.
    Unsupported,
    /// A network, filesystem or other I/O failure.
    Io,
    /// An installer or other process failed.
    Process,
    /// An operation exceeded its time limit.
    Timeout,
    /// The update server answered something unexpected.
    Protocol,
    /// A bug or an unexpected internal state.
    Internal,
}

/// A failed IPC command. Serializes as `{ "code", "message" }`; the message is short, safe to
/// display and never carries secrets.
#[derive(Debug, Serialize)]
pub struct CommandError {
    code: ErrorCode,
    message: String,
}

impl CommandError {
    /// An error of category `code`.
    pub fn new(code: ErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }

    /// A bug or unexpected state in the shell itself.
    pub fn internal(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::Internal, message)
    }

    /// The error category.
    #[cfg(test)]
    pub fn code(&self) -> ErrorCode {
        self.code
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn serializes_as_code_and_message() {
        let error = CommandError::new(ErrorCode::NotFound, "no update to install");

        let value = serde_json::to_value(&error).expect("serializable");

        assert_eq!(value, json!({ "code": "notFound", "message": "no update to install" }));
    }
}
