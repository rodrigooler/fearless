import type { ServerResponse } from "node:http";
import type { OutgoingResponse } from "./types.js";

export class Response implements OutgoingResponse {
  private _status = 200;
  private _headers: Record<string, string> = {};
  private _ended = false;

  constructor(private res: ServerResponse, private suppressBody = false) {}

  status(code: number): this {
    this._status = code;
    return this;
  }

  json(data: unknown): this {
    this.setHeader("Content-Type", "application/json");
    return this.end(JSON.stringify(data));
  }

  text(data: string): this {
    this.setHeader("Content-Type", "text/plain");
    return this.end(data);
  }

  html(data: string): this {
    this.setHeader("Content-Type", "text/html");
    return this.end(data);
  }

  setHeader(key: string, value: string): this {
    if (this._ended) {
      return this;
    }

    this._headers[key] = value;
    return this;
  }

  setHeaders(headers: Record<string, string>): this {
    if (this._ended) {
      return this;
    }

    for (const [key, value] of Object.entries(headers)) {
      this._headers[key] = value;
    }
    return this;
  }

  end(data?: string | unknown): this {
    if (this._ended) {
      return this;
    }

    this._ended = true;
    this.res.statusCode = this._status;

    for (const [key, value] of Object.entries(this._headers)) {
      this.res.setHeader(key, value);
    }

    if (this.suppressBody) {
      this.res.end();
      return this;
    }

    if (data === undefined) {
      this.res.end();
      return this;
    }

    if (typeof data === "string" || Buffer.isBuffer(data)) {
      this.res.end(data);
      return this;
    }

    this.res.end(JSON.stringify(data));
    return this;
  }

  send(status: number, data?: string | unknown): this {
    this.status(status);
    if (typeof data === "string") {
      this.setHeader("Content-Type", "text/plain");
      return this.end(data);
    }

    if (data !== undefined) {
      this.setHeader("Content-Type", "application/json");
      return this.end(JSON.stringify(data));
    }

    return this.end();
  }

  getResponse(): ServerResponse {
    return this.res;
  }

  isEnded(): boolean {
    return this._ended || this.res.writableEnded;
  }
}
