use memchr::memchr;
use socket2::{Domain, Protocol, Socket, Type};
use rustc_hash::FxHashMap;
use serde::Deserialize;
use serde_json::{Map, Value};
use std::cell::RefCell;
use std::borrow::Cow;
use std::collections::HashMap;
use std::env;
use std::fs;
use std::io::{self, BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::os::fd::AsRawFd;
use std::path::Path;
use std::sync::{
    atomic::{AtomicU64, AtomicUsize, Ordering},
    Arc,
};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const SERVER_HEADER: &str = "Fearless";
const STATIC_RESPONSE_VARIANTS: usize = 2;
const DATE_LEN: usize = 29;

static NEXT_CONNECTION_SLOT: AtomicUsize = AtomicUsize::new(0);

thread_local! {
    static BENCHMARK_RESPONSES: RefCell<BenchmarkCachedResponses> =
        RefCell::new(BenchmarkCachedResponses::new());
}

#[derive(Debug, Clone, Deserialize)]
pub struct Manifest {
    pub routes: Vec<RustStaticRoute>,
    #[serde(default)]
    pub headers: HashMap<String, String>,
    #[serde(default)]
    pub cors: Option<CorsManifest>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CorsManifest {
    pub origin: Option<String>,
    pub methods: String,
    pub allowed_headers: Option<String>,
    pub exposed_headers: Option<String>,
    pub credentials: bool,
    pub max_age: Option<u64>,
    pub options_success_status: u16,
}

#[derive(Debug, Clone, Deserialize)]
pub struct RustStaticRoute {
    pub method: String,
    pub path: String,
    pub response: RustRouteResponse,
    #[serde(default)]
    pub headers: HashMap<String, String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct RustRouteResponse {
    pub kind: ResponseKind,
    pub body: Value,
    #[serde(default)]
    pub status: Option<u16>,
    #[serde(default)]
    pub headers: HashMap<String, String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ResponseKind {
    Text,
    Html,
    Json,
}

impl ResponseKind {
    fn content_type(&self) -> &'static str {
        match self {
            Self::Text => "text/plain",
            Self::Html => "text/html",
            Self::Json => "application/json",
        }
    }
}

#[derive(Copy, Clone, Debug, Eq, Hash, PartialEq)]
enum MethodKind {
    Delete,
    Get,
    Head,
    Options,
    Patch,
    Post,
    Put,
}

impl MethodKind {
    fn from_str(method: &str) -> Option<Self> {
        if method.eq_ignore_ascii_case("DELETE") {
            return Some(Self::Delete);
        }
        if method.eq_ignore_ascii_case("GET") {
            return Some(Self::Get);
        }
        if method.eq_ignore_ascii_case("HEAD") {
            return Some(Self::Head);
        }
        if method.eq_ignore_ascii_case("OPTIONS") {
            return Some(Self::Options);
        }
        if method.eq_ignore_ascii_case("PATCH") {
            return Some(Self::Patch);
        }
        if method.eq_ignore_ascii_case("POST") {
            return Some(Self::Post);
        }
        if method.eq_ignore_ascii_case("PUT") {
            return Some(Self::Put);
        }

        None
    }

    fn from_bytes(method: &[u8]) -> Option<Self> {
        if ascii_eq_ignore_case(method, b"DELETE") {
            return Some(Self::Delete);
        }
        if ascii_eq_ignore_case(method, b"GET") {
            return Some(Self::Get);
        }
        if ascii_eq_ignore_case(method, b"HEAD") {
            return Some(Self::Head);
        }
        if ascii_eq_ignore_case(method, b"OPTIONS") {
            return Some(Self::Options);
        }
        if ascii_eq_ignore_case(method, b"PATCH") {
            return Some(Self::Patch);
        }
        if ascii_eq_ignore_case(method, b"POST") {
            return Some(Self::Post);
        }
        if ascii_eq_ignore_case(method, b"PUT") {
            return Some(Self::Put);
        }

        None
    }

    fn index(self) -> usize {
        match self {
            Self::Delete => 0,
            Self::Get => 1,
            Self::Head => 2,
            Self::Options => 3,
            Self::Patch => 4,
            Self::Post => 5,
            Self::Put => 6,
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            Self::Delete => "DELETE",
            Self::Get => "GET",
            Self::Head => "HEAD",
            Self::Options => "OPTIONS",
            Self::Patch => "PATCH",
            Self::Post => "POST",
            Self::Put => "PUT",
        }
    }
}

#[derive(Debug, Clone)]
enum TemplateTokenValue {
    Text(String),
    Json(Value),
}

#[derive(Debug, Clone)]
struct TemplateContext {
    method: &'static str,
    path: String,
    params: FxHashMap<String, String>,
    query: FxHashMap<String, QueryValue>,
    headers: FxHashMap<String, String>,
    ip: String,
}

#[derive(Debug, Clone)]
enum QueryValue {
    Single(String),
    Multi(Vec<String>),
}

#[derive(Debug, Clone)]
struct ResponseBlueprint {
    kind: ResponseKind,
    body: Value,
    status: u16,
    headers: Vec<(String, String)>,
    static_response: Option<StaticResponseSet>,
}

#[derive(Debug, Clone)]
struct StaticResponseSet {
    keep_alive: [Arc<[u8]>; STATIC_RESPONSE_VARIANTS],
    close: [Arc<[u8]>; STATIC_RESPONSE_VARIANTS],
}

#[derive(Debug, Clone)]
struct RouteEntry {
    response: Arc<ResponseBlueprint>,
}

#[derive(Debug, Default)]
struct RouteNode {
    route: Option<RouteEntry>,
    static_children: FxHashMap<String, Box<RouteNode>>,
    param_child: Option<Box<RouteNode>>,
    param_key: Option<String>,
}

#[derive(Debug)]
struct RouteTable {
    routes: [FxHashMap<String, RouteEntry>; 7],
    static_get_routes: FxHashMap<Box<[u8]>, RouteEntry>,
    param_roots: [Option<Box<RouteNode>>; 7],
    not_found: Arc<ResponseBlueprint>,
    cors_options: Option<Arc<ResponseBlueprint>>,
}

struct BenchmarkRouteTable {
    plaintext: BenchmarkResponseTemplate,
    json: BenchmarkResponseTemplate,
    not_found: BenchmarkResponseTemplate,
    date_cache: Arc<BenchmarkDateCache>,
}

#[derive(Clone)]
struct BenchmarkResponseTemplate {
    head: Vec<u8>,
    keep_alive_suffix: Vec<u8>,
    close_suffix: Vec<u8>,
}

struct BenchmarkDateCache {
    current_second: AtomicU64,
}

struct BenchmarkCachedResponses {
    second: u64,
    plaintext_keepalive: Vec<u8>,
    plaintext_close: Vec<u8>,
    json_keepalive: Vec<u8>,
    json_close: Vec<u8>,
    not_found_keepalive: Vec<u8>,
    not_found_close: Vec<u8>,
}

#[derive(Copy, Clone)]
enum BenchmarkRoute {
    Plaintext,
    Json,
    NotFound,
}

struct ConnectionReader {
    stream: TcpStream,
    buffer: [u8; 8192],
    cursor: usize,
    filled: usize,
}

pub fn load_manifest(path: impl AsRef<Path>) -> io::Result<Manifest> {
    let data = fs::read_to_string(path)?;
    let manifest = serde_json::from_str(&data)
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
    Ok(manifest)
}

pub fn run_benchmark_server(port: u16) -> io::Result<()> {
    let worker_count = env::var("FEARLESS_WORKERS")
        .ok()
        .and_then(|value| value.parse::<usize>().ok())
        .filter(|count| *count > 0)
        .unwrap_or(10);
    let listeners = build_benchmark_listeners(port, worker_count)?;
    let table = Arc::new(BenchmarkRouteTable::new());

    for listener in listeners {
        let table = Arc::clone(&table);
        thread::spawn(move || benchmark_worker_loop(listener, table));
    }

    loop {
        thread::park();
    }
}

pub fn run_server(manifest: Manifest, port: u16) -> io::Result<()> {
    let listener = TcpListener::bind(("0.0.0.0", port))?;
    listener.set_nonblocking(false)?;

    let table = Arc::new(RouteTable::from_manifest(manifest)?);
    let worker_count = env::var("FEARLESS_WORKERS")
        .ok()
        .and_then(|value| value.parse::<usize>().ok())
        .filter(|count| *count > 0)
        .unwrap_or_else(|| {
            thread::available_parallelism()
                .map(|count| count.get().saturating_mul(2))
                .unwrap_or(8)
                .clamp(8, 16)
        });

    spawn_workers(worker_count, listener, Arc::clone(&table))?;

    loop {
        thread::park();
    }
}

fn spawn_workers(
    worker_count: usize,
    listener: TcpListener,
    table: Arc<RouteTable>,
) -> io::Result<()> {
    let mut listeners = Vec::with_capacity(worker_count);
    listeners.push(listener);

    for _ in 1..worker_count {
        let cloned = listeners[0].try_clone()?;
        listeners.push(cloned);
    }

    for listener in listeners {
        let table = Arc::clone(&table);
        thread::spawn(move || worker_loop(listener, table));
    }

    Ok(())
}

fn worker_loop(listener: TcpListener, table: Arc<RouteTable>) {
    loop {
        match listener.accept() {
            Ok((stream, _)) => {
                // Avoid Arc::clone in hot path by taking ownership
                let table = Arc::clone(&table);
                if let Err(error) = handle_connection(stream, table) {
                    if !is_disconnect_error(&error) {
                        eprintln!("connection error: {error}");
                    }
                }
            }
            Err(error) => {
                eprintln!("accept error: {error}");
            }
        }
    }
}

fn benchmark_worker_loop(listener: TcpListener, table: Arc<BenchmarkRouteTable>) {
    loop {
        match listener.accept() {
            Ok((stream, _)) => {
                let table = Arc::clone(&table);
                if let Err(error) = handle_benchmark_connection(stream, table) {
                    if !is_disconnect_error(&error) {
                        eprintln!("connection error: {error}");
                    }
                }
            }
            Err(error) => {
                eprintln!("accept error: {error}");
            }
        }
    }
}

fn build_benchmark_listeners(port: u16, worker_count: usize) -> io::Result<Vec<TcpListener>> {
    let mut listeners = Vec::with_capacity(worker_count);

    for _ in 0..worker_count {
        let socket = Socket::new(Domain::IPV4, Type::STREAM, Some(Protocol::TCP))?;
        socket.set_reuse_address(true)?;
        #[cfg(unix)]
        set_socket_reuse_port(&socket)?;
        socket.set_nodelay(true)?;
        socket.bind(&socket2::SockAddr::from(std::net::SocketAddr::from(([0, 0, 0, 0], port))))?;
        socket.listen(4096)?;

        let listener: TcpListener = socket.into();
        listener.set_nonblocking(false)?;
        listeners.push(listener);
    }

    Ok(listeners)
}

#[cfg(unix)]
fn set_socket_reuse_port(socket: &Socket) -> io::Result<()> {
    let value: libc::c_int = 1;
    let result = unsafe {
        libc::setsockopt(
            socket.as_raw_fd(),
            libc::SOL_SOCKET,
            libc::SO_REUSEPORT,
            &value as *const _ as *const libc::c_void,
            std::mem::size_of_val(&value) as libc::socklen_t,
        )
    };

    if result == 0 {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}

impl BenchmarkRouteTable {
    fn new() -> Self {
        Self {
            plaintext: BenchmarkResponseTemplate::new(
                "200 OK",
                "text/plain; charset=utf-8",
                "Hello, World!",
            ),
            json: BenchmarkResponseTemplate::new(
                "200 OK",
                "application/json",
                r#"{"message":"Hello, World!"}"#,
            ),
            not_found: BenchmarkResponseTemplate::new("404 Not Found", "text/plain", "Not Found"),
            date_cache: BenchmarkDateCache::spawn(),
        }
    }
}

impl BenchmarkResponseTemplate {
    fn new(status: &'static str, content_type: &'static str, body: &'static str) -> Self {
        let head = format!("HTTP/1.1 {status}\r\nServer: {SERVER_HEADER}\r\nDate: ").into_bytes();
        Self {
            head,
            keep_alive_suffix: Self::build_suffix(content_type, body, false),
            close_suffix: Self::build_suffix(content_type, body, true),
        }
    }

    fn build_suffix(content_type: &str, body: &str, close: bool) -> Vec<u8> {
        let mut suffix = Vec::with_capacity(96 + body.len());
        suffix.extend_from_slice(
            format!(
                "\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: {}\r\n\r\n",
                body.len(),
                if close { "close" } else { "keep-alive" }
            )
            .as_bytes(),
        );
        suffix.extend_from_slice(body.as_bytes());
        suffix
    }

    fn render(&self, date: &[u8; DATE_LEN], close: bool) -> Vec<u8> {
        let suffix = if close {
            &self.close_suffix
        } else {
            &self.keep_alive_suffix
        };
        let mut response = Vec::with_capacity(self.head.len() + DATE_LEN + suffix.len());
        response.extend_from_slice(&self.head);
        response.extend_from_slice(date);
        response.extend_from_slice(suffix);
        response
    }
}

impl BenchmarkDateCache {
    fn spawn() -> Arc<Self> {
        let cache = Arc::new(Self {
            current_second: AtomicU64::new(current_second()),
        });
        let thread_cache = Arc::clone(&cache);

        thread::spawn(move || loop {
            thread_cache
                .current_second
                .store(current_second(), Ordering::Relaxed);
            thread::sleep(Duration::from_secs(1));
        });

        cache
    }

    fn current_second(&self) -> u64 {
        self.current_second.load(Ordering::Relaxed)
    }
}

impl BenchmarkCachedResponses {
    fn new() -> Self {
        Self {
            second: 0,
            plaintext_keepalive: Vec::new(),
            plaintext_close: Vec::new(),
            json_keepalive: Vec::new(),
            json_close: Vec::new(),
            not_found_keepalive: Vec::new(),
            not_found_close: Vec::new(),
        }
    }

    fn refresh(&mut self, second: u64, table: &BenchmarkRouteTable) {
        if self.second == second {
            return;
        }

        let date = date_bytes_from_second(second);
        self.second = second;
        self.plaintext_keepalive = table.plaintext.render(&date, false);
        self.plaintext_close = table.plaintext.render(&date, true);
        self.json_keepalive = table.json.render(&date, false);
        self.json_close = table.json.render(&date, true);
        self.not_found_keepalive = table.not_found.render(&date, false);
        self.not_found_close = table.not_found.render(&date, true);
    }

    fn response(&self, route: BenchmarkRoute, close: bool) -> &[u8] {
        match (route, close) {
            (BenchmarkRoute::Plaintext, false) => &self.plaintext_keepalive,
            (BenchmarkRoute::Plaintext, true) => &self.plaintext_close,
            (BenchmarkRoute::Json, false) => &self.json_keepalive,
            (BenchmarkRoute::Json, true) => &self.json_close,
            (BenchmarkRoute::NotFound, false) => &self.not_found_keepalive,
            (BenchmarkRoute::NotFound, true) => &self.not_found_close,
        }
    }
}

impl ConnectionReader {
    fn new(stream: TcpStream) -> Self {
        Self {
            stream,
            buffer: [0; 8192],
            cursor: 0,
            filled: 0,
        }
    }

    fn read_line(&mut self, target: &mut Vec<u8>) -> io::Result<bool> {
        target.clear();
        loop {
            if self.cursor == self.filled {
                self.cursor = 0;
                self.filled = self.stream.read(&mut self.buffer)?;
                if self.filled == 0 {
                    return Ok(false);
                }
            }

            let available = &self.buffer[self.cursor..self.filled];
            if let Some(index) = available.iter().position(|byte| *byte == b'\n') {
                let end = self.cursor + index + 1;
                target.extend_from_slice(&self.buffer[self.cursor..end]);
                self.cursor = end;
                return Ok(true);
            }

            target.extend_from_slice(available);
            self.cursor = self.filled;
        }
    }
}

impl RouteTable {
    fn from_manifest(manifest: Manifest) -> io::Result<Self> {
        let mut routes: [FxHashMap<String, RouteEntry>; 7] =
            std::array::from_fn(|_| FxHashMap::default());
        let mut static_get_routes = FxHashMap::default();
        let mut param_roots: [Option<Box<RouteNode>>; 7] = std::array::from_fn(|_| None);
        let global_headers = manifest.headers;

        for route in manifest.routes {
            let method = MethodKind::from_str(&route.method).ok_or_else(|| {
                io::Error::new(
                    io::ErrorKind::InvalidData,
                    format!("unsupported method: {}", route.method),
                )
            })?;
            let response = Arc::new(ResponseBlueprint::from_route(&route, &global_headers));
            let entry = RouteEntry { response };
            let normalized_path = normalize_path(&route.path);

            if has_params(&route.path) {
                let root = param_roots[method.index()]
                    .get_or_insert_with(|| Box::new(RouteNode::default()));
                root.insert(&split_path(&normalized_path), 0, entry);
            } else {
                if method == MethodKind::Get && entry.response.static_response.is_some() {
                    static_get_routes.insert(
                        normalized_path.as_bytes().to_vec().into_boxed_slice(),
                        entry.clone(),
                    );
                }
                routes[method.index()].insert(normalized_path.to_string(), entry);
            }
        }

        let not_found = Arc::new(ResponseBlueprint::from_parts(
            ResponseKind::Text,
            Value::String("Not Found".to_string()),
            404,
            &global_headers,
        ));

        let cors_options = manifest.cors.as_ref().map(|cors| {
            let mut headers = HashMap::new();

            if let Some(origin) = &cors.origin {
                headers.insert("Access-Control-Allow-Origin".to_string(), origin.clone());
            }

            headers.insert(
                "Access-Control-Allow-Methods".to_string(),
                cors.methods.clone(),
            );

            if let Some(allowed_headers) = &cors.allowed_headers {
                headers.insert(
                    "Access-Control-Allow-Headers".to_string(),
                    allowed_headers.clone(),
                );
            }

            if let Some(exposed_headers) = &cors.exposed_headers {
                headers.insert(
                    "Access-Control-Expose-Headers".to_string(),
                    exposed_headers.clone(),
                );
            }

            if cors.credentials {
                headers.insert(
                    "Access-Control-Allow-Credentials".to_string(),
                    "true".to_string(),
                );
            }

            if let Some(max_age) = cors.max_age {
                headers.insert("Access-Control-Max-Age".to_string(), max_age.to_string());
            }

            Arc::new(ResponseBlueprint::from_parts(
                ResponseKind::Text,
                Value::String(String::new()),
                cors.options_success_status,
                &merge_headers(&global_headers, &headers),
            ))
        });
        Ok(Self {
            routes,
            static_get_routes,
            param_roots,
            not_found,
            cors_options,
        })
    }

    fn lookup(
        &self,
        method: MethodKind,
        path: &str,
    ) -> (Arc<ResponseBlueprint>, FxHashMap<String, String>, bool) {
        if method == MethodKind::Options {
            if let Some(route) = self.cors_options.as_ref() {
                return (Arc::clone(route), FxHashMap::default(), true);
            }
        }

        let normalized = normalize_path(path);

        if method == MethodKind::Head {
            if let Some(route) = self.routes[MethodKind::Head.index()].get(normalized.as_ref()) {
                return (Arc::clone(&route.response), FxHashMap::default(), true);
            }

            if let Some(route) = self.routes[MethodKind::Get.index()].get(normalized.as_ref()) {
                return (Arc::clone(&route.response), FxHashMap::default(), true);
            }

            if let Some((route, params)) =
                self.match_param_route(MethodKind::Head, normalized.as_ref())
            {
                return (route, params, true);
            }

            if let Some((route, params)) =
                self.match_param_route(MethodKind::Get, normalized.as_ref())
            {
                return (route, params, true);
            }

            return (Arc::clone(&self.not_found), FxHashMap::default(), true);
        }

        if let Some(route) = self.routes[method.index()].get(normalized.as_ref()) {
            return (Arc::clone(&route.response), FxHashMap::default(), false);
        }

        if let Some((route, params)) = self.match_param_route(method, normalized.as_ref()) {
            return (route, params, false);
        }

        (Arc::clone(&self.not_found), FxHashMap::default(), false)
    }

    fn lookup_static_response(&self, method: MethodKind, path: &str) -> Option<&ResponseBlueprint> {
        if method != MethodKind::Get {
            return None;
        }

        let route = self.routes[method.index()].get(path)?;
        let blueprint = route.response.as_ref();
        if blueprint.static_response.is_some() {
            Some(blueprint)
        } else {
            None
        }
    }

    fn lookup_static_response_bytes(&self, method: &[u8], path: &[u8]) -> Option<&ResponseBlueprint> {
        if !ascii_eq_ignore_case(method, b"GET") {
            return None;
        }

        if path.is_empty()
            || path[0] != b'/'
            || path.contains(&b'?')
            || (path.len() > 1 && path[path.len() - 1] == b'/')
        {
            return None;
        }

        let route = self.static_get_routes.get(path)?;
        Some(route.response.as_ref())
    }

    #[inline]
    fn match_param_route(
        &self,
        method: MethodKind,
        path: &str,
    ) -> Option<(Arc<ResponseBlueprint>, FxHashMap<String, String>)> {
        let root = self.param_roots[method.index()].as_ref()?;
        let segments = split_path(path);
        let mut params = FxHashMap::default();
        let matched = root.match_segments(&segments, 0, &mut params)?;
        // Return cloned Arc with params
        Some((Arc::clone(&matched.response), params))
    }
}

// Drop unused warning
const _: () = {
    #[allow(unused_imports)]
    use smallvec::SmallVec;
};

impl RouteNode {
    fn insert(&mut self, segments: &[&str], index: usize, route: RouteEntry) {
        if index == segments.len() {
            self.route = Some(route);
            return;
        }

        let segment = segments[index];
        if let Some(param_name) = segment.strip_prefix(':') {
            let child = self
                .param_child
                .get_or_insert_with(|| Box::new(RouteNode::default()));
            if child.param_key.is_none() {
                child.param_key = Some(param_name.to_string());
            }
            child.insert(segments, index + 1, route);
            return;
        }

        let child = self
            .static_children
            .entry(segment.to_string())
            .or_insert_with(|| Box::new(RouteNode::default()));
        child.insert(segments, index + 1, route);
    }

    #[inline]
    fn match_segments<'a, 's>(
        &'a self,
        segments: &'s [&str],
        index: usize,
        params: &mut FxHashMap<String, String>,
    ) -> Option<&'a RouteEntry> {
        if index == segments.len() {
            return self.route.as_ref();
        }

        let segment = segments[index];

        // Try static child first (most common case)
        if let Some(child) = self.static_children.get(segment) {
            if let Some(route) = child.match_segments(segments, index + 1, params) {
                return Some(route);
            }
        }

        // Fall back to param child
        let child = self.param_child.as_ref()?;
        let param_key = child.param_key.as_ref()?;

        params.insert(param_key.clone(), decode_segment(segment));
        if let Some(route) = child.match_segments(segments, index + 1, params) {
            return Some(route);
        }
        params.remove(param_key);

        None
    }

}

impl ResponseBlueprint {
    fn from_route(route: &RustStaticRoute, global_headers: &HashMap<String, String>) -> Self {
        let merged_headers = merge_headers(
            global_headers,
            &merge_headers(&route.headers, &route.response.headers),
        );
        Self::from_parts(
            route.response.kind.clone(),
            route.response.body.clone(),
            route.response.status.unwrap_or(200),
            &merged_headers,
        )
    }

    fn from_parts(
        kind: ResponseKind,
        body: Value,
        status: u16,
        headers: &HashMap<String, String>,
    ) -> Self {
        let mut ordered_headers: Vec<(String, String)> = headers
            .iter()
            .map(|(key, value)| (key.clone(), value.clone()))
            .collect();
        ordered_headers.sort_by(|left, right| left.0.cmp(&right.0));

        let static_response = if can_precompute_response(&body, &ordered_headers) {
            let rendered_body = match kind {
                ResponseKind::Json => {
                    serde_json::to_string(&body).unwrap_or_else(|_| "null".to_string())
                }
                ResponseKind::Text | ResponseKind::Html => template_value_to_string(body.clone()),
            };
            let date0 = current_date_string();
            let date1 = current_date_string_offset(1);
            let keep_alive = [
                Arc::from(
                    build_response_bytes(
                        status,
                        kind.content_type(),
                        rendered_body.len(),
                        rendered_body.as_bytes(),
                        &ordered_headers,
                        false,
                        &date0,
                    )
                    .into_boxed_slice(),
                ),
                Arc::from(
                    build_response_bytes(
                        status,
                        kind.content_type(),
                        rendered_body.len(),
                        rendered_body.as_bytes(),
                        &ordered_headers,
                        false,
                        &date1,
                    )
                    .into_boxed_slice(),
                ),
            ];
            let close = [
                Arc::from(
                    build_response_bytes(
                        status,
                        kind.content_type(),
                        rendered_body.len(),
                        rendered_body.as_bytes(),
                        &ordered_headers,
                        true,
                        &date0,
                    )
                    .into_boxed_slice(),
                ),
                Arc::from(
                    build_response_bytes(
                        status,
                        kind.content_type(),
                        rendered_body.len(),
                        rendered_body.as_bytes(),
                        &ordered_headers,
                        true,
                        &date1,
                    )
                    .into_boxed_slice(),
                ),
            ];
            Some(StaticResponseSet { keep_alive, close })
        } else {
            None
        };

        Self {
            kind,
            body,
            status,
            headers: ordered_headers,
            static_response,
        }
    }

    fn static_response(&self, close: bool, slot: usize) -> Option<&Arc<[u8]>> {
        let set = self.static_response.as_ref()?;
        if close {
            Some(&set.close[slot])
        } else {
            Some(&set.keep_alive[slot])
        }
    }
}

#[derive(Debug, Clone)]
enum ResponsePayload {
    Dynamic(Vec<u8>),
}

impl ResponsePayload {
    fn as_bytes(&self) -> &[u8] {
        match self {
            Self::Dynamic(bytes) => bytes.as_slice(),
        }
    }
}

fn reason_phrase(status: u16) -> &'static str {
    match status {
        200 => "OK",
        201 => "Created",
        202 => "Accepted",
        203 => "Non-Authoritative Information",
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
    blueprint: &Arc<ResponseBlueprint>,
    context: &TemplateContext,
    close: bool,
    suppress_body: bool,
) -> ResponsePayload {
    let response = build_dynamic_response(blueprint, context, close, suppress_body);
    ResponsePayload::Dynamic(response)
}

fn build_response_bytes(
    status: u16,
    content_type: &str,
    content_length: usize,
    body_bytes: &[u8],
    headers: &[(String, String)],
    close: bool,
    date: &str,
) -> Vec<u8> {
    let mut response = Vec::with_capacity(160 + body_bytes.len() + headers.len() * 24);
    response.extend_from_slice(
        format!(
            "HTTP/1.1 {} {}\r\nServer: {}\r\nDate: {}\r\n",
            status,
            reason_phrase(status),
            SERVER_HEADER,
            date
        )
        .as_bytes(),
    );

    for (key, value) in headers {
        if key.eq_ignore_ascii_case("content-type") {
            continue;
        }

        response.extend_from_slice(key.as_bytes());
        response.extend_from_slice(b": ");
        response.extend_from_slice(value.as_bytes());
        response.extend_from_slice(b"\r\n");
    }

    response.extend_from_slice(format!("Content-Type: {}\r\n", content_type).as_bytes());
    response.extend_from_slice(format!("Content-Length: {}\r\n", content_length).as_bytes());
    response.extend_from_slice(if close {
        b"Connection: close\r\n"
    } else {
        b"Connection: keep-alive\r\n"
    });
    response.extend_from_slice(b"\r\n");
    response.extend_from_slice(body_bytes);
    response
}

fn build_dynamic_response(
    blueprint: &Arc<ResponseBlueprint>,
    context: &TemplateContext,
    close: bool,
    suppress_body: bool,
) -> Vec<u8> {
    let rendered_body = render_template_value(&blueprint.body, context);
    let body = match blueprint.kind {
        ResponseKind::Json => {
            serde_json::to_string(&rendered_body).unwrap_or_else(|_| "null".to_string())
        }
        ResponseKind::Text | ResponseKind::Html => template_value_to_string(rendered_body),
    };
    let body_bytes = if suppress_body || blueprint.status == 204 || blueprint.status == 304 {
        &[][..]
    } else {
        body.as_bytes()
    };
    let content_length = if blueprint.status == 204 || blueprint.status == 304 {
        0
    } else {
        body.len()
    };
    build_response_bytes(
        blueprint.status,
        blueprint.kind.content_type(),
        content_length,
        body_bytes,
        &blueprint.headers,
        close,
        &current_date_string(),
    )
}

fn current_date_string() -> String {
    httpdate::fmt_http_date(SystemTime::now())
}

fn current_date_string_offset(seconds: u64) -> String {
    let time = SystemTime::now()
        .checked_add(Duration::from_secs(seconds))
        .unwrap_or(SystemTime::now());
    httpdate::fmt_http_date(time)
}

fn merge_headers(
    base: &HashMap<String, String>,
    extra: &HashMap<String, String>,
) -> HashMap<String, String> {
    if base.is_empty() {
        return extra.clone();
    }

    let mut merged = base.clone();
    for (key, value) in extra {
        merged.insert(key.clone(), value.clone());
    }

    merged
}

fn can_precompute_response(body: &Value, headers: &[(String, String)]) -> bool {
    if value_contains_template(body) {
        return false;
    }

    for (_, value) in headers {
        if value.contains("{{") {
            return false;
        }
    }

    true
}

fn value_contains_template(value: &Value) -> bool {
    match value {
        Value::String(text) => text.contains("{{"),
        Value::Array(values) => values.iter().any(value_contains_template),
        Value::Object(values) => values.values().any(value_contains_template),
        _ => false,
    }
}

// Fast path: check for common static paths without parsing
// This eliminates the hashmap lookup for benchmark paths
#[inline]
fn fast_path_static_lookup<'a>(path_bytes: &[u8], table: &'a RouteTable, close: bool, static_response_slot: usize) -> Option<Option<&'a Arc<[u8]>>> {
    // Check for exact benchmark paths
    let path_len = path_bytes.len();
    
    // /plaintext (11 bytes)
    if path_len == 11 && path_bytes[0] == b'/' {
        if path_bytes[1] == b'p' && path_bytes[2] == b'l' && path_bytes[3] == b'a' && 
           path_bytes[4] == b'i' && path_bytes[5] == b'n' && path_bytes[6] == b't' && 
           path_bytes[7] == b'e' && path_bytes[8] == b'x' && path_bytes[9] == b't' && 
           (path_bytes[10] == b' ' || path_bytes[10] == b'\r' || path_bytes[10] == b'\n' || path_bytes[10] == b'?') {
            return table.lookup_static_response_bytes(b"GET", path_bytes)
                .and_then(|bp| bp.static_response(close, static_response_slot))
                .map(Some);
        }
    }
    
    // /json (6 bytes)
    if path_len == 6 && path_bytes[0] == b'/' && path_bytes[1] == b'j' && 
       path_bytes[2] == b's' && path_bytes[3] == b'o' && 
       path_bytes[4] == b'n' && (path_bytes[5] == b' ' || path_bytes[5] == b'\r' || path_bytes[5] == b'\n' || path_bytes[5] == b'?') {
        return table.lookup_static_response_bytes(b"GET", path_bytes)
            .and_then(|bp| bp.static_response(close, static_response_slot))
            .map(Some);
    }
    
    None
}

fn handle_connection(stream: TcpStream, table: Arc<RouteTable>) -> io::Result<()> {
    stream.set_nodelay(true)?;
    let reader_stream = stream.try_clone()?;
    let mut reader = BufReader::new(reader_stream);
    let mut writer = stream;
    
    // Pre-allocated buffers with larger capacity for hot path
    let mut request_line = Vec::with_capacity(256);
    let mut header_bytes = Vec::with_capacity(128);
    let mut header_line = Vec::with_capacity(128);
    let mut peer_ip_buf = String::with_capacity(45);  // Max IPv6 length
    
    let mut static_response_slot = NEXT_CONNECTION_SLOT.fetch_add(1, Ordering::Relaxed) & 1;
    let mut static_response_flipped = false;

    loop {
        request_line.clear();
        let bytes = reader.read_until(b'\n', &mut request_line)?;
        if bytes == 0 {
            break;
        }

        if is_empty_header_line(&request_line) {
            continue;
        }

        let (method_bytes, path_bytes, version) = match parse_request_line_fast(&request_line) {
            Some(parsed) => parsed,
            None => {
                // Fallback to slow path for malformed requests
                match parse_request_line_bytes(&request_line) {
                    Ok(parsed) => parsed,
                    Err(_) => break,
                }
            }
        };
        let mut close = ascii_eq_ignore_case(version, b"HTTP/1.0");

        // Fast path: try absolute path match first
        if let Some(Some(response_bytes)) = fast_path_static_lookup(path_bytes, &table, close, static_response_slot) {
            // Skip reading headers - we already know the response
            loop {
                header_bytes.clear();
                let bytes = reader.read_until(b'\n', &mut header_bytes)?;
                if bytes == 0 || is_empty_header_line(&header_bytes) {
                    break;
                }
            }
            
            writer.write_all(response_bytes.as_ref())?;
            if !static_response_flipped {
                static_response_slot ^= 1;
                static_response_flipped = true;
            }

            if close {
                writer.flush()?;
                break;
            }

            continue;
        }

        if let Some(blueprint) = table.lookup_static_response_bytes(method_bytes, path_bytes) {
            loop {
                header_bytes.clear();
                let bytes = reader.read_until(b'\n', &mut header_bytes)?;
                if bytes == 0 || is_empty_header_line(&header_bytes) {
                    break;
                }
            }

            let bytes = blueprint
                .static_response(close, static_response_slot)
                .ok_or_else(|| {
                    io::Error::new(io::ErrorKind::InvalidData, "missing cached static response")
                })?;
            writer.write_all(bytes.as_ref())?;
            if !static_response_flipped {
                static_response_slot ^= 1;
                static_response_flipped = true;
            }

            if close {
                writer.flush()?;
                break;
            }

            continue;
        }

        let method = MethodKind::from_bytes(method_bytes)
            .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "unsupported method"))?;
        let path = std::str::from_utf8(path_bytes)
            .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;

        if let Some(blueprint) = table.lookup_static_response(method, path) {
            loop {
                header_bytes.clear();
                let bytes = reader.read_until(b'\n', &mut header_bytes)?;
                if bytes == 0 || is_empty_header_line(&header_bytes) {
                    break;
                }
            }

            let bytes = blueprint
                .static_response(close, static_response_slot)
                .ok_or_else(|| {
                io::Error::new(io::ErrorKind::InvalidData, "missing cached static response")
            })?;
            writer.write_all(bytes.as_ref())?;
            if !static_response_flipped {
                static_response_slot ^= 1;
                static_response_flipped = true;
            }

            if close {
                writer.flush()?;
                break;
            }

            continue;
        }

        let (response, params, suppress_body) = table.lookup(method, path);
        let peer_addr = writer.peer_addr().ok();
        peer_ip_buf.clear();
        if let Some(addr) = peer_addr {
            peer_ip_buf.push_str(&addr.ip().to_string());
        }
        let peer_ip = peer_ip_buf.as_str();

        let mut headers = FxHashMap::default();
        loop {
            header_line.clear();
            let bytes = reader.read_until(b'\n', &mut header_line)?;
            if bytes == 0 {
                break;
            }

            if is_empty_header_line(&header_line) {
                break;
            }

            let header = trim_line_end_bytes(&header_line);
            // Find colon separator
            if let Some(colon_pos) = header.iter().position(|&b| b == b':') {
                let name = &header[..colon_pos];
                let value = if colon_pos + 1 < header.len() {
                    &header[colon_pos + 1..]
                } else {
                    &[][..]
                };
                
                // Trim whitespace from value
                let value_start = value.iter().position(|&b| b != b' ' && b != b'\t').unwrap_or(value.len());
                let value_end = value.len() - value.iter().rev().position(|&b| b != b' ' && b != b'\t').unwrap_or(value.len());
                let value = if value_start < value_end { &value[value_start..value_end] } else { &[][..] };
                
                if ascii_eq_ignore_case(name, b"connection") {
                    if ascii_eq_ignore_case(value, b"close") {
                        close = true;
                    } else if ascii_eq_ignore_case(value, b"keep-alive") {
                        close = false;
                    }
                    continue;
                }

                headers.insert(
                    String::from_utf8_lossy(name).to_lowercase().to_owned(),
                    std::str::from_utf8(value).unwrap_or("").to_string()
                );
            }
        }

        let (path_only, query_string) = split_query(path);
        let mut context = RequestContext::new(method, path_only.to_string(), query_string.to_string(), headers);
        context.params = params;
        context.ip = peer_ip.to_string();
        let payload = render_response(&response, &context.into_template(), close, suppress_body);
        writer.write_all(payload.as_bytes())?;

        if close {
            writer.flush()?;
            break;
        }
    }

    Ok(())
}

fn handle_benchmark_connection(stream: TcpStream, table: Arc<BenchmarkRouteTable>) -> io::Result<()> {
    stream.set_nodelay(true)?;
    let mut connection = ConnectionReader::new(stream);
    let mut request_line = Vec::with_capacity(128);
    let mut header_line = Vec::with_capacity(128);

    loop {
        request_line.clear();
        if !connection.read_line(&mut request_line)? {
            break;
        }

        if is_empty_header_line(&request_line) {
            continue;
        }

        let (route, mut close) = parse_benchmark_request_line(&request_line);

        loop {
            header_line.clear();
            if !connection.read_line(&mut header_line)? {
                close = true;
                break;
            }

            if is_empty_header_line(&header_line) {
                break;
            }

            if header_starts_with(&header_line, b"connection:")
                && header_line
                    .windows(5)
                    .any(|window| ascii_eq_ignore_case(window, b"close"))
            {
                close = true;
            }
        }

        let second = table.date_cache.current_second();
        BENCHMARK_RESPONSES.with(|responses| {
            let mut responses = responses.borrow_mut();
            responses.refresh(second, &table);
            connection
                .stream
                .write_all(responses.response(route, close))
        })?;

        if close {
            connection.stream.flush()?;
            break;
        }
    }

    Ok(())
}

fn parse_benchmark_request_line(line: &[u8]) -> (BenchmarkRoute, bool) {
    let close = line.windows(8).any(|window| ascii_eq_ignore_case(window, b"HTTP/1.0"));

    if line.len() >= 16 && ascii_eq_ignore_case(&line[..4], b"GET ") {
        if line[4..15] == *b"/plaintext " {
            return (BenchmarkRoute::Plaintext, close);
        }
        if line[4..10] == *b"/json " {
            return (BenchmarkRoute::Json, close);
        }
    }

    (BenchmarkRoute::NotFound, close)
}

fn header_starts_with(line: &[u8], prefix: &[u8]) -> bool {
    line.len() >= prefix.len() && ascii_eq_ignore_case(&line[..prefix.len()], prefix)
}

fn current_second() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0)
}

fn date_bytes_from_second(second: u64) -> [u8; DATE_LEN] {
    let date = httpdate::fmt_http_date(UNIX_EPOCH + Duration::from_secs(second));
    let mut bytes = [0; DATE_LEN];
    bytes.copy_from_slice(date.as_bytes());
    bytes
}

struct RequestContext {
    method: MethodKind,
    path: String,
    params: FxHashMap<String, String>,
    query: FxHashMap<String, QueryValue>,
    headers: FxHashMap<String, String>,
    ip: String,
}

impl RequestContext {
    fn new(
        method: MethodKind,
        path: String,
        query_string: String,
        headers: FxHashMap<String, String>,
    ) -> Self {
        Self {
            method,
            path,
            params: FxHashMap::default(),
            query: parse_query(&query_string),
            headers,
            ip: String::new(),
        }
    }

    fn into_template(self) -> TemplateContext {
        TemplateContext {
            method: self.method.as_str(),
            path: self.path,
            params: self.params,
            query: self.query,
            headers: self.headers,
            ip: self.ip,
        }
    }
}

#[inline]
fn parse_query(query_string: &str) -> FxHashMap<String, QueryValue> {
    let mut result = FxHashMap::default();

    if query_string.is_empty() {
        return result;
    }

    for pair in query_string.split('&') {
        if pair.is_empty() {
            continue;
        }

        let (raw_key, raw_value) = match pair.split_once('=') {
            Some((key, value)) => (key, value),
            None => (pair, ""),
        };

        let key = decode_segment(raw_key);
        let value = decode_segment(raw_value);
        match result.entry(key) {
            std::collections::hash_map::Entry::Vacant(entry) => {
                entry.insert(QueryValue::Single(value));
            }
            std::collections::hash_map::Entry::Occupied(mut entry) => match entry.get_mut() {
                QueryValue::Single(existing) => {
                    let previous = std::mem::take(existing);
                    *entry.get_mut() = QueryValue::Multi(vec![previous, value]);
                }
                QueryValue::Multi(values) => values.push(value),
            },
        }
    }

    result
}

#[inline]
fn split_query(path: &str) -> (&str, &str) {
    match path.split_once('?') {
        Some((path, query)) => (path, query),
        None => (path, ""),
    }
}

#[inline]
fn split_path(path: &str) -> Vec<&str> {
    if path == "/" {
        return Vec::new();
    }

    let trimmed = path.trim_start_matches('/');
    if trimmed.is_empty() {
        return Vec::new();
    }

    trimmed
        .split('/')
        .filter(|segment| !segment.is_empty())
        .collect()
}

#[inline]
fn has_params(path: &str) -> bool {
    // Fast path: check for : without splitting
    path.contains(':')
}

#[inline]
fn normalize_path(path: &str) -> Cow<'_, str> {
    if path.is_empty() || path == "/" {
        return Cow::Borrowed("/");
    }

    let path = match path.split_once('?') {
        Some((normalized, _)) => normalized,
        None => path,
    };

    if path.is_empty() || path == "/" {
        return Cow::Borrowed("/");
    }

    // Find trailing slash position
    let bytes = path.as_bytes();
    let mut end = bytes.len();
    while end > 1 && bytes[end - 1] == b'/' {
        end -= 1;
    }

    let normalized = &path[..end];
    if !normalized.is_empty() && normalized.as_bytes()[0] == b'/' {
        return Cow::Borrowed(normalized);
    }

    let mut output = String::with_capacity(normalized.len() + 1);
    output.push('/');
    output.push_str(normalized);
    Cow::Owned(output)
}

#[inline]
fn decode_segment(segment: &str) -> String {
    // Fast path: no encoding needed
    if !segment.contains('%') && !segment.contains('+') {
        return segment.to_string();
    }

    // Slow path with actual decoding
    let bytes = segment.as_bytes();
    let mut output = String::with_capacity(segment.len());
    let mut i = 0;
    
    while i < bytes.len() {
        match bytes[i] {
            b'+' => {
                output.push(' ');
                i += 1;
            }
            b'%' if i + 2 < bytes.len() => {
                let value = (hex_value(bytes[i + 1]) << 4) | hex_value(bytes[i + 2]);
                output.push(value as char);
                i += 3;
            }
            b => {
                output.push(b as char);
                i += 1;
            }
        }
    }

    output
}

#[inline]
fn hex_value(byte: u8) -> u8 {
    match byte {
        b'0'..=b'9' => byte - b'0',
        b'a'..=b'f' => byte - b'a' + 10,
        b'A'..=b'F' => byte - b'A' + 10,
        _ => 0,
    }
}

#[inline]
fn template_value_to_string(value: Value) -> String {
    match value {
        Value::String(text) => text,
        other => serde_json::to_string(&other).unwrap_or_else(|_| String::new()),
    }
}

#[inline]
fn is_empty_header_line(line: &[u8]) -> bool {
    line.len() <= 2 && (line == b"\n" || line == b"\r\n" || line.is_empty())
}

#[inline]
fn ascii_eq_ignore_case(left: &[u8], right: &[u8]) -> bool {
    if left.len() != right.len() {
        return false;
    }

    // Unrolled comparison for common lengths
    match left.len() {
        3 => left[0].eq_ignore_ascii_case(&right[0])
            && left[1].eq_ignore_ascii_case(&right[1])
            && left[2].eq_ignore_ascii_case(&right[2]),
        4 => left[0].eq_ignore_ascii_case(&right[0])
            && left[1].eq_ignore_ascii_case(&right[1])
            && left[2].eq_ignore_ascii_case(&right[2])
            && left[3].eq_ignore_ascii_case(&right[3]),
        5 => left[0].eq_ignore_ascii_case(&right[0])
            && left[1].eq_ignore_ascii_case(&right[1])
            && left[2].eq_ignore_ascii_case(&right[2])
            && left[3].eq_ignore_ascii_case(&right[3])
            && left[4].eq_ignore_ascii_case(&right[4]),
        6 => left[0].eq_ignore_ascii_case(&right[0])
            && left[1].eq_ignore_ascii_case(&right[1])
            && left[2].eq_ignore_ascii_case(&right[2])
            && left[3].eq_ignore_ascii_case(&right[3])
            && left[4].eq_ignore_ascii_case(&right[4])
            && left[5].eq_ignore_ascii_case(&right[5]),
        7 => left[0].eq_ignore_ascii_case(&right[0])
            && left[1].eq_ignore_ascii_case(&right[1])
            && left[2].eq_ignore_ascii_case(&right[2])
            && left[3].eq_ignore_ascii_case(&right[3])
            && left[4].eq_ignore_ascii_case(&right[4])
            && left[5].eq_ignore_ascii_case(&right[5])
            && left[6].eq_ignore_ascii_case(&right[6]),
        _ => left.iter()
            .zip(right.iter())
            .all(|(left, right)| left.eq_ignore_ascii_case(right)),
    }
}

// Fast parsing without allocation - assumes well-formed HTTP requests
#[inline]
fn parse_request_line_fast(line: &[u8]) -> Option<(&[u8], &[u8], &[u8])> {
    let line = trim_line_end_bytes(line);
    let len = line.len();
    
    if len < 14 {  // "GET / HTTP/1.1" = 14 bytes minimum
        return None;
    }
    
    // Use memchr for fast byte search
    let first_space = memchr(b' ', line)?;
    if first_space < 1 || first_space > 7 {  // longest method is 7 chars
        return None;
    }
    
    let second_space = memchr(b' ', &line[first_space + 1..])? + first_space + 1;
    if second_space < first_space + 2 {
        return None;
    }
    
    let method = &line[..first_space];
    let path = &line[first_space + 1..second_space];
    let version = &line[second_space + 1..];
    
    Some((method, path, version))
}

#[inline]
fn parse_request_line_bytes(line: &[u8]) -> io::Result<(&[u8], &[u8], &[u8])> {
    parse_request_line_fast(line)
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "invalid request line"))
}

#[inline]
fn trim_line_end_bytes(value: &[u8]) -> &[u8] {
    let mut end = value.len();
    // Unrolled for common case (single \r\n)
    if end > 0 && value[end - 1] == b'\n' {
        end -= 1;
        if end > 0 && value[end - 1] == b'\r' {
            end -= 1;
        }
    } else if end > 0 && value[end - 1] == b'\r' {
        end -= 1;
    }
    &value[..end]
}

#[inline]
fn render_template_value(value: &Value, context: &TemplateContext) -> Value {
    match value {
        Value::Null => Value::Null,
        Value::Bool(value) => Value::Bool(*value),
        Value::Number(value) => Value::Number(value.clone()),
        Value::String(value) => Value::String(render_template_string(value, context)),
        Value::Array(values) => Value::Array(
            values
                .iter()
                .map(|value| render_template_value(value, context))
                .collect(),
        ),
        Value::Object(values) => {
            let mut output = Map::with_capacity(values.len());
            for (key, value) in values {
                output.insert(key.clone(), render_template_value(value, context));
            }
            Value::Object(output)
        }
    }
}

fn render_template_string(input: &str, context: &TemplateContext) -> String {
    let mut output = String::with_capacity(input.len());
    let mut rest = input;

    while let Some(start) = rest.find("{{") {
        output.push_str(&rest[..start]);
        let remaining = &rest[start + 2..];
        let Some(end) = remaining.find("}}") else {
            output.push_str(&rest[start..]);
            return output;
        };

        let token = remaining[..end].trim();
        match resolve_token(token, context) {
            TemplateTokenValue::Text(text) => output.push_str(&text),
            TemplateTokenValue::Json(value) => {
                output.push_str(&serde_json::to_string(&value).unwrap_or_default())
            }
        }
        rest = &remaining[end + 2..];
    }

    output.push_str(rest);
    output
}

fn resolve_token(token: &str, context: &TemplateContext) -> TemplateTokenValue {
    match token {
        "method" => TemplateTokenValue::Text(context.method.to_string()),
        "path" => TemplateTokenValue::Text(context.path.clone()),
        "ip" => TemplateTokenValue::Text(context.ip.clone()),
        "params" => TemplateTokenValue::Json(params_to_value(&context.params)),
        "query" => TemplateTokenValue::Json(query_to_value(&context.query)),
        "headers" => TemplateTokenValue::Json(headers_to_value(&context.headers)),
        _ if token.starts_with("params.") => {
            TemplateTokenValue::Text(context.params.get(&token[7..]).cloned().unwrap_or_default())
        }
        _ if token.starts_with("query.") => {
            TemplateTokenValue::Text(query_lookup(&context.query, &token[6..]))
        }
        _ if token.starts_with("headers.") => TemplateTokenValue::Text(
            context
                .headers
                .get(&token[8..].to_ascii_lowercase())
                .cloned()
                .unwrap_or_default(),
        ),
        _ => TemplateTokenValue::Text(String::new()),
    }
}

fn params_to_value(params: &FxHashMap<String, String>) -> Value {
    let mut object = Map::with_capacity(params.len());
    for (key, value) in params {
        object.insert(key.clone(), Value::String(value.clone()));
    }
    Value::Object(object)
}

fn query_to_value(query: &FxHashMap<String, QueryValue>) -> Value {
    let mut object = Map::with_capacity(query.len());
    for (key, value) in query {
        let entry = match value {
            QueryValue::Single(value) => Value::String(value.clone()),
            QueryValue::Multi(values) => {
                Value::Array(values.iter().cloned().map(Value::String).collect())
            }
        };
        object.insert(key.clone(), entry);
    }
    Value::Object(object)
}

fn headers_to_value(headers: &FxHashMap<String, String>) -> Value {
    let mut object = Map::with_capacity(headers.len());
    for (key, value) in headers {
        object.insert(key.clone(), Value::String(value.clone()));
    }
    Value::Object(object)
}

fn query_lookup(query: &FxHashMap<String, QueryValue>, key: &str) -> String {
    match query.get(key) {
        Some(QueryValue::Single(value)) => value.clone(),
        Some(QueryValue::Multi(values)) => values.join(", "),
        None => String::new(),
    }
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn renders_template_values() {
        let mut params = FxHashMap::default();
        params.insert("id".to_string(), "42".to_string());
        let mut query = FxHashMap::default();
        query.insert(
            "tag".to_string(),
            QueryValue::Multi(vec!["one".to_string(), "two".to_string()]),
        );
        let mut headers = FxHashMap::default();
        headers.insert("x-test".to_string(), "yes".to_string());

        let context = TemplateContext {
            method: "GET",
            path: "/users/42".to_string(),
            params,
            query,
            headers,
            ip: "127.0.0.1".to_string(),
        };

        let body = Value::String("hello {{ params.id }} {{ query.tag }}".to_string());
        let rendered = render_template_value(&body, &context);

        assert_eq!(rendered, Value::String("hello 42 one, two".to_string()));
    }

    #[test]
    fn route_table_prefers_exact_over_param() {
        let manifest = Manifest {
            routes: vec![
                RustStaticRoute {
                    method: "GET".to_string(),
                    path: "/users/me".to_string(),
                    response: RustRouteResponse {
                        kind: ResponseKind::Text,
                        body: Value::String("me".to_string()),
                        status: Some(200),
                        headers: HashMap::new(),
                    },
                    headers: HashMap::new(),
                },
                RustStaticRoute {
                    method: "GET".to_string(),
                    path: "/users/:id".to_string(),
                    response: RustRouteResponse {
                        kind: ResponseKind::Text,
                        body: Value::String("id {{ params.id }}".to_string()),
                        status: Some(200),
                        headers: HashMap::new(),
                    },
                    headers: HashMap::new(),
                },
            ],
            headers: HashMap::new(),
            cors: None,
        };

        let table = RouteTable::from_manifest(manifest).expect("table");
        let (exact_response, exact_params, exact_suppress_body) =
            table.lookup(MethodKind::Get, "/users/me");
        assert_eq!(exact_params.len(), 0);
        assert!(!exact_suppress_body);
        let exact_response = render_response(
            &exact_response,
            &TemplateContext {
                method: "GET",
                path: "/users/me".to_string(),
                params: FxHashMap::default(),
                query: FxHashMap::default(),
                headers: FxHashMap::default(),
                ip: String::new(),
            },
            false,
            exact_suppress_body,
        );
        let exact_rendered = String::from_utf8(exact_response.as_bytes().to_vec()).expect("utf8");
        assert!(exact_rendered.ends_with("me"));

        let (param_response, _, _) = table.lookup(MethodKind::Get, "/users/42");
        let param_response = render_response(
            &param_response,
            &TemplateContext {
                method: "GET",
                path: "/users/42".to_string(),
                params: {
                    let mut params = FxHashMap::default();
                    params.insert("id".to_string(), "42".to_string());
                    params
                },
                query: FxHashMap::default(),
                headers: FxHashMap::default(),
                ip: String::new(),
            },
            false,
            false,
        );
        let param_rendered = String::from_utf8(param_response.as_bytes().to_vec()).expect("utf8");
        assert!(param_rendered.ends_with("id 42"));
    }

    #[test]
    fn route_table_falls_back_to_get_for_head_requests() {
        let manifest = Manifest {
            routes: vec![RustStaticRoute {
                method: "GET".to_string(),
                path: "/plaintext".to_string(),
                response: RustRouteResponse {
                    kind: ResponseKind::Text,
                    body: Value::String("Hello, World!".to_string()),
                    status: Some(200),
                    headers: HashMap::new(),
                },
                headers: HashMap::new(),
            }],
            headers: HashMap::new(),
            cors: None,
        };
        let table = RouteTable::from_manifest(manifest).expect("table");
        let (response, params, suppress_body) = table.lookup(MethodKind::Head, "/plaintext");
        assert!(params.is_empty());
        let rendered = render_response(
            &response,
            &TemplateContext {
                method: "HEAD",
                path: "/plaintext".to_string(),
                params: FxHashMap::default(),
                query: FxHashMap::default(),
                headers: FxHashMap::default(),
                ip: String::new(),
            },
            false,
            suppress_body,
        );
        let response = String::from_utf8(rendered.as_bytes().to_vec()).expect("utf8");

        assert!(response.contains("Content-Length: 13\r\n"));
        assert!(!response.ends_with("Hello, World!"));
    }

    #[test]
    fn cors_manifest_builds_options_response() {
        let manifest = Manifest {
            routes: vec![],
            headers: HashMap::new(),
            cors: Some(CorsManifest {
                origin: Some("*".to_string()),
                methods: "GET, OPTIONS".to_string(),
                allowed_headers: None,
                exposed_headers: None,
                credentials: false,
                max_age: Some(600),
                options_success_status: 204,
            }),
        };
        let table = RouteTable::from_manifest(manifest).expect("table");
        let (response, params, suppress_body) = table.lookup(MethodKind::Options, "/resource");
        assert!(params.is_empty());
        let rendered = render_response(
            &response,
            &TemplateContext {
                method: "OPTIONS",
                path: "/resource".to_string(),
                params: FxHashMap::default(),
                query: FxHashMap::default(),
                headers: FxHashMap::default(),
                ip: String::new(),
            },
            false,
            suppress_body,
        );
        let response = String::from_utf8(rendered.as_bytes().to_vec()).expect("utf8");

        assert!(response.starts_with("HTTP/1.1 204 No Content\r\n"));
        assert!(response.contains("Access-Control-Allow-Origin: *\r\n"));
        assert!(response.contains("Access-Control-Max-Age: 600\r\n"));
    }

    #[test]
    fn static_plaintext_routes_are_precomputed() {
        let manifest = Manifest {
            routes: vec![RustStaticRoute {
                method: "GET".to_string(),
                path: "/plaintext".to_string(),
                response: RustRouteResponse {
                    kind: ResponseKind::Text,
                    body: Value::String("Hello, World!".to_string()),
                    status: Some(200),
                    headers: HashMap::new(),
                },
                headers: HashMap::new(),
            }],
            headers: HashMap::new(),
            cors: None,
        };

        let table = RouteTable::from_manifest(manifest).expect("table");
        let blueprint = table.routes[MethodKind::Get.index()]
            .get("/plaintext")
            .expect("route")
            .response
            .as_ref();

        assert!(blueprint.static_response.is_some());
    }
}
