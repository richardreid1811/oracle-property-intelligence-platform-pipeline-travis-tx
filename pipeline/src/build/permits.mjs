#!/usr/bin/env node
// Build `permits` from harvested City of Austin permit NDJSON into the county DuckDB.
// - Links each permit to a TCAD parcel via tcad_id = geo_id (target-parcel evidence), and
//   keeps valid-unlinked permits rather than dropping them.
// - Classifies roofing work from the description (Austin has no re-roof work class; the
//   'Roof' work class is mostly electrical work on roofs).
// - Buckets status and computes open duration so long-open permits can be queried.
// Usage: node src/build/permits.mjs <county.duckdb> <base.ndjson> [window.ndjson ...]
// Later harvests win: each permit keeps the version from the most recent fetch (window refreshes
// layered over the full pull), and every row records which harvest it came from.
import { DuckDBInstance } from "@duckdb/node-api";
import { readFile } from "node:fs/promises";

const [dbPath, ...inputs] = process.argv.slice(2);
if (!dbPath || !inputs.length) {
  console.error("usage: permits.mjs <county.duckdb> <base.ndjson> [window.ndjson ...]");
  process.exit(2);
}
const receipts = await Promise.all(inputs.map(async (f) => ({ file: f, ...JSON.parse(await readFile(`${f}.receipt.json`, "utf8")) })));
const lit = (s) => `'${String(s).replaceAll("'", "''")}'`;

// Roofing taxonomy (applied to upper-cased description), Building Permits only: companion
// electrical/plumbing/mechanical permits repeat the building permit's project description, so
// classifying them would count one re-roof several times. Exclusions (solar, rooftop units,
// signs) apply unless an explicit re-roof phrase is present.
const REROOF = String.raw`\bRE-?\s?ROOF`;
const REPLACEMENT = String.raw`\bROOF(ING)?\s+(REPLACE|REPLACEMENT|TEAR\s?-?OFF|OVERLAY)|\bREPLAC(E|ING)\s+(THE\s+|EXISTING\s+)?ROOF|\bNEW\s+ROOF(ING)?\b|\bTEAR\s?-?OFF\b`;
const REPAIR = String.raw`\bROOF(ING)?\s+REPAIR|\bREPAIR\s+(THE\s+|EXISTING\s+)?ROOF|\bROOF\s+DECK(ING)?\s+REPAIR`;
const EXCLUDE = String.raw`SOLAR|PHOTOVOLTAIC|\bPV\b|ROOF\s?-?TOP\s+UNIT|\bRTU\b|\bSIGN\b|ANTENNA|TELECOM|CELL\s+SITE`;

const db = await DuckDBInstance.create(dbPath);
const c = await db.connect();
const t0 = Date.now();

await c.run(`
create or replace temp table raw_permits as
select * from read_json([${inputs.map(lit).join(", ")}], format='newline_delimited', union_by_name=true, filename=true,
  columns={
    permittype:'VARCHAR', permit_type_desc:'VARCHAR', permit_number:'VARCHAR', permit_class_mapped:'VARCHAR',
    permit_class:'VARCHAR', work_class:'VARCHAR', description:'VARCHAR', tcad_id:'VARCHAR',
    legal_description:'VARCHAR', applieddate:'VARCHAR', issue_date:'VARCHAR', status_current:'VARCHAR',
    statusdate:'VARCHAR', expiresdate:'VARCHAR', completed_date:'VARCHAR', original_address1:'VARCHAR',
    original_city:'VARCHAR', original_state:'VARCHAR', original_zip:'VARCHAR', jurisdiction:'VARCHAR',
    link:'VARCHAR', project_id:'VARCHAR', masterpermitnum:'VARCHAR', latitude:'VARCHAR', longitude:'VARCHAR',
    total_job_valuation:'VARCHAR', housing_units:'VARCHAR', number_of_floors:'VARCHAR',
    contractor_trade:'VARCHAR', contractor_company_name:'VARCHAR', contractor_full_name:'VARCHAR',
    contractor_phone:'VARCHAR', contractor_address1:'VARCHAR', contractor_address2:'VARCHAR',
    contractor_city:'VARCHAR', contractor_zip:'VARCHAR',
    socrata_id:'VARCHAR', socrata_updated_at:'VARCHAR', source_url:'VARCHAR', fetched_at:'VARCHAR'
  })`);

await c.run(`
create or replace table permits as
with base as (
  select
    'austin:' || permit_number as permit_key,
    'City of Austin' as issuing_authority,
    permit_number, permittype as permit_type, permit_type_desc, permit_class_mapped, permit_class, work_class,
    description, nullif(trim(tcad_id), '') as tcad_id,
    try_cast(applieddate as timestamp)::date as applied_date,
    try_cast(issue_date as timestamp)::date as issued_date,
    try_cast(statusdate as timestamp)::date as status_date,
    try_cast(expiresdate as timestamp)::date as expires_date,
    try_cast(completed_date as timestamp)::date as completed_date,
    status_current as status,
    original_address1 as address, original_city as city, original_zip as zip, jurisdiction as source_jurisdiction,
    project_id, masterpermitnum,
    try_cast(latitude as double) as latitude, try_cast(longitude as double) as longitude,
    try_cast(total_job_valuation as double) as job_valuation,
    nullif(trim(contractor_company_name), '') as contractor_company_name,
    nullif(trim(contractor_full_name), '') as contractor_full_name,
    contractor_trade,
    nullif(regexp_replace(coalesce(contractor_phone, ''), '[^0-9]', '', 'g'), '') as contractor_phone,
    nullif(trim(concat_ws(' ', contractor_address1, contractor_address2)), '') as contractor_address,
    contractor_city, contractor_zip,
    link as source_detail_url, source_url, socrata_id, fetched_at, filename as harvest_file,
    upper(coalesce(description, '')) as d
  from raw_permits
),
dedup as (
  -- One row per permit number; the harvest can see a row twice if it is edited mid-pull.
  select * exclude (rk) from (
    select *, row_number() over (partition by permit_number order by fetched_at desc, status_date desc nulls last, socrata_id desc) as rk
    from base) where rk = 1
)
select
  * exclude (d),
  case
    when permit_type <> 'BP' then null
    when regexp_matches(d, ${lit(REROOF)}) then 'roof_replacement'
    when regexp_matches(d, ${lit(EXCLUDE)}) then null
    when regexp_matches(d, ${lit(REPLACEMENT)}) then 'roof_replacement'
    when regexp_matches(d, ${lit(REPAIR)}) then 'roof_repair'
    when regexp_matches(d, '\\bROOF') then 'roof_mention'
  end as roofing_work,
  case
    when upper(status) in ('FINAL', 'CLOSED', 'COMPLETE', 'COMPLETED') then 'closed'
    when upper(status) in ('VOID', 'WITHDRAWN', 'CANCELLED', 'CANCELED', 'DENIED') then 'void'
    when upper(status) = 'EXPIRED' and completed_date is null then 'expired_unfinaled'
    when upper(status) = 'EXPIRED' then 'closed'
    else 'open'
  end as status_bucket,
  coalesce(issued_date, applied_date) as opened_date,
  case when completed_date is not null then completed_date end as closed_date
from dedup`);

// Open duration: still-open and expired-unfinaled permits accrue days until today.
await c.run(`
alter table permits add column open_days integer;
update permits set open_days = case
  when status_bucket in ('open', 'expired_unfinaled') and opened_date is not null then date_diff('day', opened_date, current_date)
  when status_bucket = 'closed' and opened_date is not null and closed_date is not null then date_diff('day', opened_date, closed_date)
end;
alter table permits add column prop_id varchar;
alter table permits add column link_basis varchar;
-- geo_id is not unique in the roll (~10k shared ids), so link deterministically: unique geo_id
-- first; when shared, the parcel whose situs address matches the permit address; else the lowest
-- PROP_ID, flagged as ambiguous.
create or replace temp table geo_link as
with cand as (
  select p.permit_key, pr.prop_id,
         count(*) over (partition by p.permit_key) as n,
         (upper(coalesce(pr.situs_address, '')) = upper(trim(coalesce(p.address, '')))) as addr_match
  from permits p join properties pr on pr.geo_id = p.tcad_id
)
select permit_key, prop_id,
       case when n = 1 then 'tcad_id=geo_id'
            when addr_match then 'tcad_id=geo_id+address (' || n || ' parcels share geo_id)'
            else 'tcad_id=geo_id (ambiguous ' || n || ', lowest prop_id)' end as link_basis
from (select *, row_number() over (partition by permit_key order by addr_match desc, prop_id::bigint) as rk from cand)
where rk = 1;
update permits p set prop_id = g.prop_id, link_basis = g.link_basis from geo_link g where g.permit_key = p.permit_key;
-- Older permits often record the 6-7 digit PROP_ID in tcad_id instead of the 10-char geo_id.
update permits p set prop_id = pr.prop_id, link_basis = 'tcad_id=prop_id'
from properties pr where p.prop_id is null and length(p.tcad_id) between 4 and 9
  and pr.prop_id = ltrim(p.tcad_id, '0');
alter table permits add column window_source varchar;
${receipts.map((r) => `update permits set window_source = ${lit(r.window_since ? `window>${r.window_since}` : "full")} where harvest_file = ${lit(r.file)};`).join("\n")}
alter table permits drop column harvest_file;`);

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
