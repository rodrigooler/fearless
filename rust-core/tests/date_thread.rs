use fearless_core::benchmark::date::{format_http_date, DateClock};
use std::time::{SystemTime, UNIX_EPOCH};

#[test]
fn formats_known_epoch_correctly() {
    let bytes = format_http_date(0);
    assert_eq!(&bytes, b"Thu, 01 Jan 1970 00:00:00 GMT");
}

#[test]
fn clock_advances_within_two_seconds() {
    let clock = DateClock::start();
    let first = clock.snapshot();
    std::thread::sleep(std::time::Duration::from_millis(1100));
    let second = clock.snapshot();
    assert_ne!(first, second, "date bytes must update at least once per second");
    let now_secs = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs();
    let expected = format_http_date(now_secs);
    assert_eq!(second, expected);
}
