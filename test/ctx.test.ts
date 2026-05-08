import { test } from "node:test";
import assert from "node:assert/strict";
import { RequestContext } from "../src/ctx.js";
import { HttpError, ValidationError } from "../src/errors.js";

function makeWebReq(opts: { method?: string; url: string; body?: string; headers?: Record<string, string> }) {
  return new globalThis.Request(opts.url, {
    method: opts.method ?? "GET",
    headers: opts.headers,
    body: opts.body,
  });
}

test("ctx.fromWeb exposes method/path/url/params/query/headers/ip", () => {
  const ctx = RequestContext.fromWeb(
    makeWebReq({ url: "http://localhost/users/42?foo=bar&foo=baz" }),
    { id: "42" },
    "127.0.0.1"
  );
  assert.equal(ctx.method, "GET");
  assert.equal(ctx.path, "/users/42");
  assert.equal(ctx.url, "/users/42?foo=bar&foo=baz");
  assert.deepEqual(ctx.params, { id: "42" });
  assert.deepEqual(ctx.query, { foo: ["bar", "baz"] });
  assert.equal(ctx.ip, "127.0.0.1");
});

test("ctx.body parses JSON", async () => {
  const ctx = RequestContext.fromWeb(
    makeWebReq({ method: "POST", url: "http://localhost/", body: JSON.stringify({ hello: "world" }), headers: { "content-type": "application/json" } }),
    {}
  );
  const body = await ctx.body<{ hello: string }>();
  assert.equal(body.hello, "world");
});

test("ctx.body throws HttpError 400 on invalid JSON", async () => {
  const ctx = RequestContext.fromWeb(
    makeWebReq({ method: "POST", url: "http://localhost/", body: "not json" }),
    {}
  );
  await assert.rejects(() => ctx.body(), (err: unknown) => err instanceof HttpError && (err as HttpError).status === 400);
});

test("ctx.body returns null for empty body", async () => {
  const ctx = RequestContext.fromWeb(makeWebReq({ url: "http://localhost/" }), {});
  const body = await ctx.body();
  assert.equal(body, null);
});

test("ctx.text caches across calls", async () => {
  const ctx = RequestContext.fromWeb(
    makeWebReq({ method: "POST", url: "http://localhost/", body: "hello" }),
    {}
  );
  assert.equal(await ctx.text(), "hello");
  assert.equal(await ctx.text(), "hello");
});

test("ctx.validate throws ValidationError when validator returns null", async () => {
  const ctx = RequestContext.fromWeb(
    makeWebReq({ method: "POST", url: "http://localhost/", body: JSON.stringify({ x: 1 }), headers: { "content-type": "application/json" } }),
    {}
  );
  await assert.rejects(
    () => ctx.validate(() => null),
    (err: unknown) => err instanceof ValidationError && (err as ValidationError).status === 422
  );
});

test("ctx.json builds Response with json content-type", async () => {
  const ctx = RequestContext.fromWeb(makeWebReq({ url: "http://localhost/" }), {});
  const response = ctx.json({ ok: true });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "application/json");
  assert.deepEqual(await response.json(), { ok: true });
});

test("ctx.status chains into next builder", async () => {
  const ctx = RequestContext.fromWeb(makeWebReq({ url: "http://localhost/" }), {});
  const response = ctx.status(201).json({ created: true });
  assert.equal(response.status, 201);
});

test("ctx.header chains into next builder", async () => {
  const ctx = RequestContext.fromWeb(makeWebReq({ url: "http://localhost/" }), {});
  const response = ctx.header("X-Request-Id", "abc").json({});
  assert.equal(response.headers.get("x-request-id"), "abc");
});

test("ctx.redirect default 302 with Location header", async () => {
  const ctx = RequestContext.fromWeb(makeWebReq({ url: "http://localhost/" }), {});
  const response = ctx.redirect("/elsewhere");
  assert.equal(response.status, 302);
  assert.equal(response.headers.get("location"), "/elsewhere");
});

test("ctx.notFound returns 404", async () => {
  const ctx = RequestContext.fromWeb(makeWebReq({ url: "http://localhost/" }), {});
  const response = ctx.notFound();
  assert.equal(response.status, 404);
  assert.equal(await response.text(), "Not Found");
});

test("ctx.noContent returns 204 with null body", async () => {
  const ctx = RequestContext.fromWeb(makeWebReq({ url: "http://localhost/" }), {});
  const response = ctx.noContent();
  assert.equal(response.status, 204);
  assert.equal(response.body, null);
});

test("ctx.state survives across builder calls", () => {
  const ctx = RequestContext.fromWeb(makeWebReq({ url: "http://localhost/" }), {});
  ctx.state.userId = 42;
  assert.equal(ctx.state.userId, 42);
});

test("pending shape resets after finalize", async () => {
  const ctx = RequestContext.fromWeb(makeWebReq({ url: "http://localhost/" }), {});
  ctx.status(500);
  const first = ctx.json({});
  assert.equal(first.status, 500);
  // Next call without explicit status should be the default 200.
  const second = ctx.json({});
  assert.equal(second.status, 200);
});
