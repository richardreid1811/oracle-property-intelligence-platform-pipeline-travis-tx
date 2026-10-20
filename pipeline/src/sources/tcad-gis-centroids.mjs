#!/usr/bin/env node
// Harvest TCAD parcel centroids (WGS84) from the City of Austin-hosted TCAD parcel layer.
// Output: NDJSON, one record per parcel feature, each carrying its source request URL.
// Usage: node pipeline/src/sources/tcad-gis-centroids.mjs <out.ndjson>
import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";

const LAYER =
  "https://services.arcgis.com/0L95CJ0VTaxqcmED/arcgis/rest/services/EXTERNAL_tcad_parcel/FeatureServer/0";
const PAGE = 2000; // layer maxRecordCount
const CONCURRENCY = 2;
const MAX_ATTEMPTS = 5;

const out = process.argv[2];
if (!out) {
  console.error("usage: tcad-gis-centroids.mjs <out.ndjson>");
  process.exit(2);
}

function pageUrl(offset) {
  const q = new URLSearchParams({
    where: "1=1",
    outFields: "OBJECTID_1,PROP_ID,PID_10",
    returnGeometry: "false",
    returnCentroid: "true",
    outSR: "4326",
    orderByFields: "OBJECTID_1",
    resultOffset: String(offset),
    resultRecordCount: String(PAGE),
    f: "json",
  });
  return `${LAYER}/query?${q}`;
}

async function getJson(url) {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.json();
      if (body.error) throw new Error(`ArcGIS error ${JSON.stringify(body.error)}`);
      return body;
    } catch (err) {
      if (attempt >= MAX_ATTEMPTS) throw err;
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
    }
  }
}

const countBody = await getJson(`${LAYER}/query?where=1%3D1&returnCountOnly=true&f=json`);
const total = countBody.count;
const offsets = [];
for (let o = 0; o < total; o += PAGE) offsets.push(o);

await mkdir(dirname(out), { recursive: true });
const sink = createWriteStream(out);
const fetchedAt = new Date().toISOString();
let written = 0;
let nullCentroid = 0;
const results = new Map(); // offset -> lines, flushed in order so output is deterministic
let nextFlush = 0;

function flush() {
  while (results.has(offsets[nextFlush])) {
    for (const line of results.get(offsets[nextFlush])) sink.write(line);
    results.delete(offsets[nextFlush]);
    nextFlush++;
  }
}

let cursor = 0;
async function worker() {
  while (cursor < offsets.length) {
    const offset = offsets[cursor++];
    const url = pageUrl(offset);
    const body = await getJson(url);
    const lines = body.features.map((f) => {
      const c = f.centroid;
      if (!c) nullCentroid++;
      return (
        JSON.stringify({
          object_id: f.attributes.OBJECTID_1,
          prop_id: f.attributes.PROP_ID == null ? null : String(f.attributes.PROP_ID),
          geo_id: f.attributes.PID_10 ?? null,
          longitude: c ? Number(c.x.toFixed(7)) : null,
          latitude: c ? Number(c.y.toFixed(7)) : null,
          source_url: url,
          fetched_at: fetchedAt,
        }) + "\n"
      );
    });
    written += lines.length;
    results.set(offset, lines);
    flush();
  }
}

await Promise.all(Array.from({ length: CONCURRENCY }, worker));
await new Promise((r) => sink.end(r));
console.log(JSON.stringify({ layer: LAYER, reported: total, written, null_centroid: nullCentroid, pages: offsets.length }));
if (written !== total) {
  console.error(`reconciliation failed: reported ${total}, written ${written}`);
  process.exit(1);
}
