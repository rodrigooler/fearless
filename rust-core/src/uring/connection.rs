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
    /// Close decision (HTTP/1.0 vs HTTP/1.1) captured at park time so the
    /// async response delivery can honor keep-alive instead of forcing close.
    #[cfg(feature = "pg-handles")]
    parked_close_after: bool,
}

#[derive(Copy, Clone, Eq, PartialEq)]
enum State {
    Reading,
    Writing,
    /// Parked while an async handler runs on the tokio runtime. No I/O ops
    /// are submitted in this state; the connection is woken by an eventfd
    /// CQE that drains the bridge and calls `deliver_async_response`.
    #[cfg(feature = "pg-handles")]
    AwaitingAsync,
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
            #[cfg(feature = "pg-handles")]
            parked_close_after: false,
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
        #[cfg(feature = "pg-handles")] bridge: &Arc<crate::runtime::async_bridge::WorkerBridge>,
    ) -> io::Result<bool> {
        match self.state {
            State::Reading => {
                if result <= 0 {
                    self.close();
                    return Ok(false);
                }
                self.read_filled += result as usize;
                #[cfg(feature = "pg-handles")]
                {
                    self.process_buffered(ring, token, bridge)
                }
                #[cfg(not(feature = "pg-handles"))]
                {
                    self.process_buffered(ring, token)
                }
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
                    #[cfg(feature = "pg-handles")]
                    {
                        return self.process_buffered(ring, token, bridge);
                    }
                    #[cfg(not(feature = "pg-handles"))]
                    {
                        return self.process_buffered(ring, token);
                    }
                }
                self.submit_read(ring, token)?;
                Ok(true)
            }
            #[cfg(feature = "pg-handles")]
            State::AwaitingAsync => {
                // We don't submit Recv/Send while parked, so a CQE arriving here
                // means a stale completion slipped past the generation check, or
                // a logic bug. Close defensively rather than risk corrupting state.
                self.close();
                Ok(false)
            }
        }
    }

    fn process_buffered(
        &mut self,
        ring: &mut IoUring,
        token: u64,
        #[cfg(feature = "pg-handles")] bridge: &Arc<crate::runtime::async_bridge::WorkerBridge>,
    ) -> io::Result<bool> {
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
        // When an async route fires we park; signal so the post-loop
        // tail skips submit_write entirely (the eventfd CQE will deliver).
        #[cfg(feature = "pg-handles")]
        let mut parked_async = false;

        for (i, cls) in classifications[..result.count].iter().enumerate() {
            let request_start = bytes_consumed;
            let request_end = request_start + cls.request_len as usize;

            // Three dispatch paths in priority order:
            //   1. Benchmark fast path — Plaintext/Json: pre-baked bytes from snap
            //   2. AOT sync path  — NotFound + AotRouteTable hit: run handler inline
            //   2b. AOT async path — NotFound + AotRouteTable hit: spawn on bridge, park
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
                    let aot_outcome = if let Some(table) = aot_table.as_ref() {
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
                        AotOutcome::NoMatch
                    };

                    match aot_outcome {
                        AotOutcome::SyncWritten(n) => n,
                        #[cfg(feature = "pg-handles")]
                        AotOutcome::Async {
                            handler,
                            method,
                            path,
                            params,
                            query,
                            headers,
                        } => {
                            // If preceding pipelined requests already filled
                            // the write region, flush those first; this async
                            // request stays in the read buffer and gets
                            // re-classified on the next pass.
                            if i > 0 {
                                break;
                            }
                            let registry = match self.server.handle_registry.as_ref() {
                                Some(r) => r.clone(),
                                None => {
                                    // Async route registered but no handle
                                    // registry available (e.g. PG env not set
                                    // or aot-handlers off). Return 503 inline.
                                    const SVC_UNAVAIL: &[u8] = b"HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";
                                    if self.write_filled + SVC_UNAVAIL.len() > WRITE_REGION_BYTES {
                                        self.close();
                                        return Ok(false);
                                    }
                                    let write_slice = unsafe {
                                        std::slice::from_raw_parts_mut(
                                            self.slot.write_ptr,
                                            WRITE_REGION_BYTES,
                                        )
                                    };
                                    write_slice[self.write_filled
                                        ..self.write_filled + SVC_UNAVAIL.len()]
                                        .copy_from_slice(SVC_UNAVAIL);
                                    self.write_filled += SVC_UNAVAIL.len();
                                    close_after = true;
                                    bytes_consumed = request_end;
                                    classified_consumed += 1;
                                    break;
                                }
                            };
                            // Consume the request bytes so we don't re-process
                            // them on wake.
                            bytes_consumed = request_end;
                            classified_consumed += 1;

                            let slot_id = (token & 0xFFFF_FFFF) as u32;
                            bridge.spawn(slot_id, async move {
                                handler(method, path, params, query, headers, registry).await
                            });
                            self.park_for_async(cls.close);
                            parked_async = true;
                            break;
                        }
                        AotOutcome::NoMatch => {
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
                        AotOutcome::Overflow => {
                            // Sync handler ran but its output won't fit; if
                            // we've already buffered prior writes, flush them
                            // first. Otherwise close (single response is too
                            // large for the write region).
                            if i == 0 {
                                self.close();
                                return Ok(false);
                            }
                            break;
                        }
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

        // Async-parked path: bridge::spawn already running; the eventfd CQE
        // will deliver the response and submit a Send. Don't submit_write here.
        // State is already AwaitingAsync (set in the async arm via park_for_async).
        #[cfg(feature = "pg-handles")]
        if parked_async {
            assert_eq!(
                self.write_filled, 0,
                "async dispatch must not buffer prior writes"
            );
            return Ok(true);
        }

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

    /// Try to dispatch a request through the AOT table.
    ///
    /// `request_bytes` is the full HTTP request (line + headers + `\r\n\r\n`).
    /// `scratch` is a per-Connection Vec used to capture sync handler output
    /// before copying into the write region. Cleared on entry; never freed.
    ///
    /// Sync handlers run inline and copy their output into the write region.
    /// Async handlers are NOT run here — the caller spawns them on the bridge
    /// after taking the owned state out of `AotOutcome::Async`.
    fn try_aot_dispatch(
        table: &crate::aot::AotRouteTable,
        request_bytes: &[u8],
        scratch: &mut Vec<u8>,
        write_ptr: *mut u8,
        write_filled: usize,
    ) -> AotOutcome {
        let Some((method, path)) = parse_method_path(request_bytes) else {
            return AotOutcome::NoMatch;
        };
        let Some((kind, params)) = table.lookup(method, path) else {
            return AotOutcome::NoMatch;
        };

        let std_params: HashMap<String, String> = params.into_iter().collect();

        // Strip query string from path for AotRequest.path. Keep ctx.url with query.
        let (clean_path, query_str) = match path.find('?') {
            Some(q) => (&path[..q], &path[q + 1..]),
            None => (path, ""),
        };

        let query = parse_query_string(query_str);
        let headers = parse_headers(request_bytes);

        match kind {
            crate::aot::HandlerKind::Sync(handler) => {
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
                    return AotOutcome::Overflow;
                }
                unsafe {
                    let dst = write_ptr.add(write_filled);
                    std::ptr::copy_nonoverlapping(scratch.as_ptr(), dst, n);
                }
                AotOutcome::SyncWritten(n)
            }
            #[cfg(feature = "pg-handles")]
            crate::aot::HandlerKind::Async(handler) => AotOutcome::Async {
                handler: *handler,
                method: method.to_string(),
                path: path.to_string(),
                params: std_params,
                query,
                headers,
            },
        }
    }
}

/// Outcome of a single AOT dispatch attempt. Sync handlers run inline (writing
/// into the slot's write region) and return `SyncWritten`. Async handlers
/// require the caller to spawn the future on the bridge — `Async` carries the
/// function pointer + owned request state across the spawn boundary.
enum AotOutcome {
    SyncWritten(usize),
    /// Sync handler produced output that won't fit in the remaining write
    /// region. Caller flushes prior buffered writes and retries on next pass,
    /// or closes if this is the first request in the batch.
    Overflow,
    NoMatch,
    #[cfg(feature = "pg-handles")]
    Async {
        handler: crate::aot::AotAsyncHandlerFn,
        method: String,
        path: String,
        params: HashMap<String, String>,
        query: HashMap<String, String>,
        headers: HashMap<String, String>,
    },
}

#[cfg(feature = "pg-handles")]
impl Connection {
    /// Transition the connection into the parked state. Called by the async
    /// dispatcher (Task 7) after spawning the handler future on the bridge.
    /// While parked, no I/O is submitted; the loop wakes us via the eventfd
    /// CQE and calls `deliver_async_response`.
    #[allow(dead_code)] // wired up in Task 7
    pub(crate) fn park_for_async(&mut self, close_after: bool) {
        self.state = State::AwaitingAsync;
        self.parked_close_after = close_after;
    }

    /// Called from the io_uring loop when the eventfd CQE delivers an async
    /// handler's response. Copies bytes into the slot's write region,
    /// transitions to `Writing`, and submits a Send.
    ///
    /// Returns `Ok(true)` if the connection is still alive (Send submitted),
    /// `Ok(false)` if it should be removed (response too large, or unexpected
    /// state). MVP closes the connection after the response drains — keep-alive
    /// on the async path is a Phase 1.2 follow-up.
    pub(crate) fn deliver_async_response(
        &mut self,
        ring: &mut IoUring,
        token: u64,
        bytes: &[u8],
    ) -> io::Result<bool> {
        // Defensive: only honor delivery while parked. A late delivery after
        // the conn already closed and the slot was reused could land here
        // through a generation race; ignore it.
        if !matches!(self.state, State::AwaitingAsync) {
            return Ok(true);
        }
        if bytes.len() > WRITE_REGION_BYTES {
            self.close();
            return Ok(false);
        }
        let write_slice = unsafe {
            std::slice::from_raw_parts_mut(self.slot.write_ptr, WRITE_REGION_BYTES)
        };
        write_slice[..bytes.len()].copy_from_slice(bytes);
        self.write_filled = bytes.len();
        self.write_offset = 0;
        // Honor the close decision captured at park time: HTTP/1.1 keep-alive
        // requests transition back to Reading after the Send drains; HTTP/1.0
        // (or explicit Connection: close) still tear down the socket.
        self.close_after_drain = self.parked_close_after;
        self.state = State::Writing;
        self.submit_write(ring, token)?;
        Ok(true)
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
