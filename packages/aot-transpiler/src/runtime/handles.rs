//! Typed framework handles — Phase 1 AOT runtime contract.
//!
//! Generated handlers that use `fearless.sql(...)`, `fearless.kv(...)`,
//! `fearless.http(...)` depend on these types. The handles themselves are
//! declared at module scope in user code; the analyzer treats them as a
//! special "framework-owned identifier" that the transpiler can lower to
//! native Rust calls into a registered pool.
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
    PoolExhausted(String),
    Database(String),
    Network(String),
    Cache(String),
    NotFound,
    UnknownStatement(&'static str),
    Other(String),
}

impl std::fmt::Display for HandleError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            HandleError::NotConfigured => write!(f, "handle not configured (env var missing?)"),
            HandleError::PoolExhausted(m) => write!(f, "connection pool exhausted: {}", m),
            HandleError::Database(m) => write!(f, "database error: {}", m),
            HandleError::Network(m) => write!(f, "network error: {}", m),
            HandleError::Cache(m) => write!(f, "cache error: {}", m),
            HandleError::NotFound => write!(f, "not found"),
            HandleError::UnknownStatement(k) => write!(f, "unknown statement key: {}", k),
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
/// Backed by `deadpool-postgres` pool wrapping `tokio-postgres`. The handle
/// borrows a shared `Arc<Pool>` so many handles can share one pool. Statements
/// are prepared lazily via `prepare_cached` (cheap when cache is warm) and can
/// be pre-warmed at startup via `prepare_all`.
#[cfg(feature = "pg-handles")]
pub struct SqlHandle {
    pub name: &'static str,
    pool: Arc<deadpool_postgres::Pool>,
    /// Static map from statement key → SQL text, built at compile time via
    /// `phf::phf_map!` by the generated `register_handles()` function.
    statements: &'static phf::Map<&'static str, &'static str>,
}

#[cfg(feature = "pg-handles")]
impl SqlHandle {
    /// Construct a handle bound to a pool and the build-generated STATEMENTS
    /// map. Called once per registered handle at startup from the generated
    /// `register_handles()` function.
    pub fn new(
        name: &'static str,
        pool: Arc<deadpool_postgres::Pool>,
        statements: &'static phf::Map<&'static str, &'static str>,
    ) -> Self {
        Self { name, pool, statements }
    }

    /// Execute a prepared statement that returns at most one row.
    /// `key` must be present in the build-generated STATEMENTS map; if not,
    /// returns `HandleError::UnknownStatement`. `params` are the bind args.
    pub async fn query_one(
        &self,
        key: &'static str,
        params: &[&(dyn tokio_postgres::types::ToSql + Sync)],
    ) -> Result<Option<tokio_postgres::Row>, HandleError> {
        let sql = self
            .statements
            .get(key)
            .ok_or(HandleError::UnknownStatement(key))?;
        let client = self
            .pool
            .get()
            .await
            .map_err(|e| HandleError::PoolExhausted(e.to_string()))?;
        let stmt = client
            .prepare_cached(sql)
            .await
            .map_err(|e| HandleError::Database(e.to_string()))?;
        client
            .query_opt(&stmt, params)
            .await
            .map_err(|e| HandleError::Database(e.to_string()))
    }

    /// Execute a prepared statement that returns zero or more rows.
    pub async fn query_many(
        &self,
        key: &'static str,
        params: &[&(dyn tokio_postgres::types::ToSql + Sync)],
    ) -> Result<Vec<tokio_postgres::Row>, HandleError> {
        let sql = self
            .statements
            .get(key)
            .ok_or(HandleError::UnknownStatement(key))?;
        let client = self
            .pool
            .get()
            .await
            .map_err(|e| HandleError::PoolExhausted(e.to_string()))?;
        let stmt = client
            .prepare_cached(sql)
            .await
            .map_err(|e| HandleError::Database(e.to_string()))?;
        client
            .query(&stmt, params)
            .await
            .map_err(|e| HandleError::Database(e.to_string()))
    }

    /// Execute a prepared statement that returns no rows; returns affected count.
    pub async fn execute(
        &self,
        key: &'static str,
        params: &[&(dyn tokio_postgres::types::ToSql + Sync)],
    ) -> Result<u64, HandleError> {
        let sql = self
            .statements
            .get(key)
            .ok_or(HandleError::UnknownStatement(key))?;
        let client = self
            .pool
            .get()
            .await
            .map_err(|e| HandleError::PoolExhausted(e.to_string()))?;
        let stmt = client
            .prepare_cached(sql)
            .await
            .map_err(|e| HandleError::Database(e.to_string()))?;
        client
            .execute(&stmt, params)
            .await
            .map_err(|e| HandleError::Database(e.to_string()))
    }

    /// Eagerly prepare every statement in the map against one client. Called
    /// once at startup (after pool init) so the first user request doesn't pay
    /// the prepare round-trip.
    pub async fn prepare_all(&self) -> Result<(), HandleError> {
        let client = self
            .pool
            .get()
            .await
            .map_err(|e| HandleError::PoolExhausted(e.to_string()))?;
        for sql in self.statements.values() {
            client
                .prepare_cached(sql)
                .await
                .map_err(|e| HandleError::Database(e.to_string()))?;
        }
        Ok(())
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
    #[cfg(feature = "pg-handles")]
    pub sql: HashMap<&'static str, Arc<SqlHandle>>,
    pub kv: HashMap<&'static str, Arc<KvHandle>>,
    pub http: HashMap<&'static str, Arc<HttpHandle>>,
}

impl Default for HandleRegistry {
    fn default() -> Self {
        Self {
            #[cfg(feature = "pg-handles")]
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
