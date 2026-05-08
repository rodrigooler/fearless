use crate::benchmark::responses::BenchmarkServer;
use crate::uring::connection::Connection;
use io_uring::{opcode, types::Fd, IoUring};
use rustc_hash::FxHashMap;
use std::io;
use std::os::fd::RawFd;
use std::sync::Arc;

const ACCEPT_TOKEN: u64 = u64::MAX;

pub fn run_loop(
    ring: &mut IoUring,
    listener_fd: RawFd,
    server: Arc<BenchmarkServer>,
) -> io::Result<()> {
    let mut conns: FxHashMap<u64, Connection> = FxHashMap::default();
    let mut next_token: u64 = 0;

    submit_accept(ring, listener_fd)?;

    loop {
        ring.submit_and_wait(1)?;
        // Drain the completion queue into a Vec so we can mutate `conns` while iterating.
        let completions: Vec<(u64, i32)> = {
            let cq = ring.completion();
            cq.into_iter().map(|cqe| (cqe.user_data(), cqe.result())).collect()
        };

        for (user_data, result) in completions {
            if user_data == ACCEPT_TOKEN {
                if result < 0 {
                    submit_accept(ring, listener_fd)?;
                    continue;
                }
                let client_fd = result as RawFd;
                let token = next_token;
                next_token = next_token.wrapping_add(1);
                let mut conn = Connection::new(client_fd, Arc::clone(&server));
                conn.submit_read(ring, token)?;
                conns.insert(token, conn);
                submit_accept(ring, listener_fd)?;
                continue;
            }

            if let Some(mut conn) = conns.remove(&user_data) {
                if conn.handle_completion(ring, user_data, result)? {
                    conns.insert(user_data, conn);
                }
            }
        }
    }
}

fn submit_accept(ring: &mut IoUring, listener_fd: RawFd) -> io::Result<()> {
    let entry = opcode::Accept::new(Fd(listener_fd), std::ptr::null_mut(), std::ptr::null_mut())
        .build()
        .user_data(ACCEPT_TOKEN);
    unsafe { ring.submission().push(&entry).map_err(|_| io::Error::other("sq full"))? };
    Ok(())
}
