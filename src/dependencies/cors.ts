import type { BuiltinCorsConfig, BuiltinFeature } from "../types.js";

export interface CorsOptions {
  origin?: string | boolean;
  methods?: string[];
  allowedHeaders?: string[];
  exposedHeaders?: string[];
  credentials?: boolean;
  maxAge?: number;
  optionsSuccessStatus?: number;
}

function serializeOrigin(origin: CorsOptions["origin"]): string | null {
  if (origin === false) {
    return null;
  }

  if (origin === undefined || origin === true) {
    return "*";
  }

  return origin;
}

function buildCorsConfig(options: CorsOptions): BuiltinCorsConfig {
  return {
    origin: serializeOrigin(options.origin),
    methods: options.methods?.join(", ") ?? "GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS",
    allowedHeaders: options.allowedHeaders?.join(", ") ?? null,
    exposedHeaders: options.exposedHeaders?.join(", ") ?? null,
    credentials: options.credentials === true,
    maxAge:
      typeof options.maxAge === "number" && Number.isFinite(options.maxAge) && options.maxAge >= 0
        ? Math.floor(options.maxAge)
        : null,
    optionsSuccessStatus: options.optionsSuccessStatus ?? 204,
  };
}

export function cors(options: CorsOptions = {}): BuiltinFeature {
  return {
    kind: "cors",
    config: buildCorsConfig(options),
  };
}
