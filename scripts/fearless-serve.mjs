#!/usr/bin/env node
/**
 * `fearless-serve` — supervisor that brings up the dual-port Fearless runtime.
 *
 * Starts:
 *   1. rust-core (Docker container) on --rust-port (default 8080) — serves AOT routes
 *   2. Bun runtime on --bun-port (default 8081) — serves everything (including
 *      AOT routes, just slower; the LB / reverse proxy decides routing)
 *
 * Pipes logs from both with [rust] / [bun] prefixes. Handles SIGINT cleanly:
 *   - stops the rust-core container
 *   - kills the Bun child process
 *
 * Usage:
 *   node scripts/fearless-serve.mjs <app.ts> [--rust-port 8080] [--bun-port 8081]
 *                                            [--image fearless-rust:latest]
 *                                            [--postgres-url postgres://...]
 */
import { spawn, spawnSync } from "node:child_process";
import { resolve } from "node:path";

function parseArgs(argv) {
  const args = {
    appPath: null,
    rustPort: 8080,
    bunPort: 8081,
    image: "fearless-rust:bench",
    postgresUrl: process.env.DATABASE_URL ?? "postgres://postgres:pw@127.0.0.1:5432/postgres",
  };
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--rust-port") args.rustPort = parseInt(argv[++i], 10);
    else if (arg === "--bun-port") args.bunPort = parseInt(argv[++i], 10);
    else if (arg === "--image") args.image = argv[++i];
    else if (arg === "--postgres-url") args.postgresUrl = argv[++i];
    else if (args.appPath == null) args.appPath = arg;
  }
  return args;
}

function color(code, text) {
  if (!process.stdout.isTTY) return text;
  return `\x1b[${code}m${text}\x1b[0m`;
}
const cyan = (t) => color(36, t);
const yellow = (t) => color(33, t);
const grey = (t) => color(90, t);
const bold = (t) => color(1, t);
const red = (t) => color(31, t);

function logTagged(tag, color, line) {
  if (!line.trim()) return;
  console.log(`${color(`[${tag}]`)} ${line}`);
}

function bringUpRust(image, port) {
  console.log(grey(`[supervisor] starting rust-core (image=${image}, port=${port})`));
  spawnSync("docker", ["rm", "-f", "fearless-aot"], { stdio: "ignore" });
  const result = spawnSync(
    "docker",
    [
      "run",
      "-d",
      "--name", "fearless-aot",
      "--ulimit", "memlock=-1",
      "--cap-add", "SYS_NICE",
      "--cap-add", "NET_ADMIN",
      "--security-opt", "seccomp=unconfined",
      "-p", `${port}:8080`,
      image,
    ],
    { stdio: "pipe" }
  );
  if (result.status !== 0) {
    console.error(red("[supervisor] failed to start rust-core:"));
    console.error(result.stderr?.toString());
    process.exit(1);
  }
  console.log(grey("[supervisor] rust-core started"));

  // Tail logs into our stream.
  const tail = spawn("docker", ["logs", "-f", "fearless-aot"]);
  tail.stdout.on("data", (chunk) => {
    for (const line of chunk.toString().split("\n")) logTagged("rust", cyan, line);
  });
  tail.stderr.on("data", (chunk) => {
    for (const line of chunk.toString().split("\n")) logTagged("rust", cyan, line);
  });
  return tail;
}

function bringUpBun(appPath, port, postgresUrl) {
  console.log(grey(`[supervisor] starting Bun runtime (app=${appPath}, port=${port})`));
  const env = {
    ...process.env,
    DATABASE_URL: postgresUrl,
    FEARLESS_PORT: String(port),
  };
  const child = spawn("bun", ["run", appPath], {
    stdio: ["ignore", "pipe", "pipe"],
    env,
  });
  child.stdout.on("data", (chunk) => {
    for (const line of chunk.toString().split("\n")) logTagged("bun", yellow, line);
  });
  child.stderr.on("data", (chunk) => {
    for (const line of chunk.toString().split("\n")) logTagged("bun", yellow, line);
  });
  return child;
}

function shutdown(rustTail, bunChild) {
  console.log("");
  console.log(grey("[supervisor] shutdown signal received"));
  if (rustTail != null) rustTail.kill();
  if (bunChild != null) bunChild.kill("SIGTERM");
  spawnSync("docker", ["rm", "-f", "fearless-aot"], { stdio: "ignore" });
  console.log(grey("[supervisor] cleaned up"));
  process.exit(0);
}

function main() {
  const args = parseArgs(process.argv);
  if (args.appPath == null) {
    console.error("usage: fearless-serve <app.ts> [--rust-port 8080] [--bun-port 8081] [--image NAME] [--postgres-url URL]");
    process.exit(1);
  }

  console.log(bold("Fearless dual-port supervisor"));
  console.log(grey(`  app:           ${args.appPath}`));
  console.log(grey(`  rust-port:     ${args.rustPort}  (AOT routes — rust-core io_uring)`));
  console.log(grey(`  bun-port:      ${args.bunPort}  (all routes — Bun.serve fallback)`));
  console.log(grey(`  image:         ${args.image}`));
  console.log("");

  const rustTail = bringUpRust(args.image, args.rustPort);
  const bunChild = bringUpBun(resolve(args.appPath), args.bunPort, args.postgresUrl);

  for (const sig of ["SIGINT", "SIGTERM"]) {
    process.on(sig, () => shutdown(rustTail, bunChild));
  }

  bunChild.on("exit", (code) => {
    console.log(red(`[supervisor] Bun child exited with code ${code}`));
    shutdown(rustTail, null);
  });
}

main();
