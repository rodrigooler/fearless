import assert from "node:assert/strict";
import https from "node:https";
import net from "node:net";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { App, securityHeaders } from "../src/index.js";

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
  const app = new App({ port, host: "127.0.0.1", runtime: "node" });

  app.use(securityHeaders());

  app.text("/plaintext", "Hello, World!");
  app.html("/page", "<strong>ok</strong>");
  app.get("/users/:id", {
    kind: "json",
    body: {
      id: "{{ params.id }}",
      query: {
        tag: "{{ query.tag }}",
        mode: "{{ query.mode }}",
      },
      ip: "{{ ip }}",
    },
  });
  app.post("/users/:id", {
    kind: "json",
    status: 201,
    body: {
      id: "{{ params.id }}",
      created: true,
    },
    headers: {
      "x-route-header": "on",
    },
  });

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
        tag: "one, two",
        mode: "fast",
      },
      ip: "127.0.0.1",
    });

    const created = await fetch(`http://127.0.0.1:${port}/users/99`, {
      method: "POST",
    });

    assert.equal(created.headers.get("x-route-header"), "on");
    assert.equal(created.headers.get("content-type"), "application/json");
    assert.deepEqual(await created.json(), {
      id: "99",
      created: true,
    });
  } finally {
    await app.close();
  }
});

test("route headers are preserved on declarative routes", async () => {
  const port = await getFreePort();
  const app = new App({ port, host: "127.0.0.1", runtime: "node" });

  app.text(
    "/protected",
    "ok",
    {
      headers: {
        "x-protected": "yes",
      },
    }
  );

  app.listen();

  try {
    await waitForTcp(port);

    const response = await fetch(`http://127.0.0.1:${port}/protected`);
    assert.equal(await response.text(), "ok");
    assert.equal(response.headers.get("x-protected"), "yes");
  } finally {
    await app.close();
  }
});

test("exact routes win over param routes", async () => {
  const port = await getFreePort();
  const app = new App({ port, host: "127.0.0.1", runtime: "node" });

  app.get("/users/me", { kind: "text", body: "me" });
  app.get("/users/:id", { kind: "text", body: "id: {{ params.id }}" });

  app.listen();

  try {
    await waitForTcp(port);

    const exact = await fetch(`http://127.0.0.1:${port}/users/me`);
    const param = await fetch(`http://127.0.0.1:${port}/users/42`);

    assert.equal(await exact.text(), "me");
    assert.equal(await param.text(), "id: 42");
  } finally {
    await app.close();
  }
});

test("https runtime serves static routes when tls is configured", async () => {
  const port = await getFreePort();
  const app = new App({
    port,
    host: "127.0.0.1",
    runtime: "node",
    keyFileName: tlsKeyFile,
    certFileName: tlsCertFile,
    httpVersion: "2",
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
