use fearless_core::benchmark::parser::{classify, parse_pipeline, Classification, Route};

#[test]
fn classifies_plaintext_keepalive() {
    let line = b"GET /plaintext HTTP/1.1\r\n";
    assert_eq!(classify(line), Classification { route: Route::Plaintext, close: false });
}

#[test]
fn classifies_json_close() {
    let line = b"GET /json HTTP/1.0\r\n";
    assert_eq!(classify(line), Classification { route: Route::Json, close: true });
}

#[test]
fn unknown_path_is_not_found() {
    let line = b"GET /db HTTP/1.1\r\n";
    assert_eq!(classify(line).route, Route::NotFound);
}

#[test]
fn non_get_is_not_found() {
    let line = b"POST /plaintext HTTP/1.1\r\n";
    assert_eq!(classify(line).route, Route::NotFound);
}

#[test]
fn truncated_input_is_not_found() {
    let line = b"GET /";
    assert_eq!(classify(line).route, Route::NotFound);
}

#[test]
fn parses_three_pipelined_plaintext() {
    let buf = b"GET /plaintext HTTP/1.1\r\nHost: a\r\n\r\n\
                GET /plaintext HTTP/1.1\r\nHost: a\r\n\r\n\
                GET /plaintext HTTP/1.1\r\nHost: a\r\n\r\n";
    let mut out = [Classification { route: Route::NotFound, close: false }; 8];
    let result = parse_pipeline(buf, &mut out);
    assert_eq!(result.count, 3);
    assert_eq!(result.consumed, buf.len());
    for c in &out[..3] {
        assert_eq!(c.route, Route::Plaintext);
        assert!(!c.close);
    }
}

#[test]
fn keeps_partial_trailing_request() {
    let mut buf = b"GET /plaintext HTTP/1.1\r\nHost: a\r\n\r\nGET /pla".to_vec();
    let mut out = [Classification { route: Route::NotFound, close: false }; 4];
    let result = parse_pipeline(&buf, &mut out);
    assert_eq!(result.count, 1);
    assert!(result.consumed < buf.len());
    let trailing = buf.len() - result.consumed;
    buf.copy_within(result.consumed.., 0);
    buf.truncate(trailing);
    assert_eq!(&buf, b"GET /pla");
}
