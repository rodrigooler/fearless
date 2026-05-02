import type { BuiltinFeature, BuiltinSecurityHeadersConfig } from "../types.js";

export interface SecurityHeadersOptions {
  contentSecurityPolicy?: string | false;
  crossOriginOpenerPolicy?: string | false;
  crossOriginResourcePolicy?: string | false;
  referrerPolicy?: string | false;
  frameOptions?: string | false;
  noSniff?: boolean;
}

function buildSecurityHeadersConfig(options: SecurityHeadersOptions): BuiltinSecurityHeadersConfig {
  return {
    contentSecurityPolicy: options.contentSecurityPolicy === false ? null : options.contentSecurityPolicy ?? null,
    crossOriginOpenerPolicy:
      options.crossOriginOpenerPolicy === false ? null : options.crossOriginOpenerPolicy ?? "same-origin",
    crossOriginResourcePolicy:
      options.crossOriginResourcePolicy === false ? null : options.crossOriginResourcePolicy ?? "same-origin",
    referrerPolicy: options.referrerPolicy === false ? null : options.referrerPolicy ?? "no-referrer",
    frameOptions: options.frameOptions === false ? null : options.frameOptions ?? "DENY",
    noSniff: options.noSniff !== false,
  };
}

export function securityHeaders(options: SecurityHeadersOptions = {}): BuiltinFeature {
  return {
    kind: "securityHeaders",
    config: buildSecurityHeadersConfig(options),
  };
}
