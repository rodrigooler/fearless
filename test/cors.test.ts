import assert from "node:assert/strict";
import net from "node:net";
import test from "node:test";
import { App, cors } from "../src/index.js";

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

test("cors builtin applies headers and answers preflight", async () => {
  const port = await getFreePort();
  const app = new App({ port, host: "127.0.0.1", runtime: "node" });

  app.use(
    cors({
      origin: "https://example.com",
      methods: ["GET", "OPTIONS"],
      allowedHeaders: ["content-type"],
      exposedHeaders: ["x-request-id"],
      credentials: true,
      maxAge: 600,
    })
  );

  app.text("/resource", "ok");

  app.listen();

  try {
    await waitForTcp(port);

    const response = await fetch(`http://127.0.0.1:${port}/resource`);
    assert.equal(await response.text(), "ok");
    assert.equal(response.headers.get("access-control-allow-origin"), "https://example.com");
    assert.equal(response.headers.get("access-control-allow-methods"), "GET, OPTIONS");
    assert.equal(response.headers.get("access-control-allow-headers"), "content-type");
    assert.equal(response.headers.get("access-control-expose-headers"), "x-request-id");
    assert.equal(response.headers.get("access-control-allow-credentials"), "true");
    assert.equal(response.headers.get("access-control-max-age"), "600");

    const preflight = await fetch(`http://127.0.0.1:${port}/resource`, {
      method: "OPTIONS",
    });

    assert.equal(preflight.status, 204);
    assert.equal(await preflight.text(), "");
    assert.equal(preflight.headers.get("access-control-allow-origin"), "https://example.com");
  } finally {
    await app.close();
  }
});

test("builtin features decorate declarative responses", async () => {
  const port = await getFreePort();
  const app = new App({ port, host: "127.0.0.1", runtime: "node" });

  app.use(
    cors({
      origin: "https://example.com",
      methods: ["GET", "OPTIONS"],
      allowedHeaders: ["content-type"],
    })
  );
  app.text(
    "/ordered",
    "ok",
    {
      headers: {
        "x-global": "yes",
        "x-route": "yes",
      },
    }
  );

  app.listen();

  try {
    await waitForTcp(port);

    const response = await fetch(`http://127.0.0.1:${port}/ordered`);
    assert.equal(await response.text(), "ok");
    assert.equal(response.headers.get("x-global"), "yes");
    assert.equal(response.headers.get("x-route"), "yes");
    assert.equal(response.headers.get("access-control-allow-origin"), "https://example.com");
  } finally {
    await app.close();
  }
});
