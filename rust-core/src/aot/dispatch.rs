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
//! The build pipeline (`fearless build`) generates a `register(table)` function
//! in `aot/handlers.rs` that calls `table.add(...)` for each route. The
//! framework calls `register` once at startup.

use crate::aot::runtime::AotRequest;
use rustc_hash::FxHashMap;

/// Function pointer signature every generated AOT handler must conform to.
pub type AotHandlerFn = fn(&AotRequest, &mut Vec<u8>);

/// One segment of a route path.
#[derive(Debug, Clone)]
pub enum RouteSegment {
    Static(&'static str),
    Param(&'static str),
}

#[derive(Debug, Clone)]
pub struct AotRoute {
    pub method: &'static str,
    pub segments: Vec<RouteSegment>,
    pub handler: AotHandlerFn,
}

#[derive(Debug, Default)]
pub struct AotRouteTable {
    routes: Vec<AotRoute>,
}

impl AotRouteTable {
    pub fn new() -> Self {
        Self::default()
    }

    /// Register a route. `path` is split into segments; segments starting with
    /// `:` are param captures. Method is the uppercase HTTP verb (`"GET"`).
    pub fn add(&mut self, method: &'static str, path: &'static str, handler: AotHandlerFn) {
        let segments = parse_segments(path);
        self.routes.push(AotRoute { method, segments, handler });
    }

    /// Look up a route. Returns the handler + captured params if found.
    /// `params` is a fresh `FxHashMap` — caller decides whether to recycle it.
    pub fn lookup(&self, method: &str, path: &str) -> Option<(AotHandlerFn, FxHashMap<String, String>)> {
        for route in &self.routes {
            if route.method != method {
                continue;
            }
            if let Some(params) = match_segments(&route.segments, path) {
                return Some((route.handler, params));
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
        let (handler, _) = table.lookup("GET", "/x").unwrap();
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
}
