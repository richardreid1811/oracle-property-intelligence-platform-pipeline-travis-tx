// Shared SQL for City of Austin permits, used by the full build (permits.mjs) and the incremental
// window build (incremental.mjs) so both apply the same classifier, status buckets and links.
export const lit = (s) => `'${String(s).replaceAll("'", "''")}'`;

// Roofing taxonomy (applied to upper-cased description), Building Permits only: companion
// electrical/plumbing/mechanical permits repeat the building permit's project description, so
// classifying them would count one re-roof several times. Exclusions (solar, rooftop units,
// signs) apply unless an explicit re-roof phrase is present.
const REROOF = String.raw`\bRE-?\s?ROOF`;
const REPLACEMENT = String.raw`\bROOF(ING)?\s+(REPLACE|REPLACEMENT|TEAR\s?-?OFF|OVERLAY)|\bREPLAC(E|ING)\s+(THE\s+|EXISTING\s+)?ROOF|\bNEW\s+ROOF(ING)?\b|\bTEAR\s?-?OFF\b`;
const REPAIR = String.raw`\bROOF(ING)?\s+REPAIR|\bREPAIR\s+(THE\s+|EXISTING\s+)?ROOF|\bROOF\s+DECK(ING)?\s+REPAIR`;
const EXCLUDE = String.raw`SOLAR|PHOTOVOLTAIC|\bPV\b|ROOF\s?-?TOP\s+UNIT|\bRTU\b|\bSIGN\b|ANTENNA|TELECOM|CELL\s+SITE`;

/** Roofing classification from an upper-cased description column and the permit type. */
export const roofingWorkExpr = (d, type) => `case
    when ${type} <> 'BP' then null
    when regexp_matches(${d}, ${lit(REROOF)}) then 'roof_replacement'
    when regexp_matches(${d}, ${lit(EXCLUDE)}) then null
    when regexp_matches(${d}, ${lit(REPLACEMENT)}) then 'roof_replacement'
    when regexp_matches(${d}, ${lit(REPAIR)}) then 'roof_repair'
    when regexp_matches(${d}, '\\bROOF') then 'roof_mention'
  end`;

/**
 * Normalized status. Terminal statuses are matched by prefix: the source also uses variants such as
 * 'Cancelled - Contractor Required', 'Denied but Closed' and 'Expired - License'.
 */
export const statusBucketExpr = (status, completed) => `case
    when regexp_matches(upper(coalesce(${status}, '')), '^(FINAL|CLOSED|COMPLETE)') then 'closed'
    when regexp_matches(upper(coalesce(${status}, '')), '^(VOID|WITHDRAWN|CANCEL|DENIED|ABORTED|REVOKED|REJECTED)') then 'void'
    when regexp_matches(upper(coalesce(${status}, '')), '^EXPIRED') and ${completed} is null then 'expired_unfinaled'
    when regexp_matches(upper(coalesce(${status}, '')), '^EXPIRED') then 'closed'
    else 'open'
  end`;

/**
 * Re-apply the current classifier and status rules to every row of `table`, so rule changes reach
 * permits carried over from earlier snapshots (incremental builds only normalize the new window).
 */
export const reclassifySql = (table) => `
update ${table} set
  roofing_work = ${roofingWorkExpr("upper(coalesce(description, ''))", "permit_type")},
  status_bucket = ${statusBucketExpr("status", "completed_date")},
  closed_date = completed_date
where coalesce(issuing_authority, 'City of Austin') = 'City of Austin';
-- Lakeway permit types are words, not Austin's BP/EP codes: classify type + work class + description.
update ${table} set
  roofing_work = ${roofingWorkExpr("upper(concat_ws(' ', permit_type, work_class, description))", "'BP'")},
  status_bucket = ${statusBucketExpr("status", "completed_date")},
  closed_date = completed_date
where issuing_authority = 'City of Lakeway'`;

/**
 * Owner mailing-region fallback: PO-box and other unique ZIPs have no Census ZIP area, so a Travis
 * mailing city (or an Austin-area ZIP prefix) is used before calling an owner out of area.
 */
const TRAVIS_MAIL_CITIES = ["AUSTIN", "PFLUGERVILLE", "MANOR", "LAKEWAY", "LAGO VISTA", "DEL VALLE", "BEE CAVE", "WEST LAKE HILLS",
  "SPICEWOOD", "JONESTOWN", "MANCHACA", "ELROY", "CREEDMOOR", "MUSTANG RIDGE", "ROLLINGWOOD", "SUNSET VALLEY", "VOLENTE",
  "BRIARCLIFF", "POINT VENTURE", "WEBBERVILLE", "SAN LEANNA", "THE HILLS", "GARFIELD", "COUPLAND"];
const METRO_MAIL_CITIES = ["ROUND ROCK", "CEDAR PARK", "LEANDER", "GEORGETOWN", "HUTTO", "TAYLOR", "LIBERTY HILL", "KYLE", "BUDA",
  "SAN MARCOS", "DRIPPING SPRINGS", "WIMBERLEY", "BASTROP", "ELGIN", "SMITHVILLE", "LOCKHART", "LULING", "JARRELL", "FLORENCE"];
export const ownerRegionFallbackSql = `
update owner_signals o set owner_mail_region = case
    when upper(trim(p.mail_city)) in (${TRAVIS_MAIL_CITIES.map(lit).join(", ")}) then 'travis_county'
    when upper(trim(p.mail_city)) in (${METRO_MAIL_CITIES.map(lit).join(", ")}) or left(p.mail_zip, 3) in ('786', '787') then 'austin_metro'
    else o.owner_mail_region end
from properties p
where p.prop_id = o.prop_id and o.owner_mail_region in ('texas_other', 'unknown')
  and o.owner_mail_county_fips is null and upper(coalesce(p.mail_state, 'TX')) = 'TX'`;

/** Temp table `raw_permits` from harvested NDJSON files (filename kept as harvest_file). */
export const rawPermitsSql = (inputs) => `
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
  })`;

/** Normalize raw_permits into `target`: one row per permit (latest harvest wins), classified. */
export const normalizePermitsSql = (target) => `
create or replace table ${target} as
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
  -- One row per permit number; later harvests (and edits seen mid-pull) win.
  select * exclude (rk) from (
    select *, row_number() over (partition by permit_number order by fetched_at desc, status_date desc nulls last, socrata_id desc) as rk
    from base) where rk = 1
)
select
  * exclude (d),
  ${roofingWorkExpr('d', 'permit_type')} as roofing_work,
  ${statusBucketExpr('status', 'completed_date')} as status_bucket,
  coalesce(issued_date, applied_date) as opened_date,
  case when completed_date is not null then completed_date end as closed_date
from dedup`;

/** Open duration as of today: open and expired-unfinaled permits accrue days. */
export const openDaysSql = (table) => `
alter table ${table} add column if not exists open_days integer;
update ${table} set open_days = case
  when status_bucket in ('open', 'expired_unfinaled') and opened_date is not null then date_diff('day', opened_date, current_date)
  when status_bucket = 'closed' and opened_date is not null and closed_date is not null then date_diff('day', opened_date, closed_date)
end;`;

/**
 * Deterministic parcel links. geo_id is not unique in the roll (~10k shared ids): unique geo_id
 * first; when shared, the parcel whose situs address matches the permit address; else the lowest
 * PROP_ID, flagged as ambiguous. Older permits often carry the 6-7 digit PROP_ID instead.
 */
export const linkSql = (table) => `
alter table ${table} add column if not exists prop_id varchar;
alter table ${table} add column if not exists link_basis varchar;
update ${table} set prop_id = null, link_basis = null;
create or replace temp table geo_link as
with cand as (
  select p.permit_key, pr.prop_id,
         count(*) over (partition by p.permit_key) as n,
         (upper(coalesce(pr.situs_address, '')) = upper(trim(coalesce(p.address, '')))) as addr_match
  from ${table} p join properties pr on pr.geo_id = p.tcad_id
)
select permit_key, prop_id,
       case when n = 1 then 'tcad_id=geo_id'
            when addr_match then 'tcad_id=geo_id+address (' || n || ' parcels share geo_id)'
            else 'tcad_id=geo_id (ambiguous ' || n || ', lowest prop_id)' end as link_basis
from (select *, row_number() over (partition by permit_key order by addr_match desc, prop_id::bigint) as rk from cand)
where rk = 1;
update ${table} p set prop_id = g.prop_id, link_basis = g.link_basis from geo_link g where g.permit_key = p.permit_key;
update ${table} p set prop_id = pr.prop_id, link_basis = 'tcad_id=prop_id'
from properties pr where p.prop_id is null and length(p.tcad_id) between 4 and 9 and pr.prop_id = ltrim(p.tcad_id, '0');`;

/** Tag each row with the harvest that produced it, then drop the file column. */
export const windowSourceSql = (table, receipts) => `
alter table ${table} add column if not exists window_source varchar;
${receipts.map((r) => `update ${table} set window_source = ${lit(r.window_since ? `window>${r.window_since}` : "full")} where harvest_file = ${lit(r.file)};`).join("\n")}
alter table ${table} drop column harvest_file;`;

/** Per-property roof age from accepted re-roof evidence; ambiguous links are not evidence. */
export const roofAgeSql = `
create or replace table roof_age as
with rp as (
  select pm.prop_id, pm.permit_key, pm.status_bucket, pm.issued_date, pm.completed_date, pr.year_built
  from permits pm join properties pr using (prop_id)
  where pm.roofing_work = 'roof_replacement'
    and pm.link_basis not like '%ambiguous%'
    and (pr.year_built is null or year(coalesce(pm.completed_date, pm.issued_date)) >= pr.year_built)
),
final_roof as (
  select prop_id, arg_max(permit_key, struct_pack(d := completed_date, k := permit_key)) as permit_key, max(completed_date) as d
  from rp where status_bucket = 'closed' and completed_date is not null group by 1
),
unverified_roof as (
  select prop_id, arg_max(permit_key, struct_pack(d := issued_date, k := permit_key)) as permit_key, max(issued_date) as d
  from rp where status_bucket in ('open', 'expired_unfinaled') and issued_date is not null group by 1
)
select
  p.prop_id,
  case when f.d is not null then year(f.d) when u.d is not null then year(u.d) else p.year_built end as roof_year,
  case when f.d is not null then 'permit_final_roof_replacement'
       when u.d is not null then 'permit_issued_roof_replacement_unfinaled'
       when p.year_built is not null then 'tcad_year_built_assumes_original_roof'
       else 'unknown' end as roof_age_basis,
  -- Year built is only a roof-age proxy; past ~50 years an unpermitted replacement is likely.
  case when f.d is not null then 'high' when u.d is not null then 'medium'
       when p.year_built is not null and year(current_date) - p.year_built > 50 then 'very_low'
       when p.year_built is not null then 'low' else 'none' end as roof_age_confidence,
  coalesce(f.permit_key, u.permit_key) as evidence_permit_key,
  p.roof_covering, p.roof_style,
  -- Austin also issues permits in its ETJ and limited-purpose areas, which TCAD records as
  -- unincorporated; those parcels have real permit history.
  case when p.jurisdiction = 'CITY OF AUSTIN' then 'austin_permit_history_1978_plus'
       when p.jurisdiction = 'CITY OF LAKEWAY' and lw.loaded then 'lakeway_permit_history'
       when p.jurisdiction = 'TRAVIS COUNTY (UNINCORPORATED)' and ap.prop_id is not null then 'austin_etj_or_limited_purpose_permits'
       when p.jurisdiction = 'TRAVIS COUNTY (UNINCORPORATED)' then 'no_county_building_permits_in_texas'
       else 'municipal_permits_not_yet_ingested' end as permit_history_coverage
from properties p
left join final_roof f using (prop_id)
left join unverified_roof u using (prop_id)
left join (select distinct prop_id from permits where prop_id is not null and coalesce(issuing_authority, 'City of Austin') = 'City of Austin') ap using (prop_id)
cross join (select count(*) > 0 as loaded from permits where issuing_authority = 'City of Lakeway') lw;
alter table roof_age add column if not exists roof_age_years integer;
update roof_age set roof_age_years = year(current_date) - roof_year where roof_year is not null`;

/** Business-name normalization shared by every entity match. */
export const normName = (col) => `regexp_replace(trim(regexp_replace(regexp_replace(upper(coalesce(${col}, '')), '[^A-Z0-9 ]', ' ', 'g'),
  '\\b(LLC|L L C|INC|INCORPORATED|CO|COMPANY|CORP|CORPORATION|LTD|LP|LLP|PLLC|PC|THE|DBA)\\b', '', 'g')), '\\s+', ' ', 'g')`;

/**
 * Contractor aggregation from permits with explicit tie-breaks (most frequent value, then
 * alphabetical) and sorted lists, so an unchanged input always yields byte-identical output.
 * Produces: contractor_key, name_norm, display_name, phones, trades, city, zip, permit_count,
 * roofing_permit_count, first_permit, last_permit.
 */
export const contractorAggSql = `
with pc as (
  select ${normName("contractor_company_name")} as name_norm, contractor_company_name as name, contractor_phone as phone,
         contractor_trade as trade, contractor_city as city, contractor_zip as zip, roofing_work, opened_date
  from permits where contractor_company_name is not null
),
pc2 as (select * from pc where name_norm <> ''),
top_name as (select name_norm, arg_max(name, struct_pack(n := cnt, v := name)) as display_name
             from (select name_norm, name, count(*) as cnt from pc2 group by 1, 2) group by 1),
top_city as (select name_norm, arg_max(city, struct_pack(n := cnt, v := city)) as city
             from (select name_norm, city, count(*) as cnt from pc2 where city is not null group by 1, 2) group by 1),
top_zip as (select name_norm, arg_max(zip, struct_pack(n := cnt, v := zip)) as zip
            from (select name_norm, zip, count(*) as cnt from pc2 where zip is not null group by 1, 2) group by 1),
agg as (
  select name_norm,
         list_sort(list_distinct(list(phone) filter (phone is not null)))[:5] as phones,
         list_sort(list_distinct(list(trade) filter (trade is not null))) as trades,
         count(*) as permit_count,
         count(*) filter (roofing_work in ('roof_replacement', 'roof_repair')) as roofing_permit_count,
         min(opened_date) as first_permit, max(opened_date) as last_permit
  from pc2 group by 1
)
select 'contractor:' || md5(a.name_norm) as contractor_key, a.name_norm, n.display_name, a.phones, a.trades,
       c.city, z.zip, a.permit_count, a.roofing_permit_count, a.first_permit, a.last_permit
from agg a join top_name n using (name_norm) left join top_city c using (name_norm) left join top_zip z using (name_norm)`;

/**
 * Owner reconciliation across properties: one owner entity per normalized owner name + mailing
 * address, with its property portfolio, linked to a Texas Comptroller business when the name
 * matches exactly one Travis County taxpayer. Needs `properties` and `businesses`.
 */
export const ownersSql = `
create or replace table owners as
with p as (
  select prop_id, owner_name, mail_city, mail_state, mail_zip, market_val,
         ${normName("owner_name")} as name_norm,
         upper(trim(regexp_replace(coalesce(mail_line1, '') || ' ' || coalesce(mail_line2, ''), '\\s+', ' ', 'g'))) as mail_norm
  from properties where owner_name is not null
),
keyed as (select *, 'owner:' || md5(name_norm || '|' || mail_norm || '|' || coalesce(mail_zip, '')) as owner_key from p),
biz as (
  select ${normName("legal_name")} as name_norm, count(distinct taxpayer_number) as n, min(taxpayer_number) as taxpayer_number
  from businesses group by 1
)
select k.owner_key,
       arg_max(k.owner_name, struct_pack(n := 1, v := k.owner_name)) as owner_name,
       any_value(k.name_norm) as name_norm,
       min(k.mail_city) as mail_city, min(k.mail_state) as mail_state, min(k.mail_zip) as mail_zip,
       count(*) as property_count,
       sum(k.market_val)::BIGINT as total_market_val,  -- exact integer (HUGEINT would export as DOUBLE)
       case when any_value(b.n) = 1 then any_value(b.taxpayer_number) end as taxpayer_number,
       case when any_value(b.n) = 1 then 'business_registry_exact_name'
            when any_value(b.n) > 1 then 'business_registry_ambiguous'
            else 'no_business_registry_match' end as registry_link
from keyed k left join biz b using (name_norm)
group by k.owner_key
order by k.owner_key;
create or replace temp table prop_owner as
select prop_id, 'owner:' || md5(${normName("owner_name")} || '|' ||
       upper(trim(regexp_replace(coalesce(mail_line1, '') || ' ' || coalesce(mail_line2, ''), '\\s+', ' ', 'g'))) || '|' || coalesce(mail_zip, '')) as owner_key
from properties where owner_name is not null`;

/**
 * Hail exposure per property from NOAA Storm Events hail reports (table hail_events), against the
 * current roof only (reports in or after roof_year; parcels without a roof year get none). Severe =
 * 1.75 inches or more (golf ball), within 1 mile of the parcel centroid: hail reports are dense in
 * this area, so wider radii or smaller sizes flag most parcels. Time-windowed questions ("hit since
 * 2023") are answered at query time from hail_events. Needs properties and roof_age.
 */
export const HAIL_RADIUS_MILES = 1;
export const HAIL_SEVERE_INCHES = 1.75;
export const hailExposureSql = `
create or replace table hail_exposure as
with pr as (
  select p.prop_id, p.latitude, p.longitude, r.roof_year
  from properties p join roof_age r using (prop_id)
  where p.latitude is not null and r.roof_year is not null
),
hits as (
  select pr.prop_id, ev.event_date, ev.hail_inches
  from pr join hail_events ev
    on ev.latitude between pr.latitude - 0.0145 and pr.latitude + 0.0145
   and ev.longitude between pr.longitude - 0.0168 and pr.longitude + 0.0168
  where ev.hail_inches >= 1 and year(ev.event_date) >= pr.roof_year
    and 3958.8 * 2 * asin(sqrt(pow(sin(radians(ev.latitude - pr.latitude) / 2), 2)
        + cos(radians(pr.latitude)) * cos(radians(ev.latitude)) * pow(sin(radians(ev.longitude - pr.longitude) / 2), 2))) <= ${HAIL_RADIUS_MILES}
)
select prop_id,
       count(*) filter (hail_inches >= ${HAIL_SEVERE_INCHES}) as severe_hail_reports_since_roof,
       max(hail_inches) as max_hail_inches_since_roof,
       max(event_date) filter (hail_inches >= ${HAIL_SEVERE_INCHES}) as last_severe_hail_date_since_roof
from hits group by prop_id order by prop_id`;

/**
 * City of Lakeway permits (Tyler EnerGov Civic Self Service, src/sources/tyler-permits.mjs) into
 * `target` with the same columns and rules as the Austin permits: same roofing classifier and
 * status buckets; `tcad_id` from the portal's MainParcel (a TCAD geo_id with dashes on legacy
 * permits, the TCAD PROP_ID on newer ones), so the shared deterministic link rules apply.
 * `source_url` is the search endpoint; `source_request_json` holds the exact POST body that
 * returned the row. Run linkSql/openDaysSql on `target` afterwards, then upsert by permit_key.
 */
export const lakewayPermitsSql = (target, ndjson) => `
create or replace table ${target} as
with raw as (
  select * from read_json(${lit(ndjson)}, format='newline_delimited', columns={
    jurisdiction:'VARCHAR', case_id:'VARCHAR', permit_number:'VARCHAR', permit_type:'VARCHAR', work_class:'VARCHAR',
    status:'VARCHAR', description:'VARCHAR', main_parcel:'VARCHAR', address:'VARCHAR', apply_date:'VARCHAR',
    issue_date:'VARCHAR', expire_date:'VARCHAR', final_date:'VARCHAR', complete_date:'VARCHAR', source_request:'JSON',
    source_detail_url:'VARCHAR', fetched_at:'VARCHAR', contractors:'JSON'})
),
base as (
  select
    'lakeway:' || permit_number as permit_key, 'City of Lakeway' as issuing_authority, permit_number,
    permit_type, permit_type as permit_type_desc, work_class, description,
    nullif(regexp_replace(coalesce(main_parcel, ''), '[^0-9]', '', 'g'), '') as tcad_id,
    try_cast(apply_date as timestamp)::date as applied_date, try_cast(issue_date as timestamp)::date as issued_date,
    try_cast(expire_date as timestamp)::date as expires_date,
    coalesce(try_cast(final_date as timestamp)::date, try_cast(complete_date as timestamp)::date) as completed_date,
    status,
    trim(regexp_replace(coalesce(regexp_extract(upper(address), '^(.*?)\\s+LAKEWAY\\b', 1), upper(address)), '\\s+', ' ', 'g')) as address,
    'LAKEWAY' as city, regexp_extract(address, '(\\d{5})\\s*$', 1) as zip, 'CITY OF LAKEWAY' as source_jurisdiction,
    nullif(trim(json_extract_string(contractors, '$[0].name')), '') as contractor_company_name,
    json_extract_string(contractors, '$[0].role') as contractor_trade,
    source_detail_url, json_extract_string(source_request, '$.url') as source_url,
    cast(json_extract(source_request, '$.json') as varchar) as source_request_json,
    case_id as socrata_id, fetched_at, '48453' as county_fips,
    upper(concat_ws(' ', permit_type, work_class, description)) as d
  from raw
)
select * exclude (d),
  ${roofingWorkExpr("d", "'BP'")} as roofing_work,
  ${statusBucketExpr("status", "completed_date")} as status_bucket,
  coalesce(issued_date, applied_date) as opened_date,
  case when completed_date is not null then completed_date end as closed_date,
  'lakeway' as window_source,
  case when contractor_company_name is not null then 'contractor:' || md5(${normName("contractor_company_name")}) end as contractor_key
from base`;

/**
 * Overture places (src/sources/overture-places.mjs) as `business_locations`, one row per GERS id,
 * reconciled conservatively: a TCAD parcel only when the place's street address and ZIP match
 * exactly one parcel's situs address (suite/unit removed), and a Texas Comptroller business only
 * when its normalized name and street address match exactly one business. Unmatched stays null.
 * Needs properties and businesses.
 */
const streetNorm = (col) => `regexp_replace(regexp_replace(upper(trim(${col})), '\\s+(STE|SUITE|UNIT|APT|BLDG|#)\\s*.*$', ''), '\\s+', ' ', 'g')`;
export const businessLocationsSql = (placesParquet) => `
create or replace table business_locations as
with pl as (select * from read_parquet(${lit(placesParquet)})),
pa as (select gers_id, ${streetNorm("address_freeform")} as a, left(address_postcode, 5) as z from pl where address_freeform is not null),
ta as (select prop_id, ${streetNorm("situs_address")} as a, situs_zip as z from properties where situs_address is not null),
parcel as (
  select pa.gers_id, min(ta.prop_id) as prop_id from pa join ta using (a, z) group by 1 having count(distinct ta.prop_id) = 1
),
bn as (select business_key, ${normName("business_name")} as n, ${streetNorm("address")} as a, left(zip, 5) as z from businesses where business_name is not null),
biz as (
  select pl.gers_id, min(bn.business_key) as business_key
  from pl join bn on bn.n = ${normName("pl.name_primary")} and bn.a = ${streetNorm("pl.address_freeform")} and bn.z = left(pl.address_postcode, 5)
  group by 1 having count(distinct bn.business_key) = 1
)
select pl.gers_id, pl.overture_version, pl.name_primary as name, pl.taxonomy_primary,
       array_to_string(pl.taxonomy_hierarchy, ' > ') as taxonomy_hierarchy, pl.basic_category, pl.operating_status,
       round(pl.confidence, 4) as confidence, pl.brand_name, pl.address_freeform as address, pl.address_locality as locality,
       left(pl.address_postcode, 5) as zip, pl.latitude, pl.longitude,
       array_to_string(list_sort(list_distinct(list_transform(pl.sources, s -> lower(s.dataset)))), ';') as providers,
       pl.websites[1] as website, pl.phones[1] as phone,
       parcel.prop_id, case when parcel.prop_id is not null then 'exact_situs_address_unique' end as parcel_link_basis,
       biz.business_key, case when biz.business_key is not null then 'exact_name_and_address_unique' end as business_link_basis,
       pl.overture_release,
       'https://docs.overturemaps.org/attribution/' as license_url
from pl left join parcel using (gers_id) left join biz using (gers_id)
order by pl.gers_id`;
