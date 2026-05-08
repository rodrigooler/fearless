//! ntex bench app — TFB-shaped /plaintext, /json, /db.
//!
//! Mirrors patterns from TFB's published ntex framework benchmark
//! (frameworks/Rust/ntex). Uses tokio-postgres with `prepare_typed_cached`
//! so the /db query path is a fast statement re-use, not parse-each-time.
//!
//! Env:
//!   BENCH_PORT   (default 8080)
//!   DATABASE_URL (default postgres://fearless:fearless@localhost:5432/fearless_bench)

use ntex::http::header::{HeaderValue, CONTENT_TYPE, SERVER};
use ntex::web::{self, App, HttpResponse, HttpServer};
use serde::Serialize;
use std::sync::Arc;
use tokio_postgres::{Client, NoTls, Statement};

#[derive(Serialize)]
struct Message<'a> {
    message: &'a str,
}

#[derive(Serialize)]
struct WorldRow {
    id: i32,
    #[serde(rename = "randomNumber")]
    random_number: i32,
}

struct PgState {
    client: Client,
    select_world: Statement,
}

async fn plaintext() -> HttpResponse {
    let mut res = HttpResponse::Ok().body("Hello, World!");
    res.headers_mut()
        .insert(CONTENT_TYPE, HeaderValue::from_static("text/plain"));
    res.headers_mut()
        .insert(SERVER, HeaderValue::from_static("ntex"));
    res
}

async fn json() -> HttpResponse {
    let body = serde_json::to_vec(&Message { message: "Hello, World!" }).unwrap();
    let mut res = HttpResponse::Ok().body(body);
    res.headers_mut()
        .insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
    res.headers_mut()
        .insert(SERVER, HeaderValue::from_static("ntex"));
    res
}

async fn db(pg: web::types::State<Arc<PgState>>) -> HttpResponse {
    let id: i32 = (fastrand::u32(0..10_000) as i32) + 1;
    let row = match pg.client.query_one(&pg.select_world, &[&id]).await {
        Ok(row) => row,
        Err(e) => {
            return HttpResponse::InternalServerError().body(format!("pg: {e}"));
        }
    };
    let world = WorldRow {
        id: row.get(0),
        random_number: row.get(1),
    };
    let body = serde_json::to_vec(&world).unwrap();
    let mut res = HttpResponse::Ok().body(body);
    res.headers_mut()
        .insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
    res.headers_mut()
        .insert(SERVER, HeaderValue::from_static("ntex"));
    res
}

async fn build_pg_state(database_url: &str) -> Arc<PgState> {
    let (client, conn) = tokio_postgres::connect(database_url, NoTls)
        .await
        .expect("pg connect");
    ntex::rt::spawn(async move {
        if let Err(e) = conn.await {
            eprintln!("pg connection: {e}");
        }
    });
    let select_world = client
        .prepare_typed(
            "SELECT id, randomnumber FROM world WHERE id = $1",
            &[tokio_postgres::types::Type::INT4],
        )
        .await
        .expect("prepare select_world");
    Arc::new(PgState { client, select_world })
}

#[ntex::main]
async fn main() -> std::io::Result<()> {
    let port: u16 = std::env::var("BENCH_PORT")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(8080);
    let database_url = std::env::var("DATABASE_URL")
        .unwrap_or_else(|_| "postgres://fearless:fearless@localhost:5432/fearless_bench".into());

    let bind = format!("0.0.0.0:{port}");
    eprintln!("ntex-bench listening on http://{bind}");

    // One shared client. ntex multi-worker mode would prefer per-worker
    // clients (TFB pattern); for simple comparison a single client + a
    // tokio-postgres internal pipeline is enough and removes the per-worker
    // bootstrapping complexity.
    let pg = build_pg_state(&database_url).await;

    HttpServer::new(move || {
        App::new()
            .state(pg.clone())
            .service(web::resource("/plaintext").to(plaintext))
            .service(web::resource("/json").to(json))
            .service(web::resource("/db").to(db))
    })
    .bind(bind)?
    .run()
    .await
}
