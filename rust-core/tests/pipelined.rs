#![cfg(all(target_os = "linux", feature = "io-uring"))]

use std::io::{Read, Write};
use std::net::TcpStream;
use std::thread;
use std::time::Duration;

#[test]
fn handles_pipelined_burst() {
    let port = 18801;
    thread::spawn(move || {
        fearless_core::run_benchmark_server(port).unwrap();
    });
    thread::sleep(Duration::from_millis(200));

    let mut stream = TcpStream::connect(("127.0.0.1", port)).unwrap();
    let mut burst = Vec::new();
    for _ in 0..16 {
        burst.extend_from_slice(b"GET /plaintext HTTP/1.1\r\nHost: x\r\n\r\n");
    }
    stream.write_all(&burst).unwrap();
    stream
        .set_read_timeout(Some(Duration::from_secs(2)))
        .unwrap();

    let mut received = Vec::new();
    let mut buf = [0u8; 8192];
    while received
        .windows(13)
        .filter(|w| w == b"Hello, World!")
        .count()
        < 16
    {
        let n = stream.read(&mut buf).unwrap();
        received.extend_from_slice(&buf[..n]);
        if n == 0 {
            break;
        }
    }

    let count = received
        .windows(13)
        .filter(|w| w == b"Hello, World!")
        .count();
    assert_eq!(
        count, 16,
        "expected 16 plaintext responses for 16 pipelined requests"
    );
}
