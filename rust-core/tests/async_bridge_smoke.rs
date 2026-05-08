#![cfg(all(feature = "pg-handles", target_os = "linux"))]

use fearless_core::runtime::async_bridge::{init_runtime, WorkerBridge};
use std::os::fd::RawFd;
use std::time::Duration;

#[test]
fn spawn_then_drain_yields_the_response() {
    init_runtime(2);
    let bridge = WorkerBridge::new().expect("bridge new");

    bridge.spawn(7, async {
        tokio::time::sleep(Duration::from_millis(10)).await;
        b"hello world".to_vec()
    });

    wait_for_eventfd(bridge.eventfd(), Duration::from_secs(1));

    let completions = bridge.drain();
    assert_eq!(completions.len(), 1);
    assert_eq!(completions[0].slot_id, 7);
    assert_eq!(completions[0].bytes, b"hello world");
}

#[test]
fn many_completions_are_all_drained() {
    init_runtime(2);
    let bridge = WorkerBridge::new().expect("bridge new");

    for i in 0..100u32 {
        bridge.spawn(i, async move {
            tokio::time::sleep(Duration::from_millis(1)).await;
            format!("slot-{i}").into_bytes()
        });
    }

    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    let mut seen = vec![false; 100];
    let mut total = 0;
    while total < 100 && std::time::Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(5));
        for c in bridge.drain() {
            assert!(!seen[c.slot_id as usize], "duplicate slot {}", c.slot_id);
            seen[c.slot_id as usize] = true;
            assert_eq!(c.bytes, format!("slot-{}", c.slot_id).into_bytes());
            total += 1;
        }
    }
    assert_eq!(total, 100, "only drained {total} of 100");
}

fn wait_for_eventfd(fd: RawFd, timeout: Duration) {
    let deadline = std::time::Instant::now() + timeout;
    let mut buf = [0u8; 8];
    while std::time::Instant::now() < deadline {
        let n = unsafe { libc::read(fd, buf.as_mut_ptr() as *mut libc::c_void, 8) };
        if n == 8 {
            return;
        }
        std::thread::sleep(Duration::from_millis(5));
    }
    panic!("eventfd never fired within {timeout:?}");
}
