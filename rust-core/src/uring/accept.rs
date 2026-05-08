use crate::benchmark::responses::BenchmarkServer;
use crate::uring::connection::Connection;
use io_uring::{opcode, types::Fixed, IoUring};
use rustc_hash::FxHashMap;
use std::io;
use std::os::fd::RawFd;
use std::sync::Arc;

const ACCEPT_TOKEN: u64 = u64::MAX;

pub fn run_loop(
    ring: &mut IoUring,
    listener_slot: u32,
    server: Arc<BenchmarkServer>,
) -> io::Result<()> {
    let mut conns: FxHashMap<u64, Connection> = FxHashMap::default();
    let mut next_token: u64 = 0;
    // Reused across iterations so the completion drain is allocation-free in steady state.
    let mut completions: Vec<(u64, i32, u32)> = Vec::with_capacity(crate::uring::runtime::RING_ENTRIES as usize);

    submit_accept(ring, listener_slot)?;

    loop {
        ring.submit_and_wait(1)?;
        completions.clear();
        {
            let cq = ring.completion();
            completions.extend(cq.into_iter().map(|cqe| (cqe.user_data(), cqe.result(), cqe.flags())));
        }

        for (user_data, result, flags) in completions.drain(..) {
            if user_data == ACCEPT_TOKEN {
                if result < 0 {
                    submit_accept(ring, listener_slot)?;
                    continue;
                }
                let client_fd = result as RawFd;
                let token = next_token;
                next_token = next_token.wrapping_add(1);
                let mut conn = Connection::new(client_fd, Arc::clone(&server));
                conn.submit_read(ring, token)?;
                conns.insert(token, conn);
                if !io_uring::cqueue::more(flags) {
                    submit_accept(ring, listener_slot)?;
                }
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

fn submit_accept(ring: &mut IoUring, listener_slot: u32) -> io::Result<()> {
    let entry = opcode::AcceptMulti::new(Fixed(listener_slot))
        .build()
        .user_data(ACCEPT_TOKEN);
    unsafe { ring.submission().push(&entry).map_err(|_| io::Error::other("sq full"))? };
    Ok(())
}
