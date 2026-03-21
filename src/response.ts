import type { HttpResponse as UWSResponse } from "uWebSockets.js";
import type { OutgoingResponse } from "./types.js";

export class Response implements OutgoingResponse {
  private _status = 200;
  private _headers: Record<string, string> = {};

  constructor(private res: UWSResponse) {}

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
    this._headers[key] = value;
    return this;
  }

  setHeaders(headers: Record<string, string>): this {
    for (const [key, value] of Object.entries(headers)) {
      this._headers[key] = value;
    }
    return this;
  }

  end(data?: string | unknown): this {
    const statusStr = `${this._status}`;
    this.res.cork(() => {
      this.res.writeStatus(statusStr);
      for (const [key, value] of Object.entries(this._headers)) {
        this.res.writeHeader(key, value);
      }
      if (data === undefined) {
        this.res.end();
      } else if (typeof data === "string") {
        this.res.end(data);
      } else {
        this.res.end(JSON.stringify(data));
      }
    });
    return this;
  }

  send(status: number, data?: string | unknown): this {
    this.status(status);
    if (typeof data === "string") {
      this.setHeader("Content-Type", "text/plain");
      return this.end(data);
    } else if (data !== undefined) {
      this.setHeader("Content-Type", "application/json");
      return this.end(JSON.stringify(data));
    }
    return this.end();
  }

  getResponse(): UWSResponse {
    return this.res;
  }
}
