use serde::Deserialize;
use std::collections::HashMap;
use std::fs;
use std::io::{self, BufRead, BufReader, Write};
use std::net::{TcpListener, TcpStream};
use std::path::Path;
use std::sync::Arc;
use std::thread;

#[derive(Debug, Clone, Deserialize)]
pub struct Manifest {
    pub routes: Vec<RustStaticRoute>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct RustStaticRoute {
    pub method: String,
    pub path: String,
    #[serde(rename = "contentType")]
    pub content_type: String,
    pub body: String,
    #[serde(default)]
    pub headers: HashMap<String, String>,
    pub status: u16,
}

#[derive(Debug, Clone)]
struct ResponseTemplate {
    keep_alive: Vec<u8>,
    close: Vec<u8>,
}

#[derive(Debug, Hash, Eq, PartialEq, Clone)]
struct RouteKey {
    method: String,
    path: String,
}

#[derive(Debug, Clone)]
struct RouteTable {
    routes: HashMap<RouteKey, ResponseTemplate>,
    not_found: ResponseTemplate,
}

#[derive(Debug)]
struct RequestHead {
    method: String,
    path: String,
    close: bool,
}

pub fn load_manifest(path: impl AsRef<Path>) -> io::Result<Manifest> {
    let data = fs::read_to_string(path)?;
    let manifest = serde_json::from_str(&data)
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
    Ok(manifest)
}

pub fn run_server(manifest: Manifest, port: u16) -> io::Result<()> {
    let listener = TcpListener::bind(("127.0.0.1", port))?;
    listener.set_nonblocking(false)?;

    let table = Arc::new(RouteTable::from_manifest(manifest));

    for incoming in listener.incoming() {
        match incoming {
            Ok(stream) => {
                let table = Arc::clone(&table);
                thread::spawn(move || {
                    if let Err(error) = handle_connection(stream, table) {
                        if !is_disconnect_error(&error) {
                            eprintln!("connection error: {error}");
                        }
                    }
                });
            }
            Err(error) => return Err(error),
        }
    }

    Ok(())
}

impl RouteTable {
    fn from_manifest(manifest: Manifest) -> Self {
        let mut routes = HashMap::new();

        for route in manifest.routes {
            let response = ResponseTemplate::from_route(&route);
            let key = RouteKey {
                method: route.method.clone(),
                path: route.path.clone(),
            };
            routes.insert(key, response);
        }

        let not_found = ResponseTemplate::from_parts(404, "text/plain", "Not Found", &HashMap::new());

        Self { routes, not_found }
    }

    fn lookup(&self, method: &str, path: &str) -> &ResponseTemplate {
        let key = RouteKey {
            method: method.to_string(),
            path: path.to_string(),
        };

        self.routes.get(&key).unwrap_or(&self.not_found)
    }
}

impl ResponseTemplate {
    fn from_route(route: &RustStaticRoute) -> Self {
        Self::from_parts(route.status, &route.content_type, &route.body, &route.headers)
    }

    fn from_parts(
        status: u16,
        content_type: &str,
        body: &str,
        headers: &HashMap<String, String>,
    ) -> Self {
        Self {
            keep_alive: render_response(status, content_type, body, headers, false),
            close: render_response(status, content_type, body, headers, true),
        }
    }
}

fn reason_phrase(status: u16) -> &'static str {
    match status {
        200 => "OK",
        201 => "Created",
        204 => "No Content",
        301 => "Moved Permanently",
        302 => "Found",
        400 => "Bad Request",
        401 => "Unauthorized",
        403 => "Forbidden",
        404 => "Not Found",
        500 => "Internal Server Error",
        _ => "OK",
    }
}

fn render_response(
    status: u16,
    content_type: &str,
    body: &str,
    headers: &HashMap<String, String>,
    close: bool,
) -> Vec<u8> {
    let mut response = Vec::with_capacity(128 + body.len() + headers.len() * 24);

    response.extend_from_slice(format!("HTTP/1.1 {status} {}\r\n", reason_phrase(status)).as_bytes());
    response.extend_from_slice(format!("Content-Type: {content_type}\r\n").as_bytes());
    response.extend_from_slice(format!("Content-Length: {}\r\n", body.len()).as_bytes());
    response.extend_from_slice(if close {
        b"Connection: close\r\n"
    } else {
        b"Connection: keep-alive\r\n"
    });

    let mut extra_headers: Vec<(&String, &String)> = headers.iter().collect();
    extra_headers.sort_by(|left, right| left.0.cmp(right.0));
    for (key, value) in extra_headers {
        response.extend_from_slice(key.as_bytes());
        response.extend_from_slice(b": ");
        response.extend_from_slice(value.as_bytes());
        response.extend_from_slice(b"\r\n");
    }

    response.extend_from_slice(b"\r\n");
    response.extend_from_slice(body.as_bytes());
    response
}

fn handle_connection(stream: TcpStream, table: Arc<RouteTable>) -> io::Result<()> {
    stream.set_nodelay(true)?;
    let reader_stream = stream.try_clone()?;
    let mut reader = BufReader::new(reader_stream);
    let mut writer = stream;

    loop {
        let request = match read_request(&mut reader)? {
            Some(request) => request,
            None => break,
        };

        let response = table.lookup(&request.method, &request.path);
        let payload = if request.close {
            &response.close
        } else {
            &response.keep_alive
        };
        writer.write_all(payload)?;

        if request.close {
            writer.flush()?;
            break;
        }
    }

    Ok(())
}

fn is_disconnect_error(error: &io::Error) -> bool {
    matches!(
        error.kind(),
        io::ErrorKind::UnexpectedEof
            | io::ErrorKind::ConnectionReset
            | io::ErrorKind::BrokenPipe
            | io::ErrorKind::ConnectionAborted
    )
}

fn read_request<R: BufRead>(reader: &mut R) -> io::Result<Option<RequestHead>> {
    let mut request_line = String::new();
    let bytes = reader.read_line(&mut request_line)?;
    if bytes == 0 {
        return Ok(None);
    }

    if request_line == "\r\n" {
        return Ok(None);
    }

    let request_line = request_line.trim_end_matches(['\r', '\n']);
    let mut parts = request_line.split_whitespace();
    let method = parts
        .next()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "missing method"))?
        .to_string();
    let path = parts
        .next()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "missing path"))?
        .to_string();
    let version = parts
        .next()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "missing version"))?;

    let mut close = version.eq_ignore_ascii_case("HTTP/1.0");

    loop {
        let mut header_line = String::new();
        let bytes = reader.read_line(&mut header_line)?;
        if bytes == 0 {
            break;
        }

        let header_line = header_line.trim_end_matches(['\r', '\n']);
        if header_line.is_empty() {
            break;
        }

        if let Some((name, value)) = header_line.split_once(':') {
            if name.eq_ignore_ascii_case("connection") {
                let value = value.trim();
                if value.eq_ignore_ascii_case("close") {
                    close = true;
                } else if value.eq_ignore_ascii_case("keep-alive") {
                    close = false;
                }
            }
        }
    }

    Ok(Some(RequestHead {
        method,
        path,
        close,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    #[test]
    fn renders_keep_alive_response() {
        let template = ResponseTemplate::from_parts(200, "text/plain", "Hello, World!", &HashMap::new());
        let response = String::from_utf8(template.keep_alive).expect("valid utf8");

        assert!(response.starts_with("HTTP/1.1 200 OK"));
        assert!(response.contains("Content-Type: text/plain"));
        assert!(response.contains("Content-Length: 13"));
        assert!(response.ends_with("Hello, World!"));
    }

    #[test]
    fn parses_request_with_connection_close() {
        let raw = b"GET /plaintext HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n";
        let mut cursor = Cursor::new(raw.as_slice());
        let request = read_request(&mut cursor)
            .expect("request parsed")
            .expect("request exists");

        assert_eq!(request.method, "GET");
        assert_eq!(request.path, "/plaintext");
        assert!(request.close);
    }

    #[test]
    fn route_table_returns_not_found_for_unknown_path() {
        let manifest = Manifest {
            routes: vec![RustStaticRoute {
                method: "GET".to_string(),
                path: "/plaintext".to_string(),
                content_type: "text/plain".to_string(),
                body: "Hello, World!".to_string(),
                headers: HashMap::new(),
                status: 200,
            }],
        };
        let table = RouteTable::from_manifest(manifest);
        let response = table.lookup("GET", "/missing");
        let payload = String::from_utf8(response.keep_alive.clone()).expect("valid utf8");

        assert!(payload.starts_with("HTTP/1.1 404 Not Found"));
        assert!(payload.ends_with("Not Found"));
    }
}
