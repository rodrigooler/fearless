use fearless_core::{load_manifest, run_server, CorsManifest, Manifest, ResponseKind, RustRouteResponse, RustStaticRoute};
use serde_json::json;
use std::env;
use std::collections::HashMap;
use std::path::PathBuf;
use std::process::ExitCode;

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
            Ok(manifest) => manifest,
            Err(error) => {
                eprintln!("{error}");
                return ExitCode::from(1);
            }
        },
        None => benchmark_manifest(),
    };

    match run_server(manifest, port) {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("{error}");
            ExitCode::from(1)
        }
    }
}

fn benchmark_manifest() -> Manifest {
    Manifest {
        routes: vec![
            RustStaticRoute {
                method: "GET".to_string(),
                path: "/plaintext".to_string(),
                response: RustRouteResponse {
                    kind: ResponseKind::Text,
                    body: json!("Hello, World!"),
                    status: Some(200),
                    headers: HashMap::new(),
                },
                headers: HashMap::new(),
            },
            RustStaticRoute {
                method: "GET".to_string(),
                path: "/json".to_string(),
                response: RustRouteResponse {
                    kind: ResponseKind::Json,
                    body: json!({ "message": "Hello, World!" }),
                    status: Some(200),
                    headers: HashMap::new(),
                },
                headers: HashMap::new(),
            },
        ],
        headers: HashMap::new(),
        cors: Some(CorsManifest {
            origin: Some("*".to_string()),
            methods: "GET,HEAD,PUT,PATCH,POST,DELETE".to_string(),
            allowed_headers: Some("*".to_string()),
            exposed_headers: None,
            credentials: false,
            max_age: Some(600),
            options_success_status: 204,
        }),
    }
}
