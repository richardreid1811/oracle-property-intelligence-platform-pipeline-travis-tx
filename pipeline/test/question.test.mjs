// Deterministic question parser (packages/query-tools/question.mjs): the agent's fallback when the
// model allocation is used up. README demo prompts and a few variants map to one tool call each.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { parseQuestion, planQuestion } from "@travis-oracle/query-tools/question.mjs";
import { duck } from "./duck.mjs";

describe("parseQuestion", () => {
  test("README aged-roof prompt (radius as a word, county mention ignored)", () => {
    const p = parseQuestion("Which properties in Travis County within five miles of Sunset Valley have roofs older than 15 years?");
    assert.equal(p.tool, "aged_roofs_near");
    assert.deepEqual(p.args, { radius_miles: 5, older_than_years: 15 });
    assert.deepEqual(p.place_candidates, ["Sunset Valley"]);
  });

  test("short form: roofs older than 15 years within 5 miles of Sunset Valley", () => {
    const p = parseQuestion("Show me roofs older than 15 years within 5 miles of Sunset Valley");
    assert.equal(p.tool, "aged_roofs_near");
    assert.deepEqual(p.args, { radius_miles: 5, older_than_years: 15 });
    assert.deepEqual(p.place_candidates, ["Sunset Valley"]);
  });

  test("README open-permits-plus-contractor prompt: long-open permits, no place (reuses the previous one)", () => {
    const p = parseQuestion("Which properties near that area have open roofing permits that have been open for many years, and who is the listed contractor?");
    assert.equal(p.tool, "open_roofing_permits_near");
    assert.deepEqual(p.args, { radius_miles: 3, min_open_years: 3 });
    assert.deepEqual(p.place_candidates, []);
  });

  test("open permits with an explicit duration and a ZIP code", () => {
    const p = parseQuestion("List permits still open more than 5 years within 2 miles of 78745");
    assert.equal(p.tool, "open_roofing_permits_near");
    assert.deepEqual(p.args, { radius_miles: 2, min_open_years: 5 });
    assert.deepEqual(p.place_candidates, ["78745"]);
  });

  test("hail wins over roof age; default radius 3", () => {
    const p = parseQuestion("Roofs older than 10 years in Pflugerville hit by hail");
    assert.equal(p.tool, "hail_exposed_roofs_near");
    assert.deepEqual(p.args, { radius_miles: 3, older_than_years: 10 });
    assert.deepEqual(p.place_candidates, ["Pflugerville"]);
    assert.ok(p.assumptions.some((a) => /3 miles/.test(a)));
  });

  test("no ownership change in N years", () => {
    const p = parseQuestion("Within 3 miles of 78704, which owners have not sold in over 10 years and mail their tax bills out of state?");
    assert.equal(p.tool, "stale_ownership_near");
    assert.deepEqual(p.args, { radius_miles: 3, min_years: 10 });
    assert.deepEqual(p.place_candidates, ["78704"]);
  });

  test("out-of-area owners", () => {
    const p = parseQuestion("absentee owners around Hyde Park within half a mile");
    assert.equal(p.tool, "absentee_owners_near");
    assert.deepEqual(p.args, { radius_miles: 0.5 });
    assert.deepEqual(p.place_candidates, ["Hyde Park"]);
  });

  test("anything else falls back to aged roofs", () => {
    assert.equal(parseQuestion("good leads in Lakeway").tool, "aged_roofs_near");
  });
});

describe("planQuestion", () => {
  let db;
  before(async () => {
    db = await duck();
    await db.run(`create table places as select * from (values
      ('SUNSET VALLEY', 'municipality', 30.2252, -97.8139, 332), ('78704', 'zip', 30.243, -97.765, 9000)
    ) v(name, kind, latitude, longitude, parcels)`);
  });
  after(() => db.close());

  test("resolves the place through resolve_place; a later question without one reuses it", async () => {
    const first = await planQuestion("Which properties in Travis County within five miles of Sunset Valley have roofs older than 15 years?", db.rows);
    assert.equal(first.args.place, "SUNSET VALLEY");
    const next = await planQuestion("Which properties near that area have open roofing permits that have been open for many years, and who is the listed contractor?", db.rows,
      { place: first.place, radius_miles: first.args.radius_miles });
    assert.equal(next.tool, "open_roofing_permits_near");
    assert.deepEqual(next.args, { place: "SUNSET VALLEY", radius_miles: 5, min_open_years: 3 });
    assert.ok(next.assumptions.includes("no place named; reusing SUNSET VALLEY within 5 miles"));
  });

  test("unknown places and missing places are errors, not a silent default", async () => {
    await assert.rejects(planQuestion("old roofs near Atlantis", db.rows), /no Travis County place matches "Atlantis"/);
    await assert.rejects(planQuestion("old roofs within 2 miles", db.rows), /name a Travis County/);
  });
});
