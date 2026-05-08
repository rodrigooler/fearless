import { test } from "node:test";
import assert from "node:assert/strict";
import { App, HttpError } from "../src/index.js";

async function withApp(fn: (app: App, base: string) => Promise<void>): Promise<void> {
  const port = 30000 + Math.floor(Math.random() * 5000);
  const app = new App({ port, host: "127.0.0.1", runtime: "node" });
  await new Promise<void>((resolve, reject) => {
    app.listen((started) => (started ? resolve() : reject(new Error("failed to listen"))));
  });
  try {
    await fn(app, `http://127.0.0.1:${port}`);
  } finally {
    await app.close();
  }
}

test("handler route returns json", async () => {
  await withApp(async (app, base) => {
    app.get("/users/:id", (ctx) => ctx.json({ id: ctx.params.id }));
    const response = await fetch(`${base}/users/42`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(body, { id: "42" });
  });
});

test("handler route can read JSON body", async () => {
  await withApp(async (app, base) => {
    app.post("/echo", async (ctx) => {
      const body = await ctx.body<{ msg: string }>();
      return ctx.json({ echoed: body.msg });
    });
    const response = await fetch(`${base}/echo`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ msg: "hi" }),
    });
    const body = await response.json();
    assert.deepEqual(body, { echoed: "hi" });
  });
});

test("HttpError thrown in handler converts to status response", async () => {
  await withApp(async (app, base) => {
    app.get("/missing", () => {
      throw HttpError.notFound("user not found");
    });
    const response = await fetch(`${base}/missing`);
    assert.equal(response.status, 404);
    const body = await response.json();
    assert.equal(body.error, "user not found");
  });
});

test("non-HttpError throws become generic 500", async () => {
  await withApp(async (app, base) => {
    app.get("/boom", () => {
      throw new Error("internal bug");
    });
    const response = await fetch(`${base}/boom`);
    assert.equal(response.status, 500);
    const body = await response.json();
    assert.equal(body.error, "Internal Server Error");
  });
});

test("onRequest hook can short-circuit", async () => {
  await withApp(async (app, base) => {
    app.onRequest((ctx) => {
      if (ctx.headers["x-block"] === "1") {
        return ctx.status(401).json({ error: "blocked" });
      }
    });
    app.get("/private", (ctx) => ctx.json({ ok: true }));

    const blocked = await fetch(`${base}/private`, { headers: { "x-block": "1" } });
    assert.equal(blocked.status, 401);

    const ok = await fetch(`${base}/private`);
    assert.equal(ok.status, 200);
  });
});

test("onResponse hook can replace response", async () => {
  await withApp(async (app, base) => {
    app.onResponse((_, response) => {
      const headers = new Headers(response.headers);
      headers.set("X-Wrapped", "yes");
      return new Response(response.body, { status: response.status, headers });
    });
    app.get("/x", (ctx) => ctx.json({ ok: true }));
    const response = await fetch(`${base}/x`);
    assert.equal(response.headers.get("x-wrapped"), "yes");
  });
});

test("onError hook can recover", async () => {
  await withApp(async (app, base) => {
    app.onError((ctx, error) => ctx.status(503).json({ caught: (error as Error).message }));
    app.get("/down", () => {
      throw new Error("db unavailable");
    });
    const response = await fetch(`${base}/down`);
    assert.equal(response.status, 503);
    const body = await response.json();
    assert.deepEqual(body, { caught: "db unavailable" });
  });
});

test("template route still works alongside handler routes", async () => {
  await withApp(async (app, base) => {
    app.text("/plaintext", "Hello, World!");
    app.get("/dynamic", (ctx) => ctx.json({ ip: ctx.ip }));
    const text = await fetch(`${base}/plaintext`);
    assert.equal(await text.text(), "Hello, World!");
    const dyn = await fetch(`${base}/dynamic`);
    const body = await dyn.json();
    assert.equal(typeof body.ip, "string");
  });
});

test("handler routes block runtime: 'rust'", () => {
  const port = 35555;
  const app = new App({ port, runtime: "rust" });
  app.get("/handler", (ctx) => ctx.json({}));
  assert.throws(
    () => app.listen(),
    (err: Error) => err.message.includes("Handler routes are not compatible")
  );
});
