use fearless_core::benchmark::responses::{BenchmarkResponses, Variant};

#[test]
fn plaintext_keepalive_has_expected_layout() {
    let responses = BenchmarkResponses::new();
    let bytes = responses.snapshot().get(Variant::PlaintextKeepalive);
    let s = std::str::from_utf8(&bytes).unwrap();
    assert!(s.starts_with("HTTP/1.1 200 OK\r\nDate: "));
    assert!(!s.contains("Server:"), "Server header intentionally omitted in benchmark mode");
    assert!(s.contains("Content-Type: text/plain; charset=utf-8\r\n"));
    assert!(s.contains("Content-Length: 13\r\n"));
    assert!(s.contains("Connection: keep-alive\r\n"));
    assert!(s.ends_with("\r\n\r\nHello, World!"));
}

#[test]
fn json_close_has_expected_layout() {
    let responses = BenchmarkResponses::new();
    let bytes = responses.snapshot().get(Variant::JsonClose);
    let s = std::str::from_utf8(&bytes).unwrap();
    assert!(s.contains("Content-Type: application/json\r\n"));
    assert!(s.contains("Content-Length: 27\r\n"));
    assert!(s.contains("Connection: close\r\n"));
    assert!(s.ends_with("\r\n\r\n{\"message\":\"Hello, World!\"}"));
}

#[test]
fn snapshot_returns_same_arc_until_refresh() {
    let responses = BenchmarkResponses::new();
    let snap1 = responses.snapshot();
    let snap2 = responses.snapshot();
    let p1 = snap1.get(Variant::PlaintextKeepalive);
    let p2 = snap2.get(Variant::PlaintextKeepalive);
    assert!(std::ptr::eq(p1.as_ptr(), p2.as_ptr()), "snapshots should share the underlying Arc when no refresh occurred");
}
