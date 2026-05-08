#!/usr/bin/env node
/**
 * `compare-bench` — diff between two runs in bench-history.json.
 *
 * Usage:
 *   node scripts/compare-bench.mjs [BASELINE] [CURRENT]
 *
 * BASELINE / CURRENT can be:
 *   - A numeric index (negative counts from end, so -2 = previous, -1 = latest)
 *   - A label / SHA prefix
 *   - Omitted: defaults to BASELINE=-2, CURRENT=-1 (latest two runs)
 *
 * Exits non-zero if any AOT scenario regressed by > 10% (CI-friendly gate).
 *
 * Examples:
 *   node scripts/compare-bench.mjs                    # latest two
 *   node scripts/compare-bench.mjs ca1ee36 HEAD       # by SHA
 *   node scripts/compare-bench.mjs -5 -1              # 5 runs back vs latest
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const HISTORY_PATH = resolve("bench-history.json");
const REGRESSION_THRESHOLD_PCT = 10;

function color(code, text) {
  if (!process.stdout.isTTY) return text;
  return `\x1b[${code}m${text}\x1b[0m`;
}
const green = (t) => color(32, t);
const red = (t) => color(31, t);
const yellow = (t) => color(33, t);
const grey = (t) => color(90, t);
const bold = (t) => color(1, t);

function loadHistory() {
  if (!existsSync(HISTORY_PATH)) {
    console.error(red(`bench-history.json not found at ${HISTORY_PATH}`));
    console.error(grey("run `npm run bench:track` first to produce some data"));
    process.exit(1);
  }
  const parsed = JSON.parse(readFileSync(HISTORY_PATH, "utf8"));
  if (!Array.isArray(parsed.runs) || parsed.runs.length === 0) {
    console.error(red("bench-history.json has no runs"));
    process.exit(1);
  }
  return parsed.runs;
}

function pickRun(runs, selector, fallbackIndex) {
  if (selector == null) {
    const idx = runs.length + fallbackIndex; // fallbackIndex is negative
    if (idx < 0 || idx >= runs.length) {
      console.error(red(`history has only ${runs.length} run(s); can't pick index ${fallbackIndex}`));
      process.exit(1);
    }
    return runs[idx];
  }
  const asNum = parseInt(selector, 10);
  if (!Number.isNaN(asNum) && String(asNum) === selector) {
    const idx = asNum < 0 ? runs.length + asNum : asNum;
    if (idx < 0 || idx >= runs.length) {
      console.error(red(`history has only ${runs.length} run(s); can't pick index ${asNum}`));
      process.exit(1);
    }
    return runs[idx];
  }
  // Label / SHA prefix match
  const matches = runs.filter((r) =>
    r.label === selector ||
    r.label.startsWith(selector) ||
    (r.git?.sha ?? "").startsWith(selector)
  );
  if (matches.length === 0) {
    console.error(red(`no run matches "${selector}"`));
    process.exit(1);
  }
  if (matches.length > 1) {
    console.error(yellow(`multiple matches for "${selector}"; using most recent: ${matches[matches.length - 1].label}`));
  }
  return matches[matches.length - 1];
}

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

function main() {
  const runs = loadHistory();
  const baseline = pickRun(runs, process.argv[2], -2);
  const current = pickRun(runs, process.argv[3], -1);

  console.log(bold("Bench comparison"));
  console.log(`  baseline: ${baseline.label}  ${grey("(" + baseline.timestamp + ")")}`);
  if (baseline.note) console.log(`            ${grey(baseline.note)}`);
  console.log(`  current:  ${current.label}  ${grey("(" + current.timestamp + ")")}`);
  if (current.note) console.log(`            ${grey(current.note)}`);
  console.log("");

  const allIds = new Set([
    ...Object.keys(baseline.scenarios ?? {}),
    ...Object.keys(current.scenarios ?? {}),
  ]);

  let regressionCount = 0;
  const widthDesc = 40;
  const widthRps = 10;
  console.log(bold(`  ${"scenario".padEnd(widthDesc)}  ${"baseline".padStart(widthRps)}  ${"current".padStart(widthRps)}  delta`));
  console.log(grey(`  ${"-".repeat(widthDesc)}  ${"-".repeat(widthRps)}  ${"-".repeat(widthRps)}  ------`));

  for (const id of allIds) {
    const b = baseline.scenarios?.[id];
    const c = current.scenarios?.[id];
    const desc = (c?.description ?? b?.description ?? id).padEnd(widthDesc).slice(0, widthDesc);

    if (b == null) {
      console.log(`  ${desc}  ${grey("(absent)".padStart(widthRps))}  ${formatRps(c.rps).padStart(widthRps)}  ${grey("new")}`);
      continue;
    }
    if (c == null) {
      console.log(`  ${desc}  ${formatRps(b.rps).padStart(widthRps)}  ${grey("(absent)".padStart(widthRps))}  ${grey("removed")}`);
      continue;
    }
    if (b.rps === 0) {
      console.log(`  ${desc}  ${grey("0".padStart(widthRps))}  ${formatRps(c.rps).padStart(widthRps)}  ${grey("n/a")}`);
      continue;
    }
    const deltaPct = ((c.rps - b.rps) / b.rps) * 100;
    if (id.startsWith("aot/") && deltaPct < -REGRESSION_THRESHOLD_PCT) regressionCount += 1;
    const bRps = formatRps(b.rps).padStart(widthRps);
    const cRps = formatRps(c.rps).padStart(widthRps);
    console.log(`  ${desc}  ${bRps}  ${cRps}  ${colorDelta(deltaPct)}`);
  }

  console.log("");
  if (regressionCount > 0) {
    console.log(red(`✗ ${regressionCount} AOT scenario(s) regressed by >${REGRESSION_THRESHOLD_PCT}%`));
    process.exit(1);
  }
  console.log(green("✓ no AOT regressions over threshold"));
}

main();
