#!/usr/bin/env node
// Publish one pipeline run to IPFS and write its artifact manifest + run-history entry.
//   - CIDs are computed locally (Kubo default profile) and every vendor response must match.
//   - Directory artifacts (run root, partitioned permits, lead tiles) get a CAR each and are
//     imported into Filebase with dag/import (CIDs preserved block-for-block).
//   - Every listed file is also added as its own root to Filebase and Pinata, so it is announced
//     and retrievable by bare CID, and survives the loss of either vendor.
//   - CIDs already published by a previous run are not re-uploaded; nothing is ever unpinned.
// Usage: node src/publish/publish.mjs <run-dir> <run-id> <repo-runs-dir> <cars-dir> [--dry-run]
import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { importTree, PROFILE_DESCRIPTION, writeCar } from "./unixfs.mjs";

const [runDir, runId, runsDir, carsDir, ...flags] = process.argv.slice(2);
const dryRun = flags.includes("--dry-run");
if (!runDir || !runId || !runsDir || !carsDir) {
  console.error("usage: publish.mjs <run-dir> <run-id> <repo-runs-dir> <cars-dir> [--dry-run]");
  process.exit(2);
}
const env = process.env;
for (const k of ["FILEBASE_ACCESS_KEY", "FILEBASE_SECRET_KEY", "FILEBASE_BUCKET", "PINATA_JWT"]) {
  if (!dryRun && !env[k]) throw new Error(`${k} is not set`);
}
const FILEBASE_RPC = "https://rpc.filebase.io/api/v0";
const filebaseToken = () =>
  Buffer.from(`${env.FILEBASE_ACCESS_KEY}:${env.FILEBASE_SECRET_KEY}:${env.FILEBASE_BUCKET}`).toString("base64");
const DIRECTORY_ARTIFACTS = ["", "tables/permits", "tiles/leads"];
const LISTED_FILE = (p) => !p.startsWith("tiles/leads/"); // tiles are reachable via their directory root
const GATEWAYS = ["https://ipfs.io", "https://dweb.link"];

async function walk(dir, base = dir) {
  const out = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(full, base)));
    else out.push(relative(base, full).split("\\").join("/"));
  }
  return out;
}
async function sha256(path) {
  const h = createHash("sha256");
  for await (const chunk of createReadStream(path)) h.update(chunk);
  return h.digest("hex");
}
async function retry(label, fn, attempts = 5) {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (err) {
      if (i >= attempts) throw new Error(`${label}: ${err.message}`);
      await new Promise((r) => setTimeout(r, 2000 * 2 ** i));
    }
  }
}
async function formPost(url, headers, path, fields = {}) {
  const form = new FormData();
  const bytes = await readFile(path);
  form.append("file", new Blob([bytes]), fields.filename ?? "file");
  for (const [k, v] of Object.entries(fields)) if (k !== "filename") form.append(k, v);
  const res = await fetch(url, { method: "POST", headers, body: form, signal: AbortSignal.timeout(600_000) });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
  // Kubo-style endpoints stream one JSON object per line; prefer the line for our filename.
  const lines = text.trim().split("\n").map((l) => JSON.parse(l));
  return lines.find((l) => l.Name === fields.filename) ?? lines.at(-1);
}
// Upload names must be flat: a '/' makes Kubo wrap the file in a directory and report that instead.
const flat = (name) => name.replaceAll("/", "__");
const filebaseAdd = (path, name) =>
  retry(`filebase add ${name}`, async () =>
    (await formPost(`${FILEBASE_RPC}/add?cid-version=1&pin=true`, { Authorization: `Bearer ${filebaseToken()}` }, path, { filename: flat(name) })).Hash);
const filebaseImportCar = (carPath) =>
  retry(`filebase dag/import ${carPath}`, async () =>
    (await formPost(`${FILEBASE_RPC}/dag/import?pin-roots=true`, { Authorization: `Bearer ${filebaseToken()}` }, carPath, { filename: "dag.car" })).Root.Cid["/"]);
const pinataAdd = (path, name) =>
  retry(`pinata add ${name}`, async () =>
    (await formPost("https://uploads.pinata.cloud/v3/files", { Authorization: `Bearer ${env.PINATA_JWT}` }, path,
      { filename: name.split("/").pop(), network: "public", name })).data.cid);

// --- previous runs: CIDs already published are never re-uploaded
await mkdir(runsDir, { recursive: true });
const historyPath = join(runsDir, "history.json");
const history = existsSync(historyPath) ? JSON.parse(await readFile(historyPath, "utf8")) : { county: "travis", state: "TX", runs: [] };
if (history.runs.some((r) => r.run_id === runId)) throw new Error(`run ${runId} already in history`);
const published = new Map(); // cid -> pins already recorded
for (const r of history.runs) {
  const m = JSON.parse(await readFile(join(runsDir, r.run_id, "manifest.json"), "utf8"));
  for (const o of m.objects) published.set(o.cid, o.pins);
}
const previous = history.runs.at(-1) ?? null;

// --- local CIDs
const files = (await walk(runDir)).sort();
const t0 = Date.now();
const { blockstore, entries } = await importTree(runDir, files);
console.log(`imported ${files.length} files in ${((Date.now() - t0) / 1000).toFixed(1)}s; root ${entries.get("").cid}`);

const objects = [];
await mkdir(join(carsDir, runId), { recursive: true });
for (const dir of DIRECTORY_ARTIFACTS) {
  const e = entries.get(dir);
  if (!e) throw new Error(`missing directory artifact ${dir || "<root>"}`);
  const carName = `${dir ? dir.replaceAll("/", "_") : "root"}.car`;
  const carPath = join(carsDir, runId, carName);
  const { blocks } = await writeCar(blockstore, e.cid, carPath);
  objects.push({
    name: dir || ".", cid: e.cid.toString(), codec: "directory", size: e.size, sha256: null,
    car: { file: `${runId}/${carName}`, bytes: (await stat(carPath)).size, sha256: await sha256(carPath), blocks,
           release_asset: `https://github.com/richardreid1811/oracle-property-intelligence-platform-pipeline-travis-tx/releases/download/run-${runId}/${carName}` },
    pins: [], local_car_path: carPath,
  });
}
for (const f of files.filter(LISTED_FILE)) {
  const e = entries.get(f);
  const path = join(runDir, f);
  objects.push({ name: f, cid: e.cid.toString(), codec: "file", size: (await stat(path)).size, sha256: await sha256(path), pins: [], local_path: path });
}

// --- upload
for (const o of objects) {
  const prior = published.get(o.cid);
  if (prior) {
    o.pins = prior;
    o.reused_from_previous_run = true;
    continue;
  }
  if (dryRun) continue;
  if (o.codec === "directory") {
    const got = await filebaseImportCar(o.local_car_path);
    if (got !== o.cid) throw new Error(`filebase root mismatch for ${o.name}: ${got} != ${o.cid}`);
    o.pins.push({ provider: "filebase", method: "dag/import", at: new Date().toISOString() });
  } else {
    const fb = await filebaseAdd(o.local_path, `${runId}/${o.name}`);
    if (fb !== o.cid) throw new Error(`filebase CID mismatch for ${o.name}: ${fb} != ${o.cid}`);
    o.pins.push({ provider: "filebase", method: "add", at: new Date().toISOString() });
    const pn = await pinataAdd(o.local_path, `${runId}/${o.name}`);
    if (pn !== o.cid) throw new Error(`pinata CID mismatch for ${o.name}: ${pn} != ${o.cid}`);
    o.pins.push({ provider: "pinata", method: "v3 files public", at: new Date().toISOString() });
  }
  process.stderr.write(`\rpinned ${objects.indexOf(o) + 1}/${objects.length}`);
}
process.stderr.write("\n");

// --- manifest
const coverage = JSON.parse(await readFile(join(runDir, "coverage.json"), "utf8"));
const manifest = {
  schema: "travis-oracle/artifact-manifest@1",
  run_id: runId,
  created_at: new Date().toISOString(),
  county: "travis", state: "TX", fips: "48453",
  root: { cid: entries.get("").cid.toString(), car: objects[0].car },
  unixfs_profile: PROFILE_DESCRIPTION,
  cid_version: 1, multibase: "base32",
  previous_run: previous ? { run_id: previous.run_id, root_cid: previous.root_cid, manifest_cid: previous.manifest_cid } : null,
  ipns: null,
  gateway_urls_note: "Gateway URLs are derived from CIDs and are convenience locators only; the CID is the artifact.",
  objects: objects.map(({ local_path, local_car_path, ...o }) => ({
    ...o,
    gateway_urls: GATEWAYS.map((g) => `${g}/ipfs/${o.cid}`),
  })),
  counts: coverage.counts,
};
const runOut = join(runsDir, runId);
await mkdir(runOut, { recursive: true });
const manifestPath = join(runOut, "manifest.json");
await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n");

let manifestCid = null;
if (!dryRun) {
  manifestCid = await filebaseAdd(manifestPath, `${runId}/manifest.json`);
  const pn = await pinataAdd(manifestPath, `${runId}/manifest.json`);
  if (pn !== manifestCid) throw new Error(`manifest CID mismatch: filebase ${manifestCid} pinata ${pn}`);
}

const prevCounts = previous?.counts ?? null;
const deltas = Object.fromEntries(Object.entries(coverage.counts).map(([k, v]) => [k, prevCounts ? Number(v) - Number(prevCounts[k] ?? 0) : Number(v)]));
history.runs.push({
  run_id: runId,
  published_at: manifest.created_at,
  root_cid: manifest.root.cid,
  manifest_cid: manifestCid,
  manifest_path: `runs/${runId}/manifest.json`,
  objects: manifest.objects.length,
  new_objects: manifest.objects.filter((o) => !o.reused_from_previous_run).length,
  counts: coverage.counts,
  deltas_vs_previous: deltas,
  previous_run_id: previous?.run_id ?? null,
});
if (!dryRun) await writeFile(historyPath, JSON.stringify(history, null, 2) + "\n");
console.log(JSON.stringify({ run_id: runId, root: manifest.root.cid, manifest_cid: manifestCid, objects: manifest.objects.length, dry_run: dryRun }));
