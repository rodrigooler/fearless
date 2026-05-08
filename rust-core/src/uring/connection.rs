use crate::benchmark::parser::{classify, Classification, Route};
use crate::benchmark::responses::{BenchmarkServer, Variant};
use io_uring::{opcode, types::Fd, IoUring};
use std::io;
use std::os::fd::RawFd;
use std::sync::Arc;

const READ_BUF: usize = 4096;

pub struct Connection {
    fd: RawFd,
    server: Arc<BenchmarkServer>,
    read_buf: Box<[u8; READ_BUF]>,
    write_buf: Option<Arc<[u8]>>,
    read_filled: usize,
    state: State,
}

#[derive(Copy, Clone, Eq, PartialEq)]
enum State {
    Reading,
    Writing { close_after: bool },
}

impl Connection {
    pub fn new(fd: RawFd, server: Arc<BenchmarkServer>) -> Self {
        Self {
            fd,
            server,
            read_buf: Box::new([0u8; READ_BUF]),
            write_buf: None,
            read_filled: 0,
            state: State::Reading,
        }
    }

    pub fn submit_read(&mut self, ring: &mut IoUring, token: u64) -> io::Result<()> {
        let ptr = unsafe { self.read_buf.as_mut_ptr().add(self.read_filled) };
        let len = (READ_BUF - self.read_filled) as u32;
        let entry = opcode::Recv::new(Fd(self.fd), ptr, len).build().user_data(token);
        unsafe { ring.submission().push(&entry).map_err(|_| io::Error::other("sq full"))? };
        Ok(())
    }

    fn submit_write(&mut self, ring: &mut IoUring, token: u64) -> io::Result<()> {
        let buf = self.write_buf.as_ref().expect("write buf set");
        let entry = opcode::Send::new(Fd(self.fd), buf.as_ptr(), buf.len() as u32)
            .build()
            .user_data(token);
        unsafe { ring.submission().push(&entry).map_err(|_| io::Error::other("sq full"))? };
        Ok(())
    }

    /// Returns Ok(true) if the connection should remain in the registry, Ok(false) if it has closed.
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
                let buf = &self.read_buf[..self.read_filled];
                if find_double_crlf(buf).is_none() {
                    self.submit_read(ring, token)?;
                    return Ok(true);
                }
                let cls = classify_first_line(buf);
                let snap = self.server.responses.snapshot();
                let bytes = snap.get(variant_for(cls));
                self.write_buf = Some(bytes);
                self.state = State::Writing { close_after: cls.close };
                self.submit_write(ring, token)?;
                Ok(true)
            }
            State::Writing { close_after } => {
                if result <= 0 || close_after {
                    self.close();
                    return Ok(false);
                }
                self.read_filled = 0;
                self.write_buf = None;
                self.state = State::Reading;
                self.submit_read(ring, token)?;
                Ok(true)
            }
        }
    }

    fn close(&self) {
        unsafe {
            libc::close(self.fd);
        }
    }
}

#[inline]
fn classify_first_line(buf: &[u8]) -> Classification {
    if buf.is_empty() {
        return Classification { route: Route::NotFound, close: false };
    }
    let line_end = memchr::memchr(b'\n', buf).unwrap_or(buf.len().saturating_sub(1));
    let end = (line_end + 1).min(buf.len());
    classify(&buf[..end])
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

#[inline]
fn find_double_crlf(buf: &[u8]) -> Option<usize> {
    let mut i = 0;
    while let Some(off) = memchr::memchr(b'\r', &buf[i..]) {
        let pos = i + off;
        if pos + 4 > buf.len() {
            return None;
        }
        if &buf[pos..pos + 4] == b"\r\n\r\n" {
            return Some(pos);
        }
        i = pos + 1;
    }
    None
}
