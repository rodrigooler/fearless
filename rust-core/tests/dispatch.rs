use fearless_core::{benchmark_manifest_routes_only, is_benchmark_manifest};

#[test]
fn detects_pure_benchmark_manifest() {
    let manifest = benchmark_manifest_routes_only();
    assert!(is_benchmark_manifest(&manifest));
}

#[test]
fn rejects_manifest_with_extra_routes() {
    let mut manifest = benchmark_manifest_routes_only();
    manifest.routes.push(fearless_core::RustStaticRoute {
        method: "GET".into(),
        path: "/extra".into(),
        response: fearless_core::RustRouteResponse {
            kind: fearless_core::ResponseKind::Text,
            body: serde_json::json!("x"),
            status: Some(200),
            headers: Default::default(),
        },
        headers: Default::default(),
    });
    assert!(!is_benchmark_manifest(&manifest));
}
