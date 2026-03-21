import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import net from "node:net";
import { promisify } from "node:util";
import autocannon from "autocannon";

const exec = promisify(setTimeout);

type FrameworkName = "fearless" | "elysia";

interface BenchmarkResult {
  framework: FrameworkName;
  requestsPerSec: number;
  latencyAvgMs: number;
  latencyP99Ms: number;
  throughputMbps: number;
}

interface ServerSpec {
  name: FrameworkName;
  port: number;
  script: string;
}

const serverDir = new URL("./servers/", import.meta.url);
const connections = Number(process.env.BENCH_CONNECTIONS ?? 100);
const duration = Number(process.env.BENCH_DURATION ?? 10);
const benchmarkUrlPath = "/";
const benchmarkBody = "Hello, World!";

const servers: ServerSpec[] = [
  { name: "fearless", port: 4101, script: fileURLToPath(new URL("fearless.ts", serverDir)) },
  { name: "elysia", port: 4102, script: fileURLToPath(new URL("elysia.ts", serverDir)) },
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

async function runScenario(baseUrl: string): Promise<{
  requestsPerSec: number;
  latencyAvgMs: number;
  latencyP99Ms: number;
  throughputMbps: number;
}> {
  const result = await new Promise<any>((resolve, reject) => {
    const instance = autocannon(
      {
        url: `${baseUrl}${benchmarkUrlPath}`,
        method: "GET",
        connections,
        duration,
        pipelining: 1,
        headers: {
          accept: "text/plain",
        },
      },
      (error, res) => {
        if (error) {
          reject(error);
          return;
        }

        resolve(res);
      }
    );

    autocannon.track(instance, { renderProgressBar: false, renderResultsTable: false });
  });

  return {
    requestsPerSec: result.requests.average,
    latencyAvgMs: result.latency.average,
    latencyP99Ms: result.latency.p99,
    throughputMbps: result.throughput.average / 1_000_000,
  };
}

function formatNumber(value: number): string {
  return Number.isFinite(value) ? value.toFixed(2) : "n/a";
}

async function main(): Promise<void> {
  const results: BenchmarkResult[] = [];

  logSection(`PlainText benchmark on Node ${process.version}, ${connections} connections, ${duration}s`);
  console.log("Target body: Hello, World!");

  for (const server of servers) {
    const child = spawnServer(server.script, server.port);

    try {
      await waitForTcp(server.port);
      const baseUrl = `http://127.0.0.1:${server.port}`;

      logSection(server.name);
      const stats = await runScenario(baseUrl);
      results.push({
        framework: server.name,
        ...stats,
      });
      console.log(
        `${server.name.padEnd(8)} ${formatNumber(stats.requestsPerSec)} req/s  ` +
          `${formatNumber(stats.latencyAvgMs)} ms avg  ${formatNumber(stats.latencyP99Ms)} ms p99`
      );
    } finally {
      await stopServer(child);
    }
  }

  logSection("Summary");
  console.table(
    results.map((row) => ({
      framework: row.framework,
      "req/s": formatNumber(row.requestsPerSec),
      "lat avg ms": formatNumber(row.latencyAvgMs),
      "lat p99 ms": formatNumber(row.latencyP99Ms),
      mbps: formatNumber(row.throughputMbps),
    }))
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
