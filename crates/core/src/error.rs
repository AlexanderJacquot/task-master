use thiserror::Error;

/// Every failure the core can report. Adapters map it with [`Error::kind`].
#[derive(Debug, Error)]
pub enum Error {
    /// Input broke a domain rule (empty title, cycle, unknown date format...).
    #[error("{0}")]
    Invalid(String),

    #[error("{entity} {id} not found")]
    NotFound { entity: &'static str, id: String },

    #[error("database error: {0}")]
    Db(#[from] rusqlite::Error),

    #[error("migration error: {0}")]
    Migration(#[from] Box<rusqlite_migration::Error>),

    #[error("I/O error: {0}")]
    Io(#[from] std::io::Error),

    #[error("JSON error: {0}")]
    Json(#[from] serde_json::Error),
}

impl Error {
    pub(crate) fn invalid(message: impl Into<String>) -> Self {
        Self::Invalid(message.into())
    }

    pub(crate) fn not_found(entity: &'static str, id: impl Into<String>) -> Self {
        Self::NotFound {
            entity,
            id: id.into(),
        }
    }

    /// Stable machine-readable category for adapters: `invalid`, `not_found` or `internal`.
    pub fn kind(&self) -> &'static str {
        match self {
            Self::Invalid(_) => "invalid",
            Self::NotFound { .. } => "not_found",
            _ => "internal",
        }
    }
}

impl From<rusqlite_migration::Error> for Error {
    fn from(err: rusqlite_migration::Error) -> Self {
        Self::Migration(Box::new(err))
    }
}

pub type Result<T, E = Error> = std::result::Result<T, E>;
