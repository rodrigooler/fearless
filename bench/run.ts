import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import net from "node:net";
import { writeFile } from "node:fs/promises";
import autocannon from "autocannon";

const serverDir = new URL("./servers/", import.meta.url);

const DEFAULT_CONNECTIONS = 100;
const DEFAULT_DURATION = 10;
const DEFAULT_WARMUP = 3;
const DEFAULT_RUNS = 3;
const ELYSIA_REFERENCE_NAME = "elysia";
const ELYSIA_REFERENCE_REQUESTS_PER_SEC = 1_837_294;

interface BenchmarkCase {
  name: string;
  path: string;
  expectBody: string;
  method?: "GET" | "POST" | "PUT" | "DELETE" | "PATCH" | "OPTIONS" | "HEAD";
}

type Runtime = "node" | "bun";

interface ServerSpec {
  name: "fearless" | "elysia";
  port: number;
  script: string;
  runtime: Runtime;
}

interface BenchmarkSummary {
  run: number;
  requestsPerSec: number;
  requestsMaxPerSec: number;
  latencyAvgMs: number;
  latencyP99Ms: number;
  errors: number;
  mismatches: number;
  non2xx: number;
  durationSec: number;
}

interface CaseReport {
  name: string;
  url: string;
  warmupSec: number;
  runs: BenchmarkSummary[];
  best: BenchmarkSummary;
}

interface BenchmarkReport {
  startedAt: string;
  finishedAt: string;
  nodeVersion: string;
  platform: string;
  arch: string;
  connections: number;
  durationSec: number;
  warmupSec: number;
  runsPerCase: number;
  reference: BenchmarkReference;
  targets: TargetReport[];
}

interface BenchmarkReference {
  name: string;
  requestsPerSec: number;
}

interface TargetReport {
  name: string;
  url: string;
  cases: CaseReport[];
}

const cases: BenchmarkCase[] = [
  {
    name: "plaintext",
    path: "/plaintext",
    expectBody: "Hello, World!",
  },
  {
    name: "json",
    path: "/json",
    expectBody: '{"message":"Hello, World!"}',
  },
];

const servers: ServerSpec[] = [
  { name: "fearless", port: 4101, script: fileURLToPath(new URL("fearless.ts", serverDir)), runtime: "node" },
  { name: "elysia", port: 4102, script: fileURLToPath(new URL("elysia.ts", serverDir)), runtime: "bun" },
];

function parseIntEnv(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
}

function parseArgs(argv: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const current = argv[i];
    if (!current.startsWith("--")) continue;

    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      result[current.slice(2)] = "true";
      continue;
    }

    result[current.slice(2)] = next;
    i += 1;
  }
  return result;
}

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
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  }

  throw new Error(`Timed out waiting for ${host}:${port}`);
}

function spawnServer(server: ServerSpec): ReturnType<typeof spawn> {
  const command = server.runtime === "bun" ? "bun" : process.execPath;
  const args = server.runtime === "bun" ? [server.script] : ["--import", "tsx", server.script];

  const child = spawn(command, args, {
    env: {
      ...process.env,
      PORT: String(server.port),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => process.stdout.write(`[server ${server.name}:${server.port}] ${chunk}`));
  child.stderr.on("data", (chunk) => process.stderr.write(`[server ${server.name}:${server.port} ERROR] ${chunk}`));
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

async function runAutocannon(url: string, connections: number, durationSec: number, expectBody: string) {
  return autocannon({
    url,
    method: "GET",
    connections,
    duration: durationSec,
    pipelining: 1,
    headers: {},
    expectBody,
    excludeErrorStats: false,
    renderProgressBar: false,
    renderResultsTable: false,
    renderLatencyTable: false,
  });
}

function toSummary(run: number, result: Awaited<ReturnType<typeof runAutocannon>>): BenchmarkSummary {
  return {
    run,
    requestsPerSec: result.requests.average,
    requestsMaxPerSec: result.requests.max,
    latencyAvgMs: result.latency.average,
    latencyP99Ms: result.latency.p99,
    errors: result.errors,
    mismatches: result.mismatches,
    non2xx: result.non2xx,
    durationSec: result.duration,
  };
}

function pickBest(runs: BenchmarkSummary[]): BenchmarkSummary {
  return [...runs].sort((left, right) => {
    if (right.requestsPerSec !== left.requestsPerSec) {
      return right.requestsPerSec - left.requestsPerSec;
    }

    if (left.errors !== right.errors) {
      return left.errors - right.errors;
    }

    if (left.mismatches !== right.mismatches) {
      return left.mismatches - right.mismatches;
    }

    return left.latencyP99Ms - right.latencyP99Ms;
  })[0];
}

function formatNumber(value: number): string {
  return value.toFixed(2).padStart(12);
}

function formatPercent(value: number): string {
  return `${value.toFixed(2)}%`.padStart(8);
}

function printCaseReport(report: CaseReport): void {
  console.log(`\n${report.name}`);
  console.log(`  url: ${report.url}`);
  console.log(`  best: ${report.best.requestsPerSec.toFixed(2)} req/s`);
  console.log("  runs:");
  for (const run of report.runs) {
    console.log(
      `    #${run.run}: ${run.requestsPerSec.toFixed(2)} req/s, ` +
        `latency avg ${run.latencyAvgMs.toFixed(2)} ms, p99 ${run.latencyP99Ms.toFixed(2)} ms, ` +
        `errors ${run.errors}, mismatches ${run.mismatches}, non2xx ${run.non2xx}`
    );
  }
}

async function runCaseBenchmark(
  baseUrl: string,
  benchmarkCase: BenchmarkCase,
  connections: number,
  durationSec: number,
  warmupSec: number,
  runsPerCase: number
): Promise<CaseReport> {
  const url = new URL(benchmarkCase.path, baseUrl).href;

  if (warmupSec > 0) {
    console.log(`Warmup ${benchmarkCase.name} (${warmupSec}s)`);
    await runAutocannon(url, connections, warmupSec, benchmarkCase.expectBody);
  }

  const runs: BenchmarkSummary[] = [];
  for (let run = 1; run <= runsPerCase; run += 1) {
    console.log(`Measure ${benchmarkCase.name} run ${run}/${runsPerCase} (${durationSec}s)`);
    const result = await runAutocannon(url, connections, durationSec, benchmarkCase.expectBody);
    runs.push(toSummary(run, result));
  }

  return {
    name: benchmarkCase.name,
    url,
    warmupSec,
    runs,
    best: pickBest(runs),
  };
}

function printTargetReport(target: TargetReport): void {
  console.log(`\nTarget: ${target.name}`);
  console.log(`  url: ${target.url}`);

  for (const caseReport of target.cases) {
    const best = caseReport.best;
    console.log(
      `  ${caseReport.name.padEnd(10)} ${formatNumber(best.requestsPerSec)} req/s  ` +
        `latency avg ${formatNumber(best.latencyAvgMs)} ms  ` +
        `p99 ${formatNumber(best.latencyP99Ms)} ms`
    );
  }
}

function summarizeAgainstReference(target: TargetReport, reference: BenchmarkReference): void {
  console.log(`\n${target.name} vs ${reference.name}`);

  for (const caseReport of target.cases) {
    const best = caseReport.best;
    const ratio = (best.requestsPerSec / reference.requestsPerSec) * 100;
    const gap = reference.requestsPerSec - best.requestsPerSec;
    console.log(
      `  ${caseReport.name.padEnd(10)} ${formatNumber(best.requestsPerSec)} req/s  ` +
        `${formatPercent(ratio)} of ${reference.name}  ` +
        `gap ${formatNumber(gap)} req/s`
    );
  }
}

function printComparison(targets: TargetReport[]): void {
  if (targets.length < 2) {
    return;
  }

  console.log("\nComparison");
  const caseNames = targets[0]?.cases.map((item) => item.name) ?? [];

  for (const caseName of caseNames) {
    const line = targets
      .map((target) => {
        const caseReport = target.cases.find((entry) => entry.name === caseName);
        if (!caseReport) {
          return `${target.name}: n/a`;
        }

        return `${target.name}: ${caseReport.best.requestsPerSec.toFixed(2)} req/s`;
      })
      .join(" | ");

    console.log(`  ${caseName.padEnd(10)} ${line}`);
  }
}

async function benchmarkTarget(
  name: string,
  baseUrl: string,
  connections: number,
  durationSec: number,
  warmupSec: number,
  runsPerCase: number
): Promise<TargetReport> {
  const reports: CaseReport[] = [];

  for (const benchmarkCase of cases) {
    logSection(`${name} / ${benchmarkCase.name}`);
    const report = await runCaseBenchmark(baseUrl, benchmarkCase, connections, durationSec, warmupSec, runsPerCase);
    reports.push(report);
    printCaseReport(report);
  }

  return {
    name,
    url: baseUrl,
    cases: reports,
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const connections = parseIntEnv(args.connections ?? process.env.BENCH_CONNECTIONS, DEFAULT_CONNECTIONS);
  const durationSec = parseIntEnv(args.duration ?? process.env.BENCH_DURATION, DEFAULT_DURATION);
  const warmupSec = parseIntEnv(args.warmup ?? process.env.BENCH_WARMUP, DEFAULT_WARMUP);
  const runsPerCase = parseIntEnv(args.runs ?? process.env.BENCH_RUNS, DEFAULT_RUNS);
  const outputFile = args.output ?? process.env.BENCH_OUTPUT;
  const fearlessUrl = args.url ?? process.env.BENCH_URL;
  const elysiaUrl = args["compare-url"] ?? process.env.BENCH_COMPARE_URL;

  const startedAt = new Date();
  console.log(
    `TechEmpower-style local benchmark on Node ${process.version}, ` +
      `${connections} connections, ${durationSec}s measure, ${warmupSec}s warmup, ${runsPerCase} runs/case`
  );
  console.log("Metrics captured: requests/sec, latency avg/p99, errors, mismatches, non-2xx");
  console.log(
    `Reference target: ${ELYSIA_REFERENCE_NAME} ${ELYSIA_REFERENCE_REQUESTS_PER_SEC.toLocaleString("en-US")} req/s`
  );

  const targets: TargetReport[] = [];
  const children: ReturnType<typeof spawn>[] = [];

  try {
    for (const server of servers) {
      const overrideUrl = server.name === "fearless" ? fearlessUrl : elysiaUrl;
      if (overrideUrl) {
        const target = await benchmarkTarget(server.name, overrideUrl, connections, durationSec, warmupSec, runsPerCase);
        targets.push(target);
        continue;
      }

      const child = spawnServer(server);
      children.push(child);

      try {
        await waitForTcp(server.port);
        const baseUrl = `http://127.0.0.1:${server.port}/`;
        const target = await benchmarkTarget(server.name, baseUrl, connections, durationSec, warmupSec, runsPerCase);
        targets.push(target);
      } catch (error) {
        await stopServer(child);
        throw error;
      }
    }
  } finally {
    for (const child of children) {
      await stopServer(child);
    }
  }

  const finishedAt = new Date();
  const report: BenchmarkReport = {
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    nodeVersion: process.version,
    platform: process.platform,
    arch: process.arch,
    connections,
    durationSec,
    warmupSec,
    runsPerCase,
    reference: {
      name: ELYSIA_REFERENCE_NAME,
      requestsPerSec: ELYSIA_REFERENCE_REQUESTS_PER_SEC,
    },
    targets,
  };

  console.log("\nSummary");
  for (const target of targets) {
    printTargetReport(target);
  }

  printComparison(targets);
  for (const target of targets) {
    if (target.name !== report.reference.name) {
      summarizeAgainstReference(target, report.reference);
    }
  }

  if (outputFile) {
    await writeFile(outputFile, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    console.log(`\nWrote report to ${outputFile}`);
  } else {
    console.log("\nSet BENCH_OUTPUT=<file.json> to persist the structured report.");
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
