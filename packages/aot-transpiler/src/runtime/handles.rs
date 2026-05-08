//! Typed framework handles — Phase 1 AOT runtime contract.
//!
//! Generated handlers that use `fearless.sql(...)`, `fearless.kv(...)`,
//! `fearless.http(...)` depend on these types. The handles themselves are
//! declared at module scope in user code; the analyzer treats them as a
//! special "framework-owned identifier" that the transpiler can lower to
//! native Rust calls into a registered pool.
//!
//! **Status: contract only.** The actual implementations of `SqlHandle`,
//! `KvHandle`, `HttpHandle` are stubs that return errors — Phase 1 work
//! lands the real pools (tokio-postgres, deadpool-redis, hyper-client).
//!
//! See `docs/superpowers/plans/2026-05-08-typed-handles-design.md` for
//! the full implementation plan.

use std::collections::HashMap;
use std::sync::Arc;

/// Error type returned by typed-handle operations. Generated handlers translate
/// this into HTTP responses (typically 500 with structured body).
#[derive(Debug)]
pub enum HandleError {
    NotConfigured,
    PoolExhausted,
    Database(String),
    Network(String),
    Cache(String),
    NotFound,
    Other(String),
}

impl std::fmt::Display for HandleError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            HandleError::NotConfigured => write!(f, "handle not configured (env var missing?)"),
            HandleError::PoolExhausted => write!(f, "connection pool exhausted"),
            HandleError::Database(m) => write!(f, "database error: {}", m),
            HandleError::Network(m) => write!(f, "network error: {}", m),
            HandleError::Cache(m) => write!(f, "cache error: {}", m),
            HandleError::NotFound => write!(f, "not found"),
            HandleError::Other(m) => write!(f, "error: {}", m),
        }
    }
}

impl std::error::Error for HandleError {}

// ============================================================================
// SqlHandle — Postgres (and later MySQL/SQLite) typed pool wrapper.
// ============================================================================

/// Typed Postgres handle. The TS-side `fearless.sql("primary")` declaration
/// resolves at startup to one of these, configured via `FEARLESS_SQL_PRIMARY`
/// env var (URL).
///
/// Phase 1: backed by `deadpool-postgres` pool wrapping `tokio-postgres`.
/// Today: stub returning NotConfigured.
pub struct SqlHandle {
    pub name: &'static str,
    // Real impl will hold: pool: deadpool_postgres::Pool, prepared: HashMap<&'static str, tokio_postgres::Statement>
}

impl SqlHandle {
    pub const fn new(name: &'static str) -> Self {
        Self { name }
    }

    /// Run a parameterized query expected to return at most one row.
    /// `stmt_key` is the prepared-statement identifier the transpiler emits.
    /// `params` are the bound values, in order.
    ///
    /// **Phase 1**: returns one row mapped to a typed Rust struct.
    /// **Today**: stub — returns NotConfigured.
    pub async fn query_one(
        &self,
        _stmt_key: &'static str,
        _params: &[SqlValue<'_>],
    ) -> Result<Option<Row>, HandleError> {
        Err(HandleError::NotConfigured)
    }

    /// Run a parameterized query returning any number of rows.
    pub async fn query(
        &self,
        _stmt_key: &'static str,
        _params: &[SqlValue<'_>],
    ) -> Result<Vec<Row>, HandleError> {
        Err(HandleError::NotConfigured)
    }

    /// Run an UPDATE / INSERT / DELETE; returns rows affected.
    pub async fn execute(
        &self,
        _stmt_key: &'static str,
        _params: &[SqlValue<'_>],
    ) -> Result<u64, HandleError> {
        Err(HandleError::NotConfigured)
    }
}

/// SQL bind value. The transpiler emits one variant per parameter type.
/// Phase 1 covers the common scalars; user-defined types can be added later.
pub enum SqlValue<'a> {
    Null,
    Bool(bool),
    I32(i32),
    I64(i64),
    F64(f64),
    Str(&'a str),
    Bytes(&'a [u8]),
}

/// Result row. Phase 1 will be a typed struct generated per query; this
/// untyped form is a placeholder so the contract compiles.
pub struct Row {
    pub columns: HashMap<String, RowValue>,
}

pub enum RowValue {
    Null,
    Bool(bool),
    I32(i32),
    I64(i64),
    F64(f64),
    Str(String),
    Bytes(Vec<u8>),
}

// ============================================================================
// KvHandle — Redis / DragonflyDB typed wrapper.
// ============================================================================

/// Key-value cache handle. `fearless.kv("session-cache")` resolves to one of
/// these, backed by `deadpool-redis` in Phase 1.
pub struct KvHandle {
    pub name: &'static str,
}

impl KvHandle {
    pub const fn new(name: &'static str) -> Self {
        Self { name }
    }

    pub async fn get(&self, _key: &str) -> Result<Option<Vec<u8>>, HandleError> {
        Err(HandleError::NotConfigured)
    }

    pub async fn set(
        &self,
        _key: &str,
        _value: &[u8],
        _ttl_seconds: Option<u64>,
    ) -> Result<(), HandleError> {
        Err(HandleError::NotConfigured)
    }

    pub async fn delete(&self, _key: &str) -> Result<(), HandleError> {
        Err(HandleError::NotConfigured)
    }
}

// ============================================================================
// HttpHandle — typed outbound HTTP client (calling another microservice).
// ============================================================================

/// Outbound HTTP client handle with a known baseUrl + response schema.
/// `fearless.http("user-service", { baseUrl: "...", responseSchema: ... })`.
///
/// Phase 1: backed by `hyper` + `rustls`.
pub struct HttpHandle {
    pub name: &'static str,
    pub base_url: &'static str,
}

impl HttpHandle {
    pub const fn new(name: &'static str, base_url: &'static str) -> Self {
        Self { name, base_url }
    }

    pub async fn get(&self, _path: &str) -> Result<HttpResponse, HandleError> {
        Err(HandleError::NotConfigured)
    }

    pub async fn post(
        &self,
        _path: &str,
        _body: &[u8],
        _content_type: &str,
    ) -> Result<HttpResponse, HandleError> {
        Err(HandleError::NotConfigured)
    }
}

pub struct HttpResponse {
    pub status: u16,
    pub headers: HashMap<String, String>,
    pub body: Vec<u8>,
}

// ============================================================================
// Registry — globally accessible map of named handles.
// ============================================================================

/// Phase 1 will populate this via build-time codegen + env-driven init.
/// Generated handlers reference handles by static name lookups against this.
pub struct HandleRegistry {
    pub sql: HashMap<&'static str, Arc<SqlHandle>>,
    pub kv: HashMap<&'static str, Arc<KvHandle>>,
    pub http: HashMap<&'static str, Arc<HttpHandle>>,
}

impl Default for HandleRegistry {
    fn default() -> Self {
        Self {
            sql: HashMap::new(),
            kv: HashMap::new(),
            http: HashMap::new(),
        }
    }
}

impl HandleRegistry {
    pub fn new() -> Self {
        Self::default()
    }
}
