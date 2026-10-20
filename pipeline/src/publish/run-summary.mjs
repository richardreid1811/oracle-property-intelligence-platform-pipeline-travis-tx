#!/usr/bin/env node
// Write run.json into the run directory: sources (with snapshot receipts), timings, counts and
// documented source limitations. It is part of the published DAG, so the run summary itself is
// content-addressed.
// Usage: node src/publish/run-summary.mjs <run-dir> <run-id> <raw-dir> <mode: full|incremental> [started-at]
//          [--note "<text>" ...] [--prev-run <previous run.json>]
// Sources not re-harvested in this run (e.g. a CI permit-window refresh) carry their receipt forward
// from the previous run, marked carried_from.
import { existsSync } from "node:fs";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const argv = process.argv.slice(2);
const flagged = new Set(["--note", "--prev-run"]);
const notes = argv.flatMap((a, i) => (a === "--note" ? [argv[i + 1]] : []));
const prevRunPath = argv.flatMap((a, i) => (a === "--prev-run" ? [argv[i + 1]] : []))[0];
const [runDir, runId, raw, mode, startedAt] = argv.filter((a, i) => !flagged.has(a) && !flagged.has(argv[i - 1]));
if (!runDir || !runId || !raw || !mode) {
  console.error("usage: run-summary.mjs <run-dir> <run-id> <raw-dir> <full|incremental> [started-at]");
  process.exit(2);
}
const readJson = async (p) => (existsSync(p) ? JSON.parse(await readFile(p, "utf8")) : null);
const coverage = await readJson(join(runDir, "coverage.json"));
// The TCAD snapshot actually used is the newest extracted export; permits list every harvest file.
const tcadReceipts = [];
for (const d of existsSync(join(raw, "tcad")) ? await readdir(join(raw, "tcad")) : []) {
  const r = await readJson(join(raw, "tcad", d, "extracted", "receipt.json"));
  if (r && existsSync(join(raw, "tcad", d, "extracted", "PROP.TXT"))) tcadReceipts.push(r);
}
tcadReceipts.sort((a, b) => a.extracted_at.localeCompare(b.extracted_at));
const permitReceipts = [];
for (const f of (existsSync(join(raw, "permits/austin")) ? await readdir(join(raw, "permits/austin")) : []).filter((f) => f.endsWith(".receipt.json")).sort()) {
  permitReceipts.push({ file: f.replace(".receipt.json", ""), ...(await readJson(join(raw, "permits/austin", f))) });
}

const sources = [
  { key: "tcad_appraisal_roll", name: "Travis Central Appraisal District appraisal export (2026, Legacy 8.0.33)",
    kind: "bulk_download", receipt: tcadReceipts.at(-1) ?? null },
  { key: "tcad_parcel_centroids", name: "TCAD parcel layer (City of Austin-hosted ArcGIS FeatureServer), centroids",
    kind: "arcgis_paging", receipt: { url: "https://services.arcgis.com/0L95CJ0VTaxqcmED/arcgis/rest/services/EXTERNAL_tcad_parcel/FeatureServer/0", features: 386682 } },
  { key: "austin_permits", name: "City of Austin Issued Construction Permits (Socrata 3syk-w9eu)",
    kind: mode === "full" ? "full_pull" : "full_pull + business_date_windows",
    receipt: permitReceipts.at(-1) ?? null, harvests: permitReceipts },
  { key: "tx_sales_tax_outlets", name: "Texas Comptroller Active Sales Tax Permit Holders (Travis, county 227)",
    kind: "socrata", receipt: await readJson(join(raw, "identity/tx-sales-tax-travis.ndjson.receipt.json")) },
  { key: "tx_franchise_taxpayers", name: "Texas Comptroller Active Franchise Taxpayers (statewide, identity resolution)",
    kind: "socrata", receipt: await readJson(join(raw, "identity/tx-franchise-taxpayers.ndjson.receipt.json")) },
  { key: "tdlr_licenses", name: "TDLR All Licenses (contractor classes)",
    kind: "socrata", receipt: await readJson(join(raw, "identity/tdlr-contractor-licenses.ndjson.receipt.json")) },
  { key: "census_zcta_county", name: "US Census 2020 ZCTA-to-county relationship file",
    kind: "bulk_download", receipt: { url: "https://www2.census.gov/geo/docs/maps-data/data/rel2020/zcta520/tab20_zcta520_county20_natl.txt", sha256: "3ed41278d637dc249e0323306f68be8a6c234e3090f4de88ef328dee71aeaaaf" } },
  { key: "bbb", name: "Better Business Bureau profiles", kind: "blocked",
    receipt: await readJson(join(raw, "bbb/access-evidence.json")) },
];

const limitations = [
  "BBB ratings unavailable: bbb.org returned HTTP 403 and robots.txt disallows search/pagination; official BBB API access requested. Contractors carry bbb_status instead of a rating.",
  "Permit history is automated for the City of Austin (56.2% of parcels). Unincorporated Travis County (25.2%) has no county building permits under Texas law, so roof age there is year-built based. Pflugerville and Lakeway adapters are planned; 19 other municipalities require Texas Public Information Act requests.",
  "Roof age basis: finaled re-roof permit (high), issued-but-unfinaled re-roof permit (medium), TCAD year built assuming original roof (low). The basis and confidence are recorded per property.",
  "Texas is a non-disclosure state: no sale prices. Ownership age is derived from the TCAD deed date.",
  "11,211 assessed parcels (2.5%) have no polygon or parent-lot centroid and are excluded from radius queries; 40,405 condo units use their parent lot centroid.",
  "300,336 Austin permits carry a tcad_id absent from the 2026 roll (Williamson/Hays-county Austin addresses, or retired/replatted parcels). They are kept as valid-unlinked with their own coordinates; roof age uses only verified parcel links.",
  "Contractor identity resolves to a Texas Comptroller entity only on an unambiguous exact normalized-name match (no fuzzy matching); Texas has no roofing contractor license.",
  "City of Austin rewrites Socrata :updated_at for every row nightly; incremental refreshes window on status/applied/issued/completed dates instead.",
];

const prevRun = prevRunPath ? await readJson(prevRunPath) : null;
for (const s of sources) {
  const carried = prevRun?.sources?.find((x) => x.key === s.key);
  if (!s.receipt && carried?.receipt) Object.assign(s, { receipt: carried.receipt, carried_from: carried.carried_from ?? prevRun.run_id });
  if (s.key === "austin_permits" && carried?.harvests) s.harvests = [...carried.harvests.filter((h) => !s.harvests?.some((x) => x.file === h.file)), ...(s.harvests ?? [])];
}

const run = {
  run_id: runId, mode, started_at: startedAt ?? null, summarized_at: new Date().toISOString(),
  county: "travis", state: "TX", fips: "48453",
  sources, counts: coverage?.counts ?? null, corrections: notes, record_deltas: await readJson(join(runDir, "deltas.json")), limitations,
};
await writeFile(join(runDir, "run.json"), JSON.stringify(run, null, 2) + "\n");
console.log(JSON.stringify({ run_id: runId, sources: sources.length, limitations: limitations.length }));
