#!/usr/bin/env node
// Incremental build: start from the previous published snapshot (read by CID from IPFS, or a local
// run directory), layer a City of Austin permit window on top, and recompute what depends on it.
// Produces the same tables as the full build, so export/deltas/publish run unchanged. Runs without
// the multi-GB raw sources, which is what lets the scheduled refresh run on a free CI runner.
//   - permits: window rows replace their previous versions (same normalization, classifier and
//     deterministic parcel links as the full build); open durations recomputed as of today
//   - roof_age: recomputed from all permits
//   - owners: owner entities and portfolios re-derived from properties (same SQL as the full build)
//   - contractors: re-aggregated from permits; registry identity carried over by contractor key,
//     new contractors marked pending_registry_refresh until the next full identity refresh
// Usage: node src/build/incremental.mjs <out.duckdb> <prev-manifest.json> <window.ndjson>
//          [--prev-dir <run-dir>] [--gateway https://ipfs.filebase.io] [--hail <recent hail-events.parquet>]
import { DuckDBInstance } from "@duckdb/node-api";
import { existsSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { contractorAggSql, hailExposureSql, linkSql, lit, normalizePermitsSql, normName, openDaysSql, ownerRegionFallbackSql, ownersSql, rawPermitsSql, reclassifySql, roofAgeSql, windowSourceSql } from "./permit-sql.mjs";

const [out, prevManifestPath, windowFile, ...rest] = process.argv.slice(2);
const opt = (n) => (rest.includes(n) ? rest[rest.indexOf(n) + 1] : null);
if (!out || !prevManifestPath || !windowFile) {
  console.error("usage: incremental.mjs <out.duckdb> <prev-manifest.json> <window.ndjson> [--prev-dir d] [--gateway url]");
  process.exit(2);
}
const prev = JSON.parse(await readFile(prevManifestPath, "utf8"));
const prevDir = opt("--prev-dir");
const gateway = opt("--gateway") ?? "https://ipfs.filebase.io";
const receipt = { file: windowFile, ...JSON.parse(await readFile(`${windowFile}.receipt.json`, "utf8")) };

const source = (name) => {
  if (prevDir && existsSync(join(prevDir, name))) {
    const p = join(prevDir, name);
    return lit(statSync(p).isDirectory() ? join(p, "**", "*.parquet") : p);
  }
  const objs = prev.objects.filter((o) => o.codec === "file" && (o.name === name || o.name.startsWith(`${name}/`)));
  if (!objs.length) throw new Error(`previous manifest has no ${name}`);
  return `[${objs.map((o) => lit(`${gateway}/ipfs/${o.cid}`)).join(", ")}]`;
};

const db = await DuckDBInstance.create(out);
const c = await db.connect();
const step = async (label, sql) => {
  const t = Date.now();
  await c.run(sql);
  console.error(`${label} (${((Date.now() - t) / 1000).toFixed(1)}s)`);
};
if (!prevDir) await step("httpfs", "install httpfs; load httpfs");

for (const t of ["properties", "owner_signals", "businesses", "licenses", "contractors"]) {
  await step(`load ${t}`, `create or replace table ${t} as select * from read_parquet(${source(`tables/${t}.parquet`)})`);
}
// Partition files fetched by CID carry no year=/ path, so the partition column may be absent.
await step("load permits", `create or replace table permits as select * from read_parquet(${source("tables/permits")});
alter table permits drop column if exists year;
-- open_days is derived, not published (stable snapshots); recreate it before window rows are merged.
alter table permits add column if not exists open_days integer;`);
const before = Number((await c.runAndReadAll("select count(*) as n from permits")).getRowObjectsJson()[0].n);
// Carried permits get the current classifier and status rules (the window gets them in normalize).
await step("reclassify carried permits", reclassifySql("permits"));

// Window rows through the same transform as the full build.
await step("window normalize", rawPermitsSql([windowFile]) + ";\n" + normalizePermitsSql("permits_window"));
await step("window links", openDaysSql("permits_window") + linkSql("permits_window") + windowSourceSql("permits_window", [receipt]));
await step("window county + contractor key", `
alter table permits_window add column county_fips varchar;
-- ZIP -> county from the existing permits (avoids a census download in CI); linked rows are Travis.
update permits_window w set county_fips = case when w.prop_id is not null then '48453' else z.county_fips end
from (select zip, mode(county_fips) as county_fips from permits where zip is not null group by 1) z where z.zip = w.zip;
update permits_window set county_fips = '48453' where prop_id is not null and county_fips is null;
alter table permits_window add column contractor_key varchar;
update permits_window set contractor_key = 'contractor:' || md5(${normName("contractor_company_name")}) where contractor_company_name is not null`);
const win = (await c.runAndReadAll(`
  select count(*) as window_rows, count(*) filter (permit_key in (select permit_key from permits)) as updated_existing
  from permits_window`)).getRowObjectsJson()[0];
await step("upsert", `
delete from permits where permit_key in (select permit_key from permits_window);
insert into permits by name select * from permits_window;`);
await step("open days (all)", openDaysSql("permits"));

await step("roof_age", roofAgeSql);

// Hail: previous snapshot's reports plus a recent NOAA harvest (newer rows win by event_id).
const hailRecent = opt("--hail");
const prevHail = (() => { try { return source("tables/hail_events.parquet"); } catch { return null; } })();
const hailParts = [prevHail && `select * from read_parquet(${prevHail})`, hailRecent && `select * from read_parquet(${lit(hailRecent)})`].filter(Boolean);
await step("hail", (hailParts.length
  ? `create or replace table hail_events as select * exclude (rk) from (
       select *, row_number() over (partition by event_id order by source_url desc) as rk from (${hailParts.join(" union all by name ")})
     ) where rk = 1 order by event_date, event_id;\n`
  : `create or replace table hail_events (event_id varchar, episode_id varchar, event_date date, latitude double, longitude double, hail_inches double, county_zone varchar, report_source varchar, source_url varchar);\n`) + hailExposureSql);
// Older snapshots carried a calendar-dependent years_since_deed; tenure is now computed at query time.
await step("owner_signals", "alter table owner_signals drop column if exists years_since_deed;\n" + ownerRegionFallbackSql);
await step("owners", ownersSql + `;
alter table owner_signals add column if not exists owner_key varchar;
update owner_signals o set owner_key = po.owner_key from prop_owner po where po.prop_id = o.prop_id`);

await step("contractors", `
create or replace temp table prev_contractors as select * from contractors;
create or replace table contractors as
with agg as (${contractorAggSql})
select a.contractor_key, a.name_norm, a.display_name, a.phones, a.trades, a.city, a.zip, a.permit_count, a.roofing_permit_count,
       a.first_permit, a.last_permit,
       p.taxpayer_number, p.sos_file_number, p.legal_name, p.right_to_transact_business,
       coalesce(p.identity_status, 'pending_registry_refresh') as identity_status,
       case when p.tdlr_licenses is null or p.tdlr_licenses = '' then null else list_sort(string_split(p.tdlr_licenses, ';')) end as tdlr_licenses,
       p.bbb_rating, case when p.bbb_rating is not null then p.bbb_status else 'excluded_no_public_api_http_403' end as bbb_status
from agg a left join prev_contractors p using (contractor_key)`);
// export.mjs expects the build's list/derived columns.
await step("shape for export", `
alter table licenses add column if not exists name_norm varchar;
update licenses set name_norm = ${normName("business_name")};`);

const after = (await c.runAndReadAll(`select count(*) as permits,
  count(*) filter (roofing_work in ('roof_replacement','roof_repair') and status_bucket in ('open','expired_unfinaled')) as roofing_open,
  (select count(*) from contractors where identity_status = 'pending_registry_refresh') as contractors_pending
  from permits`)).getRowObjectsJson()[0];
console.log(JSON.stringify({ previous_run: prev.run_id, window_since: receipt.window_since, permits_before: before, ...win, ...after }));
