use crate::benchmark::responses::BenchmarkServer;
use core_affinity::CoreId;
use io_uring::IoUring;
use std::io;
use std::net::TcpListener;
use std::os::fd::{AsRawFd, IntoRawFd, RawFd};
use std::sync::Arc;
use std::thread;

pub(crate) const RING_ENTRIES: u32 = 4096;

pub fn run(port: u16, worker_count: usize) -> io::Result<()> {
    let cores = core_affinity::get_core_ids().unwrap_or_default();
    let server = Arc::new(BenchmarkServer::new());

    let mut handles = Vec::with_capacity(worker_count);
    for i in 0..worker_count {
        let core = cores.get(i % cores.len().max(1)).copied();
        let cpu_id = core.map(|c| c.id);
        // First listener in the REUSEPORT group carries the CBPF program that pins
        // accepted connections to the worker matching the SYN's CPU. The kernel
        // propagates the program to the rest of the group automatically.
        let attach_cbpf = i == 0;
        let listener = build_reuseport_listener(port, cpu_id, attach_cbpf, worker_count)?;
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
    let sqpoll_ms: u32 = std::env::var("FEARLESS_SQPOLL_MS")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(0);

    let mut builder = IoUring::builder();

    if sqpoll_ms > 0 {
        // SQPOLL spawns a kernel-side submitter thread, which conflicts with several
        // tuning flags that assume userspace controls SQE submission timing.
        // We use ONLY setup_sqpoll when it's enabled — no other setup_* flags.
        builder.setup_sqpoll(sqpoll_ms);
    } else {
        // Without SQPOLL, lean on the modern userspace-driven completion path.
        builder.setup_coop_taskrun().setup_single_issuer().setup_defer_taskrun();
    }

    builder.build(RING_ENTRIES)
}

fn build_reuseport_listener(
    port: u16,
    cpu_id: Option<usize>,
    attach_cbpf: bool,
    nworkers: usize,
) -> io::Result<TcpListener> {
    use socket2::{Domain, Protocol, Socket, Type};
    let socket = Socket::new(Domain::IPV4, Type::STREAM, Some(Protocol::TCP))?;
    socket.set_reuse_address(true)?;
    socket.set_reuse_port(true)?;
    socket.set_nodelay(true)?;
    socket.set_recv_buffer_size(1 << 20)?;
    socket.set_send_buffer_size(1 << 20)?;

    // SO_INCOMING_CPU: hint to the kernel that this socket prefers connections
    // arriving on this CPU. With SO_REUSEPORT, the kernel uses this hint to spread
    // accepts across the group. Best-effort — if libc rejects (older kernel), keep going.
    if let Some(cpu) = cpu_id {
        let cpu_val: libc::c_int = cpu as libc::c_int;
        let result = unsafe {
            libc::setsockopt(
                socket.as_raw_fd(),
                libc::SOL_SOCKET,
                libc::SO_INCOMING_CPU,
                &cpu_val as *const _ as *const libc::c_void,
                std::mem::size_of::<libc::c_int>() as libc::socklen_t,
            )
        };
        if result != 0 {
            // Non-fatal; some environments forbid this. Worker still works without it.
            eprintln!(
                "warn: SO_INCOMING_CPU setsockopt failed for cpu {}: {}",
                cpu,
                io::Error::last_os_error()
            );
        }
    }

    socket.bind(&socket2::SockAddr::from(std::net::SocketAddr::from((
        [0, 0, 0, 0],
        port,
    ))))?;
    socket.listen(8192)?;

    // Attach a CBPF program to the REUSEPORT group ONCE (kernel propagates it).
    // The program: load incoming CPU, modulo nworkers, return as socket index.
    // Effect: connection from CPU N goes to socket index (N % nworkers) in the group.
    if attach_cbpf {
        if let Err(error) = attach_reuseport_cbpf(socket.as_raw_fd(), nworkers) {
            eprintln!("warn: SO_ATTACH_REUSEPORT_CBPF failed: {error}");
        }
    }

    Ok(socket.into())
}

/// Attach a Classic BPF program to a SO_REUSEPORT group socket that selects the
/// destination socket by current-CPU mod nworkers.
///
/// The program is 3 instructions: load CPU, A = A mod nworkers, return A.
fn attach_reuseport_cbpf(fd: RawFd, nworkers: usize) -> io::Result<()> {
    // BPF instruction encoding (linux/bpf_common.h)
    const BPF_LD: u16 = 0x00;
    const BPF_W: u16 = 0x00;
    const BPF_ABS: u16 = 0x20;
    const BPF_ALU: u16 = 0x04;
    const BPF_MOD: u16 = 0x90;
    const BPF_K: u16 = 0x00;
    const BPF_RET: u16 = 0x06;
    const BPF_A: u16 = 0x10;

    // SKF accessors (linux/filter.h): negative offsets read pseudo-fields.
    // SKF_AD_OFF is sign-extended u32 = 0xFFFF_F000 (-4096 signed).
    const SKF_AD_OFF: u32 = 0xFFFF_F000;
    const SKF_AD_CPU: u32 = 36;

    #[repr(C)]
    #[derive(Copy, Clone)]
    struct SockFilter {
        code: u16,
        jt: u8,
        jf: u8,
        k: u32,
    }

    #[repr(C)]
    struct SockFprog {
        len: u16,
        filter: *const SockFilter,
    }

    let nworkers_u32: u32 = nworkers.try_into().unwrap_or(u32::MAX);

    let prog: [SockFilter; 3] = [
        // ld word [skf_ad_cpu]   ; A = current CPU
        SockFilter {
            code: BPF_LD | BPF_W | BPF_ABS,
            jt: 0,
            jf: 0,
            k: SKF_AD_OFF + SKF_AD_CPU,
        },
        // mod immediate, nworkers ; A = A % nworkers
        SockFilter {
            code: BPF_ALU | BPF_MOD | BPF_K,
            jt: 0,
            jf: 0,
            k: nworkers_u32,
        },
        // ret a                   ; return A as socket index in REUSEPORT group
        SockFilter {
            code: BPF_RET | BPF_A,
            jt: 0,
            jf: 0,
            k: 0,
        },
    ];

    let fprog = SockFprog {
        len: prog.len() as u16,
        filter: prog.as_ptr(),
    };

    let result = unsafe {
        libc::setsockopt(
            fd,
            libc::SOL_SOCKET,
            libc::SO_ATTACH_REUSEPORT_CBPF,
            &fprog as *const _ as *const libc::c_void,
            std::mem::size_of::<SockFprog>() as libc::socklen_t,
        )
    };
    if result == 0 {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}
