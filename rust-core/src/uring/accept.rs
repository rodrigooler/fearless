use crate::benchmark::responses::BenchmarkServer;
use crate::uring::buffers::FixedBuffers;
use crate::uring::connection::Connection;
use io_uring::{opcode, types::Fixed, IoUring};
use slab::Slab;
use std::io;
use std::os::fd::RawFd;
use std::sync::Arc;

const ACCEPT_TOKEN: u64 = u64::MAX;

/// Reserved user_data for the per-worker eventfd Read op. The bridge signals
/// completion of an async handler by writing to the eventfd; the resulting CQE
/// is the loop's wake-up to drain `WorkerBridge::drain()`.
#[cfg(feature = "pg-handles")]
pub(crate) const EVENTFD_TOKEN: u64 = u64::MAX - 1;

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
    #[cfg(feature = "pg-handles")] bridge: Arc<crate::runtime::async_bridge::WorkerBridge>,
) -> io::Result<()> {
    // Slab keyed by token-low-32-bits. O(1) lookup + insert + remove, no hashing.
    let mut conns: Slab<RegistryEntry> = Slab::with_capacity(1024);
    let mut next_generation: u32 = 0;
    // Reused across iterations so the completion drain is allocation-free in steady state.
    let mut completions: Vec<(u64, i32, u32)> =
        Vec::with_capacity(crate::uring::runtime::RING_ENTRIES as usize);

    submit_accept(ring, listener_slot)?;

    // 8-byte read buffer for the eventfd Read op. Owned by this loop frame so
    // the pointer stays stable for the lifetime of the worker — the bridge
    // can't store it because it's shared via `Arc`.
    #[cfg(feature = "pg-handles")]
    let mut eventfd_buf: Box<[u8; 8]> = Box::new([0u8; 8]);
    #[cfg(feature = "pg-handles")]
    submit_eventfd_read(ring, bridge.eventfd(), eventfd_buf.as_mut_ptr())?;

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
            #[cfg(feature = "pg-handles")]
            if user_data == EVENTFD_TOKEN {
                // Eventfd Read completed: drain queued completions and deliver
                // each into its parked connection. `result` is normally 8 (the
                // number of bytes read from the eventfd counter); we ignore the
                // value since we just need the wake-up signal.
                let drained = bridge.drain();
                for completion in drained {
                    let index = completion.slot_id as usize;
                    if let Some(entry) = conns.get_mut(index) {
                        let token = pack_token(entry.generation, index);
                        // MVP: slot_id alone identifies the parked connection; a
                        // generation race (slot reused before async resolves) is
                        // a known limitation tracked for Phase 1.2.
                        let alive = entry
                            .conn
                            .deliver_async_response(ring, token, &completion.bytes)
                            .unwrap_or(false);
                        if !alive {
                            let removed = conns.remove(index);
                            buffers.release(removed.conn.slot());
                        }
                    }
                    // Else: parked connection was already evicted (unusual but
                    // possible if the conn closed during the await). Drop the
                    // completion silently.
                }
                // Re-arm the eventfd Read so we wake again for the next batch.
                submit_eventfd_read(ring, bridge.eventfd(), eventfd_buf.as_mut_ptr())?;
                continue;
            }

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

            #[cfg(feature = "pg-handles")]
            let alive = entry.conn.handle_completion(ring, user_data, result, &bridge)?;
            #[cfg(not(feature = "pg-handles"))]
            let alive = entry.conn.handle_completion(ring, user_data, result)?;
            if !alive {
                let removed = conns.remove(index);
                buffers.release(removed.conn.slot());
            }
        }
    }
}

#[cfg(feature = "pg-handles")]
fn submit_eventfd_read(ring: &mut IoUring, fd: RawFd, buf: *mut u8) -> io::Result<()> {
    let entry = opcode::Read::new(io_uring::types::Fd(fd), buf, 8)
        .build()
        .user_data(EVENTFD_TOKEN);
    unsafe {
        ring.submission()
            .push(&entry)
            .map_err(|_| io::Error::other("sq full (eventfd)"))?
    };
    Ok(())
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
