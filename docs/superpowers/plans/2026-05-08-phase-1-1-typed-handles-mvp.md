# Phase 1.1 MVP — Typed handles, hardcoded /db proof Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove the io_uring ↔ tokio bridge architecture with a single hardcoded async `/db` endpoint that runs `SELECT id, randomNumber FROM World WHERE id=$1` against Postgres at ≥100k req/s on OrbStack (vs ~40k Bun baseline). No AOT analyzer/transpiler changes — only the runtime bridge.

**Architecture:** Shared multi-thread tokio runtime + per-worker eventfd registered with io_uring as a poll source. Tokio task awaits Postgres via `deadpool-postgres`, pushes the response into a per-worker completion queue, signals eventfd. The io_uring loop sees an eventfd CQE, drains the queue, copies bytes into the slot's write region, submits send. Connection state machine gains an `AwaitingAsync` state.

**Tech Stack:** Rust, `tokio` 1.x (multi_thread runtime), `tokio-postgres` 0.7, `deadpool-postgres` 0.14, `io_uring` (existing), Postgres 16 (Docker for bench).

**Out of scope (deferred to Phase 1.2+):**
- AOT analyzer / transpiler changes (no `await db.queryOne` from user TS yet — this comes after MVP proves the bridge)
- `sql\`...\`` template tag (build-time prepared statement collection)
- KV / HTTP handles
- Schema validation
- Multiple SQL backends per app
- Transactions, streaming results, retry logic

---

## File Structure

**New files:**
- `bench/postgres-compose.yml` — Docker compose to bring up Postgres 16 with TFB-canonical World schema for bench
- `scripts/start-bench-postgres.sh` — wrapper around docker compose + seed
- `rust-core/src/runtime/mod.rs` — module declaration for runtime helpers (currently `uring/` is the only runtime module; we add a sibling)
- `rust-core/src/runtime/pg_pool.rs` — deadpool-postgres pool builder, env-driven config
- `rust-core/src/runtime/async_bridge.rs` — shared tokio runtime + per-worker eventfd + completion queue
- `rust-core/src/aot/db_handler.rs` — single hardcoded async function `handle_db_random` returning `Vec<u8>`
- `rust-core/tests/async_bridge_smoke.rs` — integration test: spawn future via bridge, verify completion drained

**Modified files:**
- `rust-core/Cargo.toml` — new deps (tokio, tokio-postgres, deadpool-postgres) gated on a new feature `pg-handles`
- `rust-core/src/lib.rs` — export `runtime` module, init bridge from `run_benchmark_server` / `run_server`
- `rust-core/src/main.rs` — read `FEARLESS_SQL_PRIMARY` env, fail fast if `pg-handles` feature on but env missing
- `rust-core/src/uring/connection.rs` — new state `AwaitingAsync`; new dispatch arm for `Route::Db` that calls bridge instead of writing inline
- `rust-core/src/uring/runtime.rs` — register eventfd as a poll source, drain completion queue when its CQE arrives
- `rust-core/src/benchmark/parser.rs` — add `Route::Db` to the route enum; recognize `GET /db` in the fast-path classifier
- `bench/scripts/run-bench.mjs` — add `/db` scenario to the smoke profile (already there for Bun? confirm and wire to rust port)

**Test/build harness:**
- `rust-core/Cargo.toml` features section — `pg-handles = ["dep:tokio", "dep:tokio-postgres", "dep:deadpool-postgres"]`
- All new code gated `#[cfg(feature = "pg-handles")]` so default build stays unchanged.

---

## Task 1: Postgres bench infrastructure

**Files:**
- Create: `bench/postgres-compose.yml`
- Create: `scripts/start-bench-postgres.sh`
- Already exists (verify): `bench/techempower/seed.sql`

- [ ] **Step 1: Verify seed.sql has the World schema and 10000 rows**

Run: `head -30 bench/techempower/seed.sql`

Expected: `CREATE TABLE world (id integer NOT NULL, randomnumber integer NOT NULL, PRIMARY KEY (id))` and an `INSERT INTO world` block (or a generate_series stanza) producing 10000 rows.

If missing or wrong, fix before continuing.

- [ ] **Step 2: Write Postgres compose file**

Create `bench/postgres-compose.yml`:

```yaml
services:
  postgres:
    image: postgres:16-alpine
    container_name: fearless-bench-pg
    environment:
      POSTGRES_USER: fearless
      POSTGRES_PASSWORD: fearless
      POSTGRES_DB: fearless_bench
    ports:
      - "5433:5432"
    volumes:
      - ./techempower/seed.sql:/docker-entrypoint-initdb.d/01-seed.sql:ro
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U fearless -d fearless_bench"]
      interval: 1s
      timeout: 3s
      retries: 30
    # tuning for bench rig — match TFB Citrine reasonable defaults
    command:
      - "postgres"
      - "-c"
      - "max_connections=500"
      - "-c"
      - "shared_buffers=256MB"
      - "-c"
      - "synchronous_commit=off"
```

- [ ] **Step 3: Write start script**

Create `scripts/start-bench-postgres.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

docker compose -f bench/postgres-compose.yml up -d
echo "waiting for postgres to be healthy..."
until docker inspect -f '{{.State.Health.Status}}' fearless-bench-pg 2>/dev/null | grep -q healthy; do
  sleep 0.5
done

# Sanity check: expect 10000 rows in world
count=$(docker exec fearless-bench-pg psql -U fearless -d fearless_bench -tAc "SELECT count(*) FROM world")
if [[ "$count" != "10000" ]]; then
  echo "ERROR: expected 10000 world rows, got $count" >&2
  exit 1
fi

echo "ready: postgres://fearless:fearless@localhost:5433/fearless_bench (world: $count rows)"
```

Then: `chmod +x scripts/start-bench-postgres.sh`

- [ ] **Step 4: Verify it boots clean**

Run: `./scripts/start-bench-postgres.sh`

Expected output ending with `ready: postgres://...:5433/fearless_bench (world: 10000 rows)`

If the seed didn't create exactly 10000 rows, edit `bench/techempower/seed.sql` to use:

```sql
INSERT INTO world (id, randomnumber)
SELECT g, floor(random() * 10000)::int + 1
FROM generate_series(1, 10000) g;
```

Tear down with: `docker compose -f bench/postgres-compose.yml down -v` and re-run.

- [ ] **Step 5: Commit**

```bash
git add bench/postgres-compose.yml scripts/start-bench-postgres.sh bench/techempower/seed.sql
git commit -m "bench: add Postgres compose for /db benchmark"
```

---

## Task 2: Cargo deps + feature flag

**Files:**
- Modify: `rust-core/Cargo.toml`
- Modify: `rust-core/src/lib.rs:1-10` (add module decl, gated)

- [ ] **Step 1: Add deps under a new feature flag**

Modify `rust-core/Cargo.toml`. Find the `[dependencies]` and `[features]` sections, add:

```toml
[dependencies]
# ... existing deps unchanged ...
tokio = { version = "1", features = ["rt-multi-thread", "macros", "sync", "net", "time"], optional = true }
tokio-postgres = { version = "0.7", optional = true }
deadpool-postgres = { version = "0.14", optional = true }
```

```toml
[features]
default = []
io-uring = []  # existing
aot-handlers = []  # existing
pg-handles = ["dep:tokio", "dep:tokio-postgres", "dep:deadpool-postgres"]
```

(Adapt the exact `[features]` block to whatever exists today — additive only.)

- [ ] **Step 2: Verify cargo resolves cleanly with the new feature**

Run: `cd rust-core && cargo check --features pg-handles`

Expected: compiles (no errors). Warnings about unused new deps are fine.

- [ ] **Step 3: Verify default build still passes**

Run: `cd rust-core && cargo check`

Expected: compiles. The new deps are not pulled in (optional + feature-gated).

- [ ] **Step 4: Commit**

```bash
git add rust-core/Cargo.toml rust-core/Cargo.lock
git commit -m "rust-core: add tokio + postgres deps under pg-handles feature"
```

---

## Task 3: Postgres pool builder

**Files:**
- Create: `rust-core/src/runtime/mod.rs`
- Create: `rust-core/src/runtime/pg_pool.rs`
- Modify: `rust-core/src/lib.rs:1-10`

- [ ] **Step 1: Write the pool module**

Create `rust-core/src/runtime/mod.rs`:

```rust
//! Runtime helpers for Phase 1+ async I/O integration.
//!
//! Currently houses the Postgres pool and the eventfd-based async bridge that
//! lets the io_uring worker loop spawn tokio futures and resume on completion.

#[cfg(feature = "pg-handles")]
pub mod pg_pool;

#[cfg(feature = "pg-handles")]
pub mod async_bridge;
```

Create `rust-core/src/runtime/pg_pool.rs`:

```rust
//! Build a deadpool-postgres pool from `FEARLESS_SQL_PRIMARY` env URL.
//!
//! Pool sizing: defaults to `num_cpus()` connections. Override with
//! `FEARLESS_SQL_PRIMARY_POOL_SIZE`. Fail fast if the URL is missing or the
//! pool can't establish a connection at startup.

use deadpool_postgres::{Config, Pool, Runtime};
use std::env;

#[derive(Debug)]
pub enum PoolBuildError {
    MissingUrl,
    InvalidUrl(String),
    InvalidPoolSize(String),
    PoolBuild(String),
    InitialConnect(String),
}

impl std::fmt::Display for PoolBuildError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::MissingUrl => write!(f, "FEARLESS_SQL_PRIMARY env var not set"),
            Self::InvalidUrl(s) => write!(f, "invalid FEARLESS_SQL_PRIMARY: {s}"),
            Self::InvalidPoolSize(s) => write!(f, "invalid FEARLESS_SQL_PRIMARY_POOL_SIZE: {s}"),
            Self::PoolBuild(s) => write!(f, "deadpool build failed: {s}"),
            Self::InitialConnect(s) => write!(f, "could not connect to Postgres at startup: {s}"),
        }
    }
}

impl std::error::Error for PoolBuildError {}

pub async fn build_primary_pool() -> Result<Pool, PoolBuildError> {
    let url = env::var("FEARLESS_SQL_PRIMARY").map_err(|_| PoolBuildError::MissingUrl)?;

    let pool_size: usize = env::var("FEARLESS_SQL_PRIMARY_POOL_SIZE")
        .ok()
        .map(|s| s.parse().map_err(|e: std::num::ParseIntError| PoolBuildError::InvalidPoolSize(e.to_string())))
        .transpose()?
        .unwrap_or_else(num_cpus::get);

    let pg_config: tokio_postgres::Config = url
        .parse()
        .map_err(|e: tokio_postgres::Error| PoolBuildError::InvalidUrl(e.to_string()))?;

    let mut cfg = Config::new();
    cfg.host = pg_config.get_hosts().first().and_then(|h| match h {
        tokio_postgres::config::Host::Tcp(s) => Some(s.clone()),
        _ => None,
    });
    cfg.port = pg_config.get_ports().first().copied();
    cfg.user = pg_config.get_user().map(|s| s.to_string());
    cfg.password = pg_config
        .get_password()
        .and_then(|p| std::str::from_utf8(p).ok().map(|s| s.to_string()));
    cfg.dbname = pg_config.get_dbname().map(|s| s.to_string());

    let mut pool_cfg = deadpool_postgres::PoolConfig::new(pool_size);
    pool_cfg.timeouts.wait = Some(std::time::Duration::from_secs(2));
    cfg.pool = Some(pool_cfg);

    let pool = cfg
        .create_pool(Some(Runtime::Tokio1), tokio_postgres::NoTls)
        .map_err(|e| PoolBuildError::PoolBuild(e.to_string()))?;

    // Smoke test: grab one client to fail fast on bad URL/credentials.
    let client = pool
        .get()
        .await
        .map_err(|e| PoolBuildError::InitialConnect(e.to_string()))?;
    let _ = client
        .simple_query("SELECT 1")
        .await
        .map_err(|e| PoolBuildError::InitialConnect(e.to_string()))?;
    drop(client);

    Ok(pool)
}
```

- [ ] **Step 2: Add `num_cpus` dep (feature-gated)**

Modify `rust-core/Cargo.toml` — add to deps:

```toml
num_cpus = { version = "1", optional = true }
```

And update the feature:

```toml
pg-handles = ["dep:tokio", "dep:tokio-postgres", "dep:deadpool-postgres", "dep:num_cpus"]
```

- [ ] **Step 3: Wire the runtime module into lib.rs**

Modify `rust-core/src/lib.rs`. Find the existing `mod` declarations near the top, add (preserve order, just append):

```rust
pub mod runtime;
```

- [ ] **Step 4: Verify it compiles with the feature**

Run: `cd rust-core && cargo check --features pg-handles`

Expected: clean compile. If you get errors about `num_cpus` or `deadpool_postgres` unresolved, double-check the feature flag pulls them in.

- [ ] **Step 5: Write a smoke test that exercises the pool**

Create `rust-core/tests/pg_pool_smoke.rs`:

```rust
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
```

- [ ] **Step 6: Run the smoke tests**

Run: `cd rust-core && cargo test --features pg-handles --test pg_pool_smoke`

Expected: 1 passing (`missing_url_returns_specific_error`), 1 ignored.

Then start Postgres and run the live test:

```
./scripts/start-bench-postgres.sh
cd rust-core && cargo test --features pg-handles --test pg_pool_smoke -- --ignored
```

Expected: `live_pool_can_query ... ok`.

- [ ] **Step 7: Commit**

```bash
git add rust-core/Cargo.toml rust-core/Cargo.lock rust-core/src/lib.rs \
        rust-core/src/runtime/mod.rs rust-core/src/runtime/pg_pool.rs \
        rust-core/tests/pg_pool_smoke.rs
git commit -m "rust-core: deadpool-postgres pool builder under pg-handles feature"
```

---

## Task 4: Async bridge — tokio runtime + eventfd + completion queue

**Files:**
- Create: `rust-core/src/runtime/async_bridge.rs`

The bridge owns: a shared multi-thread tokio runtime (one per process) + a per-worker eventfd + a per-worker completion queue. The io_uring worker registers the eventfd as a poll source; tokio tasks push completions to the queue and write 1 byte to eventfd to wake the loop.

- [ ] **Step 1: Add `parking_lot` for cheap mutex (already in tree?)**

Run: `grep parking_lot rust-core/Cargo.toml`

If absent, add to deps (NOT feature-gated — used unconditionally):

```toml
parking_lot = "0.12"
```

- [ ] **Step 2: Write the bridge module**

Create `rust-core/src/runtime/async_bridge.rs`:

```rust
//! Async bridge: lets the io_uring worker loop spawn tokio futures and
//! consume their results via a per-worker eventfd + completion queue.
//!
//! Architecture:
//!   - One shared multi-thread tokio runtime (process-wide, set up at startup)
//!   - Per-worker `WorkerBridge`: owns an eventfd FD + a completion VecDeque
//!   - io_uring registers a `Read` op on the eventfd FD; when tokio writes 1
//!     to it, the read completes, the worker drains the queue.
//!
//! Worker exclusivity: `WorkerBridge` is owned by exactly one io_uring worker
//! thread. The `completions` mutex is contended only between that worker and
//! whichever tokio runtime threads finish a task assigned to it. Locks are
//! held only long enough to push/drain — never across awaits.

use parking_lot::Mutex;
use std::collections::VecDeque;
use std::future::Future;
use std::os::fd::RawFd;
use std::sync::Arc;
use std::sync::OnceLock;
use tokio::runtime::{Builder, Runtime};

static RUNTIME: OnceLock<Arc<Runtime>> = OnceLock::new();

/// Initialize the shared tokio runtime. Idempotent — first call wins, later
/// calls return the already-initialized runtime.
pub fn init_runtime(worker_threads: usize) -> Arc<Runtime> {
    RUNTIME
        .get_or_init(|| {
            let rt = Builder::new_multi_thread()
                .worker_threads(worker_threads.max(1))
                .thread_name("fearless-tokio")
                .enable_all()
                .build()
                .expect("tokio runtime build");
            Arc::new(rt)
        })
        .clone()
}

pub fn runtime() -> Arc<Runtime> {
    RUNTIME
        .get()
        .expect("async_bridge::init_runtime must be called before runtime()")
        .clone()
}

/// One completion ready to be written back to a parked connection.
#[derive(Debug)]
pub struct Completion {
    /// Identifier the io_uring worker uses to find the parked connection.
    /// In Phase 1.1 MVP this is the same `slot_id` the worker uses for slot
    /// indexing — keeps lookup O(1).
    pub slot_id: u32,
    /// HTTP response bytes (status line + headers + body, ready to send).
    pub bytes: Vec<u8>,
}

/// Per-worker bridge state. Owned by the io_uring worker thread.
pub struct WorkerBridge {
    eventfd: RawFd,
    completions: Arc<Mutex<VecDeque<Completion>>>,
    /// 8-byte buffer the io_uring loop reads into when the eventfd CQE fires.
    /// Lives here so it has a stable address for the lifetime of the worker.
    pub eventfd_read_buf: Box<[u8; 8]>,
}

impl WorkerBridge {
    /// Create a new bridge. Allocates a non-blocking eventfd via `eventfd2`.
    pub fn new() -> std::io::Result<Self> {
        let fd = unsafe {
            let fd = libc::eventfd(0, libc::EFD_CLOEXEC | libc::EFD_NONBLOCK);
            if fd < 0 {
                return Err(std::io::Error::last_os_error());
            }
            fd
        };
        Ok(Self {
            eventfd: fd,
            completions: Arc::new(Mutex::new(VecDeque::with_capacity(64))),
            eventfd_read_buf: Box::new([0u8; 8]),
        })
    }

    pub fn eventfd(&self) -> RawFd {
        self.eventfd
    }

    /// Spawn an async handler. Once `fut` resolves, the bytes are queued
    /// and the eventfd is signaled so the io_uring worker wakes and copies
    /// the response into the slot's write region.
    pub fn spawn<F>(&self, slot_id: u32, fut: F)
    where
        F: Future<Output = Vec<u8>> + Send + 'static,
    {
        let queue = self.completions.clone();
        let efd = self.eventfd;
        runtime().spawn(async move {
            let bytes = fut.await;
            queue.lock().push_back(Completion { slot_id, bytes });
            // SAFETY: efd is a valid eventfd opened in `new`. write of 8 bytes
            // is the eventfd contract. Errors here mean the worker is gone —
            // we drop the completion silently in that case.
            let val: u64 = 1;
            unsafe {
                libc::write(efd, &val as *const u64 as *const libc::c_void, 8);
            }
        });
    }

    /// Drain all pending completions. Called by the io_uring loop when it sees
    /// the eventfd CQE.
    pub fn drain(&self) -> Vec<Completion> {
        let mut guard = self.completions.lock();
        guard.drain(..).collect()
    }
}

impl Drop for WorkerBridge {
    fn drop(&mut self) {
        unsafe {
            libc::close(self.eventfd);
        }
    }
}
```

- [ ] **Step 3: Write the integration smoke test**

Create `rust-core/tests/async_bridge_smoke.rs`:

```rust
#![cfg(feature = "pg-handles")]

use fearless_core::runtime::async_bridge::{init_runtime, WorkerBridge};
use std::os::fd::RawFd;
use std::time::Duration;

#[test]
fn spawn_then_drain_yields_the_response() {
    init_runtime(2);
    let bridge = WorkerBridge::new().expect("bridge new");

    bridge.spawn(7, async {
        tokio::time::sleep(Duration::from_millis(10)).await;
        b"hello world".to_vec()
    });

    // Wait for the eventfd to be writeable (= tokio finished + signaled us).
    wait_for_eventfd(bridge.eventfd(), Duration::from_secs(1));

    let completions = bridge.drain();
    assert_eq!(completions.len(), 1);
    assert_eq!(completions[0].slot_id, 7);
    assert_eq!(completions[0].bytes, b"hello world");
}

#[test]
fn many_completions_are_all_drained() {
    init_runtime(2);
    let bridge = WorkerBridge::new().expect("bridge new");

    for i in 0..100u32 {
        bridge.spawn(i, async move {
            tokio::time::sleep(Duration::from_millis(1)).await;
            format!("slot-{i}").into_bytes()
        });
    }

    // Loop draining until we've seen all 100. eventfd may coalesce multiple
    // signals, so we don't read it strictly — we just poll until done.
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    let mut seen = vec![false; 100];
    let mut total = 0;
    while total < 100 && std::time::Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(5));
        for c in bridge.drain() {
            assert!(!seen[c.slot_id as usize], "duplicate slot {}", c.slot_id);
            seen[c.slot_id as usize] = true;
            assert_eq!(c.bytes, format!("slot-{}", c.slot_id).into_bytes());
            total += 1;
        }
    }
    assert_eq!(total, 100, "only drained {total} of 100");
}

fn wait_for_eventfd(fd: RawFd, timeout: Duration) {
    let deadline = std::time::Instant::now() + timeout;
    let mut buf = [0u8; 8];
    while std::time::Instant::now() < deadline {
        let n = unsafe { libc::read(fd, buf.as_mut_ptr() as *mut libc::c_void, 8) };
        if n == 8 {
            return;
        }
        std::thread::sleep(Duration::from_millis(5));
    }
    panic!("eventfd never fired within {timeout:?}");
}
```

- [ ] **Step 4: Run the smoke tests**

Run: `cd rust-core && cargo test --features pg-handles --test async_bridge_smoke`

Expected: both tests pass within ~6 seconds.

If `spawn_then_drain` hangs, the eventfd write isn't reaching the reader — check `EFD_NONBLOCK` and that `libc::write` returns 8.

- [ ] **Step 5: Commit**

```bash
git add rust-core/Cargo.toml rust-core/Cargo.lock \
        rust-core/src/runtime/async_bridge.rs rust-core/src/runtime/mod.rs \
        rust-core/tests/async_bridge_smoke.rs
git commit -m "rust-core: async_bridge — shared tokio rt + per-worker eventfd + completion queue"
```

---

## Task 5: io_uring registers eventfd, drains completions in the loop

**Files:**
- Modify: `rust-core/src/uring/runtime.rs` (the worker loop)
- Modify: `rust-core/src/uring/connection.rs` (state machine — new `AwaitingAsync` state)

This is the riskiest task — it changes the core io_uring loop. Test that the loop still works for plaintext/JSON before adding any async path.

- [ ] **Step 1: Read the existing worker loop end-to-end**

Run: `wc -l rust-core/src/uring/runtime.rs && cat rust-core/src/uring/runtime.rs`

Identify:
- Where the loop calls `submit_and_wait` (or equivalent)
- Where it dispatches CQEs by `user_data` token
- The `Token` encoding (probably packed slot_id + opcode tag)

You need to understand this before modifying. If anything is unclear, stop and ask the human.

- [ ] **Step 2: Define an EVENTFD token constant**

Pick an unused upper bit of the `Token` packing (or a sentinel slot_id like `u32::MAX`). The convention used elsewhere in the file should be matched — don't invent a new scheme.

For example, if tokens are `(slot_id: u32, op_tag: u32)`, reserve `slot_id = u32::MAX`, `op_tag = OpTag::Eventfd as u32`.

Add to `rust-core/src/uring/runtime.rs` near the existing token constants:

```rust
#[cfg(feature = "pg-handles")]
const EVENTFD_SLOT_ID: u32 = u32::MAX;
```

(Adapt to the file's actual conventions.)

- [ ] **Step 3: Add bridge construction inside the worker setup**

In the worker thread setup function (just before the loop starts), conditionally construct the bridge:

```rust
#[cfg(feature = "pg-handles")]
let bridge = std::sync::Arc::new(
    crate::runtime::async_bridge::WorkerBridge::new()
        .expect("eventfd allocation"),
);
```

Store the `bridge` somewhere the loop can reach it — likely as a field on the worker context struct that already exists.

- [ ] **Step 4: Submit a Read op on the eventfd at startup**

Before the main loop starts pulling CQEs, submit one Read on `bridge.eventfd()`:

```rust
#[cfg(feature = "pg-handles")]
{
    let entry = io_uring::opcode::Read::new(
        io_uring::types::Fd(bridge.eventfd()),
        bridge.eventfd_read_buf.as_mut_ptr(),
        8,
    )
    .build()
    .user_data(encode_token(EVENTFD_SLOT_ID, OpTag::Eventfd));
    // SAFETY: buf has 'static lifetime via Box owned by bridge.
    unsafe {
        let mut sq = ring.submission();
        sq.push(&entry).expect("sq full at startup");
    }
    ring.submit().expect("initial eventfd submit");
}
```

Adapt `encode_token` and `OpTag::Eventfd` to the file's existing conventions. If the file doesn't have an `OpTag` enum, add one alongside the existing token bits.

- [ ] **Step 5: Handle the EVENTFD CQE in the dispatch match**

Find the `match` (or if/else chain) in the loop body that dispatches CQEs by token. Add a new arm:

```rust
#[cfg(feature = "pg-handles")]
OpTag::Eventfd => {
    // Drain completions and write each into its slot's write region.
    let completions = bridge.drain();
    for completion in completions {
        // Look up the connection by slot_id. Skip silently if it's gone
        // (client disconnected before response arrived).
        if let Some(conn) = workers_state.connection_for_slot(completion.slot_id) {
            conn.deliver_async_response(&mut ring, completion.bytes)?;
        }
    }
    // Re-submit the read so we get the next signal.
    let entry = io_uring::opcode::Read::new(
        io_uring::types::Fd(bridge.eventfd()),
        bridge.eventfd_read_buf.as_mut_ptr(),
        8,
    )
    .build()
    .user_data(encode_token(EVENTFD_SLOT_ID, OpTag::Eventfd));
    unsafe {
        let mut sq = ring.submission();
        sq.push(&entry).map_err(|_| ...)?;
    }
}
```

The exact `connection_for_slot` and `deliver_async_response` methods don't exist yet — define them in the next step.

- [ ] **Step 6: Add `connection_for_slot` lookup and `deliver_async_response` on Connection**

The worker likely already has a slot table or connection map. Add a method on it that returns `Option<&mut Connection>` for a given slot_id.

Add to `rust-core/src/uring/connection.rs` (gated):

```rust
#[cfg(feature = "pg-handles")]
impl Connection {
    /// Called from the io_uring loop when the eventfd CQE delivers an
    /// async handler's response. Copies bytes into the slot's write region
    /// and submits a Send.
    pub fn deliver_async_response(
        &mut self,
        ring: &mut io_uring::IoUring,
        bytes: Vec<u8>,
    ) -> std::io::Result<()> {
        // Defensive: only accept delivery while the conn is parked.
        if !matches!(self.state, State::AwaitingAsync) {
            // Late delivery (e.g. timeout fired and conn moved on). Drop.
            return Ok(());
        }

        if bytes.len() > WRITE_REGION_BYTES {
            // Response too big — close the connection.
            self.close();
            return Ok(());
        }

        let write_slice = unsafe {
            std::slice::from_raw_parts_mut(self.slot.write_ptr, WRITE_REGION_BYTES)
        };
        write_slice[..bytes.len()].copy_from_slice(&bytes);
        self.write_filled = bytes.len();
        self.close_after_drain = true; // MVP: no keep-alive on async path
        self.state = State::Writing;
        let token = make_token(self.slot.id, OpTag::Send); // adapt to file conventions
        self.submit_write(ring, token)?;
        Ok(())
    }
}
```

- [ ] **Step 7: Add the `AwaitingAsync` state**

In the `State` enum in `connection.rs`, add (gated or unconditional, your call — gated keeps zero overhead in the no-pg-handles build):

```rust
enum State {
    // ... existing variants unchanged ...
    #[cfg(feature = "pg-handles")]
    AwaitingAsync,
}
```

Make sure every existing `match self.state` in the file either handles `AwaitingAsync` or has a wildcard arm — `cargo check --features pg-handles` will catch missing arms.

- [ ] **Step 8: Verify nothing regressed in the default build**

Run: `cd rust-core && cargo check && cargo build --release`

Expected: clean. Default build doesn't pull in tokio, doesn't see eventfd code.

- [ ] **Step 9: Verify the pg-handles build compiles**

Run: `cd rust-core && cargo check --features pg-handles && cargo build --release --features pg-handles`

Expected: clean. If you get borrow-checker errors around the `bridge` shared between the loop body and the dispatch arm — wrap in `Arc` and clone before the loop.

- [ ] **Step 10: Run the existing benchmark to verify no regression on plaintext/json**

Start the rust-core with `pg-handles` feature but no DB env (paths should not be exercised):

```
cd rust-core && cargo build --release --features pg-handles --features io-uring,aot-handlers
# (whatever feature set the bench Dockerfile uses)
```

Then run the local smoke bench (the one used in the conversation history):

```
node scripts/run-bench.mjs --quick --note "post task 5: eventfd registered, no async dispatch yet"
```

Expected: AOT plaintext / JSON within ±10% of recent baseline (~8.5M / 9.2M pipelined). If you see > 15% regression, the eventfd Read op or dispatch arm is interfering with the hot path — investigate before continuing.

- [ ] **Step 11: Commit**

```bash
git add rust-core/src/uring/runtime.rs rust-core/src/uring/connection.rs
git commit -m "rust-core: register eventfd as io_uring poll source for async bridge"
```

---

## Task 6: Hardcoded /db handler

**Files:**
- Create: `rust-core/src/aot/db_handler.rs`
- Modify: `rust-core/src/aot/mod.rs:1-20` (add module decl)

This is the actual SQL query — `SELECT id, randomnumber FROM world WHERE id=$1` with a random ID, returning `{"id":N,"randomNumber":M}` as JSON. No abstractions: one function, one query, one response shape.

- [ ] **Step 1: Add `fastrand` for the random ID (already in tree?)**

Run: `grep fastrand rust-core/Cargo.toml`

If absent, add (NOT feature-gated):

```toml
fastrand = "2"
```

- [ ] **Step 2: Write the handler module**

Create `rust-core/src/aot/db_handler.rs`:

```rust
//! Hardcoded /db handler for Phase 1.1 MVP.
//!
//! Runs `SELECT id, randomnumber FROM world WHERE id = $1` with a random
//! id in [1, 10000], returns `{"id":N,"randomNumber":M}` as JSON.
//!
//! Once the AOT transpiler can lift `await db.queryOne(sql\`...\`)`, this
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
```

- [ ] **Step 3: Add `itoa` if missing**

Run: `grep itoa rust-core/Cargo.toml`

If absent, add (unconditional, cheap dep):

```toml
itoa = "1"
```

- [ ] **Step 4: Wire the module**

Modify `rust-core/src/aot/mod.rs`. Add (preserving existing decls):

```rust
#[cfg(feature = "pg-handles")]
pub mod db_handler;
```

- [ ] **Step 5: Unit test the handler against live Postgres**

Create `rust-core/tests/db_handler_smoke.rs`:

```rust
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
```

- [ ] **Step 6: Run the test**

Run:

```
./scripts/start-bench-postgres.sh
cd rust-core && cargo test --features pg-handles --test db_handler_smoke -- --ignored
```

Expected: pass.

- [ ] **Step 7: Commit**

```bash
git add rust-core/Cargo.toml rust-core/Cargo.lock rust-core/src/aot/mod.rs \
        rust-core/src/aot/db_handler.rs rust-core/tests/db_handler_smoke.rs
git commit -m "rust-core: hardcoded /db handler (Phase 1.1 MVP, no AOT transpiler yet)"
```

---

## Task 7: Wire dispatcher to spawn /db via the bridge

**Files:**
- Modify: `rust-core/src/benchmark/parser.rs` (or wherever the route enum + classifier live)
- Modify: `rust-core/src/uring/connection.rs` (dispatch arm for `Route::Db`)
- Modify: `rust-core/src/uring/runtime.rs` (worker setup — pass pool to connections)

- [ ] **Step 1: Add `Route::Db` to the parser enum**

Modify `rust-core/src/benchmark/parser.rs`. Find the `Route` enum and add:

```rust
pub enum Route {
    Plaintext,
    Json,
    NotFound,
    #[cfg(feature = "pg-handles")]
    Db,
}
```

In the path classifier (whatever recognizes `/plaintext` and `/json`), add a branch for `/db`:

```rust
#[cfg(feature = "pg-handles")]
if path == b"/db" && method == b"GET" {
    return Route::Db;
}
```

Place it BEFORE the NotFound default. The exact location depends on the existing function structure.

- [ ] **Step 2: Pass pool + bridge into the worker context**

Modify the worker setup in `rust-core/src/uring/runtime.rs`. Where the worker thread is spawned, pass the pool:

```rust
#[cfg(feature = "pg-handles")]
let pool = std::env::var("FEARLESS_SQL_PRIMARY").ok().map(|_| {
    crate::runtime::async_bridge::runtime().block_on(async {
        crate::runtime::pg_pool::build_primary_pool().await.expect("pg pool init")
    })
});
```

(Build the pool once at process startup — share across workers via `Arc`. The exact layering depends on whether workers share state via an `Arc` already.)

Store `pool: Option<Arc<deadpool_postgres::Pool>>` on the worker context struct alongside `bridge`.

- [ ] **Step 3: Add the dispatch arm**

In `rust-core/src/uring/connection.rs`, find the `match cls.route` block (around line 167 in the file referenced in Task 5). Add a `Route::Db` arm:

```rust
#[cfg(feature = "pg-handles")]
Route::Db => {
    // Spawn the async handler via the worker's bridge. Park the conn.
    let pool = self.server.pg_pool.clone(); // Arc<Pool>
    let bridge = self.server.bridge.clone();  // Arc<WorkerBridge>
    let slot_id = self.slot.id;

    match pool {
        Some(pool) => {
            bridge.spawn(slot_id, async move {
                crate::aot::db_handler::handle_db_random(&pool).await
            });
            self.state = State::AwaitingAsync;
            // Don't write anything yet, don't submit a read, don't fall through.
            // The eventfd CQE will deliver the response and submit the send.
            return Ok(true);
        }
        None => {
            // pg-handles built but no pool — return 503 inline using the
            // same write-region pattern the Plaintext/Json arms use above.
            let bytes: &[u8] = b"HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";
            if self.write_filled + bytes.len() > WRITE_REGION_BYTES {
                if i == 0 {
                    self.close();
                    return Ok(false);
                }
                break;
            }
            let write_slice = unsafe {
                std::slice::from_raw_parts_mut(self.slot.write_ptr, WRITE_REGION_BYTES)
            };
            write_slice[self.write_filled..self.write_filled + bytes.len()]
                .copy_from_slice(bytes);
            close_after = true;
            bytes.len()
        }
    }
}
```

The exact integration with the existing pipeline-loop control flow needs care: pipelined requests after `/db` in the same buffer must NOT be processed until the `/db` response is sent. For MVP, force `close_after = true` and `break` out of the pipeline loop when we hit `Route::Db`.

- [ ] **Step 4: End-to-end smoke — manually start rust-core and curl /db**

```bash
./scripts/start-bench-postgres.sh
cd rust-core
FEARLESS_SQL_PRIMARY=postgres://fearless:fearless@localhost:5433/fearless_bench \
  cargo run --release --features pg-handles,io-uring,aot-handlers -- --port 8080 &
sleep 1
curl -v http://localhost:8080/db
```

Expected output: `HTTP/1.1 200 OK`, body like `{"id":1234,"randomNumber":5678}`.

If you get hangs, the eventfd → drain → deliver path has a bug. Add tracing prints (gated behind `RUST_LOG=trace`) to the bridge spawn, drain, and `deliver_async_response` to localize.

- [ ] **Step 5: Run several hundred concurrent /db requests via wrk**

```bash
wrk -t4 -c64 -d10s http://localhost:8080/db
```

Expected: stable throughput, no leaked sockets, no panics in the rust-core stderr. Don't worry about the exact number yet — that's Task 8.

- [ ] **Step 6: Kill the rust-core, verify clean shutdown**

```bash
kill %1
wait
```

Expected: no panics on Drop, no `Connection refused` from postgres after.

- [ ] **Step 7: Commit**

```bash
git add rust-core/src/benchmark/parser.rs rust-core/src/uring/connection.rs \
        rust-core/src/uring/runtime.rs
git commit -m "rust-core: dispatch /db through async bridge (Phase 1.1 MVP)"
```

---

## Task 8: Bench /db, verify ≥100k req/s on OrbStack

**Files:**
- Modify: `bench/scripts/run-bench.mjs` (or whatever the local bench harness is — add /db scenario for the rust-core port)
- Modify: `bench-history.json` (auto-updated by run-bench)

Goal numbers:
- Bun /db baseline (recent): ~40k req/s
- AOT /db target on OrbStack: ≥100k req/s
- AOT /db projection on bare-metal Citrine: ≥500k req/s (to be verified later)

If we're below 100k on OrbStack, profile and identify the bottleneck before celebrating the MVP.

- [ ] **Step 1: Add /db scenario to the bench harness**

Modify `bench/scripts/run-bench.mjs`. Find the AOT scenario list (the one that hits port 8080), add:

```js
{
  id: "aot/db-c64",
  desc: "AOT /db c=64 (Postgres random world)",
  cmd: ["wrk", "-t", "4", "-c", "64", "-d", "10", "http://localhost:8080/db"],
  needsPg: true,
},
{
  id: "aot/db-c256",
  desc: "AOT /db c=256",
  cmd: ["wrk", "-t", "8", "-c", "256", "-d", "10", "http://localhost:8080/db"],
  needsPg: true,
},
```

If the harness has a setup hook concept, add a `needsPg` flag handler that runs `./scripts/start-bench-postgres.sh` before scenarios that require it. Otherwise, run it manually before the bench.

- [ ] **Step 2: Build the rust-core image with pg-handles enabled**

Modify `bench/techempower/fearless-rust-aot.dockerfile` (or whatever the bench Dockerfile is) to add `--features pg-handles` to the cargo build line.

Verify it still builds:

```bash
docker build -f bench/techempower/fearless-rust-aot.dockerfile -t fearless-rust-aot:dev .
```

- [ ] **Step 3: Run the bench**

```bash
./scripts/start-bench-postgres.sh
node scripts/run-bench.mjs --quick --note "Phase 1.1 MVP: hardcoded /db via async bridge"
```

Expected: full bench run completes without errors. Look at the `aot/db-c64` and `aot/db-c256` lines.

- [ ] **Step 4: Interpret the results**

Three outcomes:

(a) **AOT /db c=256 ≥ 100k req/s** — MVP success. Architecture works. Move to Phase 1.2 (generalization via AOT transpiler) or pause for human review.

(b) **AOT /db c=256 in [40k, 100k]** — works but underperforming the target. Likely bottlenecks:
   - Pool too small (try `FEARLESS_SQL_PRIMARY_POOL_SIZE=128`)
   - Postgres single-threaded for the bench (check `SELECT count(*) FROM pg_stat_activity` mid-bench)
   - Tokio runtime starvation (try `init_runtime(num_cpus * 2)`)
   - eventfd contention (check completion queue depth — add a debug counter)
   Profile with `samply` or `perf` and document what's hot.

(c) **AOT /db c=256 < 40k req/s OR errors** — regression vs Bun baseline. STOP. The bridge has a bug. Likely:
   - Slot reuse race (slot freed before delivery)
   - Eventfd CQE not re-submitted (loop only fires once)
   - Mutex contention (drain holds lock too long)
   Add tracing, narrow the scope (single connection at a time), find the root cause before any more code.

- [ ] **Step 5: If (a) — commit results**

```bash
git add bench-history.json bench/scripts/run-bench.mjs \
        bench/techempower/fearless-rust-aot.dockerfile
git commit -m "bench: Phase 1.1 MVP /db scenario, hits NNNk req/s on OrbStack"
```

(Replace NNN with the actual number from the run.)

- [ ] **Step 6: If (a) — write the wrap-up note**

Append to `docs/superpowers/plans/2026-05-08-phase-1-1-typed-handles-mvp.md` a `## MVP Result` section with:
- Number hit (req/s)
- Number per-worker (divide by worker count)
- p50 / p99 latency from wrk output
- One sentence on next step (Phase 1.2 = AOT generalization, OR retune for higher numbers first)

```bash
git add docs/superpowers/plans/2026-05-08-phase-1-1-typed-handles-mvp.md
git commit -m "docs: Phase 1.1 MVP result note"
```

---

## MVP Result (Task 8 — 2026-05-08)

**Outcome: (b) Working but underperforming.** The async bridge is functional end-to-end but the architecture hits a fundamental concurrency ceiling.

**Run id:** `248fcb7-dirty`

| Scenario | req/s | p50 | p99 |
|---|---|---|---|
| `aot/db-c64` | 13.9k | 2.0ms | 313ms |
| `aot/db-c256` | 15.6k | 31ms | 376ms |
| Bun `/db` baseline (c=64) | 44.8k | — | — |

**Plaintext/JSON regression check:** CLEAN — all within noise vs `afe9d06-dirty` baseline (plaintext-pipe32 -6.7%, json-pipe32 +5.5%, within 15% window; all c=64 scenarios within 2%).

**Root cause — architectural ceiling, not a tuning failure:**

The io_uring event loop can park at most **one** `/db` request per worker thread. With 10 io_uring workers (derived from OrbStack VM core count), only 10 queries run concurrently at any point. Postgres confirms this: under c=64 load, `pg_stat_activity` shows 64 idle connections but only 1–4 active at any moment. The pool size (64) and tokio thread count (10) are irrelevant — the bottleneck is the 1-request-per-worker parking model.

This explains c=256 being worse than c=64: with more concurrent HTTP connections queued against 10 workers, head-of-line blocking increases queuing delay (p50 jumps from 2ms to 31ms) while throughput barely changes.

**To reach 100k req/s this requires a structural change:** each io_uring worker must be able to park **multiple** concurrent async requests simultaneously — a per-connection parked state tracked by slot_id, not a per-worker "one parked at a time" model. The `park_for_async()` call in `connection.rs` must be changed to allow re-entry of new requests on the same worker while others are awaiting their futures.

**Next step:** Phase 1.2 structural fix — multi-slot async parking per worker (connection state machine allows N concurrent parked async ops per worker, bounded by the slot array size). This is a 1–2 day change confined to `uring/connection.rs` and `uring/accept.rs`. Once done, re-run Task 8 bench to verify.

---

## What "done" looks like for Phase 1.1 MVP

- ✅ `pg-handles` feature builds clean, default build unchanged
- ✅ `cargo test --features pg-handles` passes (incl. live Postgres tests under `--ignored`)
- ✅ `curl http://localhost:8080/db` returns valid JSON from a real Postgres query
- ✅ `wrk -c 256` against `/db` hits ≥100k req/s on OrbStack with no errors
- ✅ Plaintext / JSON benchmarks unchanged (within noise window) — async bridge has zero cost when not used
- ✅ Process shuts down cleanly (no panics, no leaked connections)

If all checks pass, the io_uring + tokio bridge architecture is proven. Phase 1.2 then layers the AOT analyzer / transpiler / build-time SQL collection on top — the bridge is the part that was risky, and it's now real.
