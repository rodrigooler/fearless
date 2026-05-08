//! AOT runtime contract.
//!
//! Generated handlers depend on these types and helpers. They are intentionally
//! minimal — no ownership of buffers, no async, no allocations beyond growing
//! the response Vec.
//!
//! Include this file in rust-core as `pub mod aot_runtime;` and ensure the
//! generated `aot_handlers.rs` has `use crate::aot_runtime::*;`.

use std::collections::HashMap;

/// Lightweight request view passed to AOT-compiled handlers. The framework
/// constructs it once per request from the parsed wire bytes.
pub struct AotRequest<'a> {
    pub method: &'a str,
    pub path: &'a str,
    pub url: &'a str,
    pub ip: &'a str,
    pub params: &'a HashMap<String, String>,
    pub query: &'a HashMap<String, String>,
    pub headers: &'a HashMap<String, String>,
}

impl<'a> AotRequest<'a> {
    /// Read a path parameter. Returns empty string if missing.
    #[inline]
    pub fn param(&self, key: &str) -> &str {
        self.params.get(key).map(String::as_str).unwrap_or("")
    }

    /// Read a query parameter. Returns empty string if missing.
    #[inline]
    pub fn query_get(&self, key: &str) -> &str {
        self.query.get(key).map(String::as_str).unwrap_or("")
    }

    /// Read a header (case-insensitive — keys must already be lowercased by caller).
    #[inline]
    pub fn header(&self, key: &str) -> &str {
        self.headers.get(key).map(String::as_str).unwrap_or("")
    }
}

/// JSON-string-encode `value` and append to `out`. Escapes `"`, `\\`, control
/// characters per RFC 8259.
pub fn write_json_string(out: &mut Vec<u8>, value: &str) {
    for byte in value.as_bytes() {
        match byte {
            b'"' => out.extend_from_slice(b"\\\""),
            b'\\' => out.extend_from_slice(b"\\\\"),
            b'\n' => out.extend_from_slice(b"\\n"),
            b'\r' => out.extend_from_slice(b"\\r"),
            b'\t' => out.extend_from_slice(b"\\t"),
            b'\x08' => out.extend_from_slice(b"\\b"),
            b'\x0c' => out.extend_from_slice(b"\\f"),
            &b if b < 0x20 => {
                let nibble_high = b >> 4;
                let nibble_low = b & 0x0f;
                out.extend_from_slice(b"\\u00");
                out.push(hex_nibble(nibble_high));
                out.push(hex_nibble(nibble_low));
            }
            &b => out.push(b),
        }
    }
}

#[inline]
fn hex_nibble(n: u8) -> u8 {
    if n < 10 { b'0' + n } else { b'a' + (n - 10) }
}

/// URL-encode `value` and append to `out`. Conservative: only unreserved chars
/// per RFC 3986 pass through unencoded.
pub fn write_url_encoded(out: &mut Vec<u8>, value: &str) {
    for &byte in value.as_bytes() {
        let unreserved = matches!(
            byte,
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~'
        );
        if unreserved {
            out.push(byte);
        } else {
            out.push(b'%');
            out.push(hex_nibble(byte >> 4).to_ascii_uppercase());
            out.push(hex_nibble(byte & 0x0f).to_ascii_uppercase());
        }
    }
}

/// Write `value` as a base-10 ASCII number. Used for Content-Length headers
/// where the body length is computed at runtime.
pub fn write_decimal(out: &mut Vec<u8>, mut value: usize) {
    if value == 0 {
        out.push(b'0');
        return;
    }
    // Stack buffer — usize at base 10 fits in 20 ASCII bytes.
    let mut buf = [0u8; 20];
    let mut len = 0usize;
    while value > 0 {
        buf[len] = b'0' + (value % 10) as u8;
        value /= 10;
        len += 1;
    }
    // Bytes were written least-significant first — reverse.
    for i in (0..len).rev() {
        out.push(buf[i]);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn json_string_escapes() {
        let mut out = Vec::new();
        write_json_string(&mut out, "hello \"world\"\n");
        assert_eq!(&out, b"hello \\\"world\\\"\\n");
    }

    #[test]
    fn url_encode_basic() {
        let mut out = Vec::new();
        write_url_encoded(&mut out, "a b/c");
        assert_eq!(&out, b"a%20b%2Fc");
    }

    #[test]
    fn decimal_zero() {
        let mut out = Vec::new();
        write_decimal(&mut out, 0);
        assert_eq!(&out, b"0");
    }

    #[test]
    fn decimal_multidigit() {
        let mut out = Vec::new();
        write_decimal(&mut out, 12345);
        assert_eq!(&out, b"12345");
    }
}
