#!/usr/bin/env node
// Harvest City of Austin "Issued Construction Permits" (Socrata 3syk-w9eu) as NDJSON.
// Full pull: node src/sources/austin-permits.mjs <out.ndjson>
// Window:    node src/sources/austin-permits.mjs <out.ndjson> --since <YYYY-MM-DD>
// Socrata's :updated_at is rewritten for every row on each nightly refresh, so it cannot detect
// change. The window instead selects rows whose business dates (status/applied/issued/completed)
// moved after the watermark; a full pull plus content-hash diff catches any other edit.
// Applicant fields are deliberately not selected (frequently private homeowners); contractor
// business fields are kept. Each record carries its Socrata row id, :updated_at and request URL.
import { createWriteStream } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const DATASET = "https://data.austintexas.gov/resource/3syk-w9eu.json";
const PAGE = 50000;
const MAX_ATTEMPTS = 6;
const COLUMNS = [
  ":id", ":updated_at",
  "permittype", "permit_type_desc", "permit_number", "permit_class_mapped", "permit_class", "work_class",
  "description", "tcad_id", "legal_description",
  "applieddate", "issue_date", "status_current", "statusdate", "expiresdate", "completed_date",
  "original_address1", "original_city", "original_state", "original_zip", "jurisdiction",
  "link", "project_id", "masterpermitnum", "latitude", "longitude",
  "total_job_valuation", "housing_units", "number_of_floors",
  "contractor_trade", "contractor_company_name", "contractor_full_name", "contractor_phone",
  "contractor_address1", "contractor_address2", "contractor_city", "contractor_zip",
];

const args = process.argv.slice(2);
const out = args[0];
const sinceIdx = args.indexOf("--since");
const since = sinceIdx >= 0 ? args[sinceIdx + 1] : null;
if (!out || (sinceIdx >= 0 && !since)) {
  console.error("usage: austin-permits.mjs <out.ndjson> [--since <ISO timestamp>]");
  process.exit(2);
}
const headers = process.env.SOCRATA_APP_TOKEN ? { "X-App-Token": process.env.SOCRATA_APP_TOKEN } : {};
const DATE_FIELDS = ["statusdate", "applieddate", "issue_date", "completed_date"];
const where = since ? "(" + DATE_FIELDS.map((d) => `${d} > '${since}'`).join(" OR ") + ")" : null;

function pageUrl(afterId) {
  const q = new URLSearchParams({ $select: COLUMNS.join(","), $order: ":id", $limit: String(PAGE) });
  const clauses = [where, afterId ? `:id > '${afterId}'` : null].filter(Boolean);
  if (clauses.length) q.set("$where", clauses.join(" AND "));
  return `${DATASET}?${q}`;
}

async function getJson(url) {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(180_000) });
      if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
      return await res.json();
    } catch (err) {
      if (attempt >= MAX_ATTEMPTS) throw err;
      const wait = 2000 * 2 ** attempt;
      console.error(`retry ${attempt} after ${wait}ms: ${err.message}`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
}

// Socrata's own count for the same window, so the harvest reconciles against the source claim.
const countQ = new URLSearchParams({ $select: "count(*) as n" });
if (where) countQ.set("$where", where);
const reported = Number((await getJson(`${DATASET}?${countQ}`))[0].n);

await mkdir(dirname(out), { recursive: true });
const sink = createWriteStream(out);
const fetchedAt = new Date().toISOString();
let afterId = null;
let written = 0;
let maxBusinessDate = since;
const started = Date.now();
for (;;) {
  const url = pageUrl(afterId);
  const rows = await getJson(url);
  for (const r of rows) {
    const rec = { ...r, socrata_id: r[":id"], socrata_updated_at: r[":updated_at"], source_url: url, fetched_at: fetchedAt };
    delete rec[":id"];
    delete rec[":updated_at"];
    if (rec.link && typeof rec.link === "object") rec.link = rec.link.url ?? null;
    sink.write(JSON.stringify(rec) + "\n");
    for (const d of DATE_FIELDS) {
      const v = rec[d]?.slice(0, 10);
      // Ignore future-dated fields (e.g. scheduled expiry) when advancing the watermark.
      if (v && v <= fetchedAt.slice(0, 10) && (!maxBusinessDate || v > maxBusinessDate)) maxBusinessDate = v;
    }
  }
  written += rows.length;
  process.stderr.write(`\r${written}/${reported} (${Math.round((Date.now() - started) / 1000)}s)`);
  if (rows.length < PAGE) break;
  afterId = rows[rows.length - 1][":id"];
}
await new Promise((r) => sink.end(r));
process.stderr.write("\n");

const receipt = {
  dataset: DATASET, window_since: since, window_fields: since ? DATE_FIELDS : null, reported, written,
  next_watermark: maxBusinessDate,
  fetched_at: fetchedAt, seconds: Math.round((Date.now() - started) / 1000),
};
await writeFile(`${out}.receipt.json`, JSON.stringify(receipt, null, 2) + "\n");
console.log(JSON.stringify(receipt));
// Rows updated mid-harvest can make written exceed the pre-count; fewer than reported means data loss.
if (written < reported) {
  console.error(`reconciliation failed: reported ${reported}, written ${written}`);
  process.exit(1);
}
