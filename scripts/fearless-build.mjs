#!/usr/bin/env node
/**
 * `fearless build` — orchestrates the AOT pipeline.
 *
 * Usage:
 *   node scripts/fearless-build.mjs <app-source.ts> [--out-dir rust-core/src/aot]
 *
 * Steps:
 *   1. Read user app source.
 *   2. Run @fearless/aot-build to discover routes + transpile AOT-eligible handlers.
 *   3. Write `aot_handlers.rs` to the output directory.
 *   4. Write `dispatch_manifest.json` describing which routes go where.
 *   5. Print a build report (per-route AOT/Bun/template breakdown).
 *
 * The output is consumed by:
 *   - `rust-core` build: `aot_handlers.rs` is included in the binary.
 *   - `rust-core` runtime: `dispatch_manifest.json` tells the dispatcher which
 *     route hits Rust vs forwards to Bun.
 *   - The Bun-side fallback runtime: which routes it must serve.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { compileApp, formatBuildReport } from "@fearless/aot-build";

function parseArgs(argv) {
  const args = { input: null, outDir: "rust-core/src/aot" };
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--out-dir") {
      args.outDir = argv[++i];
    } else if (!args.input) {
      args.input = arg;
    }
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv);
  if (args.input == null) {
    console.error("usage: fearless-build <app-source.ts> [--out-dir <dir>]");
    process.exit(1);
  }

  const inputPath = resolve(args.input);
  if (!existsSync(inputPath)) {
    console.error(`error: input file not found: ${inputPath}`);
    process.exit(1);
  }

  const source = readFileSync(inputPath, "utf8");
  const result = compileApp({ source, fileName: inputPath });

  const outDir = resolve(args.outDir);
  mkdirSync(outDir, { recursive: true });

  const rustPath = resolve(outDir, "aot_handlers.rs");
  writeFileSync(rustPath, result.rustSource);

  const manifestPath = resolve(outDir, "dispatch_manifest.json");
  writeFileSync(manifestPath, JSON.stringify(result.dispatchManifest, null, 2));

  console.log(formatBuildReport(result));
  console.log("");
  console.log(`Wrote: ${rustPath}`);
  console.log(`Wrote: ${manifestPath}`);

  if (result.summary.aot === 0) {
    console.log("\nNo AOT-eligible handlers — rust-core will be built without an aot_handlers.rs body.");
  } else {
    console.log(
      `\nNext: rebuild rust-core (\`cargo build --release --manifest-path rust-core/Cargo.toml --features io-uring\`).`
    );
  }
}

main();
