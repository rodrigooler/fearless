//! Runtime helpers for Phase 1+ async I/O integration.
//!
//! Currently houses the Postgres pool and the eventfd-based async bridge that
//! lets the io_uring worker loop spawn tokio futures and resume on completion.

#[cfg(feature = "pg-handles")]
pub mod pg_pool;
