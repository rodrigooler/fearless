//! Async bridge: lets the io_uring worker loop spawn tokio futures and
//! consume their results via a per-worker eventfd + completion queue.
//!
//! Architecture:
//!   - One shared multi-thread tokio runtime (process-wide, set up at startup)
//!   - Per-worker `WorkerBridge`: owns an eventfd FD + a completion VecDeque
//!   - io_uring registers a `Read` op on the eventfd FD; when tokio writes 1
//!     to it, the read completes, the worker drains the queue.
//!
//! Worker exclusivity: `WorkerBridge` is owned by exactly one io_uring worker
//! thread. The `completions` mutex is contended only between that worker and
//! whichever tokio runtime threads finish a task assigned to it. Locks are
//! held only long enough to push/drain — never across awaits.

use parking_lot::Mutex;
use std::collections::VecDeque;
use std::future::Future;
use std::os::fd::RawFd;
use std::sync::Arc;
use std::sync::OnceLock;
use tokio::runtime::{Builder, Runtime};

static RUNTIME: OnceLock<Arc<Runtime>> = OnceLock::new();

/// Initialize the shared tokio runtime. Idempotent — first call wins, later
/// calls return the already-initialized runtime.
pub fn init_runtime(worker_threads: usize) -> Arc<Runtime> {
    RUNTIME
        .get_or_init(|| {
            let rt = Builder::new_multi_thread()
                .worker_threads(worker_threads.max(1))
                .thread_name("fearless-tokio")
                .enable_all()
                .build()
                .expect("tokio runtime build");
            Arc::new(rt)
        })
        .clone()
}

pub fn runtime() -> Arc<Runtime> {
    RUNTIME
        .get()
        .expect("async_bridge::init_runtime must be called before runtime()")
        .clone()
}

/// One completion ready to be written back to a parked connection.
#[derive(Debug)]
pub struct Completion {
    /// Identifier the io_uring worker uses to find the parked connection.
    pub slot_id: u32,
    /// HTTP response bytes (status line + headers + body, ready to send).
    pub bytes: Vec<u8>,
}

/// Per-worker bridge state. Owned by the io_uring worker thread.
pub struct WorkerBridge {
    eventfd: RawFd,
    completions: Arc<Mutex<VecDeque<Completion>>>,
    /// 8-byte buffer the io_uring loop reads into when the eventfd CQE fires.
    /// Lives here so it has a stable address for the lifetime of the worker.
    pub eventfd_read_buf: Box<[u8; 8]>,
}

impl WorkerBridge {
    /// Create a new bridge. Allocates a non-blocking eventfd via `eventfd2`.
    pub fn new() -> std::io::Result<Self> {
        let fd = unsafe {
            let fd = libc::eventfd(0, libc::EFD_CLOEXEC | libc::EFD_NONBLOCK);
            if fd < 0 {
                return Err(std::io::Error::last_os_error());
            }
            fd
        };
        Ok(Self {
            eventfd: fd,
            completions: Arc::new(Mutex::new(VecDeque::with_capacity(64))),
            eventfd_read_buf: Box::new([0u8; 8]),
        })
    }

    pub fn eventfd(&self) -> RawFd {
        self.eventfd
    }

    /// Spawn an async handler. Once `fut` resolves, the bytes are queued
    /// and the eventfd is signaled so the io_uring worker wakes and copies
    /// the response into the slot's write region.
    pub fn spawn<F>(&self, slot_id: u32, fut: F)
    where
        F: Future<Output = Vec<u8>> + Send + 'static,
    {
        let queue = self.completions.clone();
        let efd = self.eventfd;
        runtime().spawn(async move {
            let bytes = fut.await;
            queue.lock().push_back(Completion { slot_id, bytes });
            // SAFETY: efd is a valid eventfd opened in `new`. write of 8 bytes
            // is the eventfd contract. Errors here mean the worker is gone —
            // we drop the completion silently in that case.
            let val: u64 = 1;
            unsafe {
                libc::write(efd, &val as *const u64 as *const libc::c_void, 8);
            }
        });
    }

    /// Drain all pending completions. Called by the io_uring loop when it sees
    /// the eventfd CQE.
    pub fn drain(&self) -> Vec<Completion> {
        let mut guard = self.completions.lock();
        guard.drain(..).collect()
    }
}

impl Drop for WorkerBridge {
    fn drop(&mut self) {
        unsafe {
            libc::close(self.eventfd);
        }
    }
}
