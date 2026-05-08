//! Placeholder for the generated AOT handlers file.
//!
//! When `fearless build` runs over a user app, it overwrites this file with
//! the actual handler functions transpiled from TypeScript. The empty stub
//! exists so `cargo build --features aot-handlers` succeeds in CI even when
//! no user app has been built yet.
//!
//! The feature is OFF by default; the build pipeline turns it on when there
//! are AOT-eligible handlers to ship.

#[allow(unused_imports)]
use crate::aot::runtime;
