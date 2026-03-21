import type { Middleware } from "../types.js";

export interface SecurityHeadersOptions {
  contentSecurityPolicy?: string | false;
  crossOriginOpenerPolicy?: string | false;
  crossOriginResourcePolicy?: string | false;
  referrerPolicy?: string | false;
  frameOptions?: string | false;
  noSniff?: boolean;
}

export function securityHeaders(options: SecurityHeadersOptions = {}): Middleware {
  return (_req, res, next) => {
    if (options.noSniff !== false) {
      res.setHeader("X-Content-Type-Options", "nosniff");
    }

    if (options.frameOptions !== false) {
      res.setHeader("X-Frame-Options", options.frameOptions ?? "DENY");
    }

    if (options.referrerPolicy !== false) {
      res.setHeader("Referrer-Policy", options.referrerPolicy ?? "no-referrer");
    }

    if (options.crossOriginOpenerPolicy !== false) {
      res.setHeader("Cross-Origin-Opener-Policy", options.crossOriginOpenerPolicy ?? "same-origin");
    }

    if (options.crossOriginResourcePolicy !== false) {
      res.setHeader("Cross-Origin-Resource-Policy", options.crossOriginResourcePolicy ?? "same-origin");
    }

    if (typeof options.contentSecurityPolicy === "string") {
      res.setHeader("Content-Security-Policy", options.contentSecurityPolicy);
    }

    return next();
  };
}
