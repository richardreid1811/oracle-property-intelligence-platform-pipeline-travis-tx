// Query tools shared by the explorer (apps/web) and the MCP server (mcp/server.mjs), from
// packages/query-tools: SQL builders run on a tiny fixture of the published tables in DuckDB.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { mcpTools, PLACES_SQL, resolveArgs, toolByName, tools, withLookupLinks } from "@travis-oracle/query-tools";
import { duck } from "./duck.mjs";

let db;
const run = (sql) => db.rows(sql);
// A tool call the way the MCP server makes it: resolve place, build SQL, run.
const call = async (name, args) => run(toolByName[name].sql(await resolveArgs(name, args, run)));

before(async () => {
  db = await duck();
  // Downtown Austin is about (30.2672, -97.7431); 0.01 degrees of latitude is about 0.69 miles.
  await db.run(`
    create table leads as select * from (values
      ('101', '100 CONGRESS AVE', 'CITY OF AUSTIN', '78701', 30.2672, -97.7431, 2000, 26, 'tcad_year_built_assumes_original_roof', 'low', 'COMP', 2000, 0, null::date,
        0, null::double, null::date, 'travis_county', 'A1', 'OWNER A', 'AUSTIN', 'TX', date '2001-01-01', true, 1, 'https://tcad/101'),
      ('102', '200 CONGRESS AVE', 'CITY OF AUSTIN', '78701', 30.2700, -97.7431, 2008, 18, 'permit_final_roof_replacement', 'high', 'METAL', 1985, 1, date '2019-01-01',
        1, 1.75, date '2021-05-01', 'out_of_state', 'B1', 'OWNER B', 'DENVER', 'CO', date '2020-06-01', false, 3, 'https://tcad/102'),
      ('103', '300 CONGRESS AVE', 'CITY OF AUSTIN', '78701', 30.2750, -97.7431, 2020, 6, 'permit_final_roof_replacement', 'high', 'COMP', 1990, 0, null::date,
        0, null::double, null::date, 'texas_other', 'F1', 'OWNER C', 'HOUSTON', 'TX', date '2010-01-01', false, 1, 'https://tcad/103'),
      -- About 14 miles north: outside a 5 mile radius.
      ('201', '1 PFLUGERVILLE PKWY', 'CITY OF PFLUGERVILLE', '78660', 30.4394, -97.6200, 1990, 36, 'tcad_year_built_assumes_original_roof', 'low', 'COMP', 1990, 0, null::date,
        0, null::double, null::date, 'travis_county', 'A1', 'OWNER D', 'PFLUGERVILLE', 'TX', date '1995-01-01', true, 1, 'https://tcad/201')
    ) v(prop_id, situs_address, jurisdiction, situs_zip, latitude, longitude, roof_year, roof_age_years, roof_age_basis, roof_age_confidence,
        roof_covering, year_built, open_roofing_permits, oldest_open_date, severe_hail_reports_since_roof, max_hail_inches_since_roof,
        last_severe_hail_date_since_roof, owner_mail_region, imprv_state_cd, owner_name, mail_city, mail_state, deed_date,
        owner_occupied_homestead, owner_property_count, source_detail_url);
    create table contractors as select * from (values
      ('contractor:acme', 'ACME ROOFING LLC', 'resolved_exact_name', null::varchar, 'excluded_no_public_api_http_403')
    ) v(contractor_key, legal_name, identity_status, bbb_rating, bbb_status);
    create table roofing_permits as select * from (values
      ('austin:2019-1', '2019-1', '102', 'Active', 'open', 'roof_replacement', date '2019-01-01', null::date, 'Acme Roofing', 'contractor:acme',
        'Re-roof SFR', '200 CONGRESS AVE', 30.2701, -97.7432, 'https://permits/2019-1'),
      ('austin:2021-2', '2021-2', '102', 'Final', 'closed', 'roof_replacement', date '2021-01-01', date '2021-03-01', 'Acme Roofing', 'contractor:acme',
        'Re-roof SFR', '200 CONGRESS AVE', 30.2701, -97.7432, 'https://permits/2021-2'),
      ('austin:2015-3', '2015-3', '201', 'Expired', 'expired_unfinaled', 'roof_repair', date '2015-01-01', null::date, null, null,
        'Roof repair', '1 PFLUGERVILLE PKWY', 30.4394, -97.6200, 'https://permits/2015-3')
    ) v(permit_key, permit_number, prop_id, status, status_bucket, roofing_work, opened_date, completed_date, contractor_company_name,
        contractor_key, description, address, latitude, longitude, source_detail_url);
    create table hail_events as select * from (values
      ('h1', date '2019-06-01', 30.2705, -97.7430, 2.0),
      ('h2', date '2019-06-01', 30.2705, -97.7430, 1.0)
    ) v(event_id, event_date, latitude, longitude, hail_inches);
    -- Published coordinates are DOUBLE (VALUES literals would be DECIMAL).
    ${["leads", "roofing_permits", "hail_events"].map((t) => `alter table ${t} alter latitude type double; alter table ${t} alter longitude type double;`).join("\n")}
    alter table hail_events alter hail_inches type double;`);
  await db.run(PLACES_SQL);
});
after(() => db.close());

describe("tool definitions", () => {
  test("every tool has a name, description, object schema and SQL builder; MCP shape matches", () => {
    for (const t of tools) {
      assert.ok(t.name && t.description, t.name);
      assert.equal(t.input_schema.type, "object", t.name);
      assert.equal(typeof t.sql, "function", t.name);
    }
    assert.deepEqual(mcpTools().map((t) => t.name), tools.map((t) => t.name));
  });
});

describe("resolve_place", () => {
  test("municipality names resolve to the parcel centroid gazetteer", async () => {
    const [hit] = await call("resolve_place", { name: "Pflugerville" });
    assert.equal(hit.name, "PFLUGERVILLE");
    assert.equal(hit.kind, "municipality");
    assert.equal(hit.latitude, 30.4394);
  });

  test("quotes in a place name cannot break out of the string literal", async () => {
    assert.deepEqual(await call("resolve_place", { name: "x' or '1'='1" }), []);
  });
});

describe("aged_roofs_near", () => {
  test("strictly older than the threshold, within the radius, permit-verified first", async () => {
    const rows = await call("aged_roofs_near", { latitude: 30.2672, longitude: -97.7431, radius_miles: 5, older_than_years: 15 });
    assert.deepEqual(rows.map((r) => r.prop_id), ["102", "101"]);
    assert.equal(rows[0].roof_age_confidence, "high");
    assert.ok(rows.every((r) => r.distance_miles <= 5));
    const [count] = await run(toolByName.aged_roofs_near.count_sql({ latitude: 30.2672, longitude: -97.7431, radius_miles: 5, older_than_years: 15 }));
    assert.deepEqual({ matches: Number(count.matches), permit_verified: Number(count.permit_verified) }, { matches: 2, permit_verified: 1 });
  });

  test("place argument resolves before SQL is built; residential_only filters state codes", async () => {
    const rows = await call("aged_roofs_near", { place: "Austin", radius_miles: 2, older_than_years: 0, residential_only: "true" });
    assert.deepEqual(rows.map((r) => r.prop_id).sort(), ["101", "102"]);
  });

  test("coordinates outside the county are rejected, not clamped", () => {
    assert.throws(() => toolByName.aged_roofs_near.sql({ latitude: 40.7, longitude: -74.0 }), /outside the Travis County area/);
  });
});

describe("open_roofing_permits_near", () => {
  test("only open or unfinaled roofing permits in the radius, with contractor identity", async () => {
    const rows = withLookupLinks(await call("open_roofing_permits_near", { latitude: 30.27, longitude: -97.743, radius_miles: 3 }));
    assert.equal(rows.length, 1);
    assert.equal(rows[0].permit_number, "2019-1");
    assert.equal(rows[0].contractor_legal_name, "ACME ROOFING LLC");
    assert.equal(rows[0].source_detail_url, "https://permits/2019-1");
    assert.match(rows[0].bbb_lookup_url, /^https:\/\/www\.bbb\.org\/search\?.*find_text=Acme%20Roofing/);
  });
});

describe("snapshot date (_as_of)", () => {
  test("days open and tenure are measured to the snapshot date, so results do not change daily", async () => {
    const { snapshotDate } = await import("@travis-oracle/query-tools");
    const asOf = snapshotDate({ run_id: "20200101T120000Z" });
    assert.equal(asOf, "2020-01-01");
    const [p] = await call("open_roofing_permits_near", { latitude: 30.27, longitude: -97.743, radius_miles: 3, _as_of: asOf });
    assert.equal(Number(p.open_days), 365);
    assert.equal(p.open_years, 1);
    const stale = await call("stale_ownership_near", { latitude: 30.2672, longitude: -97.7431, radius_miles: 5, min_years: 5, _as_of: asOf });
    assert.deepEqual(stale.map((r) => [r.prop_id, r.years_since_deed]), [["101", 18], ["103", 9]]);
    assert.doesNotMatch(toolByName.open_roofing_permits_near.sql({ latitude: 30.27, longitude: -97.743, _as_of: asOf }), /current_date/);
  });

  test("a malformed _as_of falls back to the query date instead of being interpolated", () => {
    assert.match(toolByName.open_roofing_permits_near.sql({ latitude: 30.27, longitude: -97.743, _as_of: "2020-01-01'; drop" }), /current_date/);
  });
});

describe("hail_exposed_roofs_near", () => {
  test("joins hail reports at query time, only against the current roof", async () => {
    const args = { latitude: 30.2672, longitude: -97.7431, radius_miles: 5, since: "2018-01-01" };
    const rows = await call("hail_exposed_roofs_near", args);
    // 103's roof (2020) postdates the 2019 report; the 1.0 inch report is under the 1.75 default.
    assert.deepEqual(rows.map((r) => [r.prop_id, Number(r.hail_reports)]).sort(), [["101", 1], ["102", 1]]);
    const [count] = await run(toolByName.hail_exposed_roofs_near.count_sql({ ...args, min_hail_inches: 1 }));
    assert.equal(Number(count.matches), 2);
  });
});

describe("other lead tools", () => {
  test("absentee_owners_near defaults to out-of-state, international and texas_other", async () => {
    const rows = await call("absentee_owners_near", { latitude: 30.2672, longitude: -97.7431, radius_miles: 5 });
    assert.deepEqual(rows.map((r) => r.prop_id).sort(), ["102", "103"]);
  });

  test("property_detail strips non-digits from prop_id and lists the parcel's roofing permits", async () => {
    const [row] = await call("property_detail", { prop_id: "10'2; drop table leads" });
    assert.equal(row.prop_id, "102");
    assert.equal(row.roofing_permits.length, 2);
  });

  test("dataset_summary counts every loaded table", async () => {
    const rows = Object.fromEntries((await call("dataset_summary", {})).map((r) => [r.table_name, Number(r.rows)]));
    assert.equal(rows["leads (properties)"], 4);
    assert.equal(rows.roofing_permits, 3);
    assert.equal(rows.contractors, 1);
  });
});
