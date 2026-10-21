// Incremental merge steps used by src/build/incremental.mjs: permit upsert by key, hail event merge
// and contractor identity carry-over, on tiny in-memory fixtures.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { contractorsCarrySql, hailEventsMergeSql, normName, upsertByKeySql } from "../src/build/permit-sql.mjs";
import { byKey, duck } from "./duck.mjs";

let db;
before(async () => { db = await duck(); });
after(() => db.close());

describe("upsertByKeySql", () => {
  test("window rows replace their previous versions, new rows are added, others are untouched", async () => {
    await db.run(`
      create or replace table permits (permit_key varchar, status varchar, open_days integer, source_request_json varchar);
      insert into permits values ('austin:1', 'Active', 10, null), ('austin:2', 'Active', 20, null), ('lakeway:9', 'Issued', 5, '{}');
      -- Window column order differs and lacks a column: insert is by name.
      create or replace table permits_window (status varchar, permit_key varchar);
      insert into permits_window values ('Final', 'austin:2'), ('Active', 'austin:3')`);
    await db.run(upsertByKeySql("permits", "permits_window"));
    const r = byKey(await db.rows("select * from permits"), "permit_key");
    assert.equal(Object.keys(r).length, 4);
    assert.equal(r["austin:1"].status, "Active");
    assert.equal(r["austin:1"].open_days, 10);
    assert.equal(r["austin:2"].status, "Final");
    assert.equal(r["austin:2"].open_days, null, "replaced row carries only window columns");
    assert.equal(r["austin:3"].status, "Active");
    assert.equal(r["lakeway:9"].source_request_json, "{}");
  });

  test("re-applying the same window is idempotent", async () => {
    await db.run(upsertByKeySql("permits", "permits_window"));
    const [n] = await db.rows("select count(*)::integer as n, count(distinct permit_key)::integer as k from permits");
    assert.deepEqual(n, { n: 4, k: 4 });
  });
});

describe("hailEventsMergeSql", () => {
  test("dedupes by event_id, preferring the later source_url, ordered by date", async () => {
    await db.run(`
      create or replace table prev_hail as select * from (values
        ('e1', date '2024-05-01', 1.75, 'https://noaa/StormEvents_2024_c20250101.csv'),
        ('e2', date '2023-04-01', 1.00, 'https://noaa/StormEvents_2023_c20240101.csv')) v(event_id, event_date, hail_inches, source_url);
      create or replace table recent_hail as select * from (values
        ('e1', date '2024-05-01', 2.00, 'https://noaa/StormEvents_2024_c20250601.csv'),
        ('e3', date '2025-03-01', 1.25, 'https://noaa/StormEvents_2025_c20250601.csv')) v(event_id, event_date, hail_inches, source_url)`);
    await db.run(hailEventsMergeSql(["select * from prev_hail", "select * from recent_hail"]));
    const r = await db.rows("select event_id, hail_inches::double as hail_inches from hail_events");
    assert.deepEqual(r, [{ event_id: "e2", hail_inches: 1 }, { event_id: "e1", hail_inches: 2 }, { event_id: "e3", hail_inches: 1.25 }]);
  });

  test("with no inputs creates the empty published schema", async () => {
    await db.run("drop table if exists hail_events");
    await db.run(hailEventsMergeSql([]));
    const cols = (await db.rows("select column_name from (describe hail_events)")).map((x) => x.column_name);
    assert.deepEqual(cols, ["event_id", "episode_id", "event_date", "latitude", "longitude", "hail_inches", "county_zone", "report_source", "source_url"]);
    assert.equal((await db.rows("select count(*)::integer as n from hail_events"))[0].n, 0);
  });
});

describe("contractorsCarrySql", () => {
  test("re-aggregates from permits and carries registry identity by contractor key", async () => {
    await db.run(`
      create or replace table permits (contractor_company_name varchar, contractor_phone varchar, contractor_trade varchar,
        contractor_city varchar, contractor_zip varchar, roofing_work varchar, opened_date date);
      insert into permits values
        ('Acme Roofing, LLC', '5125550100', 'Roofing', 'AUSTIN', '78704', 'roof_replacement', date '2020-01-01'),
        ('ACME ROOFING LLC', '5125550100', 'Roofing', 'AUSTIN', '78704', 'roof_repair', date '2022-01-01'),
        ('Acme Roofing Inc.', '5125550199', 'General', 'ROUND ROCK', '78664', null, date '2021-06-01'),
        ('New Co', null, null, null, null, null, date '2025-01-01'),
        (null, null, null, null, null, 'roof_replacement', date '2025-01-01')`);
    const [{ key }] = await db.rows(`select 'contractor:' || md5(${normName("'Acme Roofing'")}) as key`);
    await db.run(`
      create or replace table contractors as select * from (values
        ('${key}', '12345678901', '0801234567', 'ACME ROOFING LLC', 'ACTIVE', 'resolved_exact_name', 'RC123;AB001', 'A+', 'rated'),
        ('contractor:gone', null, null, null, null, 'unresolved_no_registry_match', null, null, null)
      ) v(contractor_key, taxpayer_number, sos_file_number, legal_name, right_to_transact_business, identity_status, tdlr_licenses, bbb_rating, bbb_status)`);
    await db.run(contractorsCarrySql);
    const rows = await db.rows(`select contractor_key, name_norm, display_name, phones, trades, city, permit_count::integer as permit_count,
      roofing_permit_count::integer as roofing_permit_count, first_permit::varchar as first_permit, last_permit::varchar as last_permit,
      legal_name, identity_status, tdlr_licenses, bbb_status from contractors order by contractor_key`);
    assert.equal(rows.length, 2, "contractors absent from permits are dropped; null names are skipped");
    const acme = rows.find((r) => r.contractor_key === key);
    assert.equal(acme.name_norm, "ACME ROOFING");
    assert.equal(acme.permit_count, 3);
    assert.equal(acme.roofing_permit_count, 2);
    assert.equal(acme.city, "AUSTIN", "most frequent city wins");
    assert.deepEqual(acme.phones, ["5125550100", "5125550199"]);
    assert.deepEqual(acme.trades, ["General", "Roofing"]);
    assert.equal(acme.first_permit, "2020-01-01");
    assert.equal(acme.last_permit, "2022-01-01");
    assert.equal(acme.legal_name, "ACME ROOFING LLC");
    assert.equal(acme.identity_status, "resolved_exact_name");
    assert.deepEqual(acme.tdlr_licenses, ["AB001", "RC123"]);
    assert.equal(acme.bbb_status, "rated");
    const fresh = rows.find((r) => r.contractor_key !== key);
    assert.equal(fresh.identity_status, "pending_registry_refresh");
    assert.equal(fresh.bbb_status, "excluded_no_public_api_http_403");
    assert.equal(fresh.tdlr_licenses, null);
  });
});
