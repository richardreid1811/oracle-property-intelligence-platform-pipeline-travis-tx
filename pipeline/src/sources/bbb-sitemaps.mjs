#!/usr/bin/env node
// Discover BBB business-profile URLs for Texas from BBB's published sitemaps.
// Compliance: BBB robots.txt disallows query-string URLs (search, category pagination) but lists
// these sitemaps and allows /us/*/*/profile/* pages. This scanner only reads sitemap XML, paced,
// and stops on the first 403 (source-access boundary, per kit bbb-harvest).
// Output NDJSON rows: {url, state, city, category, slug, bbb_id, sitemap, lastmod_index}
// Usage: node src/sources/bbb-sitemaps.mjs <out.ndjson> [--state tx] [--delay-ms 750]
import { createWriteStream } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const INDEX = "https://www.bbb.org/sitemap-business-profiles-index.xml";
const UA = "travis-oracle-pipeline/0.1 (property-data research; sitemap reader)";
const args = process.argv.slice(2);
const out = args[0];
const opt = (n, d) => (args.includes(n) ? args[args.indexOf(n) + 1] : d);
const state = opt("--state", "tx").toLowerCase();
const delayMs = Number(opt("--delay-ms", "750"));
if (!out) {
  console.error("usage: bbb-sitemaps.mjs <out.ndjson> [--state tx] [--delay-ms 750]");
  process.exit(2);
}

async function getText(url) {
  for (let attempt = 1; attempt <= 4; attempt++) {
    const res = await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(120_000) });
    if (res.status === 403) {
      const evidence = { status: 403, url, at: new Date().toISOString() };
      await writeFile(`${out}.blocked.json`, JSON.stringify(evidence, null, 2) + "\n");
      console.error("403 from BBB: stopping all BBB requests", evidence);
      process.exit(3);
    }
    if (res.ok) return res.text();
    await new Promise((r) => setTimeout(r, 5000 * attempt));
  }
  throw new Error(`failed after retries: ${url}`);
}

const locs = (xml) => [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1].trim());
const sitemaps = locs(await getText(INDEX));
const re = new RegExp(`^https://www\\.bbb\\.org/us/${state}/([^/]+)/profile/([^/]+)/(.+)-(\\d{4}-\\d+)$`);

await mkdir(dirname(out), { recursive: true });
const sink = createWriteStream(out);
let scanned = 0;
let kept = 0;
for (const [i, sm] of sitemaps.entries()) {
  const urls = locs(await getText(sm));
  scanned += urls.length;
  for (const url of urls) {
    const m = url.match(re);
    if (!m) continue;
    kept++;
    sink.write(JSON.stringify({ url, state, city: m[1], category: m[2], slug: m[3], bbb_id: m[4], sitemap: sm }) + "\n");
  }
  process.stderr.write(`\rsitemap ${i + 1}/${sitemaps.length} scanned=${scanned} kept=${kept}`);
  await new Promise((r) => setTimeout(r, delayMs));
}
await new Promise((r) => sink.end(r));
process.stderr.write("\n");
const receipt = { index: INDEX, sitemaps: sitemaps.length, scanned, kept, state, fetched_at: new Date().toISOString() };
await writeFile(`${out}.receipt.json`, JSON.stringify(receipt, null, 2) + "\n");
console.log(JSON.stringify(receipt));
