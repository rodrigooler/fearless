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

test("API surface covers all route verbs, listen callback and lifecycle", async () => {
  const port = await getFreePort();
  const app = new App({ port, host: "127.0.0.1" });
  let started = false;

  app.get("/resource", (_req, res) => {
    res.text("get");
  });

  app.post("/resource", (_req, res) => {
    res.status(201).json({ method: "POST" });
  });

  app.put("/resource", (_req, res) => {
    res.status(202).text("put");
  });

  app.patch("/resource", (_req, res) => {
    res.status(203).end("patch");
  });

  app.delete("/resource", (_req, res) => {
    res.status(204).end();
  });

  app.options("/resource", (_req, res) => {
    res.status(204).setHeader("allow", "GET, POST, PUT, PATCH, DELETE, OPTIONS, HEAD").end();
  });

  app.head("/head", (_req, res) => {
    res.status(200).text("hidden");
  });

  app.listen((ok) => {
    started = ok;
  });

  try {
    await waitForTcp(port);
    assert.equal(started, true);

    const getResponse = await fetch(`http://127.0.0.1:${port}/resource`);
    assert.equal(getResponse.status, 200);
    assert.equal(await getResponse.text(), "get");

    const headResponse = await fetch(`http://127.0.0.1:${port}/resource`, {
      method: "HEAD",
    });
    assert.equal(headResponse.status, 200);
    assert.equal(await headResponse.text(), "");

    const postResponse = await fetch(`http://127.0.0.1:${port}/resource`, {
      method: "POST",
    });
    assert.equal(postResponse.status, 201);
    assert.deepEqual(await postResponse.json(), { method: "POST" });

    const putResponse = await fetch(`http://127.0.0.1:${port}/resource`, {
      method: "PUT",
    });
    assert.equal(putResponse.status, 202);
    assert.equal(await putResponse.text(), "put");

    const patchResponse = await fetch(`http://127.0.0.1:${port}/resource`, {
      method: "PATCH",
    });
    assert.equal(patchResponse.status, 203);
    assert.equal(await patchResponse.text(), "patch");

    const deleteResponse = await fetch(`http://127.0.0.1:${port}/resource`, {
      method: "DELETE",
    });
    assert.equal(deleteResponse.status, 204);
    assert.equal(await deleteResponse.text(), "");

    const optionsResponse = await fetch(`http://127.0.0.1:${port}/resource`, {
      method: "OPTIONS",
    });
    assert.equal(optionsResponse.status, 204);
    assert.equal(optionsResponse.headers.get("allow"), "GET, POST, PUT, PATCH, DELETE, OPTIONS, HEAD");
    assert.equal(await optionsResponse.text(), "");

    const explicitHeadResponse = await fetch(`http://127.0.0.1:${port}/head`, {
      method: "HEAD",
    });
    assert.equal(explicitHeadResponse.status, 200);
    assert.equal(await explicitHeadResponse.text(), "");
  } finally {
    await app.close();
    await app.close();
  }
});
