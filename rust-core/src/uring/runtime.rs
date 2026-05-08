use crate::benchmark::responses::BenchmarkServer;
use core_affinity::CoreId;
use io_uring::IoUring;
use std::io;
use std::net::TcpListener;
use std::os::fd::{IntoRawFd, RawFd};
use std::sync::Arc;
use std::thread;

pub(crate) const RING_ENTRIES: u32 = 4096;

pub fn run(port: u16, worker_count: usize) -> io::Result<()> {
    let cores = core_affinity::get_core_ids().unwrap_or_default();
    let server = Arc::new(BenchmarkServer::new());

    let mut handles = Vec::with_capacity(worker_count);
    for i in 0..worker_count {
        let listener = build_reuseport_listener(port)?;
        let core = cores.get(i % cores.len().max(1)).copied();
        let server = Arc::clone(&server);
        handles.push(
            thread::Builder::new()
                .name(format!("fearless-uring-{i}"))
                .spawn(move || worker_main(listener, server, core))
                .expect("spawn worker"),
        );
    }
    for h in handles {
        let _ = h.join();
    }
    Ok(())
}

fn worker_main(listener: TcpListener, server: Arc<BenchmarkServer>, core: Option<CoreId>) {
    if let Some(c) = core {
        let _ = core_affinity::set_for_current(c);
    }
    let listener_fd: RawFd = listener.into_raw_fd();
    let mut ring = build_ring().expect("build ring");
    ring.submitter()
        .register_files(&[listener_fd])
        .expect("register listener fd");
    let buffers = crate::uring::buffers::FixedBuffers::register(&mut ring).expect("register buffers");
    crate::uring::accept::run_loop(&mut ring, 0 /* fixed slot */, server, buffers).expect("worker loop");
}

fn build_ring() -> io::Result<IoUring> {
    let mut builder = IoUring::builder();
    builder
        .setup_coop_taskrun()
        .setup_single_issuer()
        .setup_defer_taskrun();
    let sqpoll_ms: u32 = std::env::var("FEARLESS_SQPOLL_MS")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(0);
    if sqpoll_ms > 0 {
        builder.setup_sqpoll(sqpoll_ms);
    }
    builder.build(RING_ENTRIES)
}

fn build_reuseport_listener(port: u16) -> io::Result<TcpListener> {
    use socket2::{Domain, Protocol, Socket, Type};
    let socket = Socket::new(Domain::IPV4, Type::STREAM, Some(Protocol::TCP))?;
    socket.set_reuse_address(true)?;
    socket.set_reuse_port(true)?;
    socket.set_nodelay(true)?;
    socket.set_recv_buffer_size(1 << 20)?;
    socket.set_send_buffer_size(1 << 20)?;
    socket.bind(&socket2::SockAddr::from(std::net::SocketAddr::from((
        [0, 0, 0, 0],
        port,
    ))))?;
    socket.listen(8192)?;
    Ok(socket.into())
}
