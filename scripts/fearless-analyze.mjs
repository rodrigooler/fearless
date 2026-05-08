#!/usr/bin/env node
/**
 * `fearless analyze` — reports the AOT-readiness of each route in a user app.
 *
 * Usage:
 *   node scripts/fearless-analyze.mjs <app-source.ts>
 *
 * Output: per-route verdict + global AOT score + refactor hints for the top
 * blockers. No files written.
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { compileApp } from "@fearless/aot-build";

function color(code, text) {
  if (!process.stdout.isTTY) return text;
  return `\x1b[${code}m${text}\x1b[0m`;
}
const green = (t) => color(32, t);
const yellow = (t) => color(33, t);
const blue = (t) => color(34, t);
const grey = (t) => color(90, t);
const bold = (t) => color(1, t);

function main() {
  const inputPath = process.argv[2];
  if (inputPath == null) {
    console.error("usage: fearless-analyze <app-source.ts>");
    process.exit(1);
  }
  const resolved = resolve(inputPath);
  if (!existsSync(resolved)) {
    console.error(`error: input file not found: ${resolved}`);
    process.exit(1);
  }

  const source = readFileSync(resolved, "utf8");
  const result = compileApp({ source, fileName: resolved });

  const aotScore =
    result.summary.total === 0
      ? 0
      : (result.summary.aot + result.summary.template) / result.summary.total;

  console.log(bold(`Fearless AOT analysis — ${resolved}`));
  console.log("");
  console.log(`  ${green(`✅ ${result.summary.aot}`)} handlers compile to Rust`);
  console.log(`  ${blue(`📄 ${result.summary.template}`)} template routes (Rust hot path)`);
  console.log(`  ${yellow(`⚠️  ${result.summary.bun}`)} handlers fall back to Bun`);
  console.log("");
  console.log(
    `  ${bold("AOT score:")} ${(aotScore * 100).toFixed(1)}% (${result.summary.aot + result.summary.template}/${result.summary.total})`
  );
  console.log("");
  console.log(bold("Per-route verdict:"));
  for (const route of result.routes) {
    const method = route.method.padEnd(6);
    const path = route.path.padEnd(28);
    if (route.kind === "aot") {
      console.log(`  ${green("✅")} ${method} ${path} ${grey(`→ ${route.transpile.fnName}`)}`);
    } else if (route.kind === "template") {
      console.log(`  ${blue("📄")} ${method} ${path} ${grey("→ Rust template path")}`);
    } else {
      console.log(`  ${yellow("⚠️")} ${method} ${path} ${grey(`→ Bun (${route.reason.reasons.length} blocker${route.reason.reasons.length === 1 ? "" : "s"})`)}`);
    }
  }

  // Top refactor candidates: Bun-fallback routes ordered by FEWEST blockers
  // (lowest-hanging fruit — easiest to nudge into AOT).
  const bunRoutes = result.routes
    .filter((r) => r.kind === "bun")
    .sort((a, b) => a.reason.reasons.length - b.reason.reasons.length);

  if (bunRoutes.length > 0) {
    console.log("");
    console.log(bold("Top refactor candidates (closest to AOT):"));
    for (const route of bunRoutes.slice(0, 3)) {
      if (route.kind !== "bun") continue;
      console.log(`  ${yellow("→")} ${route.method} ${route.path}`);
      for (const reason of route.reason.reasons.slice(0, 3)) {
        console.log(`      [${reason.rule}] ${reason.message}`);
        if (reason.hint != null) {
          console.log(`        ${grey("hint: " + reason.hint)}`);
        }
      }
    }
  }

  if (result.summary.aot > 0) {
    console.log("");
    console.log(grey(`Run \`fearless build ${inputPath}\` to emit the Rust handlers.`));
  }
}

main();
