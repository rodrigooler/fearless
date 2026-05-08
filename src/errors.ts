/**
 * HTTP-aware error. When a handler throws an HttpError, the framework converts
 * it to a Response with the embedded status. Other thrown values become 500.
 */
export class HttpError extends Error {
  readonly status: number;
  readonly expose: boolean;
  readonly details?: unknown;

  constructor(status: number, message: string, options?: { expose?: boolean; details?: unknown; cause?: unknown }) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "HttpError";
    this.status = status;
    // Default: expose 4xx messages to clients, hide 5xx (security).
    this.expose = options?.expose ?? status < 500;
    this.details = options?.details;
  }

  toResponse(): Response {
    const body = this.expose
      ? JSON.stringify({ error: this.message, ...(this.details !== undefined ? { details: this.details } : {}) })
      : JSON.stringify({ error: "Internal Server Error" });
    return new Response(body, {
      status: this.status,
      headers: { "Content-Type": "application/json" },
    });
  }

  static badRequest(message = "Bad Request", details?: unknown): HttpError {
    return new HttpError(400, message, { details });
  }

  static unauthorized(message = "Unauthorized"): HttpError {
    return new HttpError(401, message);
  }

  static forbidden(message = "Forbidden"): HttpError {
    return new HttpError(403, message);
  }

  static notFound(message = "Not Found"): HttpError {
    return new HttpError(404, message);
  }

  static conflict(message = "Conflict", details?: unknown): HttpError {
    return new HttpError(409, message, { details });
  }

  static internal(message = "Internal Server Error", cause?: unknown): HttpError {
    return new HttpError(500, message, { cause, expose: false });
  }
}

/**
 * Validation failure. Always 422 with `details` carrying the validator's
 * structured errors. Always exposed to the client.
 */
export class ValidationError extends HttpError {
  constructor(message = "Validation failed", details?: unknown) {
    super(422, message, { expose: true, details });
    this.name = "ValidationError";
  }
}
