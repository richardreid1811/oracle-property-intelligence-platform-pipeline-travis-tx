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
// Coordinates outside the Travis County area are rejected, never clamped: clamping would silently
// search a different place.
const inRange = (v, lo, hi, what) => {
  const n = num(v);
  if (n < lo || n > hi) throw new Error(`${what} ${n} is outside the Travis County area (${lo} to ${hi})`);
  return n;
};
const point = (a) => ({
  lat: inRange(a.latitude, 29.9, 30.7, "latitude"),
  lon: inRange(a.longitude, -98.3, -97.3, "longitude"),
  r: num(a.radius_miles, { min: 0.1, max: 25, dflt: 5 }),
});
// "Today" for durations (days open, years since deed, default hail window) is the snapshot date when
// the runtime passes it as _as_of (see snapshotDate), so results stay identical for one snapshot
// instead of shifting daily; without it, the query date.
const asOf = (a) => (/^\d{4}-\d{2}-\d{2}$/.test(a?._as_of ?? "") ? `date '${a._as_of}'` : "current_date");
// Ownership tenure in whole years (exact; not calendar-year boundaries).
const tenure = (a, col = "deed_date") => `cast(floor(date_diff('day', ${col}, ${asOf(a)}) / 365.2425) as integer)`;
// "Older than N years": strict comparison on whole-year roof age.
const olderThan = (a) => num(a.older_than_years ?? a.min_roof_age_years, { min: 0, max: 150, dflt: 15 });
const residential = (a) => (bool(a.residential_only, false) ? "and (imprv_state_cd like 'A%' or imprv_state_cd like 'B%' or imprv_state_cd like 'E%')" : "");

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
    description: "Properties (residential and commercial) within a radius whose estimated roof is older than older_than_years (default 15). Ranked permit-verified first. Returns roof-age basis and confidence (high = finaled re-roof permit, medium = unfinaled re-roof permit, low = year built, very_low = year built over 50 years ago so the roof was probably replaced without a permit record), coordinates and the TCAD source link.",
    input_schema: { type: "object", properties: { ...POINT_PROPS, older_than_years: { type: "number", description: "Roof age threshold in years; matches roofs strictly older. Default 15." }, residential_only: { type: "boolean", description: "Only TCAD residential state codes (A*/B*/E*). Default false (all improved properties)." } } },
    sql: (a) => {
      const { lat, lon, r } = point(a);
      const age = olderThan(a);
      const res = residential(a);
      return `
        select prop_id, situs_address, jurisdiction, round(${miles(lat, lon)}, 2) as distance_miles,
               roof_age_years, roof_year, roof_age_basis, roof_age_confidence, roof_covering, year_built,
               open_roofing_permits, oldest_open_date, severe_hail_reports_since_roof, max_hail_inches_since_roof, last_severe_hail_date_since_roof,
               owner_mail_region, latitude, longitude, source_detail_url
        from leads
        where ${bbox(lat, lon, r)} and ${miles(lat, lon)} <= ${r}
          and roof_age_years > ${age} ${res}
        order by case roof_age_confidence when 'high' then 0 when 'medium' then 1 when 'low' then 2 else 3 end, roof_age_years desc, distance_miles
        limit ${LIMIT(a.limit)}`;
    },
    count_sql: (a) => {
      const { lat, lon, r } = point(a);
      return `select count(*) as matches, count(*) filter (roof_age_confidence = 'high') as permit_verified
              from leads where ${bbox(lat, lon, r)} and ${miles(lat, lon)} <= ${r} and roof_age_years > ${olderThan(a)} ${residential(a)}`;
    },
  },
  {
    name: "open_roofing_permits_near",
    description: "Roofing permits (re-roof / roof repair) within a radius that are still open or expired without a final inspection, longest-open first, with contractor identity and Texas registry resolution. BBB ratings are not ingested (BBB blocks automated access); each contractor row includes bbb_lookup_url for the user to check BBB directly. min_open_years filters long-open permits.",
    input_schema: { type: "object", properties: { ...POINT_PROPS, min_open_years: { type: "number", description: "Only permits open at least this many years (default 0)." }, issued_since: { type: "string", description: "Optional ISO date; only permits opened on/after it." } } },
    sql: (a) => {
      const { lat, lon, r } = point(a);
      const minDays = Math.round(num(a.min_open_years, { min: 0, max: 100, dflt: 0 }) * 365.25);
      const since = /^\d{4}-\d{2}-\d{2}$/.test(a.issued_since ?? "") ? `and opened_date >= date '${a.issued_since}'` : "";
      return `
        select p.permit_number, p.status, p.status_bucket, p.roofing_work, p.opened_date,
               date_diff('day', p.opened_date, ${asOf(a)}) as open_days,
               round(date_diff('day', p.opened_date, ${asOf(a)}) / 365.25, 1) as open_years, p.address, p.prop_id,
               round(${miles(lat, lon, "p.latitude", "p.longitude")}, 2) as distance_miles,
               p.contractor_company_name, c.legal_name as contractor_legal_name, c.identity_status as contractor_identity,
               c.bbb_rating, c.bbb_status, left(p.description, 160) as description,
               p.latitude, p.longitude, p.source_detail_url
        from roofing_permits p left join contractors c using (contractor_key)
        where p.roofing_work in ('roof_replacement', 'roof_repair')
          and p.status_bucket in ('open', 'expired_unfinaled')
          and ${bbox(lat, lon, r, "p.latitude", "p.longitude")} and ${miles(lat, lon, "p.latitude", "p.longitude")} <= ${r}
          and date_diff('day', p.opened_date, ${asOf(a)}) >= ${minDays} ${since}
        order by p.opened_date, p.permit_number
        limit ${LIMIT(a.limit)}`;
    },
    count_sql: (a) => {
      const { lat, lon, r } = point(a);
      const minDays = Math.round(num(a.min_open_years, { min: 0, max: 100, dflt: 0 }) * 365.25);
      const since = /^\d{4}-\d{2}-\d{2}$/.test(a.issued_since ?? "") ? `and opened_date >= date '${a.issued_since}'` : "";
      return `select count(*) as matches, count(contractor_company_name) as with_contractor
              from roofing_permits
              where roofing_work in ('roof_replacement', 'roof_repair') and status_bucket in ('open', 'expired_unfinaled')
                and ${bbox(lat, lon, r)} and ${miles(lat, lon)} <= ${r} and date_diff('day', opened_date, ${asOf(a)}) >= ${minDays} ${since}`;
    },
  },
  {
    name: "hail_exposed_roofs_near",
    description: "Properties within a radius whose current roof was hit by hail in a time window: NOAA Storm Events hail reports of at least min_hail_inches (default 1.75, golf ball) within event_radius_miles (default 1) of the property, on or after since (default: the last 3 years) and not before the roof year. Works countywide, including unincorporated areas without permits. Hail exposure is a lead signal, not evidence of damage.",
    input_schema: { type: "object", properties: { ...POINT_PROPS,
      since: { type: "string", description: "ISO date; only hail on or after it (default: 3 years ago)." },
      min_hail_inches: { type: "number", description: "Minimum hail size in inches (default 1.75)." },
      event_radius_miles: { type: "number", description: "Distance from a hail report to the property (default 1, max 3)." },
      older_than_years: { type: "number", description: "Optional: only roofs strictly older than this many years." } } },
    sql: (a) => hailSql(a, false),
    count_sql: (a) => hailSql(a, true),
  },
  {
    name: "semantic_search_permits",
    description: "Semantic (meaning-based) search over roofing permit records: finds permits whose work description matches a natural-language phrase such as 'hail damage repair', 'metal roof replacement on commercial building' or 'storm damaged shingles', even when the exact words differ. Uses vector embeddings of each permit's description, work class, status and contractor. Optionally restrict to a place/radius and to permits still open. Returns similarity scores and source links.",
    needs_embedding: true,
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "What the permit work is about, in plain language." },
        place: POINT_PROPS.place, latitude: POINT_PROPS.latitude, longitude: POINT_PROPS.longitude,
        radius_miles: { type: "number", description: "Only with place or coordinates (default 5, max 25)." },
        open_only: { type: "boolean", description: "Only permits still open or expired without a final inspection. Default false." },
        limit: POINT_PROPS.limit,
      },
      required: ["query"],
    },
    sql: (a) => {
      if (!Array.isArray(a._qvec) || a._qvec.length !== 384) throw new Error("query embedding missing");
      const vec = `[${a._qvec.map((v) => Number(v).toFixed(6)).join(",")}]::FLOAT[384]`;
      const hasPoint = Number.isFinite(Number(a.latitude)) && Number.isFinite(Number(a.longitude)) && a.latitude !== "" && a.longitude !== "";
      const geo = hasPoint ? (() => { const { lat, lon, r } = point(a); return { lat, lon, r }; })() : null;
      return `
        with q as (select ${vec} as v)
        select p.permit_number, p.status, p.status_bucket, p.roofing_work, p.opened_date,
               case when p.status_bucket in ('open', 'expired_unfinaled') then round(date_diff('day', p.opened_date, ${asOf(a)}) / 365.25, 1) end as open_years,
               p.address, p.prop_id, left(p.description, 200) as description,
               p.contractor_company_name, c.legal_name as contractor_legal_name, c.identity_status as contractor_identity, c.bbb_rating,
               round(array_cosine_similarity(e.embedding::FLOAT[384], q.v)::DOUBLE, 3) as similarity,
               ${geo ? `round(${miles(geo.lat, geo.lon, "p.latitude", "p.longitude")}, 2) as distance_miles,` : ""}
               p.latitude, p.longitude, p.source_detail_url
        from permit_embeddings e
        join roofing_permits p using (permit_key)
        left join contractors c using (contractor_key)
        cross join q
        where true
          ${bool(a.open_only, false) ? "and p.status_bucket in ('open', 'expired_unfinaled')" : ""}
          ${geo ? `and ${bbox(geo.lat, geo.lon, geo.r, "p.latitude", "p.longitude")} and ${miles(geo.lat, geo.lon, "p.latitude", "p.longitude")} <= ${geo.r}` : ""}
        order by array_cosine_similarity(e.embedding::FLOAT[384], q.v) desc, p.permit_key
        limit ${LIMIT(a.limit)}`;
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
        select prop_id, situs_address, owner_name, deed_date, ${tenure(a)} as years_since_deed, owner_occupied_homestead,
               owner_property_count, roof_age_years, roof_age_basis, round(${miles(lat, lon)}, 2) as distance_miles, source_detail_url
        from leads
        where ${bbox(lat, lon, r)} and ${miles(lat, lon)} <= ${r}
          and date_diff('day', deed_date, ${asOf(a)}) > ${minYears} * 365.2425
        order by deed_date, prop_id
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
        select prop_id, situs_address, owner_name, mail_city, mail_state, owner_mail_region, owner_property_count,
               roof_age_years, roof_age_confidence, ${tenure(a)} as years_since_deed, round(${miles(lat, lon)}, 2) as distance_miles, source_detail_url
        from leads
        where ${bbox(lat, lon, r)} and ${miles(lat, lon)} <= ${r}
          and owner_mail_region in (${regions.map((x) => `'${x}'`).join(",") || "''"})
        order by case roof_age_confidence when 'high' then 0 when 'medium' then 1 when 'low' then 2 else 3 end, roof_age_years desc nulls last, prop_id
        limit ${LIMIT(a.limit)}`;
    },
  },
  {
    name: "property_detail",
    description: "Full record for one TCAD property id: owner, deed, year built, roof attributes and roof-age evidence, plus all roofing permits on the parcel.",
    input_schema: { type: "object", properties: { prop_id: { type: "string" } }, required: ["prop_id"] },
    sql: (a) => `
      select l.*, ${tenure(a, "l.deed_date")} as years_since_deed, (select list({permit: permit_number, status: status, opened: opened_date, completed: completed_date,
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

// Query-time hail join: hail_events is small (about 1,100 reports), so the time window, size and
// radius stay parameters instead of being baked into published columns.
function hailSql(a, countOnly) {
  const { lat, lon, r } = point(a);
  const minIn = num(a.min_hail_inches, { min: 0.75, max: 6, dflt: 1.75 });
  const er = num(a.event_radius_miles, { min: 0.25, max: 3, dflt: 1 });
  const since = /^\d{4}-\d{2}-\d{2}$/.test(a.since ?? "") ? `date '${a.since}'` : `${asOf(a)} - interval 3 year`;
  const age = a.older_than_years === undefined || a.older_than_years === null || a.older_than_years === "" ? null : num(a.older_than_years, { min: 0, max: 150 });
  const dLat = er / 69.0;
  const dLon = er / (69.17 * Math.cos((lat * Math.PI) / 180));
  const body = `
    with p as (
      select prop_id, situs_address, jurisdiction, latitude, longitude, roof_year, roof_age_years, roof_age_basis,
             roof_age_confidence, roof_covering, open_roofing_permits, source_detail_url
      from leads
      where ${bbox(lat, lon, r)} and ${miles(lat, lon)} <= ${r} and roof_year is not null
        ${age === null ? "" : `and roof_age_years > ${age}`}
    ),
    ev as (
      select event_id, event_date, latitude as elat, longitude as elon, hail_inches from hail_events
      where hail_inches >= ${minIn} and event_date >= ${since}
        and ${bbox(lat, lon, r + er, "latitude", "longitude")}
    ),
    hits as (
      select p.prop_id, count(*) as hail_reports, max(ev.hail_inches) as max_hail_inches, max(ev.event_date) as last_hail_date
      from p join ev on ev.elat between p.latitude - ${dLat} and p.latitude + ${dLat}
                    and ev.elon between p.longitude - ${dLon} and p.longitude + ${dLon}
      where year(ev.event_date) >= p.roof_year and ${miles("p.latitude", "p.longitude", "ev.elat", "ev.elon")} <= ${er}
      group by p.prop_id
    )`;
  if (countOnly) return `${body} select count(*) as matches from hits`;
  return `${body}
    select p.prop_id, p.situs_address, p.jurisdiction, round(${miles(lat, lon, "p.latitude", "p.longitude")}, 2) as distance_miles,
           h.hail_reports, h.max_hail_inches, h.last_hail_date, p.roof_age_years, p.roof_year, p.roof_age_basis, p.roof_age_confidence,
           p.roof_covering, p.open_roofing_permits, p.latitude, p.longitude, p.source_detail_url
    from hits h join p using (prop_id)
    order by h.hail_reports desc, h.max_hail_inches desc, h.last_hail_date desc, p.prop_id
    limit ${LIMIT(a.limit)}`;
}

/**
 * Viewer-initiated BBB lookup. BBB blocks automated access and has no public API, so the pipeline
 * never fetches BBB; instead each contractor row carries a link that opens BBB's own search in the
 * viewer's browser, prefilled with the contractor name and Austin, TX.
 */
export const bbbLookupUrl = (name, city = "Austin, TX") =>
  name ? `https://www.bbb.org/search?find_country=USA&find_text=${encodeURIComponent(name)}&find_loc=${encodeURIComponent(city)}` : null;

/** Add bbb_lookup_url to any result row that names a contractor. */
export const withLookupLinks = (rows) =>
  rows.map((r) => (r.contractor_company_name || r.oldest_open_contractor || r.display_name
    ? { ...r, bbb_lookup_url: bbbLookupUrl(r.contractor_company_name ?? r.oldest_open_contractor ?? r.display_name) }
    : r));

/**
 * Resolve a `place` argument to latitude/longitude before building SQL, so models never have to copy
 * coordinates between steps, and embed the query text for semantic tools. `run(sql)` executes SQL and
 * returns row objects; `embedQuery(text)` returns the query vector (runtimes pass embed.mjs).
 */
export async function resolveArgs(name, args, run, embedQuery) {
  const a = { ...args };
  if (toolByName[name]?.needs_embedding) {
    if (!embedQuery) throw new Error("semantic search needs an embedder in this runtime");
    a._qvec = Array.from(await embedQuery(String(a.query ?? "")));
  }
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

/** Snapshot date (YYYY-MM-DD) from a run manifest, for the tools' _as_of argument. */
export const snapshotDate = (manifest) => {
  const m = /^(\d{4})(\d{2})(\d{2})T/.exec(manifest?.run_id ?? "");
  return m ? `${m[1]}-${m[2]}-${m[3]}` : String(manifest?.created_at ?? "").slice(0, 10) || undefined;
};

/** OpenAI-style tool list for chat-completions function calling (Workers AI accepts this shape). */
export const openAiTools = () =>
  tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.input_schema } }));

/** MCP tools/list shape. */
export const mcpTools = () => tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.input_schema }));
