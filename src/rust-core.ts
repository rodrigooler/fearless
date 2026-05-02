import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { constants, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { spawn, type ChildProcess, execFile } from "node:child_process";
import { promisify } from "node:util";
import net from "node:net";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = existsSync(join(__dirname, "..", "rust-core", "Cargo.toml"))
  ? join(__dirname, "..")
  : join(__dirname, "..", "..");
const cargoManifest = join(projectRoot, "rust-core", "Cargo.toml");
const rustBinaryName = process.platform === "win32" ? "fearless-core.exe" : "fearless-core";
const rustBinaryPath = join(projectRoot, "rust-core", "target", "release", rustBinaryName);

export interface RustStaticRoute {
  method: string;
  path: string;
  response: {
    kind: "text" | "html" | "json";
    body: import("./types.js").TemplateValue;
    status?: number;
    headers?: Record<string, string>;
  };
  headers: Record<string, string>;
}

export interface RustCorsManifest {
  origin: string | null;
  methods: string;
  allowedHeaders: string | null;
  exposedHeaders: string | null;
  credentials: boolean;
  maxAge: number | null;
  optionsSuccessStatus: number;
}

export interface RustCoreManifest {
  routes: RustStaticRoute[];
  headers?: Record<string, string>;
  cors?: RustCorsManifest | null;
}

export interface StartRustCoreServerOptions {
  port: number;
  manifest: RustCoreManifest;
  binaryPath?: string;
  startupTimeoutMs?: number;
}

export interface RustCoreServerHandle {
  child: ChildProcess;
  manifestDir: string;
  stop(): Promise<void>;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function waitForTcp(port: number, host = "127.0.0.1", timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      await new Promise<void>((resolve, reject) => {
        const socket = net.createConnection({ port, host }, () => {
          socket.end();
          resolve();
        });

        socket.on("error", reject);
      });
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  throw new Error(`Timed out waiting for Rust core on ${host}:${port}`);
}

async function ensureRustBinary(binaryPath?: string): Promise<string> {
  if (binaryPath) {
    return binaryPath;
  }

  await execFileAsync("cargo", ["build", "--release", "--manifest-path", cargoManifest], {
    cwd: projectRoot,
    env: process.env,
    maxBuffer: 1024 * 1024,
  });

  if (!(await fileExists(rustBinaryPath))) {
    throw new Error(`Rust binary was not built at ${rustBinaryPath}`);
  }

  return rustBinaryPath;
}

export async function startRustCoreServer(options: StartRustCoreServerOptions): Promise<RustCoreServerHandle> {
  const binary = await ensureRustBinary(options.binaryPath);
  const manifestDir = await mkdtemp(join(tmpdir(), "fearless-rust-core-"));
  const manifestPath = join(manifestDir, "manifest.json");

  await writeFile(manifestPath, `${JSON.stringify(options.manifest, null, 2)}\n`, "utf8");

  const child = spawn(binary, ["--port", String(options.port), "--manifest", manifestPath], {
    cwd: projectRoot,
    env: {
      ...process.env,
      PORT: String(options.port),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => process.stdout.write(`[rust-core ${options.port}] ${chunk}`));
  child.stderr.on("data", (chunk) => process.stderr.write(`[rust-core ${options.port} ERROR] ${chunk}`));

  try {
    await waitForTcp(options.port, "127.0.0.1", options.startupTimeoutMs);
  } catch (error) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }

    await rm(manifestDir, { recursive: true, force: true });
    throw error;
  }

  return {
    child,
    manifestDir,
    stop: async () => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGTERM");
      }

      await new Promise<void>((resolve) => {
        if (child.exitCode !== null || child.signalCode !== null) {
          resolve();
          return;
        }

        child.once("exit", () => resolve());
        setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null) {
            child.kill("SIGKILL");
          }
        }, 3000);
      });

      await rm(manifestDir, { recursive: true, force: true });
    },
  };
}
