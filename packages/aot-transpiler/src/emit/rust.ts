import type { ResponseShape, StaticResponse, DynamicResponse, BodyChunk } from "../types.js";
import { escapeRustByteString } from "./escape.js";
import { statusText } from "./status-text.js";

/**
 * Emit a Rust function body that writes the response into `out` (Vec<u8>).
 * Returns just the function body — the caller wraps in `pub fn ...(req, out) { ... }`.
 */
export function emitResponseBody(response: ResponseShape): string {
  if (response.kind === "static") {
    return emitStatic(response);
  }
  return emitDynamic(response);
}

function emitStatic(response: StaticResponse): string {
  const lines: string[] = [];
  lines.push("    // static response — bytes computed at compile time");

  // Special-case redirect: contentType is "redirect:<location>"
  if (response.contentType.startsWith("redirect:")) {
    const location = response.contentType.slice("redirect:".length);
    const status = response.status;
    const reason = statusText(status);
    const head = `HTTP/1.1 ${status} ${reason}\r\nLocation: ${location}\r\nContent-Length: 0\r\nConnection: keep-alive\r\n\r\n`;
    lines.push(`    out.extend_from_slice(b"${escapeRustByteString(new TextEncoder().encode(head))}");`);
    return lines.join("\n");
  }

  const head = renderResponseHead(response.status, response.contentType, response.bodyBytes.length);
  const fullResponse = new Uint8Array(head.length + response.bodyBytes.length);
  fullResponse.set(head, 0);
  fullResponse.set(response.bodyBytes, head.length);
  lines.push(`    out.extend_from_slice(b"${escapeRustByteString(fullResponse)}");`);
  return lines.join("\n");
}

function renderResponseHead(status: number, contentType: string, contentLength: number): Uint8Array {
  const reason = statusText(status);
  const text =
    `HTTP/1.1 ${status} ${reason}\r\n` +
    `Content-Type: ${contentType}\r\n` +
    `Content-Length: ${contentLength}\r\n` +
    `Connection: keep-alive\r\n\r\n`;
  return new TextEncoder().encode(text);
}

function emitDynamic(response: DynamicResponse): string {
  const lines: string[] = [];
  lines.push("    // dynamic response — body length computed at runtime");

  // Step 1: build body in a temp Vec
  lines.push("    let mut body: Vec<u8> = Vec::with_capacity(64);");
  for (const chunk of response.bodyChunks) {
    lines.push("    " + emitChunk(chunk));
  }

  // Step 2: emit status + headers + Content-Length + body
  const headPrefix =
    `HTTP/1.1 ${response.status} ${statusText(response.status)}\r\n` +
    `Content-Type: ${response.contentType}\r\n` +
    `Connection: keep-alive\r\n` +
    `Content-Length: `;
  lines.push(`    out.extend_from_slice(b"${escapeRustByteString(new TextEncoder().encode(headPrefix))}");`);
  lines.push("    aot_runtime::write_decimal(out, body.len());");
  lines.push(`    out.extend_from_slice(b"\\r\\n\\r\\n");`);
  lines.push("    out.extend_from_slice(&body);");
  return lines.join("\n");
}

function emitChunk(chunk: BodyChunk): string {
  if (chunk.kind === "literal") {
    return `body.extend_from_slice(b"${escapeRustByteString(chunk.bytes)}");`;
  }
  // ctx-read chunk — dispatch by kind
  let getter: string;
  switch (chunk.kind) {
    case "param":
      getter = `req.param("${escapeQuotes(chunk.name)}")`;
      break;
    case "query":
      getter = `req.query_get("${escapeQuotes(chunk.name)}")`;
      break;
    case "header":
      getter = `req.header("${escapeQuotes(chunk.name)}")`;
      break;
    case "input":
      getter = `req.${chunk.name}`;
      break;
  }
  switch (chunk.format) {
    case "raw":
      return `body.extend_from_slice(${getter}.as_bytes());`;
    case "json-string":
      return `aot_runtime::write_json_string(&mut body, ${getter});`;
    case "url":
      return `aot_runtime::write_url_encoded(&mut body, ${getter});`;
  }
}

function escapeQuotes(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}
