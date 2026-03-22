import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { type, createValidator, Request, Response } from "../src/index.js";
import test from "node:test";

class FakeIncomingMessage extends EventEmitter {
  method?: string;
  url?: string;
  headers: Record<string, string | string[] | undefined> = {};
  socket = {
    remoteAddress: "::ffff:127.0.0.1",
  };
}

function createRequest(
  method: string,
  url: string,
  headers: Record<string, string | string[] | undefined> = {}
): { req: FakeIncomingMessage; request: Request } {
  const req = new FakeIncomingMessage();
  req.method = method;
  req.url = url;
  req.headers = headers;
  return { req, request: new Request(req as unknown as IncomingMessage, { id: "42" }) };
}

function createResponseRecorder() {
  const headers: Record<string, string> = {};
  const calls: string[] = [];
  const serverResponse = {
    statusCode: 200,
    writableEnded: false,
    setHeader(key: string, value: string) {
      headers[key] = value;
    },
    end(data?: string | Buffer) {
      calls.push(typeof data === "string" ? data : data ? data.toString("utf8") : "");
      this.writableEnded = true;
    },
  } as unknown as ServerResponse;

  return { headers, calls, serverResponse };
}

test("Request exposes normalized path, query, headers, params and body parsing", async () => {
  const { req, request } = createRequest("post", "/users/42?tag=one&tag=two&mode=fast", {
    "content-type": "application/json",
    "x-request-id": "abc",
  });

  assert.equal(request.method, "POST");
  assert.equal(request.path, "/users/42");
  assert.deepEqual(request.params, { id: "42" });
  assert.equal(request.ip, "127.0.0.1");
  assert.deepEqual(request.query, {
    tag: ["one", "two"],
    mode: "fast",
  });
  assert.deepEqual(request.headers, {
    "content-type": "application/json",
    "x-request-id": "abc",
  });

  const schema = type({ name: "string", role: "string" });
  const bodyPromise = request.parseBodyRaw(schema);
  req.emit("data", Buffer.from('{"name":"Ada","role":"admin"}'));
  req.emit("end");

  const body = await bodyPromise;
  assert.deepEqual(body, { name: "Ada", role: "admin" });
  assert.deepEqual(request.body, { name: "Ada", role: "admin" });
  assert.equal(request.bodyParsed, true);

  const parsedAgain = await request.json(schema);
  assert.deepEqual(parsedAgain, { name: "Ada", role: "admin" });
});

test("createValidator returns success and failure states", () => {
  const validator = createValidator(type({ name: "string" }));

  const valid = validator({ name: "Ada" });
  const invalid = validator({ name: 42 });

  assert.equal(valid.ok, true);
  assert.equal(invalid.ok, false);
});

test("Response exposes status, content helpers, headers and suppression for HEAD", () => {
  const jsonRecorder = createResponseRecorder();
  const jsonResponse = new Response(jsonRecorder.serverResponse);

  jsonResponse
    .status(201)
    .setHeader("x-one", "1")
    .setHeaders({ "x-two": "2" })
    .json({ ok: true });

  assert.equal(jsonRecorder.serverResponse.statusCode, 201);
  assert.deepEqual(jsonRecorder.headers, {
    "x-one": "1",
    "x-two": "2",
    "Content-Type": "application/json",
  });
  assert.equal(jsonRecorder.calls[0], '{"ok":true}');
  assert.equal(jsonResponse.isEnded(), true);
  assert.equal(jsonResponse.getResponse(), jsonRecorder.serverResponse);

  const textRecorder = createResponseRecorder();
  const textResponse = new Response(textRecorder.serverResponse);
  textResponse.status(202).text("plain");
  assert.equal(textRecorder.serverResponse.statusCode, 202);
  assert.equal(textRecorder.headers["Content-Type"], "text/plain");
  assert.equal(textRecorder.calls[0], "plain");

  const htmlRecorder = createResponseRecorder();
  const htmlResponse = new Response(htmlRecorder.serverResponse);
  htmlResponse.status(203).html("<strong>ok</strong>");
  assert.equal(htmlRecorder.serverResponse.statusCode, 203);
  assert.equal(htmlRecorder.headers["Content-Type"], "text/html");
  assert.equal(htmlRecorder.calls[0], "<strong>ok</strong>");

  const sendRecorder = createResponseRecorder();
  const sendResponse = new Response(sendRecorder.serverResponse);
  sendResponse.send(204, { created: true });
  assert.equal(sendRecorder.serverResponse.statusCode, 204);
  assert.equal(sendRecorder.headers["Content-Type"], "application/json");
  assert.equal(sendRecorder.calls[0], '{"created":true}');

  const headRecorder = createResponseRecorder();
  const headResponse = new Response(headRecorder.serverResponse, true);
  headResponse.status(200).text("hidden");
  assert.equal(headRecorder.serverResponse.statusCode, 200);
  assert.equal(headRecorder.calls[0], "");
  assert.equal(headResponse.isEnded(), true);
});
