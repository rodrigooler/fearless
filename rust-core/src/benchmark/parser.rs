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
    /// Byte length of this request in the input buffer, including trailing
    /// `\r\n\r\n`. Used by callers that need to re-slice the raw request bytes
    /// (e.g. the AOT dispatcher needs the request line for path lookup).
    pub request_len: u32,
}

const PLAINTEXT: &[u8] = b"GET /plaintext HTTP/1.";
const JSON: &[u8] = b"GET /json HTTP/1.";

/// Classifies a single HTTP request line. The slice must include the trailing CRLF.
/// `request_len` is set to 0 by this fn — the caller in `parse_pipeline` fills
/// it in once per-request bytes are known. Direct callers (tests) get 0.
#[inline]
pub fn classify(line: &[u8]) -> Classification {
    if line.len() >= PLAINTEXT.len() + 3 && &line[..PLAINTEXT.len()] == PLAINTEXT {
        let close = line[PLAINTEXT.len()] == b'0';
        return Classification { route: Route::Plaintext, close, request_len: 0 };
    }
    if line.len() >= JSON.len() + 3 && &line[..JSON.len()] == JSON {
        let close = line[JSON.len()] == b'0';
        return Classification { route: Route::Json, close, request_len: 0 };
    }
    Classification { route: Route::NotFound, close: false, request_len: 0 }
}

#[derive(Debug, Copy, Clone, PartialEq, Eq)]
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
        let request_len = end_of_headers + 4;
        let request = &remaining[..request_len];
        let line_end = memchr::memchr(b'\n', request).unwrap_or(request.len());
        let line = &request[..line_end + 1];
        let mut cls = classify(line);
        cls.request_len = request_len as u32;
        out[count] = cls;
        count += 1;
        consumed += request_len;
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
