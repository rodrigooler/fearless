use crate::benchmark::responses::BenchmarkServer;
use crate::uring::buffers::FixedBuffers;
use crate::uring::connection::Connection;
use io_uring::{opcode, types::Fixed, IoUring};
use slab::Slab;
use std::io;
use std::os::fd::RawFd;
use std::sync::Arc;

const ACCEPT_TOKEN: u64 = u64::MAX;

/// A connection in the per-worker registry.
/// `generation` lets us reject completions that arrive for a previous tenant of
/// the same slab index (e.g. a stale Recv completion landing after we accepted
/// a new connection into the same slot). Cheap stale-detection without holding
/// the slot vacant for some "drain" interval.
struct RegistryEntry {
    generation: u32,
    conn: Connection,
}

#[inline]
fn pack_token(generation: u32, index: usize) -> u64 {
    ((generation as u64) << 32) | (index as u32 as u64)
}

#[inline]
fn unpack_token(token: u64) -> (u32, usize) {
    let generation = (token >> 32) as u32;
    let index = (token & 0xFFFF_FFFF) as usize;
    (generation, index)
}

pub fn run_loop(
    ring: &mut IoUring,
    listener_slot: u32,
    server: Arc<BenchmarkServer>,
    mut buffers: FixedBuffers,
) -> io::Result<()> {
    // Slab keyed by token-low-32-bits. O(1) lookup + insert + remove, no hashing.
    let mut conns: Slab<RegistryEntry> = Slab::with_capacity(1024);
    let mut next_generation: u32 = 0;
    // Reused across iterations so the completion drain is allocation-free in steady state.
    let mut completions: Vec<(u64, i32, u32)> =
        Vec::with_capacity(crate::uring::runtime::RING_ENTRIES as usize);

    submit_accept(ring, listener_slot)?;

    loop {
        ring.submit_and_wait(1)?;
        completions.clear();
        {
            let cq = ring.completion();
            completions.extend(
                cq.into_iter()
                    .map(|cqe| (cqe.user_data(), cqe.result(), cqe.flags())),
            );
        }

        for (user_data, result, flags) in completions.drain(..) {
            if user_data == ACCEPT_TOKEN {
                if result < 0 {
                    submit_accept(ring, listener_slot)?;
                    continue;
                }
                let client_fd = result as RawFd;
                let Some(slot) = buffers.acquire() else {
                    // No free buffer slots — close the new connection rather than queue forever.
                    unsafe {
                        libc::close(client_fd);
                    }
                    if !io_uring::cqueue::more(flags) {
                        submit_accept(ring, listener_slot)?;
                    }
                    continue;
                };

                let entry = conns.vacant_entry();
                let index = entry.key();
                let generation = next_generation;
                next_generation = next_generation.wrapping_add(1);
                let token = pack_token(generation, index);

                let mut conn = Connection::new(client_fd, Arc::clone(&server), slot);
                conn.submit_read(ring, token)?;
                entry.insert(RegistryEntry { generation, conn });

                if !io_uring::cqueue::more(flags) {
                    submit_accept(ring, listener_slot)?;
                }
                continue;
            }

            let (generation, index) = unpack_token(user_data);
            let Some(entry) = conns.get_mut(index) else {
                // Index not occupied — stale completion. Drop.
                continue;
            };
            if entry.generation != generation {
                // Slab slot was reused by a newer connection. Drop the stale completion.
                continue;
            }

            let alive = entry.conn.handle_completion(ring, user_data, result)?;
            if !alive {
                let removed = conns.remove(index);
                buffers.release(removed.conn.slot());
            }
        }
    }
}

fn submit_accept(ring: &mut IoUring, listener_slot: u32) -> io::Result<()> {
    let entry = opcode::AcceptMulti::new(Fixed(listener_slot))
        .build()
        .user_data(ACCEPT_TOKEN);
    unsafe {
        ring.submission()
            .push(&entry)
            .map_err(|_| io::Error::other("sq full"))?
    };
    Ok(())
}
