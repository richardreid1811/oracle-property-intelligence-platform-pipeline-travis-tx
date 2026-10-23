#!/usr/bin/env node
// Lexicon transform: Travis County build tables -> per-property Elephant Lexicon output, the
// contract `elephant-cli validate`, `hash` and the county archive consume
// (soofi-xyz-team-kit build-county-transform/reference/output-contract.md):
//
//   <out>/<group>/<prop_id>/  entity files, relationship files, one root per data group
//                             (named by the data-group schema CID from the live manifest),
//                             and the mandatory Seed root.
//
// Groups:
//   county                one directory per assessed property (TCAD roll + parcel geometry)
//   property_improvement  one directory per property with linked City of Austin permits
//
// Provenance is never reconstructed: every entity carries the exact request its data came from
// (the TCAD export zip, the ArcGIS page that returned the parcel centroid, the Socrata request
// that returned the permit row), split into url + multiValueQueryString as the lexicon requires.
// Fields the lexicon has no home for, and codes with no exact lexicon value, are left out (null)
// rather than guessed; see docs/lexicon-publication.md for the gap list.
//
// Usage: node src/lexicon/transform.mjs <build.duckdb> <out-dir> --group county|property_improvement
//          [--gis <tcad-centroids.ndjson>] [--limit N] [--props id1,id2,...]
import { DuckDBInstance } from "@duckdb/node-api";
import AdmZip from "adm-zip";
import { createReadStream } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";

const MANIFEST_URL = process.env.ELEPHANT_SCHEMA_MANIFEST_URL ?? "https://lexicon.elephant.xyz/api/manifest";
const [dbPath, outDir, ...rest] = process.argv.slice(2);
const opt = (n, d) => (rest.includes(n) ? rest[rest.indexOf(n) + 1] : d);
const group = opt("--group");
const limit = opt("--limit") ? Number(opt("--limit")) : null;
const onlyProps = opt("--props") ? opt("--props").split(",") : null;
const gisPath = opt("--gis");
if (!dbPath || !outDir || !["county", "property_improvement"].includes(group)) {
  console.error("usage: transform.mjs <build.duckdb> <out-dir> --group county|property_improvement [--gis file] [--limit N] [--props ids]");
  process.exit(2);
}

// Data-group schema CIDs are resolved from the live manifest at run time, never hardcoded.
const manifest = await (await fetch(MANIFEST_URL, { signal: AbortSignal.timeout(30_000) })).json();
const SEED = manifest.Seed?.ipfsCid;
const COUNTY = manifest.County?.ipfsCid;
const PI = manifest.Property_Improvement?.ipfsCid;
if (!SEED || !COUNTY || !PI) throw new Error("lexicon manifest is missing Seed, County or Property_Improvement");

// ---------------------------------------------------------------------------------------------
// Requests: the lexicon URL pattern allows no query string, so it goes in multiValueQueryString.
const request = (rawUrl) => {
  const u = new URL(rawUrl);
  const q = {};
  for (const [k, v] of u.searchParams) (q[k] ??= []).push(v);
  const r = { method: "GET", url: `${u.origin}${u.pathname}` };
  if (Object.keys(q).length) r.multiValueQueryString = q;
  return r;
};

// ---------------------------------------------------------------------------------------------
// Code mappings (Texas PTAD state codes as TCAD uses them). Only exact lexicon matches; anything
// uncertain maps to a generic value or null.
const PROPERTY_BY_CODE = {
  A1: ["SingleFamily", "Residential", "SingleFamilyDetached"],
  A2: ["ManufacturedHome", "Residential", "ManufacturedHomeOnLand"],
  A4: ["Condominium", "Residential", null],
  B1: ["MultipleFamily", "Residential", null],
  B2: ["Duplex", "Residential", "Duplex"],
  B3: ["3Units", "Residential", "Triplex"],
  B4: ["4Units", "Residential", "Quadplex"],
  C1: ["VacantLand", "Residential", null],
  C2: ["VacantLand", "Commercial", null],
  D1: ["LandParcel", "Agricultural", null],
  F1: ["Building", "Commercial", null],
  F2: ["Building", "Industrial", null],
  J1: ["Building", "Utility", null],
  J2: ["Building", "Utility", null],
  J3: ["Building", "Utility", null],
  J4: ["Building", "Utility", null],
  J5: ["Building", "Railroad", null],
  J6: ["Building", "Utility", null],
  J7: ["Building", "TelecommunicationsFacility", null],
  M1: ["MobileHome", "Residential", "MobileHome"],
  O1: ["VacantLand", "Residential", null],
};
function propertyKind(imprv, land) {
  const code = (imprv ?? land ?? "").slice(0, 2).toUpperCase();
  if (PROPERTY_BY_CODE[code]) return PROPERTY_BY_CODE[code];
  if (code.startsWith("A") || code.startsWith("E")) return ["MiscellaneousResidential", "Residential", null];
  if (code.startsWith("B")) return ["MultipleFamily", "Residential", null];
  if (code.startsWith("F")) return ["Building", "Commercial", null];
  if (!imprv) return ["LandParcel", "Unknown", null];
  return ["Building", "Unknown", null];
}
const ROOF_MATERIAL = { COMPOSITIO: "Composition", METAL: "Metal", TILE: "Tile", "WOOD SHING": "Wood" };
const ROOF_COVERING = { "BUILT-UP": "Built-Up Roof", "WOOD SHING": "Wood Shingle" };
const ROOF_DESIGN = { HIP: "Hip", GABLE: "Gable", FLAT: "Flat", MANSARD: "Mansard", BARN: "Gambrel" };

// Every required structure/lot field must be present; unknown ones are null.
const STRUCTURE_REQUIRED = [
  "architectural_style_type", "attachment_type", "exterior_wall_material_primary", "exterior_wall_material_secondary",
  "exterior_wall_condition", "exterior_wall_insulation_type", "flooring_material_primary", "flooring_material_secondary",
  "subfloor_material", "flooring_condition", "interior_wall_structure_material", "interior_wall_surface_material_primary",
  "interior_wall_surface_material_secondary", "interior_wall_finish_primary", "interior_wall_finish_secondary",
  "interior_wall_condition", "roof_covering_material", "roof_underlayment_type", "roof_structure_material",
  "roof_design_type", "roof_condition", "roof_age_years", "gutters_material", "gutters_condition", "roof_material_type",
  "foundation_type", "foundation_material", "foundation_waterproofing", "foundation_condition",
  "ceiling_structure_material", "ceiling_surface_material", "ceiling_insulation_type", "ceiling_height_average",
  "ceiling_condition", "exterior_door_material", "interior_door_material", "window_frame_material",
  "window_glazing_type", "window_operation_type", "window_screen_material", "primary_framing_material",
  "secondary_framing_material", "structural_damage_indicators",
];

// ---------------------------------------------------------------------------------------------
// Owners. TCAD writes individuals as "LAST FIRST [MIDDLE]"; several owners are joined with "&".
// A name that does not parse cleanly is not guessed: organizations become companies, anything
// else ambiguous is left unlinked (kit rule: preserve unresolved contacts as unlinked).
const ORG = /\b(LLC|L L C|INC|CORP|CORPORATION|COMPANY|CO|LTD|LP|LLP|PLLC|PC|TRUST|TRUSTEE|TRS|ESTATE|EST|BANK|ASSOCIATION|ASSN|HOA|CHURCH|PARTNERS|PARTNERSHIP|HOLDINGS|PROPERTIES|INVESTMENTS|VENTURES|GROUP|FOUNDATION|FUND|CITY|COUNTY|STATE|DISTRICT|AUTHORITY|UNIVERSITY|ISD|MUD|SCHOOL|DEVELOPMENT|HOMES|BUILDERS|REALTY|CAPITAL|MANAGEMENT|SERVICES)\b/;
const NAME_PART = /^[A-Z][A-Z'\-]*$/;
const SUFFIXES = { JR: "Jr.", SR: "Sr.", II: "II", III: "III", IV: "IV" };
const title = (s) => s.toLowerCase().replace(/(^|[ \-'])([a-z])/g, (_, p, c) => p + c.toUpperCase());
const PERSON_NAME = /^[A-Z][a-z]*([ \-',.][A-Za-z][a-z]*)*$/;
function parsePerson(tokens, inheritedLast) {
  let suffix = null;
  if (tokens.length && SUFFIXES[tokens.at(-1)]) suffix = SUFFIXES[tokens.pop()];
  let last, first, middle;
  if (inheritedLast && tokens.length >= 1 && tokens.length <= 2) [first, middle] = tokens, (last = inheritedLast);
  else if (tokens.length >= 2 && tokens.length <= 3) [last, first, middle] = tokens;
  else return null;
  if (![last, first, middle].filter(Boolean).every((t) => NAME_PART.test(t))) return null;
  const p = { last: title(last), first: title(first), middle: middle ? title(middle) : null, suffix };
  if (!PERSON_NAME.test(p.last) || !PERSON_NAME.test(p.first) || (p.middle && p.middle.length < 2)) return null;
  return p;
}
function parseOwners(name) {
  const raw = (name ?? "").trim().replace(/\s+/g, " ").toUpperCase();
  if (!raw) return [];
  if (ORG.test(raw)) return [{ kind: "company", name: raw }];
  const parts = raw.split(/\s*&\s*/);
  const out = [];
  let last = null;
  for (const [i, part] of parts.entries()) {
    const p = parsePerson(part.split(" ").filter(Boolean), i > 0 ? last : null);
    if (!p) return out; // stop at the first part we cannot read unambiguously
    last = p.last.toUpperCase();
    out.push({ kind: "person", ...p });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Per-property writer.
const link = (file) => ({ "/": `./${file}` });
// One ZIP per property (<prop_id>.zip holding data/<files>): elephant-cli reads a directory of
// property ZIPs, and ZIPs avoid hundreds of thousands of tiny files on disk.
async function writeProperty(target, files) {
  const zip = new AdmZip();
  for (const [name, value] of Object.entries(files)) zip.addFile(`data/${name}`, Buffer.from(JSON.stringify(value)));
  await writeFile(`${target}.zip`, zip.toBuffer());
}

function seedFiles(p, req) {
  const address = { source_http_request: req, request_identifier: p.prop_id, unnormalized_address: fullAddress(p) };
  const parcel = { source_http_request: req, request_identifier: p.prop_id, parcel_identifier: p.geo_id ?? p.prop_id };
  return {
    files: {
      "address.json": address,
      "parcel.json": parcel,
      "relationship_address_has_parcel.json": { from: link("address.json"), to: link("parcel.json") },
      [`${SEED}.json`]: { label: "Seed", relationships: { address_has_parcel: link("relationship_address_has_parcel.json") } },
    },
  };
}
const fullAddress = (p) =>
  [p.situs_address, [p.situs_city, "TX"].filter(Boolean).join(", "), p.situs_zip].filter(Boolean).join(" ").replace(" TX ", ", TX ").trim() ||
  `TCAD property ${p.prop_id}`;

function propertyEntity(p, req) {
  const [type, usage, form] = propertyKind(p.imprv_state_cd, p.land_state_cd);
  const e = {
    source_http_request: req,
    request_identifier: p.prop_id,
    parcel_identifier: p.geo_id ?? p.prop_id,
    property_legal_description_text: p.legal_desc ?? null,
    property_type: type,
    property_usage_type: usage,
  };
  if (form) e.structure_form = form;
  if (p.year_built) e.property_structure_built_year = p.year_built;
  if (p.main_area_sqft >= 10) e.livable_floor_area = String(Math.round(p.main_area_sqft));
  e.build_status = p.imprv_state_cd ? "Improved" : "VacantLand";
  return e;
}

function countyFiles(p, req, gis) {
  const { files } = seedFiles(p, req);
  const rel = {};
  const add = (key, fileName, value, many) => {
    files[fileName] = value;
    if (many) (rel[key] ??= []).push(link(fileName));
    else rel[key] = link(fileName);
  };
  files["property.json"] = propertyEntity(p, req);
  add("property_has_address", "relationship_property_has_address.json", { from: link("property.json"), to: link("address.json") });
  add("property_has_parcel", "relationship_property_has_parcel.json", { from: link("property.json"), to: link("parcel.json") }, true);

  // Coordinates: only a parcel's own GIS centroid, with the exact ArcGIS request that returned it.
  if (gis) {
    files["geometry.json"] = { source_http_request: request(gis.source_url), request_identifier: p.prop_id, latitude: gis.latitude, longitude: gis.longitude };
    add("address_has_geometry", "relationship_address_has_geometry.json", { from: link("address.json"), to: link("geometry.json") });
  }

  // Structure: TCAD roof attributes; roof age and roof date only from re-roof permit evidence.
  if (p.imprv_state_cd) {
    const s = { source_http_request: req, request_identifier: p.prop_id };
    for (const k of STRUCTURE_REQUIRED) s[k] = null;
    s.roof_material_type = ROOF_MATERIAL[p.roof_covering] ?? null;
    s.roof_covering_material = ROOF_COVERING[p.roof_covering] ?? null;
    s.roof_design_type = ROOF_DESIGN[p.roof_style] ?? null;
    if (p.roof_age_basis === "permit_final_roof_replacement" || p.roof_age_basis === "permit_issued_roof_replacement_unfinaled") {
      // The lexicon's roof age starts at 1; a roof replaced this year keeps only its roof_date.
      s.roof_age_years = p.roof_age_years >= 1 ? p.roof_age_years : null;
      s.roof_date = String(p.roof_year);
    }
    files["structure.json"] = s;
    add("property_has_structure", "relationship_property_has_structure.json", { from: link("property.json"), to: link("structure.json") });
  }

  // Values for the roll year (Texas: no tax bill in the appraisal export, so tax amounts stay null).
  if (p.market_val != null) {
    const t = {
      source_http_request: req, request_identifier: p.prop_id, tax_year: p.tax_year,
      property_building_amount: null, monthly_tax_amount: null, period_end_date: null, period_start_date: null,
      property_market_value_amount: Number(p.market_val),
    };
    if (p.assessed_val != null) t.property_assessed_value_amount = Number(p.assessed_val);
    files[`tax_${p.tax_year}.json`] = t;
    add("property_has_tax", `relationship_property_has_tax_${p.tax_year}.json`, { from: link("property.json"), to: link(`tax_${p.tax_year}.json`) }, true);
  }

  // Ownership: the last recorded deed and its grantees (the current owners). Texas does not
  // disclose sale prices.
  if (p.deed_date || p.owner_name) {
    files["sales_history_1.json"] = { source_http_request: req, request_identifier: p.prop_id, ownership_transfer_date: p.deed_date ?? null };
    add("property_has_sales_history", "relationship_property_has_sales_history_1.json", { from: link("property.json"), to: link("sales_history_1.json") }, true);
    if (p.deed_book || p.deed_page) {
      const d = { source_http_request: req, request_identifier: p.prop_id };
      if (p.deed_book) d.book = p.deed_book;
      if (p.deed_page) d.page = p.deed_page;
      files["deed_1.json"] = d;
      add("sales_history_has_deed", "relationship_sales_history_1_has_deed_1.json", { from: link("sales_history_1.json"), to: link("deed_1.json") }, true);
    }
    const mailing = !p.owner_address_withheld && [p.mail_line1, p.mail_line2, p.mail_line3, p.mail_city].some(Boolean)
      ? { source_http_request: req, request_identifier: p.prop_id, unnormalized_address: mailingAddress(p) } : null;
    if (mailing) files["mailing_address.json"] = mailing;
    let n = 0;
    for (const o of parseOwners(p.owner_name)) {
      n++;
      if (o.kind === "company") {
        files[`company_${n}.json`] = { source_http_request: req, request_identifier: p.prop_id, name: o.name, sunbiz_document_number: null };
        add("sales_history_has_company", `relationship_sales_history_1_has_company_${n}.json`, { from: link("sales_history_1.json"), to: link(`company_${n}.json`) }, true);
        if (mailing) add("company_has_mailing_address", `relationship_company_${n}_has_mailing_address.json`, { from: link(`company_${n}.json`), to: link("mailing_address.json") }, true);
      } else {
        files[`person_${n}.json`] = {
          source_http_request: req, request_identifier: p.prop_id, birth_date: null, first_name: o.first, last_name: o.last,
          middle_name: o.middle, prefix_name: null, suffix_name: o.suffix, us_citizenship_status: null, veteran_status: null,
        };
        add("sales_history_has_person", `relationship_sales_history_1_has_person_${n}.json`, { from: link("sales_history_1.json"), to: link(`person_${n}.json`) }, true);
        if (mailing) add("person_has_mailing_address", `relationship_person_${n}_has_mailing_address.json`, { from: link(`person_${n}.json`), to: link("mailing_address.json") }, true);
      }
    }
    if (mailing && !n) delete files["mailing_address.json"]; // an unlinked entity is a validation error
  }

  files[`${COUNTY}.json`] = { label: "County", relationships: rel };
  return files;
}
const mailingAddress = (p) =>
  [[p.mail_line1, p.mail_line2, p.mail_line3].filter(Boolean).join(" "), p.mail_city, [p.mail_state, p.mail_zip].filter(Boolean).join(" "), p.mail_country]
    .filter(Boolean).join(", ");

// Permits -> property_improvement. Status and type map only where the lexicon has an exact value;
// "expired without a final inspection" has none, so its status stays null (dates still show it).
const PERMIT_TYPE = { BP: "GeneralBuilding", EP: "Electrical", MP: "MechanicalHVAC", PP: "Plumbing", DS: "Demolition" };
function improvement(pm) {
  const roofing = pm.roofing_work === "roof_replacement" || pm.roofing_work === "roof_repair";
  return {
    // Lakeway rows came from a portal search POST: record that exact request (endpoint + JSON body).
    source_http_request: pm.source_request_json
      ? { method: "POST", url: pm.source_url, headers: { "content-type": "application/json" }, json: JSON.parse(pm.source_request_json) }
      : request(pm.source_url),
    request_identifier: pm.permit_number,
    improvement_type: roofing ? "Roofing" : PERMIT_TYPE[pm.permit_type] ?? null,
    improvement_action: pm.roofing_work === "roof_replacement" ? "Replacement" : pm.roofing_work === "roof_repair" ? "Repair" : null,
    improvement_status: pm.status_bucket === "closed" ? "Completed" : pm.status_bucket === "void" ? "Cancelled" : pm.status_bucket === "open" ? (pm.issued_date ? "Permitted" : "Planned") : null,
    completion_date: pm.completed_date ?? null,
    contractor_type: null,
    permit_number: pm.permit_number,
    ...(pm.applied_date ? { application_received_date: pm.applied_date } : {}),
    ...(pm.issued_date ? { permit_issue_date: pm.issued_date } : {}),
    ...(pm.completed_date ? { final_inspection_date: pm.completed_date } : {}),
    ...(pm.job_valuation == null ? {} : {}),
  };
}

function piFiles(p, req, permits) {
  const { files } = seedFiles(p, req);
  const rel = {};
  files["property.json"] = propertyEntity(p, req);
  permits.forEach((pm, i) => {
    const n = i + 1;
    files[`property_improvement_${n}.json`] = improvement(pm);
    files[`relationship_property_has_property_improvement_${n}.json`] = { from: link("property.json"), to: link(`property_improvement_${n}.json`) };
    (rel.property_has_property_improvement ??= []).push(link(`relationship_property_has_property_improvement_${n}.json`));
    // Contractor: only an official identity (unique exact match in the Texas Comptroller
    // franchise-taxpayer registry), with the registry request as its provenance.
    if (pm.legal_name && pm.registry_request) {
      files[`company_${n}.json`] = { source_http_request: request(pm.registry_request), request_identifier: pm.taxpayer_number, name: pm.legal_name, sunbiz_document_number: null };
      files[`relationship_property_improvement_${n}_has_company_${n}.json`] = { from: link(`property_improvement_${n}.json`), to: link(`company_${n}.json`) };
      (rel.property_improvement_has_contractor ??= []).push(link(`relationship_property_improvement_${n}_has_company_${n}.json`));
    }
  });
  files[`${PI}.json`] = { label: "Property Improvement", relationships: rel };
  return files;
}

// ---------------------------------------------------------------------------------------------
const db = await DuckDBInstance.create(dbPath, { access_mode: "READ_ONLY" });
const c = await db.connect();
const rows = async (sql) => (await c.runAndReadAll(sql)).getRowObjectsJson();
const where = onlyProps ? `where p.prop_id in (${onlyProps.map((x) => `'${x.replace(/\D/g, "")}'`).join(",")})` : "";

const gisByProp = new Map();
const urls = new Map();
const intern = (u) => urls.get(u) ?? (urls.set(u, u), u);
if (group === "county" && gisPath) {
  const rl = createInterface({ input: createReadStream(gisPath) });
  for await (const line of rl) {
    if (!line) continue;
    const g = JSON.parse(line);
    // Keep only what the geometry record needs; the request URL is shared by a whole page.
    if (g.prop_id && Number.isFinite(g.latitude))
      gisByProp.set(String(g.prop_id).replace(/^0+/, ""), { latitude: g.latitude, longitude: g.longitude, source_url: intern(g.source_url) });
  }
}

const base = `
  select p.*, r.roof_year, r.roof_age_years, r.roof_age_basis, cast(year(current_date) as integer) as tax_year
  from properties p left join roof_age r using (prop_id)`;
let written = 0;
// The group is built in a fresh staging directory and swapped in only after the whole transform
// succeeds, so a property that is no longer selected never keeps a ZIP from an earlier run.
const finalDir = join(outDir, group), stageDir = join(outDir, `.${group}.staging`);
await rm(stageDir, { recursive: true, force: true });
await mkdir(stageDir, { recursive: true });
if (group === "county") {
  // Stream in batches so the whole roll is never held in memory at once.
  const BATCH = 20_000;
  for (let offset = 0; ; offset += BATCH) {
    if (limit && offset >= limit) break;
    const take = limit ? Math.min(BATCH, limit - offset) : BATCH;
    const batch = await rows(`${base} ${where} order by p.prop_id limit ${take} offset ${offset}`);
    for (const p of batch) {
      const req = request(p.source_url);
      const gis = p.coordinate_basis === "own_parcel_centroid" ? gisByProp.get(p.prop_id) ?? null : null;
      await writeProperty(join(stageDir, p.prop_id), countyFiles(p, req, gis));
      written++;
    }
    if (batch.length < take) break;
    process.stderr.write(`\r${written} properties`);
  }
} else {
  // Registry request for resolved contractors: the Comptroller dataset query that returned the
  // taxpayer record (from the identity receipt).
  const registry = JSON.parse(await (await import("node:fs/promises")).readFile(join(dbPath, "..", "..", "raw/identity/tx-franchise-taxpayers.ndjson.receipt.json"), "utf8").catch(() => "{}"));
  const registryRequest = registry.resource ? `${registry.resource}${registry.select ? `?$select=${encodeURIComponent(registry.select)}` : ""}` : null;
  const hasRequestJson = (await rows("select count(*) as n from information_schema.columns where table_name = 'permits' and column_name = 'source_request_json'"))[0].n > 0;
  const permitRows = await rows(`
    select pm.prop_id, pm.permit_number, pm.permit_type, pm.roofing_work, pm.status_bucket, pm.applied_date, pm.issued_date,
           pm.completed_date, pm.source_url, ${hasRequestJson ? "pm.source_request_json" : "null as source_request_json"}, c.legal_name, c.taxpayer_number
    from permits pm left join contractors c on c.contractor_key = pm.contractor_key and c.identity_status = 'resolved_exact_name'
    where pm.prop_id is not null and pm.roofing_work in ('roof_replacement', 'roof_repair') and pm.link_basis not like '%ambiguous%'
      ${onlyProps ? `and pm.prop_id in (${onlyProps.map((x) => `'${x.replace(/\D/g, "")}'`).join(",")})` : ""}
    order by pm.prop_id, pm.opened_date, pm.permit_number`);
  const byProp = new Map();
  for (const pm of permitRows) {
    pm.registry_request = pm.legal_name ? registryRequest : null;
    (byProp.get(pm.prop_id) ?? byProp.set(pm.prop_id, []).get(pm.prop_id)).push(pm);
  }
  const ids = [...byProp.keys()].slice(0, limit ?? undefined);
  for (const p of await rows(`${base} where p.prop_id in (select unnest(['${ids.join("','")}'])) order by p.prop_id`)) {
    await writeProperty(join(stageDir, p.prop_id), piFiles(p, request(p.source_url), byProp.get(p.prop_id)));
    written++;
  }
}
await rm(finalDir, { recursive: true, force: true });
await rename(stageDir, finalDir);
console.log(JSON.stringify({ group, written, out: finalDir, manifest: MANIFEST_URL, seed: SEED, county: COUNTY, property_improvement: PI }));
