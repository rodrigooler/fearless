import { test } from "node:test";
import assert from "node:assert/strict";
import { HookChain } from "../src/middleware.js";
import { RequestContext } from "../src/ctx.js";
import { HttpError } from "../src/errors.js";
import type { Ctx, Handler } from "../src/types.js";

function ctx(): Ctx {
  return RequestContext.fromWeb(new globalThis.Request("http://localhost/test"), {});
}

function ok(body: string): Response {
  return new Response(body, { status: 200, headers: { "Content-Type": "text/plain" } });
}

test("runs hooks in registration order around the handler", async () => {
  const trace: string[] = [];
  const chain = new HookChain()
    .onRequest((c) => { trace.push("req1"); c.state.x = 1; })
    .onRequest((c) => { trace.push("req2"); c.state.y = 2; })
    .onResponse(() => { trace.push("res1"); })
    .onResponse(() => { trace.push("res2"); });

  const handler: Handler = (c) => {
    trace.push("handler");
    assert.equal(c.state.x, 1);
    assert.equal(c.state.y, 2);
    return ok("hello");
  };

  const response = await chain.execute(ctx(), handler);
  assert.equal(await response.text(), "hello");
  assert.deepEqual(trace, ["req1", "req2", "handler", "res1", "res2"]);
});

test("request hook short-circuits — handler is skipped", async () => {
  const trace: string[] = [];
  const chain = new HookChain()
    .onRequest(() => { trace.push("req1"); })
    .onRequest(() => { trace.push("req2-shortcircuit"); return new Response("intercepted", { status: 401 }); })
    .onRequest(() => { trace.push("req3-skipped"); })
    .onResponse(() => { trace.push("res1"); });

  const handler: Handler = () => { trace.push("handler-skipped"); return ok("nope"); };

  const response = await chain.execute(ctx(), handler);
  assert.equal(response.status, 401);
  assert.equal(await response.text(), "intercepted");
  assert.deepEqual(trace, ["req1", "req2-shortcircuit", "res1"]);
});

test("response hook can replace the response", async () => {
  const chain = new HookChain()
    .onResponse(() => new Response("replaced", { status: 418 }));
  const response = await chain.execute(ctx(), () => ok("original"));
  assert.equal(response.status, 418);
  assert.equal(await response.text(), "replaced");
});

test("response hooks chain — last replacement wins", async () => {
  const chain = new HookChain()
    .onResponse(() => new Response("first-replace", { status: 201 }))
    .onResponse((_, r) => new Response(`wrapped(${r.status})`, { status: 202 }));
  const response = await chain.execute(ctx(), () => ok("origin"));
  assert.equal(response.status, 202);
  assert.equal(await response.text(), "wrapped(201)");
});

test("handler throw routes to error hook which can recover", async () => {
  const trace: string[] = [];
  const chain = new HookChain()
    .onResponse(() => { trace.push("res-skipped"); })
    .onError((_, error) => {
      trace.push(`err:${(error as Error).message}`);
      return new Response("recovered", { status: 503 });
    });

  const response = await chain.execute(ctx(), () => { throw new Error("boom"); });
  assert.equal(response.status, 503);
  assert.equal(await response.text(), "recovered");
  assert.deepEqual(trace, ["err:boom"]);
});

test("HttpError without recovery converts via toResponse", async () => {
  const chain = new HookChain();
  const response = await chain.execute(ctx(), () => { throw HttpError.badRequest("nope"); });
  assert.equal(response.status, 400);
  const body = await response.json();
  assert.equal(body.error, "nope");
});

test("non-HttpError without recovery becomes generic 500", async () => {
  const chain = new HookChain();
  const response = await chain.execute(ctx(), () => { throw new Error("oops"); });
  assert.equal(response.status, 500);
  const body = await response.json();
  assert.equal(body.error, "Internal Server Error");
});

test("error hook throwing replaces in-flight error for next hook", async () => {
  const seen: string[] = [];
  const chain = new HookChain()
    .onError((_, error) => {
      seen.push(`first:${(error as Error).message}`);
      throw new Error("replaced");
    })
    .onError((_, error) => {
      seen.push(`second:${(error as Error).message}`);
      return new Response("recovered-from-replaced", { status: 502 });
    });

  const response = await chain.execute(ctx(), () => { throw new Error("original"); });
  assert.equal(response.status, 502);
  assert.equal(await response.text(), "recovered-from-replaced");
  assert.deepEqual(seen, ["first:original", "second:replaced"]);
});

test("error hook returning undefined falls through to default response", async () => {
  const chain = new HookChain()
    .onError(() => { /* observe only */ });
  const response = await chain.execute(ctx(), () => { throw HttpError.unauthorized(); });
  assert.equal(response.status, 401);
});

test("response hook throwing routes through error hooks", async () => {
  const chain = new HookChain()
    .onResponse(() => { throw new Error("response hook bug"); })
    .onError((_, error) => new Response((error as Error).message, { status: 500 }));
  const response = await chain.execute(ctx(), () => ok("ignored"));
  assert.equal(response.status, 500);
  assert.equal(await response.text(), "response hook bug");
});

test("hasHooks reflects registration", () => {
  const empty = new HookChain();
  assert.equal(empty.hasHooks, false);
  empty.onRequest(() => {});
  assert.equal(empty.hasHooks, true);
});

test("async hooks awaited correctly", async () => {
  const chain = new HookChain()
    .onRequest(async (c) => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      c.state.async = true;
    });
  const handler: Handler = (c) => {
    assert.equal(c.state.async, true);
    return ok("async-ok");
  };
  const response = await chain.execute(ctx(), handler);
  assert.equal(await response.text(), "async-ok");
});
