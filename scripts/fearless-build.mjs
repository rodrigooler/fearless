#!/usr/bin/env node
/**
 * `fearless build` — orchestrates the AOT pipeline.
 *
 * Usage:
 *   node scripts/fearless-build.mjs <app-source.ts> [--no-cargo] [--rust-core <dir>]
 *
 * Steps:
 *   1. Read user app source.
 *   2. Run @fearless/aot-build to discover routes + transpile AOT-eligible handlers.
 *   3. Write `rust-core/src/aot/handlers.rs` (overwriting the placeholder).
 *   4. Write `rust-core/src/aot/dispatch_manifest.json` (gitignored — diagnostic only).
 *   5. Run `cargo build --release --features io-uring,aot-handlers` (skip with --no-cargo).
 *   6. Print a build report.
 *
 * After this, run the binary:
 *   ./rust-core/target/release/fearless-core --port 8080
 * AOT routes are dispatched in Rust; everything else falls back to baked 404
 * (Bun fallback runtime is a separate sprint — see Step 5 of integration plan).
 */
import { readFileSync, writeFileSync, existsSync, copyFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { compileApp, formatBuildReport } from "@fearless/aot-build";

function parseArgs(argv) {
  const args = { input: null, runCargo: true, rustCore: "rust-core" };
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--no-cargo") {
      args.runCargo = false;
    } else if (arg === "--rust-core") {
      args.rustCore = argv[++i];
    } else if (!args.input) {
      args.input = arg;
    }
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv);
  if (args.input == null) {
    console.error("usage: fearless-build <app-source.ts> [--no-cargo] [--rust-core <dir>]");
    process.exit(1);
  }

  const inputPath = resolve(args.input);
  if (!existsSync(inputPath)) {
    console.error(`error: input file not found: ${inputPath}`);
    process.exit(1);
  }

  const source = readFileSync(inputPath, "utf8");
  const result = compileApp({ source, fileName: inputPath });

  const aotDir = resolve(args.rustCore, "src/aot");
  if (!existsSync(aotDir)) {
    console.error(`error: rust-core/src/aot not found at ${aotDir}`);
    console.error("(did you forget --rust-core <path>?)");
    process.exit(1);
  }

  const handlersPath = resolve(aotDir, "handlers.rs");
  const manifestPath = resolve(aotDir, "dispatch_manifest.json");
  const registryInitPath = resolve(aotDir, "registry_init.rs");

  if (result.summary.aot === 0) {
    // Restore the placeholder handlers.rs so the aot-handlers feature still
    // compiles cleanly with no user routes. Empty mod.
    writeFileSync(
      handlersPath,
      "//! Placeholder — `fearless build` did not find any AOT-eligible handlers.\n" +
        "//! When you add an inline arrow handler that passes the analyzer, this file\n" +
        "//! will contain real generated functions.\n\n" +
        "#[allow(unused_imports)]\nuse crate::aot::runtime;\n\n" +
        "/// Empty register — no routes to add.\n" +
        "pub fn register(_table: &mut crate::aot::AotRouteTable) {}\n"
    );
  } else {
    writeFileSync(handlersPath, result.rustSource);
  }
  writeFileSync(manifestPath, JSON.stringify(result.dispatchManifest, null, 2));

  // The `registry_init` module is gated behind `pg-handles + aot-handlers` in
  // mod.rs. When the build produces async SQL handlers, write the generated
  // STATEMENTS map + register_handles() body. Otherwise emit a placeholder so
  // the gated module still compiles cleanly when the features are turned on
  // (no statements, empty registry).
  if (result.registryRustSource && result.registryRustSource.length > 0) {
    writeFileSync(registryInitPath, result.registryRustSource);
  } else {
    writeFileSync(
      registryInitPath,
      "// Placeholder — `fearless build` did not find any AOT-eligible async SQL handlers.\n" +
        "#![cfg(all(feature = \"pg-handles\", feature = \"aot-handlers\"))]\n\n" +
        "use std::sync::Arc;\n" +
        "use deadpool_postgres::Pool;\n\n" +
        "pub static STATEMENTS: phf::Map<&'static str, &'static str> = phf::phf_map! {};\n\n" +
        "pub fn register_handles(_pool: Arc<Pool>) -> crate::aot::handles::HandleRegistry {\n" +
        "    crate::aot::handles::HandleRegistry::new()\n" +
        "}\n"
    );
  }

  console.log(formatBuildReport(result));
  console.log("");
  console.log(`Wrote: ${handlersPath}`);
  console.log(`Wrote: ${manifestPath}`);
  console.log(`Wrote: ${registryInitPath}`);

  if (!args.runCargo) {
    console.log("\nSkipped cargo build (--no-cargo).");
    return;
  }

  if (result.summary.aot === 0) {
    console.log("\nNo AOT routes — skipping cargo build.");
    return;
  }

  console.log("\nRunning cargo build with --features io-uring,aot-handlers ...");
  const cargoResult = spawnSync(
    "cargo",
    [
      "build",
      "--release",
      "--features",
      "io-uring,aot-handlers",
      "--manifest-path",
      `${args.rustCore}/Cargo.toml`,
    ],
    { stdio: "inherit" }
  );

  if (cargoResult.status !== 0) {
    console.error(`\ncargo build failed with status ${cargoResult.status}`);
    process.exit(cargoResult.status ?? 1);
  }

  console.log("\nBuild complete. Binary at:");
  console.log(`  ${resolve(args.rustCore, "target/release/fearless-core")}`);
}

main();
