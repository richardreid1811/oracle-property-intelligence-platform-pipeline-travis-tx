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
// Checkpoints (in <out-dir>, so a crash or kill resumes without redoing finished work):
//   index.ndjson        one line per search-result row as it arrives (first CaseId wins on reload)
//   index-cursor.json   finished windows, the last finished page of the current window, request count
//   contractors.ndjson  one line per contractor lookup (last line per case_id wins; errors retried on resume)
// A browser-side failure (detached frame, target closed, navigation timeout) recreates the browser and
// re-captures the template, with bounded retries and backoff. A lookup that still fails is recorded with
// contractors null and a lookup_error, not fatal. --fresh discards the checkpoints.
//
// Output: <out>/permits.ndjson + receipt.json (written at the end, atomically)
// Usage: node src/sources/tyler-permits.mjs <out-dir> --jurisdiction lakeway [--from-year 1995]
//          [--since YYYY-MM-DD] [--delay-ms 1500] [--chrome <path>] [--fresh]
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
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
  console.error("usage: tyler-permits.mjs <out-dir> --jurisdiction lakeway [--from-year 1995] [--since YYYY-MM-DD] [--fresh]");
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (s) => console.error(`${new Date().toISOString()} ${s}`);
const readLines = (file) => (existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).flatMap((l) => {
  try { return [JSON.parse(l)]; } catch { return []; } // a line cut short by a kill is dropped and refetched
}) : []);

const { default: puppeteer } = await import("puppeteer-core");
await mkdir(outDir, { recursive: true });
const indexFile = join(outDir, "index.ndjson");
const cursorFile = join(outDir, "index-cursor.json");
const contractorsFile = join(outDir, "contractors.ndjson");
const endpoint = `${j.base}/api/energov/search/search`;
const t0 = Date.now();
const startYear = since ? Number(since.slice(0, 4)) : fromYear;
let cursor = existsSync(cursorFile) ? JSON.parse(readFileSync(cursorFile, "utf8")) : null;
// A finished harvest, or one for other arguments (a crashed run with an older --since), is not resumed.
// Checkpoint lines without a cursor (e.g. contractors.ndjson seeded from an earlier output) are kept.
if (rest.includes("--fresh") || (cursor && (cursor.output_written || cursor.since !== (since ?? null) || cursor.from_year !== startYear))) {
  if (cursor) console.error(`discarding checkpoint in ${outDir} (since=${cursor.since} from_year=${cursor.from_year}${cursor.output_written ? ", finished" : ""})`);
  for (const f of [indexFile, cursorFile, contractorsFile]) await rm(f, { force: true });
  cursor = null;
}
if (!cursor) {
  cursor = { since: since ?? null, from_year: startYear, started_at: new Date().toISOString(), windows_done: [], current: null, requests: 0, index_complete: false };
}
// One harvester per out-dir: a second one would interleave checkpoint lines and double the request rate.
const lockFile = join(outDir, "harvest.lock");
if (existsSync(lockFile)) {
  const pid = Number(readFileSync(lockFile, "utf8"));
  let alive = false;
  try { process.kill(pid, 0); alive = pid !== process.pid; } catch {}
  if (alive) { console.error(`another harvester (pid ${pid}) is using ${outDir}`); process.exit(2); }
}
await writeFile(lockFile, String(process.pid));
const saveCursor = () => writeFile(cursorFile, JSON.stringify(cursor, null, 2) + "\n");
let requests = cursor.requests;

// Browser session: (re)launch Chrome, open the search route, capture the template and tenant headers.
let browser = null, page = null, template = null, tenant = null, resets = 0;
const BROWSER_ERR = /detached Frame|Target closed|Session closed|Protocol error|Navigation timeout|Execution context was destroyed|Connection closed|browser has disconnected|frame was detached|Failed to launch|TimeoutError|Waiting failed/i;
const closeBrowser = async () => {
  const b = browser;
  browser = page = null;
  if (b) await Promise.race([b.close().catch(() => {}), sleep(10_000)]);
  if (b?.process() && b.process().exitCode === null) b.process().kill("SIGKILL");
};
const openSession = async () => {
  for (let attempt = 1; ; attempt++) {
    try {
      await closeBrowser();
      browser = await puppeteer.launch({ executablePath: chrome, headless: true, handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false });
      page = await browser.newPage();
      await page.setUserAgent("travis-oracle-pipeline/0.1 (property-data research)");
      const marker = "__travis_oracle_bootstrap__";
      const respP = page.waitForResponse((r) => r.url().toLowerCase() === endpoint.toLowerCase() && r.request().method() === "POST", { timeout: 60_000 });
      respP.catch(() => {}); // a failed goto would otherwise leave this rejection unhandled
      await page.goto(`${j.base}#/search?m=1&fm=1&ps=10&pn=1&em=true&st=${marker}`, { waitUntil: "domcontentloaded", timeout: 60_000 });
      const boot = await respP;
      requests++;
      template = JSON.parse(boot.request().postData() ?? "{}");
      const h = boot.request().headers();
      tenant = Object.fromEntries(["tenantid", "tenantname", "tyler-tenanturl", "tyler-tenant-culture"].map((k) => [k, h[k]]));
      if (tenant.tenantname !== j.tenantName) throw new Error(`unexpected tenant ${tenant.tenantname}`);
      return;
    } catch (e) {
      if (attempt >= 5 || /unexpected tenant/.test(e.message)) throw e;
      const wait = Math.min(30_000 * 2 ** (attempt - 1), 300_000);
      log(`session open failed (${String(e.message).slice(0, 160)}); retry ${attempt}/4 in ${wait / 1000}s`);
      await sleep(wait);
    }
  }
};

// A signal stops the harvest (the checkpoints are already on disk); without this the closed browser
// would look like a portal failure and be recreated.
for (const [sig, code] of [["SIGINT", 130], ["SIGTERM", 143], ["SIGHUP", 129]]) {
  process.on(sig, async () => {
    log(`${sig}: stopping; rerun with the same arguments to resume`);
    await closeBrowser();
    await rm(lockFile, { force: true });
    process.exit(code);
  });
}

let next = 0;
// One request from inside the page. HTTP 5xx and dropped connections back off and retry; a
// browser-side failure also recreates the session first. Throws after the last attempt.
const post = async (path, body) => {
  for (let attempt = 1; ; attempt++) {
    const wait = next - Date.now();
    if (wait > 0) await sleep(wait);
    next = Date.now() + delayMs;
    requests++;
    const res = await (page
      ? page.evaluate(async (i) => {
          const r = await fetch(i.url, { method: "POST", headers: { accept: "application/json", "content-type": "application/json;charset=UTF-8", ...i.h }, credentials: "include", body: JSON.stringify(i.body) });
          return { status: r.status, text: await r.text() };
        }, { url: `${j.base}/${path}`, h: tenant, body })
      : Promise.reject(new Error("browser has disconnected")))
      .catch((e) => ({ status: 599, text: String(e.message ?? e) }));
    if (res.status === 200) {
      try { return JSON.parse(res.text); } catch { res.status = 598; } // truncated body: retry
    }
    if (attempt >= 5 || (res.status < 500 && res.status !== 429)) throw new Error(`${path} HTTP ${res.status}: ${res.text.slice(0, 200)}`);
    const backoff = Math.min(delayMs * 2 ** attempt, 60_000);
    log(`${path} HTTP ${res.status} (${res.text.slice(0, 120)}); attempt ${attempt}/5, backoff ${backoff / 1000}s`);
    await sleep(backoff);
    if (res.status === 599 && (BROWSER_ERR.test(res.text) || !browser?.connected)) {
      resets++;
      log(`recreating browser session (reset ${resets})`);
      await openSession();
    }
  }
};
const searchBody = (field, from, to, pageNumber) => {
  const b = structuredClone(template);
  Object.assign(b, { SearchModule: 2, FilterModule: 0, Keyword: "", ExactMatch: true, PageNumber: pageNumber, PageSize: 100, SortBy: "PermitNumber.keyword", SortAscending: true });
  Object.assign(b.PermitCriteria, { PermitTypeId: "none", PermitStatusId: "none", [`${field}From`]: from, [`${field}To`]: to, PageNumber: pageNumber, PageSize: 100, SortBy: "PermitNumber.keyword", SortAscending: true });
  return b;
};

try {
  await openSession();

  // Pass 1: index by year windows on issue date and apply date, checkpointed per page.
  const rows = new Map();
  for (const x of readLines(indexFile)) if (!rows.has(x.row.CaseId)) rows.set(x.row.CaseId, x);
  const windows = [];
  for (let y = startYear; y <= new Date(Date.parse(cursor.started_at)).getUTCFullYear(); y++) {
    const from = since && y === startYear ? `${since}T00:00:00.000Z` : `${y}-01-01T00:00:00.000Z`;
    // Full history: issue and apply dates cover every case. A --since window also searches final and
    // expiry dates so permits that finaled or expired since the last run are re-read.
    for (const field of since ? ["IssueDate", "ApplyDate", "FinalDate", "ExpireDate"] : ["IssueDate", "ApplyDate"]) windows.push({ key: `${field}:${y}`, field, from, to: `${y}-12-31T23:59:59.000Z` });
  }
  if (rows.size) log(`resuming index: ${rows.size} permits, ${cursor.windows_done.length}/${windows.length} windows done`);
  for (const w of windows) {
    if (cursor.windows_done.includes(w.key)) continue;
    const startPage = cursor.current?.key === w.key ? cursor.current.page + 1 : 1;
    for (let p = startPage; ; p++) {
      const body = searchBody(w.field, w.from, w.to, p);
      const res = (await post("api/energov/search/search", body)).Result;
      const fetched_at = new Date().toISOString();
      const fresh = [];
      for (const r of res.EntityResults ?? []) {
        if (rows.has(r.CaseId)) continue;
        const x = { row: r, request: { method: "POST", url: endpoint, json: body }, fetched_at };
        rows.set(r.CaseId, x);
        fresh.push(JSON.stringify(x) + "\n");
      }
      if (fresh.length) appendFileSync(indexFile, fresh.join(""));
      const last = p >= (res.TotalPages ?? 0);
      if (last) { cursor.windows_done.push(w.key); cursor.current = null; } else cursor.current = { key: w.key, page: p };
      cursor.requests = requests;
      await saveCursor();
      if (last) break;
    }
    log(`${w.field} ${w.from.slice(0, 4)}: ${rows.size} permits, ${requests} requests`);
  }
  cursor.index_complete = true;
  await saveCursor();

  // Pass 2: contractors for roofing work, checkpointed per lookup.
  const lookups = new Map(readLines(contractorsFile).map((x) => [x.case_id, x]));
  const todo = [...rows.values()].filter(({ row }) => isRoofing(row) && !(lookups.has(row.CaseId) && !lookups.get(row.CaseId).lookup_error));
  const roofing = [...rows.values()].filter(({ row }) => isRoofing(row)).length;
  log(`contractor lookups: ${roofing} roofing permits, ${roofing - todo.length} already done, ${todo.length} to go`);
  let done = 0, failedInRow = 0, cooldowns = 0;
  const t1 = Date.now();
  for (const { row } of todo) {
    const contactsBody = { PageNumber: 1, PageSize: 10, SortField: "", IsSortedInAscendingOrder: true, ModuleId: 1, EntityId: row.CaseId };
    const rec = { case_id: row.CaseId, contractors: null, contacts_request: { method: "POST", url: `${j.base}/api/energov/entity/contacts/search/search`, json: contactsBody } };
    try {
      const c = await post("api/energov/entity/contacts/search/search", contactsBody);
      rec.contractors = (c.Result ?? []).filter((x) => /contractor/i.test(x.ContactTypeName ?? "")).map((x) => ({ name: x.GlobalEntityName, role: x.ContactTypeName }));
      failedInRow = 0;
    } catch (e) {
      rec.lookup_error = String(e.message ?? e).slice(0, 300);
      failedInRow++;
      log(`contractor lookup failed for ${row.CaseNumber}: ${rec.lookup_error}`);
      if (/unexpected tenant/.test(rec.lookup_error)) throw e;
    }
    rec.fetched_at = new Date().toISOString();
    lookups.set(row.CaseId, rec);
    appendFileSync(contractorsFile, JSON.stringify(rec) + "\n");
    done++;
    // Many failures in a row means the portal is down, not one bad permit: cool down, then go on.
    if (failedInRow >= 10) {
      if (++cooldowns > 6) throw new Error("portal kept failing after 6 cool-downs; rerun to resume from the checkpoint");
      log(`10 lookups failed in a row; cooling down 10 min (${cooldowns}/6)`);
      await sleep(600_000);
      failedInRow = 0;
      await openSession();
    }
    if (done % 50 === 0) {
      const eta = Math.round(((Date.now() - t1) / done) * (todo.length - done) / 60_000);
      log(`contractors: ${done}/${todo.length}, ${requests} requests, eta ${eta} min`);
    }
  }

  // Output, assembled from the two checkpoints.
  const tmp = join(outDir, "permits.ndjson.tmp");
  await writeFile(tmp, "");
  let lines = [], lookupErrors = 0, withContractor = 0;
  for (const { row, request, fetched_at } of rows.values()) {
    const rec = {
      jurisdiction: j.name, case_id: row.CaseId, permit_number: row.CaseNumber, permit_type: row.CaseType, work_class: row.CaseWorkclass,
      status: row.CaseStatus, description: row.Description, main_parcel: row.MainParcel, address: row.AddressDisplay,
      apply_date: row.ApplyDate, issue_date: row.IssueDate, expire_date: row.ExpireDate, final_date: row.FinalDate, complete_date: row.CompleteDate,
      source_request: request, source_detail_url: `${j.base}#/permit/${row.CaseId}`, fetched_at,
      contractors: null,
    };
    const l = isRoofing(row) ? lookups.get(row.CaseId) : null;
    if (l) {
      rec.contractors = l.contractors;
      rec.contacts_request = l.contacts_request;
      if (l.lookup_error) { rec.lookup_error = l.lookup_error; lookupErrors++; }
      if (l.contractors?.length) withContractor++;
    }
    lines.push(JSON.stringify(rec) + "\n");
    if (lines.length >= 1000) { appendFileSync(tmp, lines.join("")); lines = []; }
  }
  appendFileSync(tmp, lines.join(""));
  await rename(tmp, join(outDir, "permits.ndjson"));
  const receipt = {
    source: `${j.name} Civic Self Service (Tyler EnerGov)`, portal: j.base, endpoint, tenant: tenant.tenantname,
    method: "browser-session template capture (kit tyler-civic-access pattern)", windows: windows.length, since: since ?? null, from_year: startYear,
    permits: rows.size, roofing_permits: roofing, roofing_with_contractor: withContractor, contractor_lookup_errors: lookupErrors,
    requests, browser_resets: resets, delay_ms: delayMs,
    // When the index started: the next --since run re-reads from here (minus a day), so nothing
    // that changed while a long or resumed harvest was running is missed.
    fetched_at: cursor.started_at, completed_at: new Date().toISOString(), seconds: Math.round((Date.now() - t0) / 1000),
  };
  await writeFile(join(outDir, "receipt.json"), JSON.stringify(receipt, null, 2) + "\n");
  cursor.output_written = receipt.completed_at;
  cursor.requests = requests;
  await saveCursor();
  console.log(JSON.stringify(receipt));
} finally {
  await closeBrowser();
  await rm(lockFile, { force: true });
}
