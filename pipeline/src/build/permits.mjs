#!/usr/bin/env node
// Build `permits` from harvested City of Austin permit NDJSON into the county DuckDB.
// - Links each permit to a TCAD parcel (deterministic geo_id/prop_id links, see permit-sql.mjs) and
//   keeps valid-unlinked permits rather than dropping them.
// - Classifies roofing work from the description (Austin has no re-roof work class; the
//   'Roof' work class is mostly electrical work on roofs).
// - Buckets status and computes open duration so long-open permits can be queried.
// Usage: node src/build/permits.mjs <county.duckdb> <base.ndjson> [window.ndjson ...]
// Later harvests win: each permit keeps the version from the most recent fetch (window refreshes
// layered over the full pull), and every row records which harvest it came from.
import { DuckDBInstance } from "@duckdb/node-api";
import { readFile } from "node:fs/promises";
import { linkSql, normalizePermitsSql, openDaysSql, rawPermitsSql, windowSourceSql } from "./permit-sql.mjs";

const [dbPath, ...inputs] = process.argv.slice(2);
if (!dbPath || !inputs.length) {
  console.error("usage: permits.mjs <county.duckdb> <base.ndjson> [window.ndjson ...]");
  process.exit(2);
}
const receipts = await Promise.all(inputs.map(async (f) => ({ file: f, ...JSON.parse(await readFile(`${f}.receipt.json`, "utf8")) })));

const db = await DuckDBInstance.create(dbPath);
const c = await db.connect();
const t0 = Date.now();
await c.run(rawPermitsSql(inputs));
await c.run(normalizePermitsSql("permits"));
await c.run(openDaysSql("permits"));
await c.run(linkSql("permits"));
await c.run(windowSourceSql("permits", receipts));

const s = await c.runAndReadAll(`
select count(*) as permits,
       count(prop_id) as linked_to_parcel,
       count(*) filter (prop_id is null and tcad_id is not null) as tcad_id_not_in_roll,
       count(*) filter (tcad_id is null) as no_tcad_id,
       count(*) filter (roofing_work = 'roof_replacement') as roof_replacement,
       count(*) filter (roofing_work = 'roof_repair') as roof_repair,
       count(*) filter (roofing_work is not null and status_bucket in ('open','expired_unfinaled')) as roofing_open_or_unfinaled
from permits`);
console.log(JSON.stringify({ ...s.getRowObjectsJson()[0], harvests: receipts.map((r) => ({ file: r.file, window_since: r.window_since, written: r.written })), seconds: Math.round((Date.now() - t0) / 1000) }));
