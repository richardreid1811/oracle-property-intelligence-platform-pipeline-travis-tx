#!/usr/bin/env node
// Build the canonical `properties` table for Travis County from the TCAD appraisal export
// (PACS Legacy 8.0.33 fixed-width layout) plus harvested GIS centroids.
// One row per assessed real-property PROP_ID; every row carries its source snapshot.
// Usage: node src/build/tcad-roll.mjs <extracted-dir> <centroids.ndjson> <out.duckdb>
import { DuckDBInstance } from "@duckdb/node-api";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const [dir, centroids, out] = process.argv.slice(2);
if (!dir || !centroids || !out) {
  console.error("usage: tcad-roll.mjs <extracted-dir> <centroids.ndjson> <out.duckdb>");
  process.exit(2);
}
const receipt = JSON.parse(await readFile(join(dir, "receipt.json"), "utf8"));
const lit = (s) => `'${String(s).replaceAll("'", "''")}'`;
// Fixed-width members are read as one VARCHAR column per line, then sliced by layout offsets.
const fw = (file) =>
  `read_csv(${lit(join(dir, file))}, columns={'l':'VARCHAR'}, delim=chr(31), quote='', escape='', header=false, encoding='latin-1')`;
const f = (start, len) => `nullif(trim(substr(l, ${start}, ${len})), '')`;
const flag = (pos) => `substr(l, ${pos}, 1) = 'T'`;

const db = await DuckDBInstance.create(out);
const c = await db.connect();
const run = async (label, sql) => {
  const t = Date.now();
  await c.run(sql);
  console.log(`${label} (${((Date.now() - t) / 1000).toFixed(1)}s)`);
};

await run("raw_prop", `
create or replace temp table raw_prop as
select
  ltrim(substr(l, 1, 12), '0')                         as prop_id,
  substr(l, 1, 12)                                     as prop_id_raw,
  ${f(13, 5)}                                          as prop_type_cd,
  ${f(547, 50)}                                        as geo_id,
  ${f(609, 70)}                                        as owner_name,
  ${flag(679)}                                         as partial_owner,
  ${f(694, 60)} as mail_line1, ${f(754, 60)} as mail_line2, ${f(814, 60)} as mail_line3,
  ${f(874, 50)} as mail_city, ${f(924, 50)} as mail_state, ${f(974, 5)} as mail_country, ${f(979, 5)} as mail_zip,
  ${flag(990)} or ${flag(4859)} as owner_confidential,
  ${flag(991)} or ${flag(4860)} as owner_address_suppressed,
  ${f(4136, 40)} as dba,
  try_cast(${f(4214, 14)} as bigint) as market_val,
  ${f(4460, 15)} as situs_num, ${f(4475, 5)} as situs_unit,
  ${f(1040, 10)} as situs_prefix, ${f(1050, 50)} as situs_street, ${f(1100, 10)} as situs_suffix,
  ${f(1110, 30)} as situs_city, ${f(1140, 10)} as situs_zip,
  ${f(1150, 255)} as legal_desc,
  try_cast(${f(1916, 15)} as bigint) as appraised_val,
  try_cast(${f(1946, 15)} as bigint) as assessed_val,
  ${f(1994, 20)} as deed_book, ${f(2014, 20)} as deed_page,
  ${f(2034, 25)} as deed_date_raw,
  -- Texas statehood (1836) to today; anything else is a keying error in the source (e.g. 0201-07-14).
  case when year(try_strptime(${f(2034, 25)}, '%m-%d-%Y')) between 1836 and year(current_date)
       then try_strptime(${f(2034, 25)}, '%m-%d-%Y')::date end as deed_date,
  ${flag(2609)} as homestead_exempt, ${flag(2610)} as over65_exempt,
  ${f(2732, 10)} as imprv_state_cd, ${f(2742, 10)} as land_state_cd,
  row_number() over (partition by substr(l, 1, 12) order by ${flag(679)}) as owner_rank
from ${fw("PROP.TXT")}
where trim(substr(l, 13, 5)) = 'R'`);

// Municipality: the parcel's city/village taxing entity; none means unincorporated Travis County.
await run("prop_city", `
create or replace temp table city_entities as
select trim(substr(l, 13, 5)) as entity_cd, trim(substr(l, 18, 70)) as entity_name
from ${fw("TOTALS.TXT")}
where trim(substr(l, 18, 70)) like 'CITY OF %' or trim(substr(l, 18, 70)) like 'VILLAGE OF %';
create or replace temp table prop_city as
select ltrim(substr(l, 1, 12), '0') as prop_id, min(e.entity_name) as jurisdiction
from ${fw("PROP_ENT.TXT")} p join city_entities e on trim(substr(p.l, 54, 10)) = e.entity_cd
group by 1`);

// Year built: main living area (1st Floor) of the largest improvement; else largest dated detail.
await run("year_built", `
create or replace temp table det as
select ltrim(substr(l, 1, 12), '0') as prop_id, substr(l, 17, 12)::bigint as imprv_id,
       trim(substr(l, 41, 10)) as det_cd,
       try_cast(trim(substr(l, 86, 4)) as int) as yr_built,
       try_cast(trim(substr(l, 94, 15)) as double) as area
from ${fw("IMP_DET.TXT")};
create or replace temp table main_imprv as
select prop_id, imprv_id, yr_built, area,
       case when det_cd = '1ST' then 'tcad_main_floor_yr_built' else 'tcad_largest_detail_yr_built' end as basis
from (
  select *, row_number() over (partition by prop_id
           order by (det_cd = '1ST') desc, area desc nulls last, yr_built) as rk
  from det where yr_built between 1800 and year(current_date)
) where rk = 1`);

await run("roof_attrs", `
create or replace temp table roof as
select ltrim(substr(l, 1, 12), '0') as prop_id, substr(l, 17, 12)::bigint as imprv_id,
       max(case when trim(substr(l, 53, 25)) = 'Roof Covering' then trim(substr(l, 78, 10)) end) as roof_covering,
       max(case when trim(substr(l, 53, 25)) = 'Roof Style' then trim(substr(l, 78, 10)) end) as roof_style
from ${fw("IMP_ATR.TXT")}
where trim(substr(l, 53, 25)) in ('Roof Covering', 'Roof Style')
group by 1, 2`);

await run("centroids", `
create or replace temp table gis as
select prop_id, geo_id, longitude, latitude from read_json(${lit(centroids)}, format='newline_delimited')`);

await run("properties", `
create or replace table properties as
with p as (select * from raw_prop where owner_rank = 1),
owners as (select prop_id, count(*) as owner_count from raw_prop group by 1),
by_prop as (select prop_id, any_value(longitude) lon, any_value(latitude) lat from gis group by 1),
by_geo as (select geo_id, any_value(longitude) lon, any_value(latitude) lat from gis where geo_id is not null group by 1),
by_parent as (select left(geo_id, 8) g8, avg(longitude) lon, avg(latitude) lat from gis where geo_id is not null group by 1)
select
  p.prop_id, p.prop_id_raw, p.geo_id,
  nullif(concat_ws(' ', p.situs_num, p.situs_prefix, p.situs_street, p.situs_suffix,
                   case when p.situs_unit is not null then '#' || p.situs_unit end), '') as situs_address,
  p.situs_city, p.situs_zip, p.legal_desc,
  coalesce(pc.jurisdiction, 'TRAVIS COUNTY (UNINCORPORATED)') as jurisdiction,
  p.imprv_state_cd, p.land_state_cd,
  p.owner_name, p.dba as owner_dba, o.owner_count,
  -- Texas Tax Code 25.025 confidential owners: keep TCAD's masking, never publish their mailing address.
  p.owner_confidential or p.owner_address_suppressed as owner_address_withheld,
  case when p.owner_confidential or p.owner_address_suppressed then null else p.mail_line1 end as mail_line1,
  case when p.owner_confidential or p.owner_address_suppressed then null else p.mail_line2 end as mail_line2,
  case when p.owner_confidential or p.owner_address_suppressed then null else p.mail_line3 end as mail_line3,
  case when p.owner_confidential or p.owner_address_suppressed then null else p.mail_city end as mail_city,
  p.mail_state, p.mail_zip, p.mail_country,
  p.deed_date, p.deed_date_raw, p.deed_book, p.deed_page,
  p.homestead_exempt, p.over65_exempt, p.market_val, p.appraised_val, p.assessed_val,
  m.yr_built as year_built, m.basis as year_built_basis, m.area as main_area_sqft,
  r.roof_covering, r.roof_style,
  coalesce(bp.lon, bg.lon, pa.lon) as longitude,
  coalesce(bp.lat, bg.lat, pa.lat) as latitude,
  case when bp.lon is not null or bg.lon is not null then 'own_parcel_centroid'
       when pa.lon is not null then 'parent_parcel_centroid'
       else 'none' end as coordinate_basis,
  ${lit(receipt.source_url)} as source_url,
  ${lit(receipt.zip_sha256)} as source_sha256,
  'https://travis.prodigycad.com/property-detail/' || p.prop_id as source_detail_url
from p
left join owners o using (prop_id)
left join prop_city pc using (prop_id)
left join main_imprv m using (prop_id)
left join roof r on r.prop_id = p.prop_id and r.imprv_id = m.imprv_id
-- Plain equality joins (each lookup is unique on its key); precedence is applied by coalesce above.
left join by_prop bp on bp.prop_id = p.prop_id
left join by_geo bg on bg.geo_id = p.geo_id
left join by_parent pa on pa.g8 = left(p.geo_id, 8)
order by p.prop_id::bigint`);

const summary = await c.runAndReadAll(`
select count(*) as properties,
       count(distinct prop_id) as distinct_prop_id,
       count(year_built) as with_year_built,
       count(roof_covering) as with_roof_covering,
       count(deed_date) as with_deed_date,
       count(*) filter (coordinate_basis = 'own_parcel_centroid') as own_centroid,
       count(*) filter (coordinate_basis = 'parent_parcel_centroid') as parent_centroid,
       count(*) filter (coordinate_basis = 'none') as no_coordinate,
       count(*) filter (owner_address_withheld) as owner_address_withheld
from properties`);
console.log(JSON.stringify(summary.getRowObjectsJson()[0]));
