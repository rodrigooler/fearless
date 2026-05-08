use arc_swap::ArcSwap;
use std::sync::Arc;
use std::time::Duration;

use crate::benchmark::date::{DateClock, DATE_LEN};

const REFRESH_INTERVAL: Duration = Duration::from_millis(500);

#[derive(Copy, Clone)]
pub enum Variant {
    PlaintextKeepalive,
    PlaintextClose,
    JsonKeepalive,
    JsonClose,
    NotFoundKeepalive,
    NotFoundClose,
}

pub struct BakedResponses {
    plaintext_keepalive: Arc<[u8]>,
    plaintext_close: Arc<[u8]>,
    json_keepalive: Arc<[u8]>,
    json_close: Arc<[u8]>,
    not_found_keepalive: Arc<[u8]>,
    not_found_close: Arc<[u8]>,
}

impl BakedResponses {
    pub fn get(&self, variant: Variant) -> Arc<[u8]> {
        match variant {
            Variant::PlaintextKeepalive => Arc::clone(&self.plaintext_keepalive),
            Variant::PlaintextClose => Arc::clone(&self.plaintext_close),
            Variant::JsonKeepalive => Arc::clone(&self.json_keepalive),
            Variant::JsonClose => Arc::clone(&self.json_close),
            Variant::NotFoundKeepalive => Arc::clone(&self.not_found_keepalive),
            Variant::NotFoundClose => Arc::clone(&self.not_found_close),
        }
    }
}

pub struct BenchmarkResponses {
    inner: ArcSwap<BakedResponses>,
}

impl BenchmarkResponses {
    pub fn new() -> Self {
        let initial = bake(&placeholder_date());
        Self { inner: ArcSwap::from_pointee(initial) }
    }

    pub fn snapshot(&self) -> Arc<BakedResponses> {
        self.inner.load_full()
    }

    pub fn refresh(&self, date: &[u8; DATE_LEN]) {
        self.inner.store(Arc::new(bake(date)));
    }
}

impl Default for BenchmarkResponses {
    fn default() -> Self {
        Self::new()
    }
}

fn placeholder_date() -> [u8; DATE_LEN] {
    *b"Thu, 01 Jan 1970 00:00:00 GMT"
}

fn bake(date: &[u8; DATE_LEN]) -> BakedResponses {
    BakedResponses {
        plaintext_keepalive: render("200 OK", "text/plain; charset=utf-8", b"Hello, World!", date, false).into(),
        plaintext_close:     render("200 OK", "text/plain; charset=utf-8", b"Hello, World!", date, true).into(),
        json_keepalive:      render("200 OK", "application/json",          br#"{"message":"Hello, World!"}"#, date, false).into(),
        json_close:          render("200 OK", "application/json",          br#"{"message":"Hello, World!"}"#, date, true).into(),
        not_found_keepalive: render("404 Not Found", "text/plain", b"Not Found", date, false).into(),
        not_found_close:     render("404 Not Found", "text/plain", b"Not Found", date, true).into(),
    }
}

fn render(status: &str, content_type: &str, body: &[u8], date: &[u8; DATE_LEN], close: bool) -> Vec<u8> {
    // Server header omitted intentionally for benchmark mode — TFB does not require it,
    // and dropping it saves ~18 bytes per response on the wire (meaningful at 6M+ req/s).
    // The legacy generic dispatch path in lib.rs still emits Server: Fearless.
    let conn = if close { "close" } else { "keep-alive" };
    let mut out = Vec::with_capacity(140 + body.len());
    out.extend_from_slice(b"HTTP/1.1 ");
    out.extend_from_slice(status.as_bytes());
    out.extend_from_slice(b"\r\nDate: ");
    out.extend_from_slice(date);
    out.extend_from_slice(b"\r\nContent-Type: ");
    out.extend_from_slice(content_type.as_bytes());
    out.extend_from_slice(b"\r\nContent-Length: ");
    out.extend_from_slice(body.len().to_string().as_bytes());
    out.extend_from_slice(b"\r\nConnection: ");
    out.extend_from_slice(conn.as_bytes());
    out.extend_from_slice(b"\r\n\r\n");
    out.extend_from_slice(body);
    out
}

pub struct BenchmarkServer {
    pub responses: Arc<BenchmarkResponses>,
    pub clock: Arc<DateClock>,
}

impl BenchmarkServer {
    pub fn new() -> Self {
        let clock = DateClock::start();
        let responses = Arc::new(BenchmarkResponses::new());
        responses.refresh(&clock.snapshot());
        let weak_clock = Arc::downgrade(&clock);
        let weak_responses = Arc::downgrade(&responses);
        std::thread::Builder::new()
            .name("fearless-resp-refresh".into())
            .spawn(move || loop {
                std::thread::sleep(REFRESH_INTERVAL);
                let (Some(c), Some(r)) = (weak_clock.upgrade(), weak_responses.upgrade()) else {
                    return;
                };
                r.refresh(&c.snapshot());
            })
            .expect("spawn refresher");
        Self { responses, clock }
    }
}

impl Default for BenchmarkServer {
    fn default() -> Self { Self::new() }
}
