#!/usr/bin/env node
// Record-level deltas between this build and the previous published run: added / removed / changed
// properties (by prop_id) and permits (by permit_key). The previous tables are read from the
// previous run directory, or by CID from a public gateway when only its manifest is available.
// Writes <run-dir>/deltas.json (part of the published run).
// Usage: node src/publish/deltas.mjs <county.duckdb> <prev-manifest.json> <run-dir> [--prev-dir <dir>] [--gateway https://ipfs.filebase.io]
import { DuckDBInstance } from "@duckdb/node-api";
import { existsSync, statSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const [dbPath, prevManifestPath, runDir, ...rest] = process.argv.slice(2);
const opt = (n) => (rest.includes(n) ? rest[rest.indexOf(n) + 1] : null);
if (!dbPath || !prevManifestPath || !runDir) {
  console.error("usage: deltas.mjs <county.duckdb> <prev-manifest.json> <run-dir> [--prev-dir d] [--gateway url]");
  process.exit(2);
}
const prev = JSON.parse(await readFile(prevManifestPath, "utf8"));
const prevDir = opt("--prev-dir");
const gateway = opt("--gateway") ?? "https://ipfs.filebase.io";
const lit = (s) => `'${String(s).replaceAll("'", "''")}'`;
// Local copy when present, otherwise fetch the previous snapshot by CID (httpfs range reads).
const source = (name) => {
  if (prevDir && existsSync(join(prevDir, name))) {
    const p = join(prevDir, name);
    return lit(statSync(p).isDirectory() ? join(p, "**", "*.parquet") : p);
  }
  const objs = prev.objects.filter((o) => o.codec === "file" && (o.name === name || o.name.startsWith(`${name}/`)));
  if (!objs.length) throw new Error(`previous manifest has no ${name}`);
  return `[${objs.map((o) => lit(`${gateway}/ipfs/${o.cid}`)).join(", ")}]`;
};

const db = await DuckDBInstance.create(dbPath);
const c = await db.connect();
if (!prevDir) await c.run("install httpfs; load httpfs");

// Fields that change on every rebuild (provenance of the snapshot itself) are excluded from the diff.
const PROP_IGNORE = ["source_url", "source_sha256"];
const PERMIT_IGNORE = ["source_url", "fetched_at", "socrata_id", "window_source", "open_days", "year"];
const columns = async (rel) => (await c.runAndReadAll(`select column_name from (describe ${rel})`)).getRowObjectsJson().map((r) => r.column_name);
// Hash only columns present in both snapshots, so a schema addition is reported as a schema change
// rather than as every record changing.
const hashExpr = (cols) => `md5(concat_ws('|', ${cols.map((x) => `coalesce(cast("${x}" as varchar), '∅')`).join(", ")}))`;

async function diff(label, key, newRel, oldSrc, ignore) {
  await c.run(`create or replace temp view old_${label} as select * from read_parquet(${oldSrc})`);
  const newCols = await columns(newRel);
  const oldCols = await columns(`old_${label}`);
  const shared = newCols.filter((x) => oldCols.includes(x) && !ignore.includes(x));
  const hNew = hashExpr(shared);
  const hOld = hashExpr(shared);
  const r = (await c.runAndReadAll(`
    with n as (select ${key} as k, ${hNew} as h from ${newRel}),
         o as (select ${key} as k, ${hOld} as h from old_${label})
    select count(*) filter (o.k is null) as added,
           count(*) filter (n.k is null) as removed,
           count(*) filter (n.k is not null and o.k is not null and n.h <> o.h) as changed,
           count(*) filter (n.k is not null and o.k is not null and n.h = o.h) as unchanged,
           list(coalesce(n.k, o.k)) filter (o.k is null)[:10] as sample_added,
           list(coalesce(n.k, o.k)) filter (n.k is null)[:10] as sample_removed,
           list(n.k) filter (n.k is not null and o.k is not null and n.h <> o.h)[:10] as sample_changed
    from n full outer join o on n.k = o.k`)).getRowObjectsJson()[0];
  r.schema = { added_columns: newCols.filter((x) => !oldCols.includes(x)), removed_columns: oldCols.filter((x) => !newCols.includes(x)), compared_columns: shared.length };
  console.log(label, JSON.stringify({ added: r.added, removed: r.removed, changed: r.changed, unchanged: r.unchanged, schema: r.schema }));
  return r;
}

const deltas = {
  previous_run_id: prev.run_id,
  previous_root_cid: prev.root.cid,
  computed_at: new Date().toISOString(),
  properties: await diff("properties", "prop_id", "properties", source("tables/properties.parquet"), PROP_IGNORE),
  permits: await diff("permits", "permit_key", "permits", source("tables/permits"), PERMIT_IGNORE),
};
await writeFile(join(runDir, "deltas.json"), JSON.stringify(deltas, null, 2) + "\n");
