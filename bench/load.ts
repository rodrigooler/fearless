import autocannon from "autocannon";
import net from "node:net";
import { App } from "../src/index.js";

async function waitForTcp(port: number): Promise<void> {
  const deadline = Date.now() + 15_000;

  while (Date.now() < deadline) {
    try {
      await new Promise<void>((resolve, reject) => {
        const socket = net.createConnection({ port, host: "127.0.0.1" }, () => {
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

  throw new Error(`Timed out waiting for 127.0.0.1:${port}`);
}

async function runLoadTest(name: string, url: string): Promise<void> {
  const result = await new Promise<any>((resolve, reject) => {
    const instance = autocannon(
      {
        url,
        connections: 100,
        duration: 10,
        pipelining: 1,
      },
      (error, outcome) => {
        if (error || !outcome) {
          reject(error ?? new Error("autocannon did not produce a result"));
          return;
        }

        resolve(outcome);
      }
    );

    instance.on("error", reject);
  });

  console.log(`${name}: ${result.requests.average.toFixed(0)} req/s average`);
  console.log(`${name}: ${result.latency.average.toFixed(2)} ms average latency`);
}

async function main(): Promise<void> {
  const port = 3001;
  const app = new App({ port, host: "127.0.0.1", runtime: "auto" });

  app.text("/plaintext", "Hello, World!");
  app.json("/json", { message: "Hello, World!" });

  app.listen();

  try {
    await waitForTcp(port);
    await runLoadTest("plaintext", `http://127.0.0.1:${port}/plaintext`);
    await runLoadTest("json", `http://127.0.0.1:${port}/json`);
  } finally {
    await app.close();
  }
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
