use io_uring::IoUring;
use libc::iovec;
use std::io;

pub const SLOT_BYTES: usize = 64 * 1024;
pub const SLOT_COUNT: usize = 1024;
pub const READ_REGION_BYTES: usize = 16 * 1024;
pub const WRITE_REGION_BYTES: usize = SLOT_BYTES - READ_REGION_BYTES;

/// Owns a contiguous registered buffer pool of `SLOT_COUNT * SLOT_BYTES` bytes,
/// hands out `Slot { idx, ptr }` handles to connections at accept time, reclaims them on close.
pub struct FixedBuffers {
    storage: Box<[u8]>,
    free: Vec<u16>,
}

#[derive(Debug, Copy, Clone)]
pub struct Slot {
    pub idx: u16,
    pub read_ptr: *mut u8,
    pub write_ptr: *mut u8,
}

// Safe: each Slot is exclusively owned by one Connection; pointers point into the
// pool's stable heap allocation that lives for the lifetime of FixedBuffers.
unsafe impl Send for Slot {}

impl FixedBuffers {
    pub fn register(ring: &mut IoUring) -> io::Result<Self> {
        let storage = vec![0u8; SLOT_BYTES * SLOT_COUNT].into_boxed_slice();
        let mut iovecs = Vec::with_capacity(SLOT_COUNT);
        for i in 0..SLOT_COUNT {
            iovecs.push(iovec {
                iov_base: unsafe { storage.as_ptr().add(i * SLOT_BYTES) } as *mut _,
                iov_len: SLOT_BYTES,
            });
        }
        unsafe { ring.submitter().register_buffers(&iovecs)? };
        // Free list pre-populated in reverse so we hand out idx=0 first (better cache locality).
        let free = (0..SLOT_COUNT as u16).rev().collect();
        Ok(Self { storage, free })
    }

    pub fn acquire(&mut self) -> Option<Slot> {
        let idx = self.free.pop()?;
        let base = unsafe { self.storage.as_ptr().add(idx as usize * SLOT_BYTES) } as *mut u8;
        Some(Slot {
            idx,
            read_ptr: base,
            write_ptr: unsafe { base.add(READ_REGION_BYTES) },
        })
    }

    pub fn release(&mut self, slot: Slot) {
        self.free.push(slot.idx);
    }
}
