import { Bench } from "tinybench";
import { normalizePath } from "../src/path.js";

function naiveNormalizePath(path: string): string {
  if (!path || path === "/") {
    return "/";
  }

  let normalized = path;
  const queryIndex = normalized.indexOf("?");
  if (queryIndex !== -1) {
    normalized = normalized.slice(0, queryIndex);
  }

  if (!normalized.startsWith("/")) {
    normalized = `/${normalized}`;
  }

  while (normalized.endsWith("/") && normalized.length > 1) {
    normalized = normalized.slice(0, -1);
  }

  return normalized.length === 0 ? "/" : normalized;
}

async function main(): Promise<void> {
  const samples = ["/users/42?tag=one&tag=two", "users/42///", "/plaintext"];
  const bench = new Bench({ time: 1000 });

  for (const sample of samples) {
    bench.add(`normalizePath(${sample})`, () => {
      normalizePath(sample);
    });

    bench.add(`naiveNormalizePath(${sample})`, () => {
      naiveNormalizePath(sample);
    });
  }

  await bench.run();
  console.table(bench.table());
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
