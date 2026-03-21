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

test("cors middleware applies headers and answers preflight", async () => {
  const port = await getFreePort();
  const app = new App({ port, host: "127.0.0.1" });

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

test("middlewares run in order and can decorate responses", async () => {
  const port = await getFreePort();
  const app = new App({ port, host: "127.0.0.1" });
  const calls: string[] = [];

  app.use(async (_req, res, next) => {
    calls.push("global:before");
    res.setHeader("x-global", "yes");
    await next();
    calls.push("global:after");
  });

  app.get(
    "/ordered",
    (_req, res) => {
      calls.push("handler");
      res.text("ok");
    },
    {
      middlewares: [
        async (_req, _res, next) => {
          calls.push("route:before");
          await next();
          calls.push("route:after");
        },
      ],
    }
  );

  app.listen();

  try {
    await waitForTcp(port);

    const response = await fetch(`http://127.0.0.1:${port}/ordered`);
    assert.equal(await response.text(), "ok");
    assert.equal(response.headers.get("x-global"), "yes");
    assert.deepEqual(calls, ["global:before", "route:before", "handler", "route:after", "global:after"]);
  } finally {
    await app.close();
  }
});
