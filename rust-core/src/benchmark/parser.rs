#[derive(Debug, Copy, Clone, PartialEq, Eq)]
pub enum Route {
    Plaintext,
    Json,
    NotFound,
}

#[derive(Debug, Copy, Clone, PartialEq, Eq)]
pub struct Classification {
    pub route: Route,
    pub close: bool,
}

const PLAINTEXT: &[u8] = b"GET /plaintext HTTP/1.";
const JSON: &[u8] = b"GET /json HTTP/1.";

#[inline]
pub fn classify(line: &[u8]) -> Classification {
    if line.len() >= PLAINTEXT.len() + 3 && &line[..PLAINTEXT.len()] == PLAINTEXT {
        let close = line[PLAINTEXT.len()] == b'0';
        return Classification { route: Route::Plaintext, close };
    }
    if line.len() >= JSON.len() + 3 && &line[..JSON.len()] == JSON {
        let close = line[JSON.len()] == b'0';
        return Classification { route: Route::Json, close };
    }
    Classification { route: Route::NotFound, close: false }
}

#[derive(Debug)]
pub struct ParseResult {
    pub consumed: usize,
    pub count: usize,
}

/// Iterates request lines in a pipelined buffer.
/// Returns the number of complete requests classified and the bytes consumed.
/// If the buffer ends mid-request, leaves the trailing partial bytes for the caller to retain.
pub fn parse_pipeline(buf: &[u8], out: &mut [Classification]) -> ParseResult {
    let mut consumed = 0usize;
    let mut count = 0usize;
    while count < out.len() {
        let remaining = &buf[consumed..];
        let Some(end_of_headers) = find_double_crlf(remaining) else { break };
        let request = &remaining[..end_of_headers + 4];
        let line_end = memchr::memchr(b'\n', request).unwrap_or(request.len());
        let line = &request[..line_end + 1];
        out[count] = classify(line);
        count += 1;
        consumed += end_of_headers + 4;
    }
    ParseResult { consumed, count }
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
