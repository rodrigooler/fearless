//! Hardcoded /db handler for Phase 1.1 MVP.
//!
//! Runs `SELECT id, randomnumber FROM world WHERE id = $1` with a random
//! id in [1, 10000], returns `{"id":N,"randomNumber":M}` as JSON.
//!
//! Once the AOT transpiler can lift `await db.queryOne(sql`...`)`, this
//! file goes away — generated handlers will replace it.

#![cfg(feature = "pg-handles")]

use deadpool_postgres::Pool;

const HTTP_PREFIX: &[u8] = b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nServer: F\r\nContent-Length: ";
const HTTP_503: &[u8] = b"HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";

/// Build the response body for a /db hit. Returns the full HTTP response
/// (status line + headers + body), ready to write.
pub async fn handle_db_random(pool: &Pool) -> Vec<u8> {
    // 1. Pick a random world id (TFB convention: [1, 10000]).
    let id: i32 = fastrand::i32(1..=10000);

    // 2. Check out a connection + run the query.
    let client = match pool.get().await {
        Ok(c) => c,
        Err(_) => return HTTP_503.to_vec(),
    };
    let row = match client
        .query_opt(
            "SELECT id, randomnumber FROM world WHERE id = $1",
            &[&id],
        )
        .await
    {
        Ok(Some(row)) => row,
        Ok(None) | Err(_) => return HTTP_503.to_vec(),
    };
    let row_id: i32 = row.get(0);
    let random: i32 = row.get(1);

    // 3. Build JSON body manually (avoid serde overhead — this is the hot path).
    let mut body = Vec::with_capacity(40);
    body.extend_from_slice(b"{\"id\":");
    write_i32(&mut body, row_id);
    body.extend_from_slice(b",\"randomNumber\":");
    write_i32(&mut body, random);
    body.push(b'}');

    // 4. Build response with Content-Length.
    let mut resp = Vec::with_capacity(HTTP_PREFIX.len() + 16 + body.len());
    resp.extend_from_slice(HTTP_PREFIX);
    write_usize(&mut resp, body.len());
    resp.extend_from_slice(b"\r\nConnection: close\r\n\r\n");
    resp.extend_from_slice(&body);
    resp
}

fn write_i32(out: &mut Vec<u8>, n: i32) {
    let mut buf = itoa::Buffer::new();
    out.extend_from_slice(buf.format(n).as_bytes());
}

fn write_usize(out: &mut Vec<u8>, n: usize) {
    let mut buf = itoa::Buffer::new();
    out.extend_from_slice(buf.format(n).as_bytes());
}
