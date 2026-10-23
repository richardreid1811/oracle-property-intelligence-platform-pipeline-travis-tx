// Roofing classifier, status buckets, reclassification of carried permits and roof age (permit-sql.mjs),
// each run on a few hand-written rows in an in-memory DuckDB.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { linkSql, reclassifySql, roofAgeSql, roofingWorkExpr, statusBucketExpr } from "../src/build/permit-sql.mjs";
import { byKey, duck } from "./duck.mjs";

let db;
before(async () => { db = await duck(); });
after(() => db.close());

const classify = async (cases) => byKey(await db.rows(`
  select k, ${roofingWorkExpr("upper(coalesce(d, ''))", "t")} as w
  from (values ${cases.map(([k, t, d]) => `('${k}', '${t}', ${d === null ? "null" : `'${d}'`})`).join(", ")}) v(k, t, d)`), "k");

describe("roofingWorkExpr", () => {
  test("re-roof, replacement, repair and mentions", async () => {
    const r = await classify([
      ["reroof", "BP", "Re-roof SFR, remove and replace shingles"],
      ["reroof2", "BP", "REROOF commercial building"],
      ["tearoff", "BP", "roof tear-off and new decking"],
      ["replace", "BP", "Replace existing roof with metal"],
      ["newroof", "BP", "new roofing on garage"],
      ["repair", "BP", "Roof repair after storm"],
      ["deck", "BP", "roof deck repair"],
      ["mention", "BP", "Remodel kitchen, roof line unchanged"],
      ["none", "BP", "Interior remodel"],
      ["nulldesc", "BP", null],
    ]);
    assert.equal(r.reroof.w, "roof_replacement");
    assert.equal(r.reroof2.w, "roof_replacement");
    assert.equal(r.tearoff.w, "roof_replacement");
    assert.equal(r.replace.w, "roof_replacement");
    assert.equal(r.newroof.w, "roof_replacement");
    assert.equal(r.repair.w, "roof_repair");
    assert.equal(r.deck.w, "roof_repair");
    assert.equal(r.mention.w, "roof_mention");
    assert.equal(r.none.w, null);
    assert.equal(r.nulldesc.w, null);
  });

  test("exclusions apply unless an explicit re-roof phrase is present", async () => {
    const r = await classify([
      ["solar", "BP", "Roof mounted solar PV system, new roof attachments"],
      ["rtu", "BP", "Replace rooftop unit (RTU) on roof"],
      ["sign", "BP", "Roof sign replacement"],
      ["solar_reroof", "BP", "Re-roof and install solar panels"],
    ]);
    assert.equal(r.solar.w, null);
    assert.equal(r.rtu.w, null);
    assert.equal(r.sign.w, null);
    assert.equal(r.solar_reroof.w, "roof_replacement");
  });

  test("only Building Permits are classified (companion trade permits repeat the description)", async () => {
    const r = await classify([["ep", "EP", "Re-roof SFR"], ["mp", "MP", "New roof"], ["bp", "BP", "Re-roof SFR"]]);
    assert.equal(r.ep.w, null);
    assert.equal(r.mp.w, null);
    assert.equal(r.bp.w, "roof_replacement");
  });
});

describe("statusBucketExpr", () => {
  test("prefix-matched terminal statuses and expired with/without completion", async () => {
    const r = byKey(await db.rows(`
      select s, ${statusBucketExpr("s", "c")} as b from (values
        ('Final', null), ('Closed', null), ('Completed', null),
        ('Void', null), ('Withdrawn', null), ('Cancelled - Contractor Required', null), ('Denied but Closed', null),
        ('Aborted', null), ('Revoked', null), ('Rejected', null),
        ('Expired', null), ('Expired - License', date '2020-01-02'),
        ('Active', null), ('Pending', null), (null, null)
      ) v(s, c)`), "s");
    for (const s of ["Final", "Closed", "Completed"]) assert.equal(r[s].b, "closed", s);
    for (const s of ["Void", "Withdrawn", "Cancelled - Contractor Required", "Denied but Closed", "Aborted", "Revoked", "Rejected"]) assert.equal(r[s].b, "void", s);
    assert.equal(r.Expired.b, "expired_unfinaled");
    assert.equal(r["Expired - License"].b, "closed");
    assert.equal(r.Active.b, "open");
    assert.equal(r.Pending.b, "open");
    assert.equal(r.null.b, "open");
  });

  test("matching is case-insensitive", async () => {
    const [r] = await db.rows(`select ${statusBucketExpr("'final'", "null")} as a, ${statusBucketExpr("'eXpIrEd'", "null")} as b`);
    assert.deepEqual(r, { a: "closed", b: "expired_unfinaled" });
  });
});

describe("reclassifySql", () => {
  test("re-applies classifier and buckets to Austin and Lakeway rows with their own rules", async () => {
    await db.run(`
      create or replace table carried (permit_key varchar, issuing_authority varchar, permit_type varchar, work_class varchar,
        description varchar, status varchar, completed_date date, roofing_work varchar, status_bucket varchar, closed_date date);
      insert into carried values
        ('austin:1', 'City of Austin', 'BP', 'Repair', 'Re-roof SFR', 'Final', date '2019-05-01', 'stale', 'open', null),
        ('austin:2', null, 'BP', null, 'Roof repair', 'Expired', null, null, 'closed', null),
        ('austin:3', 'City of Austin', 'EP', null, 'Re-roof SFR', 'Active', null, 'roof_replacement', 'open', null),
        -- Lakeway types are words ('Residential Roofing'), classified from type + work class + description.
        ('lakeway:1', 'City of Lakeway', 'Residential Roofing', 'Re-Roof', 'shingles', 'Issued', null, null, null, null),
        ('lakeway:2', 'City of Lakeway', 'Residential Building', 'Addition', 'bedroom addition', 'Finaled', date '2024-02-03', 'roof_mention', null, null)`);
    await db.run(reclassifySql("carried"));
    const r = byKey(await db.rows("select permit_key, roofing_work, status_bucket, closed_date::varchar as closed_date from carried"), "permit_key");
    assert.deepEqual(r["austin:1"], { permit_key: "austin:1", roofing_work: "roof_replacement", status_bucket: "closed", closed_date: "2019-05-01" });
    assert.equal(r["austin:2"].roofing_work, "roof_repair");
    assert.equal(r["austin:2"].status_bucket, "expired_unfinaled");
    assert.equal(r["austin:3"].roofing_work, null, "electrical permit is not classified");
    assert.equal(r["lakeway:1"].roofing_work, "roof_replacement");
    assert.equal(r["lakeway:1"].status_bucket, "open");
    assert.equal(r["lakeway:2"].roofing_work, null);
    assert.equal(r["lakeway:2"].status_bucket, "closed");
  });
});

describe("linkSql", () => {
  test("unique geo_id links; a shared geo_id resolves only on exactly one address match", async () => {
    await db.run(`
      create or replace table properties (prop_id varchar, geo_id varchar, situs_address varchar);
      insert into properties values
        ('10', 'G1', '1 A ST'),                                -- unique geo_id
        ('20', 'G2', '2 B ST'), ('21', 'G2', '3 C ST'),        -- shared, one address matches
        ('30', 'G3', '4 D ST'), ('31', 'G3', '4 D ST'),        -- shared, both addresses match: a tie
        ('40', 'G4', null), ('41', 'G4', null),                -- shared, both blank
        ('50', 'G5', '5 E ST'), ('51', 'G5', '6 F ST');        -- shared, no match
      create or replace table permits (permit_key varchar, tcad_id varchar, address varchar);
      insert into permits values ('a', 'G1', '1 A ST'), ('b', 'G2', '3 c st'), ('c', 'G3', '4 D ST'),
        ('d', 'G4', null), ('e', 'G5', '9 Z ST');`);
    await db.run(linkSql("permits"));
    const r = byKey(await db.rows("select permit_key, prop_id, link_basis from permits"), "permit_key");
    assert.deepEqual([r.a.prop_id, r.a.link_basis], ["10", "tcad_id=geo_id"]);
    assert.deepEqual([r.b.prop_id, r.b.link_basis], ["21", "tcad_id=geo_id+address (2 parcels share geo_id)"]);
    assert.match(r.c.link_basis, /ambiguous 2, 2 address matches/);
    assert.match(r.d.link_basis, /ambiguous 2, lowest prop_id/);
    assert.match(r.e.link_basis, /ambiguous 2, lowest prop_id/);
  });
});

describe("roofAgeSql", () => {
  test("finaled re-roof > unfinaled re-roof > year built, ambiguous links and pre-construction permits ignored", async () => {
    await db.run(`
      create or replace table properties (prop_id varchar, year_built integer, roof_covering varchar, roof_style varchar, jurisdiction varchar);
      insert into properties values
        ('1', 1990, 'COMP', 'GABLE', 'CITY OF AUSTIN'),            -- finaled re-roof 2015 and a later open one
        ('2', 1995, null, null, 'CITY OF AUSTIN'),                 -- only an open re-roof
        ('3', 2001, null, null, 'TRAVIS COUNTY (UNINCORPORATED)'), -- ambiguous-link re-roof only
        ('4', 1900, null, null, 'CITY OF AUSTIN'),                 -- year built over 50 years ago
        ('5', null, null, null, 'CITY OF PFLUGERVILLE'),           -- nothing known
        ('6', 2010, null, null, 'CITY OF AUSTIN'),                 -- re-roof permit dated before construction
        ('7', 1980, null, null, 'TRAVIS COUNTY (UNINCORPORATED)'); -- Austin ETJ permit, but a repair only
      create or replace table permits (permit_key varchar, prop_id varchar, roofing_work varchar, status_bucket varchar,
        issued_date date, completed_date date, link_basis varchar, issuing_authority varchar);
      insert into permits values
        ('a', '1', 'roof_replacement', 'closed', date '2015-03-01', date '2015-04-01', 'tcad_id=geo_id', 'City of Austin'),
        ('b', '1', 'roof_replacement', 'open', date '2022-01-01', null, 'tcad_id=geo_id', 'City of Austin'),
        ('c', '1', 'roof_replacement', 'closed', date '2008-01-01', date '2008-02-01', 'tcad_id=geo_id', 'City of Austin'),
        ('d', '2', 'roof_replacement', 'expired_unfinaled', date '2018-06-01', null, 'tcad_id=prop_id', 'City of Austin'),
        ('e', '3', 'roof_replacement', 'closed', date '2020-01-01', date '2020-02-01', 'tcad_id=geo_id (ambiguous 2, lowest prop_id)', 'City of Austin'),
        ('f', '6', 'roof_replacement', 'closed', date '2005-01-01', date '2005-02-01', 'tcad_id=geo_id', 'City of Austin'),
        ('g', '7', 'roof_repair', 'closed', date '2021-01-01', date '2021-02-01', 'tcad_id=geo_id', 'City of Austin'),
        ('h', '2', 'roof_replacement', 'void', date '2023-01-01', null, 'tcad_id=geo_id', 'City of Austin')`);
    await db.run(roofAgeSql);
    const r = byKey(await db.rows(`select prop_id, roof_year::integer as roof_year, roof_age_basis, roof_age_confidence, evidence_permit_key, permit_history_coverage,
      roof_age_years = year(current_date) - roof_year as years_consistent from roof_age`), "prop_id");
    assert.deepEqual([r["1"].roof_year, r["1"].roof_age_basis, r["1"].roof_age_confidence, r["1"].evidence_permit_key],
      [2015, "permit_final_roof_replacement", "high", "a"]);
    assert.deepEqual([r["2"].roof_year, r["2"].roof_age_basis, r["2"].roof_age_confidence, r["2"].evidence_permit_key],
      [2018, "permit_issued_roof_replacement_unfinaled", "medium", "d"], "void permit is not evidence");
    assert.deepEqual([r["3"].roof_year, r["3"].roof_age_basis, r["3"].roof_age_confidence], [2001, "tcad_year_built_assumes_original_roof", "low"]);
    assert.equal(r["4"].roof_age_confidence, "very_low");
    assert.deepEqual([r["5"].roof_year, r["5"].roof_age_basis, r["5"].roof_age_confidence], [null, "unknown", "none"]);
    assert.equal(r["6"].roof_age_basis, "tcad_year_built_assumes_original_roof", "permit before year built is ignored");
    assert.equal(r["1"].years_consistent, true);
    assert.equal(r["1"].permit_history_coverage, "austin_permit_history_1978_plus");
    assert.equal(r["3"].permit_history_coverage, "austin_etj_or_limited_purpose_permits");
    assert.equal(r["5"].permit_history_coverage, "municipal_permits_not_yet_ingested");
    assert.equal(r["7"].roof_age_basis, "tcad_year_built_assumes_original_roof", "a repair is not a replacement");
  });
});
