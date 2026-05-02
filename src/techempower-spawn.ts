import { availableParallelism } from "node:os";

type BunSubprocess = {
  kill(signal?: string | number): void;
  exited: Promise<number>;
};

type BunSpawnLike = {
  spawn(options: {
    cmd: string[];
    cwd?: string;
    env?: Record<string, string | undefined>;
    stdio?: [BunFileDescriptor, BunFileDescriptor, BunFileDescriptor];
  }): BunSubprocess;
};

type BunFileDescriptor = "inherit" | "ignore" | "pipe";

const bun = (globalThis as typeof globalThis & { Bun?: BunSpawnLike }).Bun;
if (!bun) {
  throw new Error("Bun runtime is required");
}

const requestedWorkers = Number(process.env.FEARLESS_BUN_WORKERS || 0);
const workerCount = requestedWorkers > 0 ? requestedWorkers : availableParallelism();
const workerPath = new URL("./techempower.ts", import.meta.url).pathname;
const workers: BunSubprocess[] = [];

for (let index = 0; index < workerCount; index += 1) {
  workers.push(
    bun.spawn({
      cmd: [process.execPath, workerPath],
      cwd: process.cwd(),
      env: {
        ...process.env,
        FEARLESS_BUN_REUSE_PORT: "1",
      },
      stdio: ["inherit", "inherit", "inherit"],
    })
  );
}

const shutdown = (): void => {
  for (const worker of workers) {
    worker.kill();
  }
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
process.on("exit", shutdown);

await Promise.race(workers.map((worker) => worker.exited));
shutdown();
process.exit(1);
