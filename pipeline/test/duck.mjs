// Tiny in-memory DuckDB harness for the SQL unit tests: run a script, read rows back as JSON objects.
import { DuckDBInstance } from "@duckdb/node-api";

export async function duck() {
  const db = await DuckDBInstance.create(":memory:");
  const c = await db.connect();
  return {
    run: (sql) => c.run(sql),
    rows: async (sql) => (await c.runAndReadAll(sql)).getRowObjectsJson(),
    close: () => c.closeSync(),
  };
}

/** Row objects keyed by `key`, for order-free assertions. */
export const byKey = (rows, key) => Object.fromEntries(rows.map((r) => [r[key], r]));
