#!/usr/bin/env bun
/**
 * `fearless-bun` CLI — starts the Bun-side fallback runtime for a user app.
 *
 * Usage:
 *   fearless-bun <app.ts> [--port 8081] [--socket /tmp/fearless.sock]
 */
import { runFallbackServer } from "./index.js";
import { resolve } from "node:path";

interface ParsedArgs {
  appPath: string | null;
  port: number;
  socket: string | null;
}

function parseArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = { appPath: null, port: 8081, socket: null };
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--port") {
      const value = argv[++i];
      if (value == null) throw new Error("--port requires a value");
      const port = parseInt(value, 10);
      if (Number.isNaN(port)) throw new Error(`invalid --port: ${value}`);
      out.port = port;
    } else if (arg === "--socket") {
      out.socket = argv[++i] ?? null;
    } else if (out.appPath == null && arg != null) {
      out.appPath = arg;
    }
  }
  return out;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  if (args.appPath == null) {
    console.error("usage: fearless-bun <app.ts> [--port 8081] [--socket /tmp/fearless.sock]");
    process.exit(1);
  }

  const resolved = resolve(args.appPath);
  await runFallbackServer({
    appPath: resolved,
    port: args.port,
    ...(args.socket != null ? { socket: args.socket } : {}),
  });

  // The user's app called `app.listen()` and is now serving. Park the
  // process — Bun keeps the event loop alive while the server is bound.
  // SIGINT/SIGTERM handling is the user app's responsibility (they typically
  // wire it via `process.on("SIGINT", ...)` to call `app.close()`).
}

void main().catch((error) => {
  console.error("fearless-bun: failed to start:", error);
  process.exit(1);
});
