import assert from "node:assert/strict";
import https from "node:https";
import net from "node:net";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { App, securityHeaders } from "../src/index.js";

function parseUser(data: unknown): { name: string; role: string } | null {
  if (!data || typeof data !== "object") {
    return null;
  }

  const candidate = data as Record<string, unknown>;
  if (typeof candidate.name !== "string" || typeof candidate.role !== "string") {
    return null;
  }

  return {
    name: candidate.name,
    role: candidate.role,
  };
}

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

const tlsKeyFile = fileURLToPath(new URL("./fixtures/tls/server-key.pem", import.meta.url));
const tlsCertFile = fileURLToPath(new URL("./fixtures/tls/server-cert.pem", import.meta.url));

async function httpsGet(
  port: number,
  path: string
): Promise<{ statusCode: number; body: string; headers: Record<string, string | string[] | undefined> }> {
  return await new Promise((resolve, reject) => {
    const request = https.request(
      {
        host: "127.0.0.1",
        port,
        path,
        method: "GET",
        rejectUnauthorized: false,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
        response.on("end", () => {
          resolve({
            statusCode: response.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
            headers: response.headers,
          });
        });
      }
    );

    request.on("error", reject);
    request.end();
  });
}

test("http runtime serves static routes, params, query strings and json bodies", async () => {
  const port = await getFreePort();
  const app = new App({ port, host: "127.0.0.1" });

  app.use(securityHeaders());

  app.text("/plaintext", "Hello, World!");
  app.html("/page", "<strong>ok</strong>");
  app.get("/users/:id", (req, res) => {
    res.json({
      id: req.params.id,
      query: req.query,
      ip: req.ip,
    });
  });
  app.post(
    "/users/:id",
    async (req, res) => {
      const body = await req.parseBodyRaw(parseUser);
      if (!body) {
        return res.status(400).json({ error: "invalid body" });
      }

      res.json({
        id: req.params.id,
        body,
      });
    },
    {
      middlewares: [
        async (_req, res, next) => {
          res.setHeader("x-route-middleware", "on");
          await next();
        },
      ],
    }
  );

  app.listen();

  try {
    await waitForTcp(port);

    const plaintext = await fetch(`http://127.0.0.1:${port}/plaintext`);
    assert.equal(await plaintext.text(), "Hello, World!");
    assert.equal(plaintext.headers.get("content-type"), "text/plain");
    assert.equal(plaintext.headers.get("x-content-type-options"), "nosniff");

    const html = await fetch(`http://127.0.0.1:${port}/page`);
    assert.equal(await html.text(), "<strong>ok</strong>");
    assert.equal(html.headers.get("content-type"), "text/html");
    assert.equal(html.headers.get("cross-origin-opener-policy"), "same-origin");

    const user = await fetch(`http://127.0.0.1:${port}/users/42?tag=one&tag=two&mode=fast`);
    const userJson = await user.json();
    assert.deepEqual(userJson, {
      id: "42",
      query: {
        tag: ["one", "two"],
        mode: "fast",
      },
      ip: "127.0.0.1",
    });

    const created = await fetch(`http://127.0.0.1:${port}/users/99`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({ name: "Ada", role: "admin" }),
    });

    assert.equal(created.headers.get("x-route-middleware"), "on");
    assert.equal(created.headers.get("content-type"), "application/json");
    assert.deepEqual(await created.json(), {
      id: "99",
      body: {
        name: "Ada",
        role: "admin",
      },
    });
  } finally {
    await app.close();
  }
});

test("static route middlewares run on the http runtime", async () => {
  const port = await getFreePort();
  const app = new App({ port, host: "127.0.0.1" });
  const calls: string[] = [];

  app.text(
    "/protected",
    "ok",
    {
      middlewares: [
        async (_req, res, next) => {
          calls.push("route:before");
          res.setHeader("x-protected", "yes");
          await next();
          calls.push("route:after");
        },
      ],
    }
  );

  app.listen();

  try {
    await waitForTcp(port);

    const response = await fetch(`http://127.0.0.1:${port}/protected`);
    assert.equal(await response.text(), "ok");
    assert.equal(response.headers.get("x-protected"), "yes");
    assert.deepEqual(calls, ["route:before", "route:after"]);
  } finally {
    await app.close();
  }
});

test("https runtime serves static routes when tls is configured", async () => {
  const port = await getFreePort();
  const app = new App({
    port,
    host: "127.0.0.1",
    keyFileName: tlsKeyFile,
    certFileName: tlsCertFile,
  });

  app.text("/secure", "ok");
  app.listen();

  try {
    await waitForTcp(port);

    const response = await httpsGet(port, "/secure");
    assert.equal(response.statusCode, 200);
    assert.equal(response.body, "ok");
    assert.equal(response.headers["content-type"], "text/plain");
  } finally {
    await app.close();
  }
});
