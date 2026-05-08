use arc_swap::ArcSwap;
use std::sync::Arc;
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

pub const DATE_LEN: usize = 29;
pub type DateBytes = [u8; DATE_LEN];

pub struct DateClock {
    bytes: ArcSwap<DateBytes>,
}

impl DateClock {
    pub fn start() -> Arc<Self> {
        let now = current_secs();
        let initial = Arc::new(format_http_date(now));
        let clock = Arc::new(Self { bytes: ArcSwap::from(initial) });
        let weak = Arc::downgrade(&clock);
        thread::Builder::new()
            .name("fearless-date".into())
            .spawn(move || loop {
                let target = next_second_boundary();
                thread::sleep(target);
                let Some(c) = weak.upgrade() else { return };
                let now = current_secs();
                c.bytes.store(Arc::new(format_http_date(now)));
            })
            .expect("spawn date thread");
        clock
    }

    pub fn snapshot(&self) -> DateBytes {
        **self.bytes.load()
    }

    pub fn shared(&self) -> Arc<DateBytes> {
        self.bytes.load_full()
    }
}

fn current_secs() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs()
}

fn next_second_boundary() -> Duration {
    let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap();
    let next = Duration::from_secs(now.as_secs() + 1);
    next.checked_sub(now).unwrap_or(Duration::from_millis(1))
}

pub fn format_http_date(epoch_secs: u64) -> DateBytes {
    let formatted = httpdate::fmt_http_date(UNIX_EPOCH + Duration::from_secs(epoch_secs));
    let bytes = formatted.as_bytes();
    let mut out = [0u8; DATE_LEN];
    out.copy_from_slice(&bytes[..DATE_LEN]);
    out
}
