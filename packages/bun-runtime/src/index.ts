/**
 * @fearless/bun-runtime
 *
 * The Bun-side companion to rust-core. The user's app file is imported here
 * (which executes its `app.listen()` call); we set FEARLESS_PORT first so the
 * app binds to the port we manage instead of its hard-coded one.
 *
 * The current architecture is dual-port: rust-core serves AOT-compiled routes
 * on port 8080, Bun serves everything (including the AOT-compatible routes,
 * which Bun re-implements naturally) on port 8081 (or whatever we configure).
 * A reverse proxy / load balancer fronts both and routes by path or just sends
 * everything to rust-core, which 404s the non-AOT routes and the LB retries
 * against Bun.
 *
 * Single-port transparent forwarding is roadmapped — see
 * docs/superpowers/plans/2026-05-08-aot-integration.md (Step 5: Bun fallback
 * runtime via IPC).
 */

export interface BunRuntimeOptions {
  /** Path to the user's TS app file (relative to CWD or absolute). */
  readonly appPath: string;
  /** TCP port for Bun to listen on. */
  readonly port: number;
  /** Optional unix socket path; takes precedence over `port` when set. */
  readonly socket?: string;
}

/**
 * Start the Bun fallback runtime by importing the user's app file.
 *
 * The user's app must be standard Fearless code that calls `app.listen()` —
 * we hand the port via env so the app binds where the runtime expects.
 *
 * Returns a promise that resolves when the import completes (and therefore
 * the app has called listen). The actual server lifecycle is owned by the
 * user's `App` instance; this runtime just sets the env and triggers import.
 */
export async function runFallbackServer(options: BunRuntimeOptions): Promise<void> {
  process.env.FEARLESS_PORT = String(options.port);
  if (options.socket != null) {
    process.env.FEARLESS_SOCKET = options.socket;
  }

  const path = options.appPath;
  if (!path.endsWith(".ts") && !path.endsWith(".js") && !path.endsWith(".mjs")) {
    throw new Error(
      `expected .ts, .js, or .mjs app path; got "${path}". The runtime imports the user's app file directly.`
    );
  }

  // Dynamic import — Bun's loader handles TS natively.
  await import(path);
}
