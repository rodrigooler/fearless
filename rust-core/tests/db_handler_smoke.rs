#![cfg(feature = "pg-handles")]

use fearless_core::aot::db_handler::handle_db_random;
use fearless_core::runtime::pg_pool::build_primary_pool;

#[tokio::test]
#[ignore = "requires Postgres at localhost:5433 — run scripts/start-bench-postgres.sh first"]
async fn returns_valid_db_response() {
    std::env::set_var(
        "FEARLESS_SQL_PRIMARY",
        "postgres://fearless:fearless@localhost:5433/fearless_bench",
    );
    let pool = build_primary_pool().await.expect("pool");

    let bytes = handle_db_random(&pool).await;
    let s = std::str::from_utf8(&bytes).expect("utf8");

    assert!(s.starts_with("HTTP/1.1 200 OK"), "status: {s}");
    let body_start = s.find("\r\n\r\n").expect("header terminator") + 4;
    let body = &s[body_start..];
    assert!(body.starts_with("{\"id\":"), "body: {body}");
    assert!(body.contains(",\"randomNumber\":"), "body: {body}");
    assert!(body.ends_with("}"), "body: {body}");
}
