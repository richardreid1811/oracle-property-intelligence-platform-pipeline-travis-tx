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
import { contractorAggSql, normName, ownerRegionFallbackSql, ownersSql, roofAgeSql } from "./permit-sql.mjs";

const [dbPath, raw] = process.argv.slice(2);
if (!dbPath || !raw) {
  console.error("usage: derive.mjs <county.duckdb> <raw-dir>");
  process.exit(2);
}
const lit = (s) => `'${String(s).replaceAll("'", "''")}'`;
const nd = (p) => `read_json(${lit(join(raw, p))}, format='newline_delimited', union_by_name=true)`;
// Austin–Round Rock–San Marcos MSA counties (Travis, Williamson, Hays, Bastrop, Caldwell).
const METRO = ["48453", "48491", "48209", "48021", "48055"];

const db = await DuckDBInstance.create(dbPath);
const c = await db.connect();
const step = async (label, sql) => {
  const t = Date.now();
  await c.run(sql);
  console.log(`${label} (${((Date.now() - t) / 1000).toFixed(1)}s)`);
};

await step("roof_age", roofAgeSql);

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
  -- Ownership tenure is computed at query time from deed_date (no calendar-dependent columns).
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

await step("owner_region_fallback", ownerRegionFallbackSql);

await step("identity_sources", `
create or replace table licenses as
select license_type, license_number, license_subtype, business_name, owner_name,
       business_address_line1, business_city_state_zip, business_county, business_telephone,
       license_expiration_date_mmddccyy as license_expiration, source_url, fetched_at,
       ${normName("business_name")} as name_norm
from ${nd("identity/tdlr-contractor-licenses.ndjson")};
create or replace table franchise_taxpayers as
select taxpayer_number, taxpayer_name, taxpayer_address, taxpayer_city, taxpayer_state, taxpayer_zip,
       taxpayer_county_code, taxpayer_organizational_type,
       secretary_of_state_sos_or_coa_file_number as sos_file_number, sos_charter_date, sos_status_code,
       right_to_transact_business_code, source_url, fetched_at,
       ${normName("taxpayer_name")} as name_norm
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

await step("owners", ownersSql + `;
alter table owner_signals add column if not exists owner_key varchar;
update owner_signals o set owner_key = po.owner_key from prop_owner po where po.prop_id = o.prop_id`);

await step("contractors", `
create or replace table contractors as
with agg as (${contractorAggSql}),
fx as (
  select name_norm, count(*) as n, min(taxpayer_number) as taxpayer_number,
         arg_min(sos_file_number, taxpayer_number) as sos_file_number,
         arg_min(taxpayer_name, taxpayer_number) as legal_name,
         arg_min(right_to_transact_business_code, taxpayer_number) as right_to_transact
  from franchise_taxpayers group by 1
),
lx as (
  select name_norm, list_sort(list_distinct(list(license_type || ' ' || license_number))) as tdlr_licenses
  from licenses group by 1
)
select
  a.*,
  case when fx.n = 1 then fx.taxpayer_number end as taxpayer_number,
  case when fx.n = 1 then fx.sos_file_number end as sos_file_number,
  case when fx.n = 1 then fx.legal_name end as legal_name,
  case when fx.n = 1 then fx.right_to_transact end as right_to_transact_business,
  case when fx.n = 1 then 'resolved_exact_name'
       when fx.n > 1 then 'ambiguous_' || fx.n || '_registry_matches'
       else 'unresolved_no_registry_match' end as identity_status,
  lx.tdlr_licenses,
  null::varchar as bbb_rating,
  'excluded_no_public_api_http_403' as bbb_status
from agg a
left join fx using (name_norm)
left join lx using (name_norm);
alter table permits add column if not exists contractor_key varchar;
update permits p set contractor_key = 'contractor:' || md5(${normName("p.contractor_company_name")})
where p.contractor_company_name is not null`);

const s = await c.runAndReadAll(`
select
  (select count(*) from roof_age where roof_age_basis like 'permit_final%') as roof_from_final_permit,
  (select count(*) from roof_age where roof_age_basis like 'permit_issued%') as roof_from_unfinaled_permit,
  (select count(*) from roof_age where roof_age_basis like 'tcad%') as roof_from_year_built,
  (select count(*) from roof_age where roof_age_years >= 15) as roof_15y_plus,
  (select count(*) from owner_signals where date_diff('day', deed_date, current_date) > 10 * 365.2425) as deed_over_10y,
  (select count(*) from owners) as owners,
  (select count(*) from owners where property_count > 1) as multi_property_owners,
  (select count(*) from owner_signals where owner_mail_region in ('out_of_state','international')) as owners_out_of_state,
  (select count(*) from contractors) as contractors,
  (select count(*) from contractors where identity_status = 'resolved_exact_name') as contractors_resolved,
  (select count(*) from businesses) as businesses,
  (select count(*) from licenses) as licenses`);
console.log(JSON.stringify(s.getRowObjectsJson()[0]));
