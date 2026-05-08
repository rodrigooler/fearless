//! Real implementation of typed framework handles for the AOT runtime.
//!
//! The corresponding contract definition for tooling (analyzer/transpiler)
//! lives in `packages/aot-transpiler/src/runtime/handles.rs`. THIS file is
//! the canonical implementation compiled into rust-core; the contract file
//! is documentation for transpiler/build authors describing the expected shape.

#![cfg(feature = "pg-handles")]

use deadpool_postgres::Pool;
use std::collections::HashMap;
use std::sync::Arc;
use tokio_postgres::types::ToSql;
use tokio_postgres::Row;

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
            Self::NotConfigured => write!(f, "handle not configured (env var missing?)"),
            Self::PoolExhausted(m) => write!(f, "connection pool exhausted: {m}"),
            Self::Database(m) => write!(f, "database error: {m}"),
            Self::Network(m) => write!(f, "network error: {m}"),
            Self::Cache(m) => write!(f, "cache error: {m}"),
            Self::NotFound => write!(f, "not found"),
            Self::UnknownStatement(k) => write!(f, "unknown statement key: {k}"),
            Self::Other(m) => write!(f, "error: {m}"),
        }
    }
}

impl std::error::Error for HandleError {}

/// Registry of named handles keyed by `registeredName` (e.g. `"primary"`).
/// The build generates a `register_handles(pool)` function that populates this
/// at startup; generated async handlers receive it as `&HandleRegistry`.
pub struct HandleRegistry {
    pub sql: HashMap<&'static str, Arc<SqlHandle>>,
    // Future: kv: HashMap<...>, http: HashMap<...>
}

impl HandleRegistry {
    pub fn new() -> Self {
        Self { sql: HashMap::new() }
    }

    /// Register a SQL handle under its `registeredName`. Called from the
    /// build-generated `register_handles` function.
    pub fn register_sql(&mut self, name: &'static str, handle: Arc<SqlHandle>) {
        self.sql.insert(name, handle);
    }

    /// Eagerly prepare every statement in every registered SQL handle. Call
    /// once at startup after pool init to avoid first-request prepare latency.
    pub async fn prepare_all(&self) -> Result<(), HandleError> {
        for handle in self.sql.values() {
            handle.prepare_all().await?;
        }
        Ok(())
    }
}

impl Default for HandleRegistry {
    fn default() -> Self {
        Self::new()
    }
}

/// Typed Postgres handle. The TS-side `fearless.sql("primary")` declaration
/// resolves at startup to one of these, configured via `FEARLESS_SQL_PRIMARY`
/// env var (URL).
///
/// Backed by `deadpool-postgres` pool wrapping `tokio-postgres`. The handle
/// borrows a shared `Arc<Pool>` so many handles can share one pool. Statements
/// are prepared lazily via `prepare_cached` (cheap when cache is warm) and can
/// be pre-warmed at startup via `prepare_all`.
pub struct SqlHandle {
    pub name: &'static str,
    pool: Arc<Pool>,
    /// Static map from statement key → SQL text, built at compile time via
    /// `phf::phf_map!` by the generated `register_handles()` function.
    statements: &'static phf::Map<&'static str, &'static str>,
}

impl SqlHandle {
    /// Construct a handle bound to a pool and the build-generated STATEMENTS
    /// map. Called once per registered handle at startup from the generated
    /// `register_handles()` function.
    pub fn new(
        name: &'static str,
        pool: Arc<Pool>,
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
        params: &[&(dyn ToSql + Sync)],
    ) -> Result<Option<Row>, HandleError> {
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
        params: &[&(dyn ToSql + Sync)],
    ) -> Result<Vec<Row>, HandleError> {
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
        params: &[&(dyn ToSql + Sync)],
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
