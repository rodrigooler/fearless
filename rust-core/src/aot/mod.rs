//! AOT (Ahead-Of-Time) compiled handler infrastructure.
//!
//! `runtime` exports the contract the generated handlers depend on (the
//! `AotRequest` type and small helpers like `write_json_string`).
//!
//! `handlers` is the generated file produced by `fearless build` from a user
//! TypeScript app. It is gated behind the `aot-handlers` feature flag so the
//! crate compiles cleanly without it (the common case for benchmark images
//! and CI). When the flag is on, `cargo build` expects `aot/handlers.rs` to
//! exist alongside this `mod.rs`.

pub mod dispatch;
pub mod runtime;

#[cfg(feature = "aot-handlers")]
pub mod handlers;

#[cfg(feature = "pg-handles")]
pub mod db_handler;

#[cfg(feature = "pg-handles")]
pub mod handles;

/// Build-generated: STATEMENTS phf map + register_handles() constructor.
/// Only present when the app was compiled with `fearless build` and at least
/// one async SQL handler was discovered.
#[cfg(all(feature = "pg-handles", feature = "aot-handlers"))]
pub mod registry_init;

pub use dispatch::{AotHandlerFn, AotRoute, AotRouteTable, RouteSegment};
