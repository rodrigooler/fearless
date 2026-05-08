use crate::aot::runtime::AotRequest;
use crate::benchmark::parser::{parse_pipeline, Classification, Route};
use crate::benchmark::responses::{BenchmarkServer, Variant};
use crate::uring::buffers::{Slot, READ_REGION_BYTES, WRITE_REGION_BYTES};
use io_uring::{opcode, types::Fd, IoUring};
use rustc_hash::FxHashMap;
use std::collections::HashMap;
use std::io;
use std::os::fd::RawFd;
use std::sync::Arc;

const MAX_PIPELINE: usize = 64;
/// Pre-allocated capacity for the per-Connection scratch buffer used to capture
/// AOT handler output before copying into the write region. 4 KiB covers the
/// typical AOT response (~50-500 B) with headroom; grows on demand.
const AOT_SCRATCH_CAPACITY: usize = 4096;

pub struct Connection {
    fd: RawFd,
    server: Arc<BenchmarkServer>,
    slot: Slot,
    read_filled: usize,
    write_filled: usize,
    write_offset: usize,
    state: State,
    close_after_drain: bool,
    /// Reused scratch buffer for AOT handler output. Cleared per-call,
    /// never freed across requests on this connection.
    aot_scratch: Vec<u8>,
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
            aot_scratch: Vec::with_capacity(AOT_SCRATCH_CAPACITY),
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
            [Classification { route: Route::NotFound, close: false, request_len: 0 }; MAX_PIPELINE];
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
        let mut bytes_consumed: usize = 0;
        let aot_table = self.server.aot_table.clone();

        for (i, cls) in classifications[..result.count].iter().enumerate() {
            let request_start = bytes_consumed;
            let request_end = request_start + cls.request_len as usize;

            // Three dispatch paths in priority order:
            //   1. Benchmark fast path — Plaintext/Json: pre-baked bytes from snap
            //   2. AOT path — only if NotFound AND aot_table present: parse + handler
            //   3. NotFound fallback — pre-baked 404 from snap
            let written = match cls.route {
                Route::Plaintext | Route::Json => {
                    // Existing benchmark hot path. `snap` keeps the Arc alive for this fn.
                    let bytes = snap.get_ref(variant_for(*cls));
                    if self.write_filled + bytes.len() > WRITE_REGION_BYTES {
                        if i == 0 {
                            self.close();
                            return Ok(false);
                        }
                        break;
                    }
                    let write_slice = unsafe {
                        std::slice::from_raw_parts_mut(self.slot.write_ptr, WRITE_REGION_BYTES)
                    };
                    write_slice[self.write_filled..self.write_filled + bytes.len()]
                        .copy_from_slice(bytes);
                    bytes.len()
                }
                Route::NotFound => {
                    // Try AOT lookup first (only if any AOT routes are registered).
                    let aot_written = if let Some(table) = aot_table.as_ref() {
                        let request_bytes = unsafe {
                            std::slice::from_raw_parts(
                                self.slot.read_ptr.add(request_start),
                                cls.request_len as usize,
                            )
                        };
                        Self::try_aot_dispatch(
                            table,
                            request_bytes,
                            &mut self.aot_scratch,
                            self.slot.write_ptr,
                            self.write_filled,
                        )
                    } else {
                        None
                    };

                    if let Some(n) = aot_written {
                        n
                    } else {
                        // No AOT match — write the pre-baked 404.
                        let bytes = snap.get_ref(variant_for(*cls));
                        if self.write_filled + bytes.len() > WRITE_REGION_BYTES {
                            if i == 0 {
                                self.close();
                                return Ok(false);
                            }
                            break;
                        }
                        let write_slice = unsafe {
                            std::slice::from_raw_parts_mut(
                                self.slot.write_ptr,
                                WRITE_REGION_BYTES,
                            )
                        };
                        write_slice[self.write_filled..self.write_filled + bytes.len()]
                            .copy_from_slice(bytes);
                        bytes.len()
                    }
                }
            };

            self.write_filled += written;
            classified_consumed += 1;
            bytes_consumed = request_end;
            if cls.close {
                close_after = true;
                break;
            }
        }

        // Bytes consumed is now precise — comes directly from the per-request request_len
        // accumulated in the loop above. No re-parse needed.
        let consumed = bytes_consumed;

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

    /// Try to dispatch a request through the AOT table. Returns:
    ///   - `Some(bytes_written)` on a successful AOT handler call (response copied into write region)
    ///   - `None` if no route matches, the request line can't be parsed, or the response
    ///     would overflow the write region. The caller falls back to the 404 path on `None`.
    ///
    /// `request_bytes` is the full HTTP request (line + headers + `\r\n\r\n`).
    /// `scratch` is a per-Connection Vec used to capture handler output before copying into
    /// the write region. Cleared on entry; never freed.
    fn try_aot_dispatch(
        table: &crate::aot::AotRouteTable,
        request_bytes: &[u8],
        scratch: &mut Vec<u8>,
        write_ptr: *mut u8,
        write_filled: usize,
    ) -> Option<usize> {
        let (method, path) = parse_method_path(request_bytes)?;
        let (handler, params) = table.lookup(method, path)?;

        let std_params: HashMap<String, String> = params.into_iter().collect();

        // Strip query string from path for AotRequest.path. Keep ctx.url with query.
        let (clean_path, query_str) = match path.find('?') {
            Some(q) => (&path[..q], &path[q + 1..]),
            None => (path, ""),
        };

        let query = parse_query_string(query_str);
        let headers = parse_headers(request_bytes);

        let req = AotRequest {
            method,
            path: clean_path,
            url: path,
            ip: "",
            params: &std_params,
            query: &query,
            headers: &headers,
        };

        scratch.clear();
        handler(&req, scratch);

        let n = scratch.len();
        if write_filled + n > WRITE_REGION_BYTES {
            return None;
        }
        unsafe {
            let dst = write_ptr.add(write_filled);
            std::ptr::copy_nonoverlapping(scratch.as_ptr(), dst, n);
        }
        Some(n)
    }
}

/// Parse the request line of an HTTP request. Returns `(method, path)`.
/// Path includes any query string. Returns None on malformed input.
///
/// The path is interned as a `&'static str` only if it survives the lifetime of
/// `request_bytes` — but here we return references into the input slice. The
/// caller (try_aot_dispatch) holds the bytes alive for the call duration.
#[inline]
fn parse_method_path(request_bytes: &[u8]) -> Option<(&str, &str)> {
    // Find first space (end of method).
    let space1 = memchr::memchr(b' ', request_bytes)?;
    let method = std::str::from_utf8(&request_bytes[..space1]).ok()?;

    let after_method = &request_bytes[space1 + 1..];
    // Find next space (end of path / start of HTTP version).
    let space2 = memchr::memchr(b' ', after_method)?;
    let path = std::str::from_utf8(&after_method[..space2]).ok()?;

    Some((method, path))
}

/// Parse HTTP headers from a raw request, into a `key → value` map.
/// Header keys are lowercased so `req.header("authorization")` matches
/// `Authorization: ...` on the wire. Values are trimmed.
///
/// Returns an empty map if the request line / header section can't be parsed.
/// Cost: O(n) over the request bytes — acceptable for AOT routes (which run
/// at ~1M req/s typically, not the 10M of the benchmark fast path).
fn parse_headers(request_bytes: &[u8]) -> HashMap<String, String> {
    let mut headers = HashMap::new();
    // Skip the request line (everything up to first \r\n)
    let after_line = match memchr::memchr(b'\n', request_bytes) {
        Some(pos) => &request_bytes[pos + 1..],
        None => return headers,
    };

    let mut cursor = after_line;
    loop {
        // End of headers — empty line (\r\n on its own)
        if cursor.starts_with(b"\r\n") || cursor.is_empty() {
            break;
        }
        let line_end = match memchr::memchr(b'\n', cursor) {
            Some(pos) => pos,
            None => break,
        };
        let line = &cursor[..line_end];
        // Strip trailing \r
        let line = if !line.is_empty() && line[line.len() - 1] == b'\r' {
            &line[..line.len() - 1]
        } else {
            line
        };
        if let Some(colon) = memchr::memchr(b':', line) {
            let key = &line[..colon];
            let value = &line[colon + 1..];
            // Trim leading space on value
            let value = value.strip_prefix(b" ").unwrap_or(value);
            if let (Ok(k), Ok(v)) = (std::str::from_utf8(key), std::str::from_utf8(value)) {
                headers.insert(k.to_ascii_lowercase(), v.to_string());
            }
        }
        cursor = &cursor[line_end + 1..];
    }
    headers
}

/// Parse a query string `foo=bar&baz=qux` into a `key → value` map.
/// Returns an empty map for empty input. URL-decoding is NOT performed in this
/// Phase 0 implementation — values are taken literally. Add it later if needed.
fn parse_query_string(query: &str) -> HashMap<String, String> {
    let mut out = HashMap::new();
    if query.is_empty() {
        return out;
    }
    for pair in query.split('&') {
        if let Some(eq) = pair.find('=') {
            let key = &pair[..eq];
            let value = &pair[eq + 1..];
            out.insert(key.to_string(), value.to_string());
        } else {
            out.insert(pair.to_string(), String::new());
        }
    }
    out
}

#[allow(dead_code)]
fn _fx_hashmap_anchor() -> Option<FxHashMap<String, String>> {
    None
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
