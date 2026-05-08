use crate::benchmark::responses::BenchmarkServer;
use io_uring::IoUring;
use std::io;
use std::os::fd::RawFd;
use std::sync::Arc;

pub fn run_loop(
    _ring: &mut IoUring,
    _listener_fd: RawFd,
    _server: Arc<BenchmarkServer>,
) -> io::Result<()> {
    // Implemented in Task 2.3
    unimplemented!("uring::accept::run_loop is implemented in Task 2.3")
}
