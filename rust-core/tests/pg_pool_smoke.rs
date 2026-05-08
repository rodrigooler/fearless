#![cfg(feature = "pg-handles")]

use fearless_core::runtime::pg_pool::{build_primary_pool, PoolBuildError};

#[tokio::test]
async fn missing_url_returns_specific_error() {
    let _guard = EnvGuard::clear("FEARLESS_SQL_PRIMARY");
    let err = build_primary_pool().await.expect_err("should fail without URL");
    assert!(matches!(err, PoolBuildError::MissingUrl), "got: {err:?}");
}

#[tokio::test]
#[ignore = "requires Postgres at localhost:5433 — run scripts/start-bench-postgres.sh first"]
async fn live_pool_can_query() {
    std::env::set_var(
        "FEARLESS_SQL_PRIMARY",
        "postgres://fearless:fearless@localhost:5433/fearless_bench",
    );
    let pool = build_primary_pool().await.expect("pool should build");
    let client = pool.get().await.expect("checkout");
    let row = client
        .query_one("SELECT 1::int", &[])
        .await
        .expect("query");
    let n: i32 = row.get(0);
    assert_eq!(n, 1);
}

struct EnvGuard {
    key: &'static str,
    prev: Option<String>,
}

impl EnvGuard {
    fn clear(key: &'static str) -> Self {
        let prev = std::env::var(key).ok();
        std::env::remove_var(key);
        Self { key, prev }
    }
}

impl Drop for EnvGuard {
    fn drop(&mut self) {
        if let Some(v) = self.prev.take() {
            std::env::set_var(self.key, v);
        }
    }
}
