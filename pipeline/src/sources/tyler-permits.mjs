#!/usr/bin/env node
// Permits from a Tyler EnerGov Civic Self Service portal (City of Lakeway), the way the kit's
// tyler-civic-access adapter talks to it: a headless Chrome session opens the portal's own search
// route, the search request it sends is captured as the template (with the tenant headers), and
// every later request is that template with only the criteria changed, sent from inside the page
// at no more than one request per --delay-ms. No login, no CAPTCHA, public records only.
//
// Pass 1 (index): permit search over issue-date and apply-date windows (so never-issued applications
// are included; with --since also final and expiry dates), 100 rows per page; de-duplicated by CaseId.
// Pass 2 (contractors): for roofing work only, the permit's contact list (contractor role).
// Each row keeps the exact request that returned it (POST url + JSON body) as provenance.
//
// Output: <out>/permits.ndjson + receipt.json
// Usage: node src/sources/tyler-permits.mjs <out-dir> --jurisdiction lakeway [--from-year 1995]
//          [--since YYYY-MM-DD] [--delay-ms 1500] [--chrome <path>]
import { createWriteStream } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const JURISDICTIONS = {
  lakeway: {
    name: "City of Lakeway",
    base: "https://lakewaytx-energovweb.tylerhost.net/apps/selfservice",
    tenantName: "LakewayTXProd",
  },
};
const [outDir, ...rest] = process.argv.slice(2);
const opt = (n, d) => (rest.includes(n) ? rest[rest.indexOf(n) + 1] : d);
const j = JURISDICTIONS[opt("--jurisdiction", "lakeway")];
const fromYear = Number(opt("--from-year", "1995"));
const since = opt("--since");
const delayMs = Number(opt("--delay-ms", "1500"));
const chrome = opt("--chrome", process.env.CHROME_EXECUTABLE_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome");
if (!outDir || !j) {
  console.error("usage: tyler-permits.mjs <out-dir> --jurisdiction lakeway [--from-year 1995] [--since YYYY-MM-DD]");
  process.exit(2);
}
// Same regexes as the Austin classifier (pipeline/src/build/permit-sql.mjs), applied to type + description.
const REROOF = /\bRE-?\s?ROOF/i;
const ROOFING = /\bRE-?\s?ROOF|\bROOF(ING)?\s+(REPLACE|REPLACEMENT|REPAIR|TEAR\s?-?OFF|OVERLAY)|\bREPLAC(E|ING)\s+(THE\s+|EXISTING\s+)?ROOF|\bNEW\s+ROOF(ING)?\b|\bTEAR\s?-?OFF\b|\bROOF(ING)?\b/i;
const EXCLUDE = /SOLAR|PHOTOVOLTAIC|\bPV\b|ROOF\s?-?TOP\s+UNIT|\bRTU\b|\bSIGN\b|ANTENNA|TELECOM|CELL\s+SITE/i;
const isRoofing = (r) => {
  const text = `${r.CaseType ?? ""} ${r.CaseWorkclass ?? ""} ${r.Description ?? ""}`;
  return REROOF.test(text) || (ROOFING.test(text) && !EXCLUDE.test(text));
};

const { default: puppeteer } = await import("puppeteer-core");
await mkdir(outDir, { recursive: true });
const endpoint = `${j.base}/api/energov/search/search`;
const browser = await puppeteer.launch({ executablePath: chrome, headless: true });
const t0 = Date.now();
let requests = 0;
try {
  const page = await browser.newPage();
  await page.setUserAgent("travis-oracle-pipeline/0.1 (property-data research)");
  const marker = "__travis_oracle_bootstrap__";
  const respP = page.waitForResponse((r) => r.url().toLowerCase() === endpoint.toLowerCase() && r.request().method() === "POST", { timeout: 60_000 });
  await page.goto(`${j.base}#/search?m=1&fm=1&ps=10&pn=1&em=true&st=${marker}`, { waitUntil: "domcontentloaded", timeout: 60_000 });
  const boot = await respP;
  const template = JSON.parse(boot.request().postData() ?? "{}");
  const h = boot.request().headers();
  const tenant = Object.fromEntries(["tenantid", "tenantname", "tyler-tenanturl", "tyler-tenant-culture"].map((k) => [k, h[k]]));
  if (tenant.tenantname !== j.tenantName) throw new Error(`unexpected tenant ${tenant.tenantname}`);

  let next = 0;
  const post = async (path, body) => {
    const wait = next - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    next = Date.now() + delayMs;
    for (let attempt = 1; ; attempt++) {
      requests++;
      // A dropped connection surfaces as a thrown "Failed to fetch": retry it like a 5xx.
      const res = await page
        .evaluate(async (i) => {
          const r = await fetch(i.url, { method: "POST", headers: { accept: "application/json", "content-type": "application/json;charset=UTF-8", ...i.h }, credentials: "include", body: JSON.stringify(i.body) });
          return { status: r.status, text: await r.text() };
        }, { url: `${j.base}/${path}`, h: tenant, body })
        .catch((e) => ({ status: 599, text: String(e.message ?? e) }));
      if (res.status === 200) return JSON.parse(res.text);
      if (attempt >= 4 || res.status < 500) throw new Error(`${path} HTTP ${res.status}: ${res.text.slice(0, 200)}`);
      await new Promise((r) => setTimeout(r, delayMs * 2 ** attempt));
    }
  };
  const searchBody = (field, from, to, pageNumber) => {
    const b = structuredClone(template);
    Object.assign(b, { SearchModule: 2, FilterModule: 0, Keyword: "", ExactMatch: true, PageNumber: pageNumber, PageSize: 100, SortBy: "PermitNumber.keyword", SortAscending: true });
    Object.assign(b.PermitCriteria, { PermitTypeId: "none", PermitStatusId: "none", [`${field}From`]: from, [`${field}To`]: to, PageNumber: pageNumber, PageSize: 100, SortBy: "PermitNumber.keyword", SortAscending: true });
    return b;
  };

  // Pass 1: index by year windows on issue date and apply date.
  const rows = new Map();
  const windows = [];
  const startYear = since ? Number(since.slice(0, 4)) : fromYear;
  for (let y = startYear; y <= new Date().getUTCFullYear(); y++) {
    const from = since && y === startYear ? `${since}T00:00:00.000Z` : `${y}-01-01T00:00:00.000Z`;
    // Full history: issue and apply dates cover every case. A --since window also searches final and
    // expiry dates so permits that finaled or expired since the last run are re-read.
    for (const field of since ? ["IssueDate", "ApplyDate", "FinalDate", "ExpireDate"] : ["IssueDate", "ApplyDate"]) windows.push({ field, from, to: `${y}-12-31T23:59:59.000Z` });
  }
  for (const w of windows) {
    for (let p = 1; ; p++) {
      const body = searchBody(w.field, w.from, w.to, p);
      const res = (await post("api/energov/search/search", body)).Result;
      for (const r of res.EntityResults ?? []) {
        if (!rows.has(r.CaseId)) rows.set(r.CaseId, { row: r, request: { method: "POST", url: endpoint, json: body } });
      }
      if (p >= (res.TotalPages ?? 0)) break;
    }
    process.stderr.write(`\r${w.field} ${w.from.slice(0, 4)}: ${rows.size} permits, ${requests} requests`);
  }

  // Pass 2: contractors for roofing work.
  const out = createWriteStream(join(outDir, "permits.ndjson"));
  let roofing = 0;
  for (const { row, request } of rows.values()) {
    const rec = {
      jurisdiction: j.name, case_id: row.CaseId, permit_number: row.CaseNumber, permit_type: row.CaseType, work_class: row.CaseWorkclass,
      status: row.CaseStatus, description: row.Description, main_parcel: row.MainParcel, address: row.AddressDisplay,
      apply_date: row.ApplyDate, issue_date: row.IssueDate, expire_date: row.ExpireDate, final_date: row.FinalDate, complete_date: row.CompleteDate,
      source_request: request, source_detail_url: `${j.base}#/permit/${row.CaseId}`, fetched_at: new Date().toISOString(),
      contractors: null,
    };
    if (isRoofing(row)) {
      roofing++;
      const contactsBody = { PageNumber: 1, PageSize: 10, SortField: "", IsSortedInAscendingOrder: true, ModuleId: 1, EntityId: row.CaseId };
      const c = await post("api/energov/entity/contacts/search/search", contactsBody);
      rec.contractors = (c.Result ?? []).filter((x) => /contractor/i.test(x.ContactTypeName ?? "")).map((x) => ({ name: x.GlobalEntityName, role: x.ContactTypeName }));
      rec.contacts_request = { method: "POST", url: `${j.base}/api/energov/entity/contacts/search/search`, json: contactsBody };
    }
    out.write(JSON.stringify(rec) + "\n");
  }
  await new Promise((r) => out.end(r));
  const receipt = {
    source: `${j.name} Civic Self Service (Tyler EnerGov)`, portal: j.base, endpoint, tenant: tenant.tenantname,
    method: "browser-session template capture (kit tyler-civic-access pattern)", windows: windows.length, since: since ?? null, from_year: startYear,
    permits: rows.size, roofing_permits: roofing, requests, delay_ms: delayMs, fetched_at: new Date().toISOString(), seconds: Math.round((Date.now() - t0) / 1000),
  };
  await writeFile(join(outDir, "receipt.json"), JSON.stringify(receipt, null, 2) + "\n");
  console.log(JSON.stringify(receipt));
} finally {
  await browser.close();
}
