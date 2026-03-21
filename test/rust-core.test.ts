import assert from "node:assert/strict";
import net from "node:net";
import test from "node:test";
import { App } from "../src/index.js";

async function getFreePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Failed to acquire a free port"));
        return;
      }

      const { port } = address;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve(port);
      });
    });
  });
}

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

test("Rust engine serves plaintext and json routes", async () => {
  const port = await getFreePort();
  const app = new App({ port, host: "127.0.0.1", engine: "rust" });

  app.text("/plaintext", "Hello, World!");
  app.json("/json", { message: "Hello, World!" });
  app.listen();

  try {
    await waitForTcp(port);

    const plaintext = await fetch(`http://127.0.0.1:${port}/plaintext`);
    const json = await fetch(`http://127.0.0.1:${port}/json`);

    assert.equal(await plaintext.text(), "Hello, World!");
    assert.equal(await json.text(), '{"message":"Hello, World!"}');
    assert.equal(plaintext.headers.get("content-type"), "text/plain");
    assert.equal(json.headers.get("content-type"), "application/json");
  } finally {
    await app.close();
  }
});
