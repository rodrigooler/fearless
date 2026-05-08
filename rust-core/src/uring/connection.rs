use crate::benchmark::parser::{parse_pipeline, Classification, Route};
use crate::benchmark::responses::{BenchmarkServer, Variant};
use crate::uring::buffers::{Slot, READ_REGION_BYTES, WRITE_REGION_BYTES};
use io_uring::{opcode, types::Fd, IoUring};
use std::io;
use std::os::fd::RawFd;
use std::sync::Arc;

const MAX_PIPELINE: usize = 64;

pub struct Connection {
    fd: RawFd,
    server: Arc<BenchmarkServer>,
    slot: Slot,
    read_filled: usize,
    write_filled: usize,
    write_offset: usize,
    state: State,
    close_after_drain: bool,
}

#[derive(Copy, Clone, Eq, PartialEq)]
enum State {
    Reading,
    Writing,
}

impl Connection {
    pub fn new(fd: RawFd, server: Arc<BenchmarkServer>, slot: Slot) -> Self {
        Self {
            fd,
            server,
            slot,
            read_filled: 0,
            write_filled: 0,
            write_offset: 0,
            state: State::Reading,
            close_after_drain: false,
        }
    }

    pub fn slot(&self) -> Slot {
        self.slot
    }

    pub fn submit_read(&mut self, ring: &mut IoUring, token: u64) -> io::Result<()> {
        debug_assert!(self.read_filled < READ_REGION_BYTES, "read_filled out of bounds");
        let ptr = unsafe { self.slot.read_ptr.add(self.read_filled) };
        let len = (READ_REGION_BYTES - self.read_filled) as u32;
        let entry = opcode::Recv::new(Fd(self.fd), ptr, len)
            .build()
            .user_data(token);
        unsafe {
            ring.submission()
                .push(&entry)
                .map_err(|_| io::Error::other("sq full"))?
        };
        Ok(())
    }

    fn submit_write(&mut self, ring: &mut IoUring, token: u64) -> io::Result<()> {
        debug_assert!(
            self.write_offset < self.write_filled,
            "write_offset >= write_filled"
        );
        let ptr = unsafe { self.slot.write_ptr.add(self.write_offset) };
        let len = (self.write_filled - self.write_offset) as u32;
        let entry = opcode::Send::new(Fd(self.fd), ptr, len)
            .build()
            .user_data(token);
        unsafe {
            ring.submission()
                .push(&entry)
                .map_err(|_| io::Error::other("sq full"))?
        };
        Ok(())
    }

    pub fn handle_completion(
        &mut self,
        ring: &mut IoUring,
        token: u64,
        result: i32,
    ) -> io::Result<bool> {
        match self.state {
            State::Reading => {
                if result <= 0 {
                    self.close();
                    return Ok(false);
                }
                self.read_filled += result as usize;
                self.process_buffered(ring, token)
            }
            State::Writing => {
                if result <= 0 {
                    self.close();
                    return Ok(false);
                }
                self.write_offset += result as usize;
                if self.write_offset < self.write_filled {
                    // Partial write — keep draining.
                    self.submit_write(ring, token)?;
                    return Ok(true);
                }
                if self.close_after_drain {
                    self.close();
                    return Ok(false);
                }
                self.write_filled = 0;
                self.write_offset = 0;
                self.state = State::Reading;
                if self.read_filled > 0 {
                    // Process any leftover pipelined requests that didn't fit in the previous write batch.
                    return self.process_buffered(ring, token);
                }
                self.submit_read(ring, token)?;
                Ok(true)
            }
        }
    }

    fn process_buffered(&mut self, ring: &mut IoUring, token: u64) -> io::Result<bool> {
        let snap = self.server.responses.snapshot();
        let mut classifications =
            [Classification { route: Route::NotFound, close: false }; MAX_PIPELINE];
        let result = {
            let read_slice =
                unsafe { std::slice::from_raw_parts(self.slot.read_ptr, self.read_filled) };
            parse_pipeline(read_slice, &mut classifications)
        };

        if result.count == 0 {
            // No complete request yet; need more data. Guard against full buffer with no terminator
            // (single oversized request) by closing rather than spinning.
            if self.read_filled == READ_REGION_BYTES {
                self.close();
                return Ok(false);
            }
            self.submit_read(ring, token)?;
            return Ok(true);
        }

        let mut close_after = false;
        let mut classified_consumed: usize = 0;
        {
            let write_slice = unsafe {
                std::slice::from_raw_parts_mut(self.slot.write_ptr, WRITE_REGION_BYTES)
            };
            for (i, cls) in classifications[..result.count].iter().enumerate() {
                let bytes = snap.get(variant_for(*cls));
                if self.write_filled + bytes.len() > WRITE_REGION_BYTES {
                    // This response would overflow the write buffer — flush what we have and
                    // leave the rest of the parsed batch in the read buffer for the next round.
                    if i == 0 {
                        // Single response larger than WRITE_REGION_BYTES — should be impossible with
                        // current baked responses (~140B), but guard anyway.
                        self.close();
                        return Ok(false);
                    }
                    break;
                }
                write_slice[self.write_filled..self.write_filled + bytes.len()]
                    .copy_from_slice(&bytes);
                self.write_filled += bytes.len();
                classified_consumed += 1;
                if cls.close {
                    close_after = true;
                    break;
                }
            }
        }

        // Compute how many input bytes we actually consumed by re-walking the parser output we used.
        // Each classification consumed `request_len` bytes; parse_pipeline already returned the
        // total `consumed` for ALL classifications. We need the prefix consumption for the ones we
        // actually copied to the write buffer.
        let consumed = if classified_consumed == result.count {
            result.consumed
        } else {
            // Re-parse just the prefix we used to find its byte count. Cheaper than carrying
            // per-request offsets through parse_pipeline.
            let read_slice =
                unsafe { std::slice::from_raw_parts(self.slot.read_ptr, self.read_filled) };
            let mut tmp = [Classification { route: Route::NotFound, close: false }; MAX_PIPELINE];
            let prefix_result = parse_pipeline(read_slice, &mut tmp[..classified_consumed]);
            prefix_result.consumed
        };

        // Compact read region. Use ptr::copy (memmove semantics — handles overlap) since we only
        // hold raw pointers into the slot, not a slice we could call copy_within on.
        if consumed > 0 {
            unsafe {
                let src = self.slot.read_ptr.add(consumed);
                let dst = self.slot.read_ptr;
                std::ptr::copy(src, dst, self.read_filled - consumed);
            }
        }
        self.read_filled -= consumed;

        self.close_after_drain = close_after;
        self.state = State::Writing;
        self.submit_write(ring, token)?;
        Ok(true)
    }

    fn close(&self) {
        unsafe {
            libc::close(self.fd);
        }
    }
}

#[inline]
fn variant_for(cls: Classification) -> Variant {
    match (cls.route, cls.close) {
        (Route::Plaintext, false) => Variant::PlaintextKeepalive,
        (Route::Plaintext, true) => Variant::PlaintextClose,
        (Route::Json, false) => Variant::JsonKeepalive,
        (Route::Json, true) => Variant::JsonClose,
        (Route::NotFound, false) => Variant::NotFoundKeepalive,
        (Route::NotFound, true) => Variant::NotFoundClose,
    }
}
