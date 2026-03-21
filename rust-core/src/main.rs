use fearless_core::{load_manifest, run_server};
use std::env;
use std::path::PathBuf;
use std::process::ExitCode;

fn parse_args() -> Result<(u16, PathBuf), String> {
    let mut port: Option<u16> = None;
    let mut manifest: Option<PathBuf> = None;

    let mut args = env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--port" => {
                let value = args
                    .next()
                    .ok_or_else(|| "--port requires a value".to_string())?;
                port = Some(value.parse::<u16>().map_err(|_| "invalid port".to_string())?);
            }
            "--manifest" => {
                let value = args
                    .next()
                    .ok_or_else(|| "--manifest requires a value".to_string())?;
                manifest = Some(PathBuf::from(value));
            }
            "--help" | "-h" => {
                return Err(
                    "usage: fearless-core --port <port> --manifest <manifest.json>".to_string(),
                );
            }
            other => {
                return Err(format!("unknown argument: {other}"));
            }
        }
    }

    let port = port.ok_or_else(|| "--port is required".to_string())?;
    let manifest = manifest.ok_or_else(|| "--manifest is required".to_string())?;
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

    match load_manifest(&manifest_path).and_then(|manifest| run_server(manifest, port)) {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("{error}");
            ExitCode::from(1)
        }
    }
}
