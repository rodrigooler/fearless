import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import net from "node:net";
import { promisify } from "node:util";

const exec = promisify(setTimeout);

const serverDir = new URL("./servers/", import.meta.url);
const connections = Number(process.env.BENCH_CONNECTIONS ?? 100);
const duration = Number(process.env.BENCH_DURATION ?? 10);
const targetBody = "Hello, World!";

interface ServerSpec {
  name: "fearless";
  port: number;
  script: string;
}

const servers: ServerSpec[] = [
  { name: "fearless", port: 4101, script: fileURLToPath(new URL("fearless.ts", serverDir)) },
];

function logSection(title: string): void {
  console.log(`\n${title}`);
}

async function waitForTcp(port: number, host = "127.0.0.1"): Promise<void> {
  const deadline = Date.now() + 15_000;

  while (Date.now() < deadline) {
    try {
      await new Promise<void>((resolve, reject) => {
        const connection = net.createConnection({ port, host }, () => {
          connection.end();
          resolve();
        });

        connection.on("error", reject);
      });
      return;
    } catch {
      await exec(150);
    }
  }

  throw new Error(`Timed out waiting for ${host}:${port}`);
}

function spawnServer(script: string, port: number): ReturnType<typeof spawn> {
  const child = spawn(process.execPath, ["--import", "tsx", script], {
    env: {
      ...process.env,
      PORT: String(port),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => process.stdout.write(`[server ${port}] ${chunk}`));
  child.stderr.on("data", (chunk) => process.stderr.write(`[server ${port} ERROR] ${chunk}`));
  return child;
}

function stopServer(child: ReturnType<typeof spawn>): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }

    child.once("exit", () => resolve());
    child.kill("SIGTERM");

    setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
    }, 3000);
  });
}

function cleanEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.NO_COLOR;
  delete env.OHA_NO_COLOR;
  return env;
}

async function findRunner(): Promise<{ bin: string; argsBase: string[] }> {
  const candidates: Array<{ bin: string; argsBase: string[] }> = [
    { bin: "oha", argsBase: [] },
    { bin: "wrk", argsBase: [] },
  ];

  for (const candidate of candidates) {
    try {
      await new Promise<void>((resolve, reject) => {
        const child = spawn(candidate.bin, ["--help"], { stdio: "ignore" });
        child.once("error", reject);
        child.once("exit", (code) => {
          if (code === 0 || code === 1) {
            resolve();
          } else {
            reject(new Error(`${candidate.bin} exited with ${code}`));
          }
        });
      });
      return candidate;
    } catch {
      continue;
    }
  }

  throw new Error("Neither oha nor wrk is installed");
}

async function runOha(url: string): Promise<number> {
  const runner = await findRunner();

  if (runner.bin === "oha") {
    const output = await new Promise<string>((resolve, reject) => {
      const child = spawn(
        "oha",
        ["--output-format", "json", "-c", String(connections), "-z", `${duration}s`, url],
        { stdio: ["ignore", "pipe", "pipe"], env: cleanEnv() }
      );

      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
      child.once("error", reject);
      child.once("exit", (code) => {
        if (code === 0) {
          resolve(stdout);
          return;
        }

        reject(new Error(stderr || stdout || `oha exited with ${code}`));
      });
    });

    const json = JSON.parse(output) as { summary?: { requestsPerSec?: number } };
    return json.summary?.requestsPerSec ?? Number.NaN;
  }

  const output = await new Promise<string>((resolve, reject) => {
    const child = spawn(
      "wrk",
      ["-c", String(connections), "-d", `${duration}s`, url],
      { stdio: ["ignore", "pipe", "pipe"], env: cleanEnv() }
    );

    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) {
        resolve(stdout);
        return;
      }

      reject(new Error(stderr || stdout || `wrk exited with ${code}`));
    });
  });

  const match = output.match(/Requests\/sec:\s+([\d,.]+)/i);
  if (!match) {
    throw new Error(`Could not parse wrk output:\n${output}`);
  }

  return Number(match[1].replace(/,/g, ""));
}

async function main(): Promise<void> {
  console.log(`PlainText benchmark on Node ${process.version}, ${connections} connections, ${duration}s`);
  console.log(`Target body: ${targetBody}`);
  console.log("Metric: requests/sec only, TechEmpower-style");

  for (const server of servers) {
    const child = spawnServer(server.script, server.port);

    try {
      await waitForTcp(server.port);
      const url = `http://127.0.0.1:${server.port}/`;

      logSection(server.name);
      const requestsPerSec = await runOha(url);
      console.log(`${server.name.padEnd(8)} ${requestsPerSec.toFixed(2)} req/s`);
    } finally {
      await stopServer(child);
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
