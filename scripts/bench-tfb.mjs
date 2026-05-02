import { cpSync, existsSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const tfbRoot = resolve(projectRoot, "..", "FrameworkBenchmarks");
const sourceRustCore = resolve(projectRoot, "rust-core");
const sourceDockerfile = resolve(projectRoot, "bench", "techempower", "fearless-rust.dockerfile");
const sourceBenchmarkConfig = resolve(projectRoot, "bench", "techempower", "benchmark_config.json");
const targetRustCore = resolve(tfbRoot, "frameworks", "TypeScript", "fearless", "rust-core");
const targetDockerfile = resolve(tfbRoot, "frameworks", "TypeScript", "fearless", "fearless.dockerfile");
const targetBenchmarkConfig = resolve(tfbRoot, "frameworks", "TypeScript", "fearless", "benchmark_config.json");

if (!existsSync(tfbRoot)) {
  throw new Error(`FrameworkBenchmarks not found at ${tfbRoot}`);
}

rmSync(targetRustCore, { recursive: true, force: true });
cpSync(sourceRustCore, targetRustCore, { recursive: true });
cpSync(sourceDockerfile, targetDockerfile);
cpSync(sourceBenchmarkConfig, targetBenchmarkConfig);

const result = spawnSync(
  "./tfb",
  ["--mode", "benchmark", "--test-dir", "TypeScript/fearless", "--type", "plaintext", "json", "--duration", "10"],
  {
    cwd: tfbRoot,
    env: process.env,
    stdio: "inherit",
  }
);

if (result.error) {
  throw result.error;
}

process.exit(result.status ?? 1);
