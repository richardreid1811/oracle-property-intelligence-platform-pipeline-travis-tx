#!/usr/bin/env node
// Generic Socrata (SODA) harvester: pages by :id, reconciles written rows against the source's
// own count for the same filter, and writes NDJSON plus a receipt. Used for data.texas.gov
// identity/licensing datasets.
// Usage: node src/sources/socrata.mjs <resource-url> <out.ndjson> [--select a,b,c] [--where "<soql>"]
import { createWriteStream } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const PAGE = 50000;
const MAX_ATTEMPTS = 6;

const [resource, out, ...rest] = process.argv.slice(2);
const opt = (name) => {
  const i = rest.indexOf(name);
  return i >= 0 ? rest[i + 1] : null;
};
const select = opt("--select");
const where = opt("--where");
if (!resource || !out) {
  console.error('usage: socrata.mjs <resource-url> <out.ndjson> [--select a,b] [--where "<soql>"]');
  process.exit(2);
}
const headers = process.env.SOCRATA_APP_TOKEN ? { "X-App-Token": process.env.SOCRATA_APP_TOKEN } : {};

async function getJson(url) {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(180_000) });
      if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
      return await res.json();
    } catch (err) {
      if (attempt >= MAX_ATTEMPTS || /^HTTP 4(?!29)/.test(err.message)) throw err;
      const wait = 2000 * 2 ** attempt;
      console.error(`retry ${attempt} after ${wait}ms: ${err.message}`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
}

const countQ = new URLSearchParams({ $select: "count(*) as n" });
if (where) countQ.set("$where", where);
const reported = Number((await getJson(`${resource}?${countQ}`))[0].n);

await mkdir(dirname(out), { recursive: true });
const sink = createWriteStream(out);
const fetchedAt = new Date().toISOString();
const started = Date.now();
let afterId = null;
let written = 0;
for (;;) {
  const q = new URLSearchParams({ $select: select ? `:id,${select}` : ":*,*", $order: ":id", $limit: String(PAGE) });
  const clauses = [where && `(${where})`, afterId && `:id > '${afterId}'`].filter(Boolean);
  if (clauses.length) q.set("$where", clauses.join(" AND "));
  const url = `${resource}?${q}`;
  const rows = await getJson(url);
  for (const r of rows) {
    const rec = { ...r, socrata_id: r[":id"], source_url: url, fetched_at: fetchedAt };
    for (const k of Object.keys(rec)) if (k.startsWith(":")) delete rec[k];
    sink.write(JSON.stringify(rec) + "\n");
  }
  written += rows.length;
  process.stderr.write(`\r${written}/${reported} (${Math.round((Date.now() - started) / 1000)}s)`);
  if (rows.length < PAGE) break;
  afterId = rows[rows.length - 1][":id"];
}
await new Promise((r) => sink.end(r));
process.stderr.write("\n");
const receipt = { resource, select, where, reported, written, fetched_at: fetchedAt, seconds: Math.round((Date.now() - started) / 1000) };
await writeFile(`${out}.receipt.json`, JSON.stringify(receipt, null, 2) + "\n");
console.log(JSON.stringify(receipt));
if (written < reported) {
  console.error(`reconciliation failed: reported ${reported}, written ${written}`);
  process.exit(1);
}
