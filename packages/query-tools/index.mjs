// Roofing-lead query tools for the Travis County Oracle dataset.
// One definition per tool: a JSON Schema (for LLM tool calling and MCP) and a SQL builder that runs
// on DuckDB (DuckDB-WASM in the browser, DuckDB Node in the MCP server) over the published tables:
//   leads, roofing_permits, contractors, properties, places
// Every result row carries provenance (source_detail_url / permit links / roof_age_basis) so
// answers can be source-backed. SQL builders only interpolate validated numbers and bound strings.

const num = (v, { min = -Infinity, max = Infinity, dflt } = {}) => {
  const n = v === undefined || v === null || v === "" ? dflt : Number(v);
  if (!Number.isFinite(n)) throw new Error(`expected a number, got ${JSON.stringify(v)}`);
  return Math.min(max, Math.max(min, n));
};
const str = (v, max = 120) => String(v ?? "").slice(0, max).replaceAll("'", "''");
// LLMs often send booleans as strings.
const bool = (v, dflt) => (v === undefined || v === null || v === "" ? dflt : v === true || String(v).toLowerCase() === "true");
const LIMIT = (v) => Math.trunc(num(v, { min: 1, max: 200, dflt: 25 }));

// Great-circle distance in miles between (lat, lon) columns and a validated point.
const miles = (lat, lon, latCol = "latitude", lonCol = "longitude") =>
  `3958.8 * 2 * asin(sqrt(pow(sin(radians(${latCol} - ${lat}) / 2), 2) + cos(radians(${lat})) * cos(radians(${latCol})) * pow(sin(radians(${lonCol} - ${lon}) / 2), 2)))`;
// Cheap bounding box first, then exact distance.
const bbox = (lat, lon, r, latCol = "latitude", lonCol = "longitude") => {
  const dLat = r / 69.0;
  const dLon = r / (69.17 * Math.cos((lat * Math.PI) / 180));
  return `${latCol} between ${lat - dLat} and ${lat + dLat} and ${lonCol} between ${lon - dLon} and ${lon + dLon}`;
};
const point = (a) => ({
  lat: num(a.latitude, { min: 29.5, max: 31.0 }),
  lon: num(a.longitude, { min: -98.6, max: -97.0 }),
  r: num(a.radius_miles, { min: 0.1, max: 25, dflt: 5 }),
});

const POINT_PROPS = {
  place: { type: "string", description: "Preferred: a Travis County city/village name or ZIP code (e.g. 'Pflugerville', '78704', 'Austin'). Resolved to its centroid from parcel data. Use this instead of latitude/longitude whenever the user names a place." },
  latitude: { type: "number", description: "Center latitude (WGS84), only for an exact map pin." },
  longitude: { type: "number", description: "Center longitude (WGS84), only for an exact map pin." },
  radius_miles: { type: "number", description: "Search radius in miles (default 5, max 25)." },
  limit: { type: "integer", description: "Maximum rows (default 25, max 200)." },
};

export const tools = [
  {
    name: "resolve_place",
    description: "Resolve a Travis County place name (city/village, ZIP code, or Austin neighborhood/subdivision) to a center point using centroids computed from parcel data. Call this first when the user names a place instead of coordinates.",
    input_schema: { type: "object", properties: { name: { type: "string", description: "e.g. 'Pflugerville', '78704', 'Hyde Park'" } }, required: ["name"] },
    sql: (a) => `
      select name, kind, latitude, longitude, parcels
      from places
      where upper(name) = upper('${str(a.name)}') or upper(name) like upper('%${str(a.name)}%')
      order by (upper(name) = upper('${str(a.name)}')) desc, parcels desc
      limit 5`,
  },
  {
    name: "aged_roofs_near",
    description: "Properties within a radius whose estimated roof age is at least min_roof_age_years (default 15). Ranked permit-verified first. Returns roof-age basis and confidence (high = finaled re-roof permit, medium = unfinaled re-roof permit, low = year built, very_low = year built over 50 years ago so the roof was probably replaced without a permit record), coordinates and the TCAD source link.",
    input_schema: { type: "object", properties: { ...POINT_PROPS, min_roof_age_years: { type: "number", description: "Default 15." }, residential_only: { type: "boolean", description: "Only TCAD residential state codes (A*/B*/E*). Default true." } } },
    sql: (a) => {
      const { lat, lon, r } = point(a);
      const minAge = num(a.min_roof_age_years, { min: 0, max: 150, dflt: 15 });
      const res = bool(a.residential_only, true) ? "and (imprv_state_cd like 'A%' or imprv_state_cd like 'B%' or imprv_state_cd like 'E%')" : "";
      return `
        select prop_id, situs_address, jurisdiction, round(${miles(lat, lon)}, 2) as distance_miles,
               roof_age_years, roof_year, roof_age_basis, roof_age_confidence, roof_covering, year_built,
               open_roofing_permits, owner_mail_region, latitude, longitude, source_detail_url
        from leads
        where ${bbox(lat, lon, r)} and ${miles(lat, lon)} <= ${r}
          and roof_age_years >= ${minAge} ${res}
        order by case roof_age_confidence when 'high' then 0 when 'medium' then 1 when 'low' then 2 else 3 end, roof_age_years desc, distance_miles
        limit ${LIMIT(a.limit)}`;
    },
    count_sql: (a) => {
      const { lat, lon, r } = point(a);
      const minAge = num(a.min_roof_age_years, { min: 0, max: 150, dflt: 15 });
      const res = bool(a.residential_only, true) ? "and (imprv_state_cd like 'A%' or imprv_state_cd like 'B%' or imprv_state_cd like 'E%')" : "";
      return `select count(*) as matches, count(*) filter (roof_age_confidence = 'high') as permit_verified
              from leads where ${bbox(lat, lon, r)} and ${miles(lat, lon)} <= ${r} and roof_age_years >= ${minAge} ${res}`;
    },
  },
  {
    name: "open_roofing_permits_near",
    description: "Roofing permits (re-roof / roof repair) within a radius that are still open or expired without a final inspection, longest-open first, with contractor identity, registry resolution and BBB status. min_open_years filters long-open permits.",
    input_schema: { type: "object", properties: { ...POINT_PROPS, min_open_years: { type: "number", description: "Only permits open at least this many years (default 0)." }, issued_since: { type: "string", description: "Optional ISO date; only permits opened on/after it." } } },
    sql: (a) => {
      const { lat, lon, r } = point(a);
      const minDays = Math.round(num(a.min_open_years, { min: 0, max: 100, dflt: 0 }) * 365.25);
      const since = /^\d{4}-\d{2}-\d{2}$/.test(a.issued_since ?? "") ? `and opened_date >= date '${a.issued_since}'` : "";
      return `
        select p.permit_number, p.status, p.status_bucket, p.roofing_work, p.opened_date, p.open_days,
               round(p.open_days / 365.25, 1) as open_years, p.address, p.prop_id,
               round(${miles(lat, lon, "p.latitude", "p.longitude")}, 2) as distance_miles,
               p.contractor_company_name, c.legal_name as contractor_legal_name, c.identity_status as contractor_identity,
               c.bbb_rating, c.bbb_status, left(p.description, 160) as description,
               p.latitude, p.longitude, p.source_detail_url
        from roofing_permits p left join contractors c using (contractor_key)
        where p.roofing_work in ('roof_replacement', 'roof_repair')
          and p.status_bucket in ('open', 'expired_unfinaled')
          and ${bbox(lat, lon, r, "p.latitude", "p.longitude")} and ${miles(lat, lon, "p.latitude", "p.longitude")} <= ${r}
          and p.open_days >= ${minDays} ${since}
        order by p.open_days desc
        limit ${LIMIT(a.limit)}`;
    },
    count_sql: (a) => {
      const { lat, lon, r } = point(a);
      const minDays = Math.round(num(a.min_open_years, { min: 0, max: 100, dflt: 0 }) * 365.25);
      const since = /^\d{4}-\d{2}-\d{2}$/.test(a.issued_since ?? "") ? `and opened_date >= date '${a.issued_since}'` : "";
      return `select count(*) as matches, count(contractor_company_name) as with_contractor
              from roofing_permits
              where roofing_work in ('roof_replacement', 'roof_repair') and status_bucket in ('open', 'expired_unfinaled')
                and ${bbox(lat, lon, r)} and ${miles(lat, lon)} <= ${r} and open_days >= ${minDays} ${since}`;
    },
  },
  {
    name: "stale_ownership_near",
    description: "Properties within a radius that have not changed ownership in more than min_years (default 10), from the TCAD deed date (Texas does not disclose sale prices).",
    input_schema: { type: "object", properties: { ...POINT_PROPS, min_years: { type: "number", description: "Default 10." } } },
    sql: (a) => {
      const { lat, lon, r } = point(a);
      const minYears = num(a.min_years, { min: 0, max: 100, dflt: 10 });
      return `
        select prop_id, situs_address, owner_name, deed_date, years_since_deed, owner_occupied_homestead,
               roof_age_years, roof_age_basis, round(${miles(lat, lon)}, 2) as distance_miles, source_detail_url
        from leads
        where ${bbox(lat, lon, r)} and ${miles(lat, lon)} <= ${r} and years_since_deed > ${minYears}
        order by years_since_deed desc
        limit ${LIMIT(a.limit)}`;
    },
  },
  {
    name: "absentee_owners_near",
    description: "Properties within a radius whose owner mailing address is outside the area: regions out_of_state, international, texas_other (outside the Austin metro), or austin_metro (outside Travis County).",
    input_schema: { type: "object", properties: { ...POINT_PROPS, regions: { type: "array", items: { type: "string", enum: ["out_of_state", "international", "texas_other", "austin_metro"] }, description: "Default ['out_of_state','international','texas_other']." } } },
    sql: (a) => {
      const { lat, lon, r } = point(a);
      const allowed = ["out_of_state", "international", "texas_other", "austin_metro"];
      const regions = (Array.isArray(a.regions) && a.regions.length ? a.regions : ["out_of_state", "international", "texas_other"]).filter((x) => allowed.includes(x));
      return `
        select prop_id, situs_address, owner_name, mail_city, mail_state, owner_mail_region,
               roof_age_years, years_since_deed, round(${miles(lat, lon)}, 2) as distance_miles, source_detail_url
        from leads
        where ${bbox(lat, lon, r)} and ${miles(lat, lon)} <= ${r}
          and owner_mail_region in (${regions.map((x) => `'${x}'`).join(",") || "''"})
        order by roof_age_years desc nulls last
        limit ${LIMIT(a.limit)}`;
    },
  },
  {
    name: "property_detail",
    description: "Full record for one TCAD property id: owner, deed, year built, roof attributes and roof-age evidence, plus all roofing permits on the parcel.",
    input_schema: { type: "object", properties: { prop_id: { type: "string" } }, required: ["prop_id"] },
    sql: (a) => `
      select l.*, (select list({permit: permit_number, status: status, opened: opened_date, completed: completed_date,
                                contractor: contractor_company_name, work: roofing_work, link: source_detail_url})
                   from roofing_permits where prop_id = l.prop_id) as roofing_permits
      from leads l where l.prop_id = '${str(a.prop_id, 12).replace(/[^0-9]/g, "")}'`,
  },
  {
    name: "dataset_summary",
    description: "Record counts by source/table for the loaded snapshot (properties, permits, roofing permits, contractors, businesses, licenses) and coverage notes.",
    input_schema: { type: "object", properties: {} },
    sql: () => `
      select 'leads (properties)' as table_name, count(*) as rows from leads
      union all select 'roofing_permits', count(*) from roofing_permits
      union all select 'contractors', count(*) from contractors
      union all select 'places (gazetteer)', count(*) from places`,
  },
];

export const toolByName = Object.fromEntries(tools.map((t) => [t.name, t]));

/**
 * Resolve a `place` argument to latitude/longitude before building SQL, so models never have to copy
 * coordinates between steps. `run(sql)` executes SQL and returns row objects.
 */
export async function resolveArgs(name, args, run) {
  const a = { ...args };
  const hasPoint = Number.isFinite(Number(a.latitude)) && Number.isFinite(Number(a.longitude)) && a.latitude !== "" && a.longitude !== "";
  if (name !== "resolve_place" && a.place && (!hasPoint || toolByName[name]?.input_schema.properties.place)) {
    let [hit] = await run(toolByName.resolve_place.sql({ name: a.place }));
    if (!hit) {
      // "downtown Pflugerville", "north Austin", "near 78704" -> retry without the modifier.
      const stripped = String(a.place).replace(/\b(downtown|central|north|south|east|west|near|around|city of|village of)\b/gi, "").trim();
      if (stripped && stripped !== a.place) [hit] = await run(toolByName.resolve_place.sql({ name: stripped }));
    }
    if (!hit) throw new Error(`no Travis County place matches "${a.place}"`);
    a.latitude = Number(hit.latitude);
    a.longitude = Number(hit.longitude);
    a.resolved_place = { name: hit.name, kind: hit.kind, latitude: a.latitude, longitude: a.longitude };
  }
  return a;
}

// Well-known Austin-area places that are not municipalities or ZIPs (approximate centers).
const LANDMARKS = [
  ["Downtown Austin", 30.2672, -97.7431], ["UT Austin campus", 30.2849, -97.7341], ["Hyde Park", 30.3062, -97.728],
  ["Zilker", 30.2669, -97.7729], ["South Congress", 30.2475, -97.75], ["East Austin", 30.2633, -97.72],
  ["Mueller", 30.2983, -97.7056], ["Barton Hills", 30.2547, -97.7849], ["Tarrytown", 30.2955, -97.768],
  ["Clarksville", 30.2827, -97.759], ["The Domain", 30.4021, -97.7253], ["Circle C Ranch", 30.192, -97.8823],
  ["Travis Heights", 30.249, -97.743], ["Allandale", 30.3366, -97.7462], ["Crestview", 30.3456, -97.727],
  ["Windsor Park", 30.317, -97.69], ["Bouldin Creek", 30.255, -97.756], ["Montopolis", 30.234, -97.697],
  ["Del Valle", 30.188, -97.638], ["Steiner Ranch", 30.3866, -97.8853], ["Jollyville", 30.4436, -97.7714],
];

// Gazetteer built from the data itself (municipality and ZIP centroids) plus the landmarks above.
// Needs the \`leads\` table.
export const PLACES_SQL = `
  create or replace table places as
  select replace(replace(jurisdiction, 'CITY OF ', ''), 'VILLAGE OF ', '') as name, 'municipality' as kind,
         avg(latitude) as latitude, avg(longitude) as longitude, count(*) as parcels
  from leads where latitude is not null group by 1
  union all
  select situs_zip, 'zip', avg(latitude), avg(longitude), count(*)
  from leads where latitude is not null and situs_zip is not null group by 1
  having count(*) >= 50
  union all
  select * from (values ${LANDMARKS.map(([n, la, lo]) => `('${n}', 'landmark (approximate)', ${la}, ${lo}, 0)`).join(", ")})`;

/** OpenAI-style tool list for chat-completions function calling (Workers AI accepts this shape). */
export const openAiTools = () =>
  tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.input_schema } }));

/** MCP tools/list shape. */
export const mcpTools = () => tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.input_schema }));
