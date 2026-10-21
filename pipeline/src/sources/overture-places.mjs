#!/usr/bin/env node
// Overture Maps places for Travis County, following the kit's overture-places-ingest gates
// (soofi-xyz-team-kit skills/overture-places-ingest):
//   1. the release is resolved from Overture's STAC catalog and pinned in the receipt (pass
//      --release to reproduce; a rerun never moves silently to a newer release)
//   2. clip with the Census TIGER/Line county polygon: bbox pruning first, then ST_Within; the bbox
//      count is diagnostic only
//   3. category logic keys on taxonomy.hierarchy (categories.* is deprecated and not used)
//   4. source/licence gate on sources[].dataset, case-insensitive: `osm` and any provider outside
//      the approved list are hard stops; the allowlist is never extended from observed data
//   5. expected_count is null: Overture supplies a numerator, not a denominator of all businesses
// Output: <out>/places.parquet + receipt.json
// Usage: node src/sources/overture-places.mjs <out-dir> [--release 2026-09-23.1]
//          [--boundary <tl_2024_us_county.zip>] [--counts-only]
import { DuckDBInstance } from "@duckdb/node-api";
import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const STAC = "https://stac.overturemaps.org/catalog.json";
const TIGER_URL = "https://www2.census.gov/geo/tiger/TIGER2024/COUNTY/tl_2024_us_county.zip";
const COUNTY_FIPS = "48453";
const APPROVED = ["meta", "microsoft", "foursquare", "pinmeto", "krick", "renderseo", "dac", "brightquery", "alltheplaces", "overture", "overture-signals"];

const [outDir, ...rest] = process.argv.slice(2);
const opt = (n, d) => (rest.includes(n) ? rest[rest.indexOf(n) + 1] : d);
const countsOnly = rest.includes("--counts-only");
if (!outDir) {
  console.error("usage: overture-places.mjs <out-dir> [--release R] [--boundary zip] [--counts-only]");
  process.exit(2);
}
await mkdir(outDir, { recursive: true });
const t0 = Date.now();

const catalog = await (await fetch(STAC, { signal: AbortSignal.timeout(30_000) })).json();
const release = opt("--release", catalog.latest);
if (!release) throw new Error("could not resolve an Overture release");

// TIGER/Line county boundaries (pinned vintage 2024), downloaded once and fingerprinted.
const boundaryZip = resolve(opt("--boundary", join(outDir, "tl_2024_us_county.zip")));
if (!existsSync(boundaryZip)) {
  const res = await fetch(TIGER_URL, { signal: AbortSignal.timeout(600_000) });
  if (!res.ok) throw new Error(`TIGER download failed: HTTP ${res.status}`);
  await writeFile(boundaryZip, Buffer.from(await res.arrayBuffer()));
}
const sha = createHash("sha256");
for await (const chunk of createReadStream(boundaryZip)) sha.update(chunk);
const boundarySha256 = sha.digest("hex");

const lit = (s) => `'${String(s).replaceAll("'", "''")}'`;
const glob = `s3://overturemaps-us-west-2/release/${release}/theme=places/type=place/*`;
const out = join(outDir, "places.parquet");
const db = await DuckDBInstance.create(":memory:");
const c = await db.connect();
const q = async (sql) => (await c.runAndReadAll(sql)).getRowObjectsJson();
await c.run("INSTALL spatial; LOAD spatial; INSTALL httpfs; LOAD httpfs; SET s3_region = 'us-west-2';");
// TIGER/Line is NAD83 (EPSG:4269); Overture is WGS84 (EPSG:4326). Transform, never relabel.
await c.run(`CREATE TEMP TABLE county_boundary AS SELECT ST_Transform(geom, 'EPSG:4269', 'EPSG:4326', true) AS geometry FROM ST_Read(${lit(`/vsizip/${boundaryZip}/tl_2024_us_county.shp`)}) WHERE GEOID = ${lit(COUNTY_FIPS)}`);
const [{ n: boundaries }] = await q("select count(*) as n from county_boundary");
if (Number(boundaries) !== 1) throw new Error(`expected one TIGER polygon for ${COUNTY_FIPS}, got ${boundaries}`);
await c.run(`CREATE TEMP TABLE county_bbox AS SELECT ST_XMin(ST_Extent(geometry)) xmin, ST_XMax(ST_Extent(geometry)) xmax,
  ST_YMin(ST_Extent(geometry)) ymin, ST_YMax(ST_Extent(geometry)) ymax FROM county_boundary`);
const bboxWhere = `p.bbox.xmin >= b.xmin AND p.bbox.xmax <= b.xmax AND p.bbox.ymin >= b.ymin AND p.bbox.ymax <= b.ymax`;

await c.run(`CREATE TEMP TABLE clipped AS
  SELECT
    p.id AS gers_id, p.version AS overture_version, p.names.primary AS name_primary,
    p.taxonomy.primary AS taxonomy_primary, p.taxonomy.hierarchy AS taxonomy_hierarchy,
    p.taxonomy.alternates AS taxonomy_alternate, p.basic_category AS basic_category,
    p.operating_status AS operating_status, p.confidence AS confidence,
    p.websites AS websites, p.phones AS phones,
    p.brand.names.primary AS brand_name, p.brand.wikidata AS brand_wikidata,
    p.addresses[1].freeform AS address_freeform, p.addresses[1].locality AS address_locality,
    p.addresses[1].postcode AS address_postcode, p.addresses[1].region AS address_region,
    p.addresses[1].country AS address_country, p.sources AS sources,
    ST_X(p.geometry) AS longitude, ST_Y(p.geometry) AS latitude,
    ${lit(release)} AS overture_release, ${lit(COUNTY_FIPS)} AS county_fips
  FROM read_parquet(${lit(glob)}, hive_partitioning = 1) AS p, county_bbox AS b, county_boundary AS cb
  WHERE ${bboxWhere} AND ST_Within(p.geometry, cb.geometry)`);

const [{ clipped }] = await q("select count(*) as clipped from clipped");
const [{ dup }] = await q("select count(*) - count(distinct gers_id) as dup from clipped");
if (Number(dup) !== 0) throw new Error(`duplicate GERS ids: ${dup}`);
const providers = await q(`select lower(s.dataset) as dataset, count(*) as n from (select unnest(sources) as s from clipped) group by 1 order by n desc`);
const blocked = providers.filter((p) => p.dataset === "osm" || !APPROVED.includes(p.dataset));
const receipt = {
  source: "Overture Maps Foundation places theme",
  stac_catalog: STAC, release, places_glob: glob, retrieved_at: new Date().toISOString(),
  boundary: { source: "Census TIGER/Line 2024 counties (tl_2024_us_county)", url: TIGER_URL, sha256: boundarySha256, geoid: COUNTY_FIPS },
  clipped_count: Number(clipped), expected_count: null,
  providers: providers.map((p) => ({ dataset: p.dataset, rows: Number(p.n) })),
  licence_gate: blocked.length ? { passed: false, blocked: blocked.map((p) => p.dataset) } : { passed: true, approved: APPROVED },
  attribution: "© OpenStreetMap is not included. Overture Maps Foundation, CDLA-Permissive-2.0; provider licences per https://docs.overturemaps.org/attribution/ (includes the Foursquare notice).",
  seconds: Math.round((Date.now() - t0) / 1000),
};
if (blocked.length) {
  await writeFile(join(outDir, "receipt.json"), JSON.stringify(receipt, null, 2) + "\n");
  throw new Error(`licence gate failed: providers ${blocked.map((p) => p.dataset).join(", ")} need human review; nothing written`);
}
if (!countsOnly) await c.run(`COPY (select * from clipped order by gers_id) TO ${lit(out)} (FORMAT parquet, COMPRESSION zstd)`);
await writeFile(join(outDir, "receipt.json"), JSON.stringify(receipt, null, 2) + "\n");
console.log(JSON.stringify({ release, clipped: Number(clipped), providers: receipt.providers, seconds: receipt.seconds }));
