#![cfg(all(target_os = "linux", feature = "io-uring"))]

use std::io::{Read, Write};
use std::net::TcpStream;
use std::thread;
use std::time::Duration;

#[test]
fn serves_plaintext_via_io_uring() {
    let port = 18800;
    thread::spawn(move || {
        fearless_core::run_benchmark_server(port).unwrap();
    });
    thread::sleep(Duration::from_millis(200));

    let mut stream = TcpStream::connect(("127.0.0.1", port)).unwrap();
    stream
        .write_all(b"GET /plaintext HTTP/1.1\r\nHost: x\r\n\r\n")
        .unwrap();
    let mut buf = [0u8; 256];
    let n = stream.read(&mut buf).unwrap();
    let response = std::str::from_utf8(&buf[..n]).unwrap();
    assert!(
        response.starts_with("HTTP/1.1 200 OK"),
        "response did not start with 200 OK: {response}"
    );
    assert!(
        response.ends_with("Hello, World!"),
        "response did not end with body: {response}"
    );
}
