import { createHash } from "node:crypto";

/**
 * Generate a stable, short key for a SQL statement based on the handle name
 * and SQL text. Used as the key in the build-time STATEMENTS map that the
 * generated Rust handler references via `handles.<kind>.get(...).query_X(KEY, ...)`.
 *
 * Format: `<handleVar>_<8-char-sha256>`. Stable across builds for the same
 * (handleVar, sqlText) pair.
 */
export function makeStatementKey(handleVar: string, sqlText: string): string {
  const hash = createHash("sha256")
    .update(`${handleVar}\0${sqlText}`)
    .digest("hex")
    .slice(0, 8);
  return `${handleVar}_${hash}`;
}
