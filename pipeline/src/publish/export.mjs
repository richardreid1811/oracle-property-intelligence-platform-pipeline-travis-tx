#!/usr/bin/env node
// Export the publishable query layer from the county DuckDB into a run directory:
//   tables/*.parquet          deterministic (fixed order, zstd, fixed row-group size)
//   tables/permits/year=YYYY/ partitioned so unchanged history keeps its CIDs run to run
//   samples/*.csv             small human-readable extracts
//   coverage.json             counts, coverage and source limitations for this snapshot
// Usage: node src/publish/export.mjs <county.duckdb> <run-dir>
import { DuckDBInstance } from "@duckdb/node-api";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const [dbPath, runDir] = process.argv.slice(2);
if (!dbPath || !runDir) {
  console.error("usage: export.mjs <county.duckdb> <run-dir>");
  process.exit(2);
}
const lit = (s) => `'${String(s).replaceAll("'", "''")}'`;
const PARQUET = "(FORMAT parquet, COMPRESSION zstd, ROW_GROUP_SIZE 100000)";

const db = await DuckDBInstance.create(dbPath, { threads: "1" }); // single thread: byte-stable output
const c = await db.connect();
await c.run("set preserve_insertion_order = true");
for (const d of ["tables", "samples"]) await mkdir(join(runDir, d), { recursive: true });

const copy = async (name, sql) => {
  const t = Date.now();
  await c.run(`copy (${sql}) to ${lit(join(runDir, "tables", `${name}.parquet`))} ${PARQUET}`);
  console.log(`tables/${name}.parquet (${((Date.now() - t) / 1000).toFixed(1)}s)`);
};

// One denormalized lead row per property: what the UI, agent and MCP query first.
await c.run(`
create or replace temp table leads as
with open_roof as (
  select prop_id,
         count(*) as open_roofing_permits,
         -- Dates, not day counts: published tables hold stable facts; queries compute duration as of today.
         min(opened_date) as oldest_open_date,
         arg_max(permit_number, struct_pack(d := open_days, k := permit_key)) as oldest_open_permit,
         arg_max(contractor_company_name, struct_pack(d := open_days, k := permit_key)) as oldest_open_contractor
  from permits
  where prop_id is not null and roofing_work in ('roof_replacement', 'roof_repair')
    and status_bucket in ('open', 'expired_unfinaled')
  group by 1
)
select p.prop_id, p.geo_id, p.situs_address, p.situs_zip, p.jurisdiction,
       p.latitude, p.longitude, p.coordinate_basis,
       p.owner_name, p.owner_count, p.mail_city, p.mail_state, p.mail_zip,
       o.owner_mail_region, o.mails_to_property, o.owner_occupied_homestead,
       o.deed_date, o.owner_key, ow.property_count as owner_property_count,
       p.year_built, r.roof_year, r.roof_age_years, r.roof_age_basis, r.roof_age_confidence,
       r.evidence_permit_key, r.roof_covering, r.roof_style, r.permit_history_coverage,
       coalesce(x.open_roofing_permits, 0) as open_roofing_permits, x.oldest_open_date,
       x.oldest_open_permit, x.oldest_open_contractor,
       p.market_val, p.imprv_state_cd, p.source_detail_url
from properties p
join roof_age r using (prop_id)
join owner_signals o using (prop_id)
left join owners ow on ow.owner_key = o.owner_key
left join open_roof x using (prop_id)
order by p.prop_id::bigint`);

await copy("leads", "select * from leads");
await copy("properties", "select * from properties order by prop_id::bigint");
await copy("roof_age", "select * from roof_age order by prop_id::bigint");
await copy("owner_signals", "select * from owner_signals order by prop_id::bigint");
await copy("roofing_permits", `select * exclude (open_days) from permits where roofing_work is not null order by permit_key`);
await copy("contractors", "select * exclude (phones, trades, tdlr_licenses), array_to_string(phones, ';') as phones, array_to_string(trades, ';') as trades, array_to_string(tdlr_licenses, ';') as tdlr_licenses from contractors order by contractor_key");
await copy("owners", "select * from owners order by owner_key");
await copy("businesses", "select * from businesses order by business_key");
// Semantic retrieval vectors (int8, 384-d) keyed by permit; absent in builds made before embeddings.
const hasEmb = (await c.runAndReadAll("select count(*) as n from information_schema.tables where table_name = 'permit_embeddings'")).getRowObjectsJson()[0].n > 0;
if (hasEmb) await copy("permit_embeddings", "select * from permit_embeddings order by permit_key");
await copy("licenses", "select * exclude (name_norm) from licenses order by license_type, license_number");

// Full permit history, partitioned by issue year so a daily refresh only rewrites recent years.
{
  const t = Date.now();
  await c.run(`copy (select * exclude (open_days), coalesce(year(opened_date), 0) as year from permits order by permit_key)
    to ${lit(join(runDir, "tables", "permits"))} (FORMAT parquet, COMPRESSION zstd, ROW_GROUP_SIZE 100000,
    PARTITION_BY (year), FILENAME_PATTERN 'part', OVERWRITE_OR_IGNORE)`);
  console.log(`tables/permits/year=*/ (${((Date.now() - t) / 1000).toFixed(1)}s)`);
}

for (const [name, sql] of [
  ["leads-roof-15y-plus", "select * from leads where roof_age_years >= 15 order by prop_id::bigint limit 200"],
  ["roofing-permits-open", "select permit_number, status, opened_date, contractor_company_name, address, description, source_detail_url from permits where roofing_work is not null and status_bucket in ('open','expired_unfinaled') order by opened_date, permit_key limit 200"],
  ["contractors-roofing", "select contractor_key, display_name, legal_name, identity_status, roofing_permit_count, bbb_status from contractors where roofing_permit_count > 0 order by roofing_permit_count desc, contractor_key limit 200"],
]) {
  await c.run(`copy (${sql}) to ${lit(join(runDir, "samples", `${name}.csv`))} (HEADER, DELIMITER ',')`);
}

const cov = (await c.runAndReadAll(`
select
  (select count(*) from properties) as properties,
  (select count(*) from properties where coordinate_basis <> 'none') as properties_with_coordinates,
  (select count(*) from permits) as permits,
  (select count(*) from permits where prop_id is not null) as permits_linked_to_parcel,
  (select count(*) from permits where roofing_work is not null) as roofing_permits,
  (select count(*) from permits where roofing_work in ('roof_replacement','roof_repair') and status_bucket in ('open','expired_unfinaled')) as roofing_permits_open_or_unfinaled,
  (select count(*) from contractors) as contractors,
  (select count(*) from contractors where identity_status = 'resolved_exact_name') as contractors_resolved,
  (select count(*) from contractors where bbb_rating is not null) as contractors_with_bbb,
  (select count(*) from businesses) as businesses,
  (select count(*) from licenses) as licenses,
  (select count(*) from roof_age where roof_age_years >= 15) as roof_15y_plus,
  (select count(*) from owner_signals where date_diff('day', deed_date, current_date) > 10 * 365.2425) as deed_over_10y,
  (select count(*) from owners) as owners,
  (select count(*) from owners where property_count > 1) as multi_property_owners,
  (select count(*) from owner_signals where owner_mail_region in ('out_of_state', 'international')) as owner_out_of_state`)).getRowObjectsJson()[0];
await writeFile(join(runDir, "coverage.json"), JSON.stringify({ county: "travis", state: "TX", fips: "48453", counts: cov }, null, 2) + "\n");
console.log(JSON.stringify(cov));
