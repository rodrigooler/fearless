/**
 * Phase 1.2: tagged template literal + `fearless.sql(...)` handle namespace.
 *
 * AT BUILD TIME the AOT analyzer/transpiler recognises:
 *   const db = fearless.sql("primary");
 *   await db.queryOne(sql`SELECT id FROM world WHERE id = ${ctx.params.id}`);
 * and emits native Rust code that calls the rust-core typed handle. The
 * functions in this file are NEVER invoked along that path.
 *
 * AT RUNTIME (Bun fallback or `bun run`), `sql` produces a `{ text, values }`
 * shape compatible with Bun's built-in `Bun.sql` driver and `pg`. The
 * `fearless.sql(name)` handle returns a tiny stub whose `queryOne/queryMany/
 * execute` methods throw — Phase 1.2 has no Bun-side runtime for these
 * declarations yet, so any code path that actually awaits them is a bug.
 */

export interface SqlQuery {
  readonly text: string;
  readonly values: readonly unknown[];
}

export function sql(strings: TemplateStringsArray, ...values: unknown[]): SqlQuery {
  let text = strings[0] ?? "";
  for (let i = 0; i < values.length; i++) {
    text += `$${i + 1}` + (strings[i + 1] ?? "");
  }
  return { text, values };
}

/**
 * Row shape returned by `queryOne`/`queryMany`. Phase 1.2 MVP binds every
 * SELECT column to a `string | number | null` (typed-row schema discovery
 * lands in Phase 1.3+). Field access is permissive for ergonomics inside
 * AOT-eligible handlers — the generated Rust handler reads columns by name
 * directly from the SELECT list.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type SqlRow = Record<string, any>;

export interface SqlHandle {
  readonly registeredName: string;
  queryOne(query: SqlQuery): Promise<SqlRow | null>;
  queryMany(query: SqlQuery): Promise<SqlRow[]>;
  execute(query: SqlQuery): Promise<number>;
}

export interface FearlessNamespace {
  sql(registeredName: string): SqlHandle;
}

function makeHandle(registeredName: string): SqlHandle {
  const notImplemented = (method: string): never => {
    throw new Error(
      `[fearless] ${method} on handle "${registeredName}" was called at runtime — this code path is meant to run only inside the AOT-compiled Rust binary. ` +
        `If you need to execute it from Bun, attach a Bun-side adapter (Phase 1.3+).`
    );
  };
  return {
    registeredName,
    async queryOne(_query: SqlQuery): Promise<SqlRow | null> {
      return notImplemented("queryOne");
    },
    async queryMany(_query: SqlQuery): Promise<SqlRow[]> {
      return notImplemented("queryMany");
    },
    async execute(_query: SqlQuery): Promise<number> {
      return notImplemented("execute");
    },
  };
}

export const fearless: FearlessNamespace = {
  sql: makeHandle,
};
