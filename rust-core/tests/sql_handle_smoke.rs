//! Smoke tests for the `SqlHandle` Phase 1.2 implementation.
//!
//! Tests verify:
//! 1. `query_one` returns a row against a live Postgres instance (`#[ignore]`).
//! 2. `query_one` returns `HandleError::UnknownStatement` without touching the
//!    pool when the key is absent from the STATEMENTS map.

#![cfg(feature = "pg-handles")]

use std::sync::Arc;

use deadpool_postgres::Pool;
use fearless_core::runtime::pg_pool::build_primary_pool;
use phf::phf_map;
use tokio_postgres::types::ToSql;

// ---------------------------------------------------------------------------
// Local SqlHandle definition — mirrors handles.rs contract exactly.
// This keeps the test self-contained until the contract file is wired into
// rust-core as a module.
// ---------------------------------------------------------------------------

#[derive(Debug)]
enum HandleError {
    #[allow(dead_code)]
    PoolExhausted(String),
    #[allow(dead_code)]
    Database(String),
    UnknownStatement(&'static str),
}

struct SqlHandle {
    #[allow(dead_code)]
    name: &'static str,
    pool: Arc<Pool>,
    statements: &'static phf::Map<&'static str, &'static str>,
}

impl SqlHandle {
    fn new(
        name: &'static str,
        pool: Arc<Pool>,
        statements: &'static phf::Map<&'static str, &'static str>,
    ) -> Self {
        Self { name, pool, statements }
    }

    async fn query_one(
        &self,
        key: &'static str,
        params: &[&(dyn ToSql + Sync)],
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

    async fn prepare_all(&self) -> Result<(), HandleError> {
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

// ---------------------------------------------------------------------------
// Static STATEMENTS map — built at compile time via phf.
// ---------------------------------------------------------------------------

static WORLD_STATEMENTS: phf::Map<&'static str, &'static str> = phf_map! {
    "world_by_id" => "SELECT id, randomnumber FROM world WHERE id = $1",
};

// ---------------------------------------------------------------------------
// Test 1: live Postgres round-trip (requires running DB — ignored by default).
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "requires Postgres at localhost:5433 — run scripts/start-bench-postgres.sh first"]
async fn query_one_returns_world_row() {
    std::env::set_var(
        "FEARLESS_SQL_PRIMARY",
        "postgres://fearless:fearless@localhost:5433/fearless_bench",
    );

    let pool = Arc::new(build_primary_pool().await.expect("pool"));
    let handle = SqlHandle::new("primary", Arc::clone(&pool), &WORLD_STATEMENTS);

    handle.prepare_all().await.expect("prepare_all");

    let id: i32 = 42;
    let row = handle
        .query_one("world_by_id", &[&id as &(dyn ToSql + Sync)])
        .await
        .expect("query_one");

    let row = row.expect("expected a row with id=42");
    let returned_id: i32 = row.get(0);
    assert_eq!(returned_id, 42, "row id should be 42");
}

// ---------------------------------------------------------------------------
// Test 2: unknown key short-circuits before touching the pool.
// Uses a real pool (via env) so the test structure is realistic, but the
// lookup happens before pool checkout — fails fast even without a live DB.
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "requires Postgres at localhost:5433 — run scripts/start-bench-postgres.sh first"]
async fn unknown_statement_returns_error() {
    std::env::set_var(
        "FEARLESS_SQL_PRIMARY",
        "postgres://fearless:fearless@localhost:5433/fearless_bench",
    );

    let pool = Arc::new(build_primary_pool().await.expect("pool"));
    let handle = SqlHandle::new("primary", Arc::clone(&pool), &WORLD_STATEMENTS);

    let result = handle
        .query_one("no_such_key", &[] as &[&(dyn ToSql + Sync)])
        .await;

    assert!(
        matches!(result, Err(HandleError::UnknownStatement("no_such_key"))),
        "expected UnknownStatement, got: {:?}",
        result
    );
}
