#!/usr/bin/env node
/**
 * `run-bench` — runs the full real-bench panel and appends results to
 * `bench-history.json`. Tag a run with --label "phase X" / --note "..." for
 * later comparison.
 *
 * Usage:
 *   node scripts/run-bench.mjs [--label "..."] [--note "..."] [--quick]
 *
 * --quick      Skip CPU-bound scenarios with high N (cuts run time roughly in half)
 * --label STR  Short tag for this run (defaults to git short-sha)
 * --note STR   Free-text description (e.g. "after Tier 1.3 borrow fix")
 *
 * Pipeline:
 *   1. Bring up Postgres (pg-bench) + rust-core (port 8080) + Bun (port 8081) +
 *      wrk-runner. Tears down at the end.
 *   2. Run each scenario, capturing req/s, p50_ms, p99_ms, errors.
 *   3. Append a run entry to bench-history.json.
 *   4. Print summary table; if a previous run exists, show delta per scenario.
 *
 * Bench history is committable — keep in git so the project has a permanent
 * perf record. New entries are appended, never edited.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const HISTORY_PATH = resolve("bench-history.json");
const SCHEMA = "fearless-bench-history-v1";

function parseArgs(argv) {
  const args = { label: null, note: null, quick: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--label") args.label = argv[++i];
    else if (a === "--note") args.note = argv[++i];
    else if (a === "--quick") args.quick = true;
  }
  return args;
}

function color(code, text) {
  if (!process.stdout.isTTY) return text;
  return `\x1b[${code}m${text}\x1b[0m`;
}
const green = (t) => color(32, t);
const red = (t) => color(31, t);
const yellow = (t) => color(33, t);
const grey = (t) => color(90, t);
const bold = (t) => color(1, t);

/**
 * Run a shell command. Used for our own tooling against fixed commands;
 * never accepts user-supplied paths inside the shell string.
 */
function sh(cmd, opts = {}) {
  const result = spawnSync("sh", ["-c", cmd], {
    stdio: opts.inherit ? "inherit" : "pipe",
    ...opts,
  });
  if (result.status !== 0 && !opts.allowFail) {
    const stderr = result.stderr?.toString?.() ?? "";
    throw new Error(`command failed (${result.status}): ${cmd}\n${stderr}`);
  }
  return result.stdout?.toString?.() ?? "";
}

function gitInfo() {
  const git = (args) => spawnSync("git", args, { stdio: ["ignore", "pipe", "ignore"] }).stdout?.toString?.().trim() ?? "";
  try {
    const sha = git(["rev-parse", "--short", "HEAD"]);
    const message = git(["log", "-1", "--format=%s"]);
    const dirty = git(["status", "--porcelain"]).length > 0;
    return { sha: sha || "unknown", message, dirty };
  } catch {
    return { sha: "unknown", message: "", dirty: false };
  }
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

function setup() {
  console.log(grey("setup: tear down stale containers..."));
  sh("docker rm -f pg-bench fearless-aot wrk-runner 2>/dev/null || true", { allowFail: true });
  sh("pkill -f 'bun run examples/real-bench' 2>/dev/null || true", { allowFail: true });

  console.log(grey("setup: start Postgres..."));
  sh("docker run -d --name pg-bench -e POSTGRES_PASSWORD=pw -p 5432:5432 postgres:16 >/dev/null");
  sh("sleep 5");
  console.log(grey("setup: seed world table..."));
  sh(`docker exec -i pg-bench psql -U postgres <<'SQL' >/dev/null
DROP TABLE IF EXISTS world;
CREATE TABLE world (id INTEGER PRIMARY KEY, randomnumber INTEGER NOT NULL);
INSERT INTO world (id, randomnumber)
SELECT g, (random()*10000)::int FROM generate_series(1, 10000) g;
VACUUM ANALYZE world;
SQL
`);

  console.log(grey("setup: build AOT handlers..."));
  sh("node scripts/fearless-build.mjs examples/real-bench/server.ts --no-cargo >/dev/null");

  console.log(grey("setup: build rust-core docker image..."));
  sh("docker build -f bench/techempower/fearless-rust-aot.dockerfile -t fearless-rust:bench . 2>&1 | tail -1");

  console.log(grey("setup: start rust-core container (8080)..."));
  sh("docker run -d --name fearless-aot --ulimit memlock=-1 --cap-add SYS_NICE --cap-add NET_ADMIN --security-opt seccomp=unconfined -p 8080:8080 -e FEARLESS_SQL_PRIMARY=postgres://postgres:pw@host.docker.internal:5432/postgres -e FEARLESS_SQL_PRIMARY_POOL_SIZE=64 fearless-rust:bench >/dev/null");
  sh("sleep 2");

  console.log(grey("setup: start Bun server (8081)..."));
  sh("DATABASE_URL=postgres://postgres:pw@127.0.0.1:5432/postgres FEARLESS_PORT=8081 bun run examples/real-bench/server.ts > /tmp/bun-bench.log 2>&1 &");
  sh("sleep 2");

  console.log(grey("setup: start wrk runner..."));
  sh("docker run -d --name wrk-runner --network host ubuntu:22.04 sleep 86400 >/dev/null");
  sh("docker exec wrk-runner sh -c 'DEBIAN_FRONTEND=noninteractive apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y wrk curl' >/dev/null 2>&1");
  sh(`docker exec wrk-runner sh -c "cat > /tmp/pipe.lua <<'EOF'
init = function(args)
  local r = {}
  local depth = tonumber(args[1]) or 16
  local path = args[2] or '/plaintext'
  for i=1,depth do r[i] = wrk.format(nil, path) end
  req = table.concat(r)
end
request = function() return req end
EOF"`);

  console.log(grey("setup: smoke checks..."));
  const aotSmoke = sh("docker exec wrk-runner curl -s http://127.0.0.1:8080/plaintext").trim();
  const bunSmoke = sh("docker exec wrk-runner curl -s http://127.0.0.1:8081/plaintext").trim();
  const dbSmoke = sh("docker exec wrk-runner curl -s http://127.0.0.1:8081/db").trim();
  const aotDbSmoke = sh("docker exec wrk-runner curl -s http://127.0.0.1:8080/db").trim();
  if (aotSmoke !== "Hello, World!") throw new Error(`AOT smoke failed: ${aotSmoke}`);
  if (bunSmoke !== "Hello, World!") throw new Error(`Bun smoke failed: ${bunSmoke}`);
  if (!dbSmoke.includes("id")) throw new Error(`DB smoke failed: ${dbSmoke}`);
  if (!aotDbSmoke.includes("id")) throw new Error(`AOT /db smoke failed: ${aotDbSmoke}`);
  console.log(grey("setup: ✓ ready"));
}

function teardown() {
  console.log(grey("teardown: stopping containers + Bun..."));
  sh("docker rm -f pg-bench fearless-aot wrk-runner 2>/dev/null || true", { allowFail: true });
  sh("pkill -f 'bun run examples/real-bench' 2>/dev/null || true", { allowFail: true });
  console.log(grey("teardown: ✓ done"));
}

// ---------------------------------------------------------------------------
// Bench scenarios
// ---------------------------------------------------------------------------

function wrkRun({ port, path, threads = 8, conns = 64, duration = 10, pipeline = null }) {
  const url = `http://127.0.0.1:${port}${path}`;
  const cmd = pipeline != null
    ? `docker exec wrk-runner wrk -t${threads} -c${conns} -d${duration}s --latency -s /tmp/pipe.lua ${url} -- ${pipeline} ${path}`
    : `docker exec wrk-runner wrk -t${threads} -c${conns} -d${duration}s --latency ${url}`;
  const out = sh(cmd, { allowFail: true });

  const rpsMatch = out.match(/Requests\/sec:\s+([0-9.]+)/);
  const p50Match = out.match(/50%\s+([0-9.]+)(us|ms|s)/);
  const p99Match = out.match(/99%\s+([0-9.]+)(us|ms|s)/);
  const errMatch = out.match(/Non-2xx or 3xx responses:\s+(\d+)/);
  const completedMatch = out.match(/(\d+) requests in/);

  return {
    rps: rpsMatch ? parseFloat(rpsMatch[1]) : 0,
    p50_ms: parseLatency(p50Match),
    p99_ms: parseLatency(p99Match),
    non2xx: errMatch ? parseInt(errMatch[1], 10) : 0,
    completed: completedMatch ? parseInt(completedMatch[1], 10) : 0,
  };
}

function parseLatency(match) {
  if (!match) return null;
  const n = parseFloat(match[1]);
  const unit = match[2];
  if (unit === "us") return n / 1000;
  if (unit === "s") return n * 1000;
  return n;
}

function makeScenarios(quick) {
  const aot = [
    ["aot/plaintext-c64",     "AOT /plaintext c=64",                () => wrkRun({ port: 8080, path: "/plaintext" })],
    ["aot/json-c64",          "AOT /json c=64",                     () => wrkRun({ port: 8080, path: "/json" })],
    ["aot/echo-c64",          "AOT /echo c=64",                     () => wrkRun({ port: 8080, path: "/echo/Alice" })],
    ["aot/config-c64",        "AOT /config c=64",                   () => wrkRun({ port: 8080, path: "/config" })],
    ["aot/access-c64",        "AOT /access c=64 (header cond)",     () => wrkRun({ port: 8080, path: "/access" })],
    ["aot/db-c64",            "AOT /db c=64 (Postgres random world)",  () => wrkRun({ port: 8080, path: "/db" })],
    ["aot/db-c256",           "AOT /db c=256 (MVP target ≥100k)",      () => wrkRun({ port: 8080, path: "/db", threads: 8, conns: 256 })],
    ["aot/plaintext-pipe32",  "AOT /plaintext c=256 pipe-32",       () => wrkRun({ port: 8080, path: "/plaintext", conns: 256, pipeline: 32 })],
    ["aot/json-pipe32",       "AOT /json c=256 pipe-32",            () => wrkRun({ port: 8080, path: "/json", conns: 256, pipeline: 32 })],
    ["aot/echo-pipe32",       "AOT /echo c=256 pipe-32",            () => wrkRun({ port: 8080, path: "/echo/Alice", conns: 256, pipeline: 32 })],
  ];
  const bunSimple = [
    ["bun/plaintext-c64",     "Bun /plaintext c=64",                () => wrkRun({ port: 8081, path: "/plaintext" })],
    ["bun/json-c64",          "Bun /json c=64",                     () => wrkRun({ port: 8081, path: "/json" })],
    ["bun/echo-c64",          "Bun /echo c=64",                     () => wrkRun({ port: 8081, path: "/echo/Alice" })],
  ];
  const bunReal = [
    ["bun/db-c64",            "Bun /db (1 PG query)",               () => wrkRun({ port: 8081, path: "/db" })],
    ["bun/queries-1-c64",     "Bun /queries?queries=1",             () => wrkRun({ port: 8081, path: "/queries?queries=1" })],
    ["bun/queries-20-c64",    "Bun /queries?queries=20 (TFB std)",  () => wrkRun({ port: 8081, path: "/queries?queries=20" })],
  ];
  const bunCpu = [
    ["bun/fib-10-c64",        "Bun /fib/10 (CPU trivial)",          () => wrkRun({ port: 8081, path: "/fib/10" })],
    ["bun/fib-20-c64",        "Bun /fib/20 (CPU ~0.2ms)",           () => wrkRun({ port: 8081, path: "/fib/20" })],
    ["bun/hash-100-c64",      "Bun /hash/100 (SHA256 x100)",        () => wrkRun({ port: 8081, path: "/hash/100" })],
  ];
  const bunHeavy = [
    ["bun/fib-30-c64",        "Bun /fib/30 (CPU ~150ms)",           () => wrkRun({ port: 8081, path: "/fib/30" })],
    ["bun/hash-1000-c64",     "Bun /hash/1000 (SHA256 x1000)",      () => wrkRun({ port: 8081, path: "/hash/1000" })],
  ];

  if (quick) {
    return [...aot, ...bunSimple, ...bunReal, ...bunCpu];
  }
  return [...aot, ...bunSimple, ...bunReal, ...bunCpu, ...bunHeavy];
}

// ---------------------------------------------------------------------------
// History storage
// ---------------------------------------------------------------------------

function loadHistory() {
  if (!existsSync(HISTORY_PATH)) {
    return { schema: SCHEMA, runs: [] };
  }
  const raw = readFileSync(HISTORY_PATH, "utf8");
  const parsed = JSON.parse(raw);
  if (parsed.schema !== SCHEMA) {
    console.warn(yellow(`bench-history.json schema mismatch (got "${parsed.schema}"); starting fresh`));
    return { schema: SCHEMA, runs: [] };
  }
  return parsed;
}

function saveHistory(history) {
  writeFileSync(HISTORY_PATH, JSON.stringify(history, null, 2) + "\n");
}

// ---------------------------------------------------------------------------
// Comparison report
// ---------------------------------------------------------------------------

function formatRps(n) {
  if (n >= 1e6) return (n / 1e6).toFixed(2) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1) + "k";
  return Math.round(n).toString();
}

function colorDelta(deltaPct) {
  const s = (deltaPct >= 0 ? "+" : "") + deltaPct.toFixed(1) + "%";
  if (Math.abs(deltaPct) < 5) return grey(s);
  if (deltaPct > 0) return green(s);
  return red(s);
}

function printComparison(currentRun, previousRun) {
  console.log("");
  console.log(bold("Results"));
  if (previousRun != null) {
    console.log(grey(`(comparing to previous run: ${previousRun.label})`));
  }
  console.log("");
  const colWidth = 38;
  for (const [id, scenario] of Object.entries(currentRun.scenarios)) {
    const desc = scenario.description ?? id;
    const padded = desc.padEnd(colWidth).slice(0, colWidth);
    const rps = formatRps(scenario.rps).padStart(8);
    let line = `  ${padded}  ${rps} req/s`;
    if (previousRun != null) {
      const prev = previousRun.scenarios[id];
      if (prev != null && prev.rps > 0) {
        const deltaPct = ((scenario.rps - prev.rps) / prev.rps) * 100;
        line += `  ${colorDelta(deltaPct)}`;
      } else {
        line += `  ${grey("(new)")}`;
      }
    }
    if (scenario.non2xx > 0) {
      line += `  ${yellow(`(${scenario.non2xx} non-2xx)`)}`;
    }
    console.log(line);
  }
  console.log("");
  console.log(bold(`Run id: ${currentRun.label}`));
  console.log(grey(`Saved to: ${HISTORY_PATH}`));
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  const args = parseArgs(process.argv);
  const git = gitInfo();
  const label = args.label ?? `${git.sha}${git.dirty ? "-dirty" : ""}`;
  const timestamp = new Date().toISOString();

  console.log(bold(`Fearless bench run — ${label} @ ${timestamp}`));
  if (git.message) console.log(grey(`  HEAD: ${git.message}`));
  if (args.note) console.log(grey(`  note: ${args.note}`));
  console.log("");

  let teardownNeeded = false;
  try {
    setup();
    teardownNeeded = true;

    const scenarios = makeScenarios(args.quick);
    const results = {};
    let i = 1;
    for (const [id, description, runner] of scenarios) {
      process.stdout.write(grey(`  [${i}/${scenarios.length}] ${description} ... `));
      const t0 = Date.now();
      try {
        const result = runner();
        const ms = Date.now() - t0;
        results[id] = { description, ...result };
        process.stdout.write(green(`✓ ${formatRps(result.rps)} req/s (${ms}ms)\n`));
      } catch (error) {
        process.stdout.write(red(`✗ ${error.message}\n`));
        results[id] = { description, rps: 0, error: error.message };
      }
      i += 1;
    }

    const currentRun = {
      label,
      timestamp,
      git,
      note: args.note,
      rig: {
        host: process.platform,
        node: process.version,
      },
      scenarios: results,
    };

    const history = loadHistory();
    const previousRun = history.runs.length > 0 ? history.runs[history.runs.length - 1] : null;
    history.runs.push(currentRun);
    saveHistory(history);

    printComparison(currentRun, previousRun);
  } finally {
    if (teardownNeeded) teardown();
  }
}

main();
