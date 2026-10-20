#!/usr/bin/env node
// Check docs/data-contract.md against a published snapshot: for every table documented with a
// column list, the documented columns and types must equal the Parquet schema exactly (order-free).
// Fails (exit 1) on any drift so the contract cannot silently go stale.
// Usage: node src/publish/check-contract.mjs <snapshot-tables-dir> [docs/data-contract.md]
import { DuckDBInstance } from "@duckdb/node-api";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const [tablesDir, contractPath = new URL("../../../docs/data-contract.md", import.meta.url).pathname] = process.argv.slice(2);
if (!tablesDir) {
  console.error("usage: check-contract.mjs <snapshot-tables-dir> [data-contract.md]");
  process.exit(2);
}
const md = await readFile(contractPath, "utf8");

// "### name" sections; rows like "| `column` | TYPE | meaning |".
const documented = new Map();
for (const section of md.split(/^### /m).slice(1)) {
  const name = section.split("\n")[0].trim();
  const cols = [...section.matchAll(/^\| `([a-z0-9_]+)` \| ([A-Z0-9\[\]]+) \|/gm)].map((m) => [m[1], m[2]]);
  if (cols.length) documented.set(name, new Map(cols));
}

const db = await DuckDBInstance.create(":memory:");
const c = await db.connect();
let problems = 0;
for (const [table, cols] of documented) {
  const path = table === "permits" ? join(tablesDir, "permits", "**", "*.parquet") : join(tablesDir, `${table}.parquet`);
  if (table !== "permits" && !existsSync(path)) {
    console.log(`SKIP ${table}: not in this snapshot`);
    continue;
  }
  const actual = new Map(
    (await c.runAndReadAll(`select column_name, column_type from (describe select * from read_parquet('${path}'))`))
      .getRowObjectsJson()
      .filter((r) => !(table === "permits" && r.column_name === "year"))
      .map((r) => [r.column_name, r.column_type]),
  );
  const missing = [...actual.keys()].filter((k) => !cols.has(k));
  const extra = [...cols.keys()].filter((k) => !actual.has(k));
  const typeDiff = [...cols].filter(([k, t]) => actual.has(k) && actual.get(k) !== t).map(([k, t]) => `${k} (${t} != ${actual.get(k)})`);
  const ok = !missing.length && !extra.length && !typeDiff.length;
  if (!ok) problems++;
  console.log(`${ok ? "OK  " : "FAIL"} ${table}: ${actual.size} columns${missing.length ? `; undocumented: ${missing.join(", ")}` : ""}${extra.length ? `; documented but absent: ${extra.join(", ")}` : ""}${typeDiff.length ? `; type mismatch: ${typeDiff.join(", ")}` : ""}`);
}
process.exit(problems ? 1 : 0);
