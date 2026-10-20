#!/usr/bin/env node
// Derive roofing-lead signals and reconciled entities in the county DuckDB:
//   roof_age            per-property roof year with basis, confidence and coverage caveat
//   owner_signals       deed age, owner-occupancy, mailing-address region
//   contractors         permit contractors deduplicated by normalized name/phone, resolved to
//                       Texas Comptroller entities only on an unambiguous exact-name match
//   businesses          Travis County sales-tax outlets + franchise taxpayers (deduped by taxpayer #)
//   licenses            TDLR contractor-class licenses
// Usage: node src/build/derive.mjs <county.duckdb> <raw-dir>
import { DuckDBInstance } from "@duckdb/node-api";
import { join } from "node:path";

const [dbPath, raw] = process.argv.slice(2);
if (!dbPath || !raw) {
  console.error("usage: derive.mjs <county.duckdb> <raw-dir>");
  process.exit(2);
}
const lit = (s) => `'${String(s).replaceAll("'", "''")}'`;
const nd = (p) => `read_json(${lit(join(raw, p))}, format='newline_delimited', union_by_name=true)`;
// Austin–Round Rock–San Marcos MSA counties (Travis, Williamson, Hays, Bastrop, Caldwell).
const METRO = ["48453", "48491", "48209", "48021", "48055"];
// Business-name normalization shared by every entity match.
const norm = (col) => `trim(regexp_replace(regexp_replace(upper(coalesce(${col}, '')), '[^A-Z0-9 ]', ' ', 'g'),
  '\\b(LLC|L L C|INC|INCORPORATED|CO|COMPANY|CORP|CORPORATION|LTD|LP|LLP|PLLC|PC|THE|DBA)\\b', '', 'g'))`;
const squash = (expr) => `regexp_replace(${expr}, '\\s+', ' ', 'g')`;

const db = await DuckDBInstance.create(dbPath);
const c = await db.connect();
const step = async (label, sql) => {
  const t = Date.now();
  await c.run(sql);
  console.log(`${label} (${((Date.now() - t) / 1000).toFixed(1)}s)`);
};

await step("roof_age", `
create or replace table roof_age as
with rp as (
  select pm.prop_id, pm.permit_key, pm.status_bucket, pm.issued_date, pm.completed_date, pr.year_built
  from permits pm join properties pr using (prop_id)
  where pm.roofing_work = 'roof_replacement'
    and (pr.year_built is null or year(coalesce(pm.completed_date, pm.issued_date)) >= pr.year_built)
),
final_roof as (
  select prop_id, arg_max(permit_key, completed_date) as permit_key, max(completed_date) as d
  from rp where status_bucket = 'closed' and completed_date is not null group by 1
),
unverified_roof as (
  select prop_id, arg_max(permit_key, issued_date) as permit_key, max(issued_date) as d
  from rp where status_bucket in ('open', 'expired_unfinaled') and issued_date is not null group by 1
)
select
  p.prop_id,
  case when f.d is not null then year(f.d)
       when u.d is not null then year(u.d)
       else p.year_built end as roof_year,
  case when f.d is not null then 'permit_final_roof_replacement'
       when u.d is not null then 'permit_issued_roof_replacement_unfinaled'
       when p.year_built is not null then 'tcad_year_built_assumes_original_roof'
       else 'unknown' end as roof_age_basis,
  case when f.d is not null then 'high' when u.d is not null then 'medium'
       when p.year_built is not null then 'low' else 'none' end as roof_age_confidence,
  coalesce(f.permit_key, u.permit_key) as evidence_permit_key,
  p.roof_covering, p.roof_style,
  case when p.jurisdiction = 'CITY OF AUSTIN' then 'austin_permit_history_1978_plus'
       when p.jurisdiction = 'TRAVIS COUNTY (UNINCORPORATED)' then 'no_county_building_permits_in_texas'
       else 'municipal_permits_not_yet_ingested' end as permit_history_coverage
from properties p
left join final_roof f using (prop_id)
left join unverified_roof u using (prop_id);
alter table roof_age add column roof_age_years integer;
update roof_age set roof_age_years = year(current_date) - roof_year where roof_year is not null`);

await step("zip_region", `
create or replace temp table zcta_county as
select zcta, county_fips from (
  select GEOID_ZCTA5_20 as zcta, GEOID_COUNTY_20 as county_fips,
         row_number() over (partition by GEOID_ZCTA5_20 order by AREALAND_PART desc) as rk
  from read_csv(${lit(join(raw, "census/zcta520_county20.txt"))}, delim='|', header=true, all_varchar=true)
  where GEOID_ZCTA5_20 is not null and GEOID_ZCTA5_20 <> ''
) where rk = 1`);

await step("permit_county", `
alter table permits add column if not exists county_fips varchar;
update permits p set county_fips = '48453' where p.prop_id is not null;
update permits p set county_fips = z.county_fips from zcta_county z where p.prop_id is null and z.zcta = left(p.zip, 5)`);

await step("owner_signals", `
create or replace table owner_signals as
select
  p.prop_id,
  p.deed_date,
  date_diff('year', p.deed_date, current_date) as years_since_deed,
  p.homestead_exempt as owner_occupied_homestead,
  -- Mailing address that repeats the situs number and street indicates owner-occupied/self-mailed.
  (p.mail_line1 is not null and p.situs_address is not null
   and position(split_part(p.situs_address, ' ', 1) || ' ' in upper(coalesce(p.mail_line1,'') || ' ' || coalesce(p.mail_line2,'')) || ' ') > 0
   and position(split_part(p.situs_address, ' ', 2) in upper(coalesce(p.mail_line1,'') || ' ' || coalesce(p.mail_line2,''))) > 0
  ) as mails_to_property,
  case
    when p.mail_country is not null and upper(p.mail_country) not in ('US', 'USA', '') then 'international'
    when p.mail_state is not null and upper(p.mail_state) <> 'TX' then 'out_of_state'
    when z.county_fips = '48453' then 'travis_county'
    when z.county_fips in (${METRO.map(lit).join(",")}) then 'austin_metro'
    when upper(coalesce(p.mail_state, '')) = 'TX' then 'texas_other'
    else 'unknown'
  end as owner_mail_region,
  z.county_fips as owner_mail_county_fips
from properties p
left join zcta_county z on z.zcta = p.mail_zip`);

await step("identity_sources", `
create or replace table licenses as
select license_type, license_number, license_subtype, business_name, owner_name,
       business_address_line1, business_city_state_zip, business_county, business_telephone,
       license_expiration_date_mmddccyy as license_expiration, source_url, fetched_at,
       ${squash(norm("business_name"))} as name_norm
from ${nd("identity/tdlr-contractor-licenses.ndjson")};
create or replace table franchise_taxpayers as
select taxpayer_number, taxpayer_name, taxpayer_address, taxpayer_city, taxpayer_state, taxpayer_zip,
       taxpayer_county_code, taxpayer_organizational_type,
       secretary_of_state_sos_or_coa_file_number as sos_file_number, sos_charter_date, sos_status_code,
       right_to_transact_business_code, source_url, fetched_at,
       ${squash(norm("taxpayer_name"))} as name_norm
from ${nd("identity/tx-franchise-taxpayers.ndjson")}`);

await step("businesses", `
create or replace table businesses as
with outlets as (
  select taxpayer_number, taxpayer_name, outlet_number, outlet_name, outlet_address, outlet_city, outlet_zip_code,
         outlet_naics_code, outlet_permit_issue_date, outlet_first_sales_date, source_url, fetched_at
  from ${nd("identity/tx-sales-tax-travis.ndjson")}
)
select
  'txcpa:' || o.taxpayer_number || ':' || o.outlet_number as business_key,
  o.taxpayer_number, coalesce(o.outlet_name, o.taxpayer_name) as business_name, o.taxpayer_name as legal_name,
  o.outlet_address as address, o.outlet_city as city, o.outlet_zip_code as zip,
  o.outlet_naics_code as naics, o.outlet_permit_issue_date as sales_tax_permit_issued,
  f.sos_file_number, f.taxpayer_organizational_type as organization_type,
  'tx_comptroller_sales_tax_outlet' as source, o.source_url, o.fetched_at
from outlets o left join franchise_taxpayers f using (taxpayer_number)
union all by name
select
  'txcpa:' || f.taxpayer_number as business_key, f.taxpayer_number, f.taxpayer_name as business_name,
  f.taxpayer_name as legal_name, f.taxpayer_address as address, f.taxpayer_city as city, f.taxpayer_zip as zip,
  null as naics, null as sales_tax_permit_issued, f.sos_file_number, f.taxpayer_organizational_type as organization_type,
  'tx_comptroller_franchise_taxpayer' as source, f.source_url, f.fetched_at
from franchise_taxpayers f
where f.taxpayer_county_code = '227'
  and f.taxpayer_number not in (select taxpayer_number from outlets)`);

await step("contractors", `
create or replace table contractors as
with pc as (
  select contractor_company_name as name, contractor_phone as phone, contractor_trade as trade,
         contractor_city as city, contractor_zip as zip, permit_key, roofing_work, opened_date,
         ${squash(norm("contractor_company_name"))} as name_norm
  from permits where contractor_company_name is not null
),
agg as (
  select name_norm,
         mode(name) as display_name,
         list_distinct(list(phone) filter (phone is not null))[:5] as phones,
         list_distinct(list(trade) filter (trade is not null)) as trades,
         mode(city) as city, mode(zip) as zip,
         count(*) as permit_count,
         count(*) filter (roofing_work in ('roof_replacement', 'roof_repair')) as roofing_permit_count,
         min(opened_date) as first_permit, max(opened_date) as last_permit
  from pc where name_norm <> '' group by 1
),
fx as (
  select name_norm, count(*) as n, any_value(taxpayer_number) as taxpayer_number, any_value(sos_file_number) as sos_file_number,
         any_value(taxpayer_name) as legal_name, any_value(right_to_transact_business_code) as right_to_transact
  from franchise_taxpayers group by 1
),
lx as (
  select name_norm, list_distinct(list(license_type || ' ' || license_number)) as tdlr_licenses
  from licenses group by 1
)
select
  'contractor:' || md5(a.name_norm) as contractor_key, a.*,
  case when fx.n = 1 then fx.taxpayer_number end as taxpayer_number,
  case when fx.n = 1 then fx.sos_file_number end as sos_file_number,
  case when fx.n = 1 then fx.legal_name end as legal_name,
  case when fx.n = 1 then fx.right_to_transact end as right_to_transact_business,
  case when fx.n = 1 then 'resolved_exact_name'
       when fx.n > 1 then 'ambiguous_' || fx.n || '_registry_matches'
       else 'unresolved_no_registry_match' end as identity_status,
  lx.tdlr_licenses,
  null::varchar as bbb_rating,
  'blocked_http_403_pending_bbb_api' as bbb_status
from agg a
left join fx using (name_norm)
left join lx using (name_norm);
alter table permits add column contractor_key varchar;
update permits p set contractor_key = 'contractor:' || md5(${squash(norm("p.contractor_company_name"))})
where p.contractor_company_name is not null`);

const s = await c.runAndReadAll(`
select
  (select count(*) from roof_age where roof_age_basis like 'permit_final%') as roof_from_final_permit,
  (select count(*) from roof_age where roof_age_basis like 'permit_issued%') as roof_from_unfinaled_permit,
  (select count(*) from roof_age where roof_age_basis like 'tcad%') as roof_from_year_built,
  (select count(*) from roof_age where roof_age_years >= 15) as roof_15y_plus,
  (select count(*) from owner_signals where years_since_deed > 10) as deed_over_10y,
  (select count(*) from owner_signals where owner_mail_region in ('out_of_state','international')) as owners_out_of_state,
  (select count(*) from contractors) as contractors,
  (select count(*) from contractors where identity_status = 'resolved_exact_name') as contractors_resolved,
  (select count(*) from businesses) as businesses,
  (select count(*) from licenses) as licenses`);
console.log(JSON.stringify(s.getRowObjectsJson()[0]));
