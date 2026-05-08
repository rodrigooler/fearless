//! Route table for AOT-compiled handlers.
//!
//! Each entry maps a (method, segmented-path) pair to a generated handler
//! function. Lookup is linear over the route list — fine for Phase 0 with
//! tens of routes; can be replaced with a trie or perfect hash later.
//!
//! Path segments support two kinds:
//!   - `Static("users")` — must match literally
//!   - `Param("id")` — matches any one segment, captured into the params map
//!
//! Handlers are split into two kinds via `HandlerKind`:
//!   - `Sync(AotHandlerFn)` — runs inline on the io_uring worker, writing into
//!     a borrowed scratch `Vec<u8>`. Cheap, no spawn, no clone.
//!   - `Async(AotAsyncHandlerFn)` — receives owned request state and an
//!     `Arc<HandleRegistry>`, returns a `Pin<Box<Future>>`. Spawned via the
//!     async bridge so the io_uring loop can park the connection without
//!     blocking other in-flight requests.
//!
//! The build pipeline (`fearless build`) generates a `register(table)` function
//! in `aot/handlers.rs` that calls `table.add(...)` (sync) or `table.add_async(...)`
//! (async, only when `pg-handles` is on) for each route.

use crate::aot::runtime::AotRequest;
use rustc_hash::FxHashMap;
#[cfg(feature = "pg-handles")]
use std::collections::HashMap;
#[cfg(feature = "pg-handles")]
use std::future::Future;
#[cfg(feature = "pg-handles")]
use std::pin::Pin;
#[cfg(feature = "pg-handles")]
use std::sync::Arc;

/// Function pointer signature for sync AOT handlers. Runs inline on the
/// io_uring worker thread; writes the response (status + headers + body) into
/// the supplied scratch buffer.
pub type AotHandlerFn = fn(&AotRequest, &mut Vec<u8>);

/// Function pointer signature for async AOT handlers. Takes OWNED request
/// state — the io_uring read buffer is reused immediately after spawn, so
/// borrowing into it would be unsound across the await.
///
/// Cost of the owned-clone (params + query + headers): ~1µs for typical
/// requests with a few small headers. Acceptable for non-benchmark routes;
/// the hot benchmark path (plaintext/json) never reaches here.
#[cfg(feature = "pg-handles")]
pub type AotAsyncHandlerFn = fn(
    method: String,
    path: String,
    params: HashMap<String, String>,
    query: HashMap<String, String>,
    headers: HashMap<String, String>,
    handles: Arc<crate::aot::handles::HandleRegistry>,
) -> Pin<Box<dyn Future<Output = Vec<u8>> + Send>>;

/// Discriminates how a route's handler should be invoked.
pub enum HandlerKind {
    Sync(AotHandlerFn),
    #[cfg(feature = "pg-handles")]
    Async(AotAsyncHandlerFn),
}

/// One segment of a route path.
#[derive(Debug, Clone)]
pub enum RouteSegment {
    Static(&'static str),
    Param(&'static str),
}

pub struct AotRoute {
    pub method: &'static str,
    pub segments: Vec<RouteSegment>,
    pub handler: HandlerKind,
}

#[derive(Default)]
pub struct AotRouteTable {
    routes: Vec<AotRoute>,
}

impl AotRouteTable {
    pub fn new() -> Self {
        Self::default()
    }

    /// Register a sync route. `path` is split into segments; segments starting
    /// with `:` are param captures. Method is the uppercase HTTP verb (`"GET"`).
    pub fn add(&mut self, method: &'static str, path: &'static str, handler: AotHandlerFn) {
        let segments = parse_segments(path);
        self.routes.push(AotRoute {
            method,
            segments,
            handler: HandlerKind::Sync(handler),
        });
    }

    /// Register an async route. Only available when `pg-handles` is on; async
    /// handlers spawn on the shared tokio runtime via the per-worker bridge.
    #[cfg(feature = "pg-handles")]
    pub fn add_async(
        &mut self,
        method: &'static str,
        path: &'static str,
        handler: AotAsyncHandlerFn,
    ) {
        let segments = parse_segments(path);
        self.routes.push(AotRoute {
            method,
            segments,
            handler: HandlerKind::Async(handler),
        });
    }

    /// Look up a route. Returns `(handler kind, captured params)` if found.
    /// `params` is a fresh `FxHashMap` — caller decides whether to recycle it.
    pub fn lookup(
        &self,
        method: &str,
        path: &str,
    ) -> Option<(&HandlerKind, FxHashMap<String, String>)> {
        for route in &self.routes {
            if route.method != method {
                continue;
            }
            if let Some(params) = match_segments(&route.segments, path) {
                return Some((&route.handler, params));
            }
        }
        None
    }

    /// Number of routes registered.
    pub fn len(&self) -> usize {
        self.routes.len()
    }

    pub fn is_empty(&self) -> bool {
        self.routes.is_empty()
    }
}

/// Split a path like `/users/:id/posts` into segments.
/// Empty leading segment (from the leading `/`) is dropped.
fn parse_segments(path: &'static str) -> Vec<RouteSegment> {
    let mut segments: Vec<RouteSegment> = Vec::new();
    for raw in path.split('/') {
        if raw.is_empty() {
            continue;
        }
        if let Some(name) = raw.strip_prefix(':') {
            segments.push(RouteSegment::Param(name));
        } else {
            segments.push(RouteSegment::Static(raw));
        }
    }
    segments
}

/// Try to match `path` against route segments. Returns captured params on success.
fn match_segments(route: &[RouteSegment], path: &str) -> Option<FxHashMap<String, String>> {
    let mut params: FxHashMap<String, String> = FxHashMap::default();
    let mut iter = path.split('/').filter(|s| !s.is_empty());

    for segment in route {
        let actual = iter.next()?;
        match segment {
            RouteSegment::Static(expected) => {
                if *expected != actual {
                    return None;
                }
            }
            RouteSegment::Param(name) => {
                params.insert((*name).to_string(), actual.to_string());
            }
        }
    }

    // After consuming all route segments, there must be no extra path segments.
    if iter.next().is_some() {
        return None;
    }

    Some(params)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn dummy_handler(_req: &AotRequest, out: &mut Vec<u8>) {
        out.extend_from_slice(b"dummy");
    }

    #[test]
    fn parse_simple_path() {
        let segments = parse_segments("/users/:id");
        assert_eq!(segments.len(), 2);
        assert!(matches!(segments[0], RouteSegment::Static("users")));
        assert!(matches!(segments[1], RouteSegment::Param("id")));
    }

    #[test]
    fn match_static_route() {
        let mut table = AotRouteTable::new();
        table.add("GET", "/healthz", dummy_handler);
        let result = table.lookup("GET", "/healthz");
        assert!(result.is_some());
        let (_, params) = result.unwrap();
        assert!(params.is_empty());
    }

    #[test]
    fn match_with_param() {
        let mut table = AotRouteTable::new();
        table.add("GET", "/users/:id", dummy_handler);
        let result = table.lookup("GET", "/users/42");
        assert!(result.is_some());
        let (_, params) = result.unwrap();
        assert_eq!(params.get("id"), Some(&"42".to_string()));
    }

    #[test]
    fn no_match_wrong_method() {
        let mut table = AotRouteTable::new();
        table.add("GET", "/x", dummy_handler);
        assert!(table.lookup("POST", "/x").is_none());
    }

    #[test]
    fn no_match_extra_segments() {
        let mut table = AotRouteTable::new();
        table.add("GET", "/users", dummy_handler);
        assert!(table.lookup("GET", "/users/42").is_none());
    }

    #[test]
    fn no_match_missing_segments() {
        let mut table = AotRouteTable::new();
        table.add("GET", "/users/:id", dummy_handler);
        assert!(table.lookup("GET", "/users").is_none());
    }

    #[test]
    fn multiple_params_captured() {
        let mut table = AotRouteTable::new();
        table.add("GET", "/users/:userId/posts/:postId", dummy_handler);
        let (_, params) = table.lookup("GET", "/users/42/posts/7").unwrap();
        assert_eq!(params.get("userId"), Some(&"42".to_string()));
        assert_eq!(params.get("postId"), Some(&"7".to_string()));
    }

    #[test]
    fn handler_is_callable_after_lookup() {
        let mut table = AotRouteTable::new();
        table.add("GET", "/x", dummy_handler);
        let (kind, _) = table.lookup("GET", "/x").unwrap();
        // `let ... else` would be irrefutable when `pg-handles` is off (only
        // one variant exists); use `match` so the test compiles cleanly under
        // both feature sets.
        let handler = match kind {
            HandlerKind::Sync(h) => h,
            #[cfg(feature = "pg-handles")]
            _ => panic!("expected sync handler"),
        };
        let req = AotRequest {
            method: "GET",
            path: "/x",
            url: "/x",
            ip: "",
            params: &HashMap::new(),
            query: &HashMap::new(),
            headers: &HashMap::new(),
        };
        let mut out = Vec::new();
        handler(&req, &mut out);
        assert_eq!(out, b"dummy");
    }

    #[cfg(feature = "pg-handles")]
    #[test]
    fn add_async_returns_async_kind() {
        fn placeholder(
            _method: String,
            _path: String,
            _params: HashMap<String, String>,
            _query: HashMap<String, String>,
            _headers: HashMap<String, String>,
            _handles: std::sync::Arc<crate::aot::handles::HandleRegistry>,
        ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Vec<u8>> + Send>> {
            Box::pin(async { Vec::new() })
        }
        let mut table = AotRouteTable::new();
        table.add_async("GET", "/db_test", placeholder);
        let (kind, _) = table.lookup("GET", "/db_test").unwrap();
        assert!(matches!(kind, HandlerKind::Async(_)));
    }
}
