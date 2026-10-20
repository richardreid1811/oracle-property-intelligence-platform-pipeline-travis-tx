#!/usr/bin/env node
// Harvest NOAA NCEI Storm Events hail reports around Travis County, TX.
// Source: https://www.ncei.noaa.gov/pub/data/swdi/stormevents/csvfiles/ (one "details" file per year).
// Each yearly file is downloaded, hashed (receipt), and filtered to EVENT_TYPE = 'Hail' with a begin
// point inside the county bounding box plus a ~10-mile buffer (hail swaths cross county lines).
// Output: <out-dir>/hail-events.parquet + receipt.json
// Usage: node src/sources/noaa-hail.mjs <out-dir> [--from 1996] [--to <current year>]
import { DuckDBInstance } from "@duckdb/node-api";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const INDEX = "https://www.ncei.noaa.gov/pub/data/swdi/stormevents/csvfiles/";
// Travis County extent (from TCAD centroids) widened by ~0.15 degrees.
const BBOX = { minLat: 29.87, maxLat: 30.78, minLon: -98.33, maxLon: -97.22 };

const [outDir, ...rest] = process.argv.slice(2);
const opt = (n, d) => (rest.includes(n) ? rest[rest.indexOf(n) + 1] : d);
const from = Number(opt("--from", "1996"));
const to = Number(opt("--to", String(new Date().getUTCFullYear())));
if (!outDir) {
  console.error("usage: noaa-hail.mjs <out-dir> [--from 1996] [--to YYYY]");
  process.exit(2);
}
const lit = (s) => `'${String(s).replaceAll("'", "''")}'`;
const filesDir = join(outDir, "files");
await mkdir(filesDir, { recursive: true });

async function get(url, attempts = 4) {
  for (let i = 1; ; i++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(300_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return Buffer.from(await res.arrayBuffer());
    } catch (e) {
      if (i >= attempts) throw new Error(`${url}: ${e.message}`);
      await new Promise((r) => setTimeout(r, 3000 * i));
    }
  }
}

// The directory listing names the current revision of each year's file (c<creation date>).
const listing = (await get(INDEX)).toString();
const names = [...new Set([...listing.matchAll(/StormEvents_details-ftp_v1\.0_d(\d{4})_c(\d{8})\.csv\.gz/g)].map((m) => m[0]))];
const byYear = new Map();
for (const n of names) {
  const [, y, c] = n.match(/_d(\d{4})_c(\d{8})/);
  if (Number(y) >= from && Number(y) <= to && (!byYear.has(y) || byYear.get(y).c < c)) byYear.set(y, { name: n, c });
}

const files = [];
for (const [year, { name }] of [...byYear].sort()) {
  const path = join(filesDir, name);
  const bytes = existsSync(path) ? await readFile(path) : await get(INDEX + name);
  if (!existsSync(path)) await writeFile(path, bytes);
  files.push({ year: Number(year), url: INDEX + name, path, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
  process.stderr.write(`\r${name} (${(bytes.length / 1e6).toFixed(1)} MB)`);
}
process.stderr.write("\n");

const db = await DuckDBInstance.create(":memory:");
const c = await db.connect();
await c.run(`create table src (path varchar, url varchar)`);
for (const f of files) await c.run(`insert into src values (${lit(f.path)}, ${lit(f.url)})`);
await c.run(`
create table hail as
select
  cast(EVENT_ID as varchar) as event_id,
  cast(EPISODE_ID as varchar) as episode_id,
  make_date(cast(BEGIN_YEARMONTH as integer) // 100, cast(BEGIN_YEARMONTH as integer) % 100, cast(BEGIN_DAY as integer)) as event_date,
  try_cast(BEGIN_LAT as double) as latitude,
  try_cast(BEGIN_LON as double) as longitude,
  try_cast(MAGNITUDE as double) as hail_inches,
  CZ_NAME as county_zone, SOURCE as report_source,
  s.url as source_url
-- All yearly files share one schema. A few rows in the national files have unescaped quotes; they are captured in reject tables and
-- checked below so no Texas hail report can be silently dropped.
from read_csv([${files.map((f) => lit(f.path)).join(", ")}], all_varchar = true, filename = true,
              store_rejects = true, rejects_scan = 'reject_scans', rejects_table = 'reject_errors') r
join src s on s.path = r.filename
where EVENT_TYPE = 'Hail' and STATE = 'TEXAS'
  and try_cast(BEGIN_LAT as double) between ${BBOX.minLat} and ${BBOX.maxLat}
  and try_cast(BEGIN_LON as double) between ${BBOX.minLon} and ${BBOX.maxLon}
order by event_date, event_id`);
await c.run(`copy (select * from hail) to ${lit(join(outDir, "hail-events.parquet"))} (FORMAT parquet, COMPRESSION zstd)`);
const stats = (await c.runAndReadAll(`select count(*) as events, min(event_date) as first, max(event_date) as last,
  count(*) filter (hail_inches >= 1) as ge_1in, max(hail_inches) as max_in from hail`)).getRowObjectsJson()[0];
const rejects = (await c.runAndReadAll(`select count(*) as rejected_rows,
  count(*) filter (csv_line ilike '%"TEXAS"%' and csv_line ilike '%"Hail"%') as rejected_texas_hail from reject_errors`)).getRowObjectsJson()[0];
if (Number(rejects.rejected_texas_hail) > 0) throw new Error(`${rejects.rejected_texas_hail} Texas hail rows failed to parse`);
const receipt = { source: INDEX, bbox: BBOX, years: [from, to], files: files.map(({ path, ...f }) => f), ...stats, ...rejects, fetched_at: new Date().toISOString() };
await writeFile(join(outDir, "receipt.json"), JSON.stringify(receipt, null, 2) + "\n");
console.log(JSON.stringify({ files: files.length, ...stats }));
