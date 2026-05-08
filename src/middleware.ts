import type { Ctx, Handler, RequestHook, ResponseHook, ErrorHook } from "./types.js";
import { HttpError } from "./errors.js";

const FALLBACK_BODY = JSON.stringify({ error: "Internal Server Error" });
const FALLBACK_HEADERS = { "Content-Type": "application/json" };

function defaultErrorResponse(error: unknown): Response {
  if (error instanceof HttpError) {
    return error.toResponse();
  }
  return new Response(FALLBACK_BODY, {
    status: 500,
    headers: FALLBACK_HEADERS,
  });
}

export class HookChain {
  private requestHooks: RequestHook[] = [];
  private responseHooks: ResponseHook[] = [];
  private errorHooks: ErrorHook[] = [];

  onRequest(hook: RequestHook): this {
    this.requestHooks.push(hook);
    return this;
  }

  onResponse(hook: ResponseHook): this {
    this.responseHooks.push(hook);
    return this;
  }

  onError(hook: ErrorHook): this {
    this.errorHooks.push(hook);
    return this;
  }

  /** True if any request/response/error hook has been registered. */
  get hasHooks(): boolean {
    return (
      this.requestHooks.length > 0 ||
      this.responseHooks.length > 0 ||
      this.errorHooks.length > 0
    );
  }

  /**
   * Run the full pipeline. Always resolves to a Response (errors are converted
   * via error hooks or the default 500 fallback).
   */
  async execute(ctx: Ctx, handler: Handler): Promise<Response> {
    let response: Response;

    try {
      const shortCircuit = await this.runRequestHooks(ctx);
      response = shortCircuit ?? (await handler(ctx));
      response = await this.runResponseHooks(ctx, response);
    } catch (error) {
      response = await this.runErrorHooks(ctx, error);
    }

    return response;
  }

  private async runRequestHooks(ctx: Ctx): Promise<Response | undefined> {
    for (const hook of this.requestHooks) {
      const result = await hook(ctx);
      if (result instanceof Response) {
        return result;
      }
    }
    return undefined;
  }

  private async runResponseHooks(ctx: Ctx, initial: Response): Promise<Response> {
    let current = initial;
    for (const hook of this.responseHooks) {
      const result = await hook(ctx, current);
      if (result instanceof Response) {
        current = result;
      }
    }
    return current;
  }

  private async runErrorHooks(ctx: Ctx, initialError: unknown): Promise<Response> {
    let currentError = initialError;
    for (const hook of this.errorHooks) {
      try {
        const result = await hook(ctx, currentError);
        if (result instanceof Response) {
          return result;
        }
      } catch (rethrow) {
        // Replace the in-flight error and continue to the next error hook.
        currentError = rethrow;
      }
    }
    return defaultErrorResponse(currentError);
  }
}
