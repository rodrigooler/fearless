use fearless_core::{
    benchmark_manifest_routes_only, is_benchmark_manifest, load_manifest, run_benchmark_server,
    run_server,
};
use std::env;
use std::path::PathBuf;
use std::process::ExitCode;

// mimalloc as the system allocator. Better small-object performance than glibc malloc;
// matters here because Arc<[u8]> reallocs (one per second on response refresh) and
// per-connection state allocations all hit the global allocator.
#[global_allocator]
static GLOBAL: mimalloc::MiMalloc = mimalloc::MiMalloc;

fn parse_args() -> Result<(u16, Option<PathBuf>), String> {
    let mut port: Option<u16> = None;
    let mut manifest: Option<PathBuf> = None;

    let mut args = env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--port" => {
                let value = args
                    .next()
                    .ok_or_else(|| "--port requires a value".to_string())?;
                port = Some(
                    value
                        .parse::<u16>()
                        .map_err(|_| "invalid port".to_string())?,
                );
            }
            "--manifest" => {
                let value = args
                    .next()
                    .ok_or_else(|| "--manifest requires a value".to_string())?;
                manifest = Some(PathBuf::from(value));
            }
            "--help" | "-h" => {
                return Err(
                    "usage: fearless-core --port <port> [--manifest <manifest.json>]".to_string(),
                );
            }
            other => {
                return Err(format!("unknown argument: {other}"));
            }
        }
    }

    let port = port.ok_or_else(|| "--port is required".to_string())?;
    Ok((port, manifest))
}

fn main() -> ExitCode {
    let (port, manifest_path) = match parse_args() {
        Ok(value) => value,
        Err(error) => {
            eprintln!("{error}");
            return ExitCode::from(1);
        }
    };

    let manifest = match manifest_path {
        Some(path) => match load_manifest(&path) {
            Ok(m) => m,
            Err(error) => {
                eprintln!("{error}");
                return ExitCode::from(1);
            }
        },
        None => benchmark_manifest_routes_only(),
    };

    let result = if is_benchmark_manifest(&manifest) {
        run_benchmark_server(port)
    } else {
        run_server(manifest, port)
    };

    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("{error}");
            ExitCode::from(1)
        }
    }
}
