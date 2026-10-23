#!/usr/bin/env node
// Publish one pipeline run to IPFS and write its artifact manifest + run-history entry.
//   - CIDs are computed locally (Kubo default profile) and every vendor response must match.
//   - Directory artifacts (run root, partitioned permits) get a full CAR each (published with the
//     GitHub Release) and are pinned on Filebase with a directory-node-only CAR after their files.
//   - Every listed file is also added as its own root to Filebase and Pinata, so it is announced
//     and retrievable by bare CID, and survives the loss of either vendor.
//   - CIDs still pinned by a retained run are not re-uploaded; prune-pins.mjs releases older runs.
// Usage: node src/publish/publish.mjs <run-dir> <run-id> <repo-runs-dir> <cars-dir> [--dry-run]
import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { ipnsLabel, publishPointer } from "./ipns.mjs";
import { importTree, PROFILE_DESCRIPTION, writeCar, writeDirOnlyCar } from "./unixfs.mjs";

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
const DIRECTORY_ARTIFACTS = ["", "tables/permits"];
const LISTED_FILE = () => true;
// Derived convenience locators only (the CID is the artifact). ipfs.io/dweb.link retired HTTP access 2026-09-21.
const GATEWAYS = ["https://ipfs.orbitor.dev", "https://dget.top"];

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
// Pinata stores a new entry per upload even for a CID it already holds (each costs one of the
// free plan's 500 files), so a retried run checks first.
const pinataHas = async (cid) => {
  const res = await fetch(`https://api.pinata.cloud/v3/files/public?cid=${cid}&limit=1`, { headers: { Authorization: `Bearer ${env.PINATA_JWT}` } });
  return res.ok && ((await res.json()).data?.files?.length ?? 0) > 0;
};
const pinataAdd = (path, name) =>
  retry(`pinata add ${name}`, async () =>
    (await formPost("https://uploads.pinata.cloud/v3/files", { Authorization: `Bearer ${env.PINATA_JWT}` }, path,
      { filename: name.split("/").pop(), network: "public", name })).data.cid);

// --- previous runs: CIDs still pinned by a retained run are not re-uploaded
await mkdir(runsDir, { recursive: true });
const historyPath = join(runsDir, "history.json");
const history = existsSync(historyPath) ? JSON.parse(await readFile(historyPath, "utf8")) : { county: "travis", state: "TX", runs: [] };
if (history.runs.some((r) => r.run_id === runId)) throw new Error(`run ${runId} already in history`);
const published = new Map(); // cid -> pins already recorded
const pinataRefused = []; // files Pinata refused this run (second copy: root CAR in the release)
// Runs whose pins were released by prune-pins.mjs no longer guarantee their CIDs are pinned: bytes that
// reappear from such a run are pinned again. CIDs shared with a retained run stay pinned (prune keeps them).
for (const r of history.runs.filter((r) => !r.pins_released)) {
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
  // Pinning uses a directory-only CAR (files are pinned individually below); the full CAR above is
  // the archive published with the GitHub Release.
  const dirOnlyPath = join(carsDir, runId, `${carName}.dirs`);
  await writeDirOnlyCar(blockstore, entries, dir, dirOnlyPath);
  objects.push({
    name: dir || ".", cid: e.cid.toString(), codec: "directory", size: e.size, sha256: null,
    car: { file: `${runId}/${carName}`, bytes: (await stat(carPath)).size, sha256: await sha256(carPath), blocks,
           release_asset: `https://github.com/richardreid1811/oracle-property-intelligence-platform-pipeline-travis-tx/releases/download/run-${runId}/${carName}` },
    pins: [], local_car_path: carPath, local_dir_car_path: dirOnlyPath,
  });
}
for (const f of files.filter(LISTED_FILE)) {
  const e = entries.get(f);
  const path = join(runDir, f);
  objects.push({ name: f, cid: e.cid.toString(), codec: "file", size: (await stat(path)).size, sha256: await sha256(path), pins: [], local_path: path });
}

// --- upload: files first, so directory roots can be pinned with their directory nodes only
const uploadOrder = [...objects.filter((o) => o.codec === "file"), ...objects.filter((o) => o.codec === "directory")];
for (const o of uploadOrder) {
  const prior = published.get(o.cid);
  if (prior) {
    o.pins = prior;
    o.reused_from_previous_run = true;
    continue;
  }
  if (dryRun) continue;
  if (o.codec === "directory") {
    const got = await filebaseImportCar(o.local_dir_car_path);
    if (got !== o.cid) throw new Error(`filebase root mismatch for ${o.name}: ${got} != ${o.cid}`);
    o.pins.push({ provider: "filebase", method: "dag/import (directory nodes; files pinned individually)", at: new Date().toISOString() });
  } else {
    const fb = await filebaseAdd(o.local_path, `${runId}/${o.name}`);
    if (fb !== o.cid) throw new Error(`filebase CID mismatch for ${o.name}: ${fb} != ${o.cid}`);
    o.pins.push({ provider: "filebase", method: "add", at: new Date().toISOString() });
    // Pinata is the second vendor on the free plan; when it refuses a file (storage limit), the run
    // still publishes: the file is on Filebase and inside the run's root CAR in the GitHub Release.
    // The refusal is recorded on the object and in the run history. A CID mismatch always fails.
    try {
      if (!(await pinataHas(o.cid))) {
        const pn = await pinataAdd(o.local_path, `${runId}/${o.name}`);
        if (pn !== o.cid) throw new Error(`pinata CID mismatch for ${o.name}: ${pn} != ${o.cid}`);
      }
      o.pins.push({ provider: "pinata", method: "v3 files public", at: new Date().toISOString() });
    } catch (e) {
      if (/CID mismatch/.test(e.message)) throw e;
      const reason = e.message.slice(0, 200);
      o.pin_notes = [...(o.pin_notes ?? []), `Pinata refused: ${reason}`];
      pinataRefused.push(o.name);
      console.error(`\nwarning: Pinata refused ${o.name}: ${reason}`);
    }
  }
  process.stderr.write(`\rpinned ${uploadOrder.indexOf(o) + 1}/${uploadOrder.length}`);
}
process.stderr.write("\n");

// --- IPNS: re-point the county's open-data name at this run's root before the manifest is
// written, so the manifest records the name and the CID it resolved to. Filebase's free plan
// allows one name, so the query table is addressed by path under the same name.
let ipns = null;
if (!dryRun) {
  const p = await publishPointer(ipnsLabel("open-data", "travis"), entries.get("").cid.toString());
  ipns = {
    ...p,
    query_table_path: `/ipns/${p.name}/tables/leads.parquet`,
    note: "IPNS is a pointer; the CID is the snapshot. resolved_cid is what the name resolved to when this run was published.",
  };
  if (!p.resolves_to_target) console.error(`warning: ${p.label} has not resolved to the new root yet (got ${p.resolved_cid})`);
}

// --- Elephant Lexicon archives (one CAR per county per data group, built and uploaded with
// elephant-cli by src/lexicon/publish-group.mjs; evidence in runs/lexicon/<group>.json). Listed in
// every run's manifest while current, so the manifest names every eligible published artifact.
const lexiconDir = join(runsDir, "lexicon");
const lexiconObjects = [];
for (const f of existsSync(lexiconDir) ? (await readdir(lexiconDir)).filter((x) => x.endsWith(".json")).sort() : []) {
  const ev = JSON.parse(await readFile(join(lexiconDir, f), "utf8"));
  if (!ev.upload || !ev.hash?.car || !ev.export_tables?.tables_car) continue;
  const at = ev.finished_at;
  const lexicon = { group: ev.group, schema: ev.atlas_entry?.schema ?? null, properties: ev.properties, cli_commit: ev.cli?.commit, evidence: `runs/lexicon/${f}` };
  lexiconObjects.push(
    { name: `lexicon/${ev.group}/archive`, cid: ev.hash.root, codec: "dag-json", size: ev.hash.car.bytes, sha256: ev.hash.car.sha256,
      car: { file: `travis-${ev.group}.car`, bytes: ev.hash.car.bytes, sha256: ev.hash.car.sha256, blocks: ev.hash.blocks, release_asset: ev.release?.archive_car ?? null },
      pins: [{ provider: "filebase", method: "elephant-cli upload (Kubo RPC dag/import, gateway readback)", at }],
      lexicon: { ...lexicon, role: "archive (CountyIndex root)" } },
    { name: `lexicon/${ev.group}/tables`, cid: ev.export_tables.tables_root, codec: "dag-json", size: ev.export_tables.tables_car.bytes, sha256: ev.export_tables.tables_car.sha256,
      car: { file: "tables.car", bytes: ev.export_tables.tables_car.bytes, sha256: ev.export_tables.tables_car.sha256, blocks: 1, release_asset: ev.release?.tables_car ?? null },
      pins: [{ provider: "filebase", method: "elephant-cli upload (parts added + tables.car dag/import, gateway readback)", at }],
      lexicon: { ...lexicon, role: "tables (CountyTables root)" } },
  );
}
const prevCids = new Set((previous ? JSON.parse(await readFile(join(runsDir, previous.run_id, "manifest.json"), "utf8")).objects : []).map((o) => o.cid));
for (const o of lexiconObjects) if (prevCids.has(o.cid)) o.reused_from_previous_run = true;
objects.push(...lexiconObjects);

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
  ipns,
  gateway_urls_note: "Gateway URLs are derived from CIDs and are convenience locators only; the CID is the artifact.",
  objects: objects.map(({ local_path, local_car_path, local_dir_car_path, ...o }) => ({
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
let manifestPinNote = null;
if (!dryRun) {
  manifestCid = await filebaseAdd(manifestPath, `${runId}/manifest.json`);
  // The manifest is also committed to the repository; a Pinata plan limit on this one small file is
  // recorded in the run history rather than failing a run whose data files are pinned on both vendors.
  try {
    if (!(await pinataHas(manifestCid))) {
      const pn = await pinataAdd(manifestPath, `${runId}/manifest.json`);
      if (pn !== manifestCid) throw new Error(`manifest CID mismatch: filebase ${manifestCid} pinata ${pn}`);
    }
  } catch (e) {
    if (/CID mismatch/.test(e.message)) throw e;
    manifestPinNote = `manifest pinned on Filebase and committed to the repository; Pinata refused it: ${e.message.slice(0, 200)}`;
    console.error(`warning: ${manifestPinNote}`);
  }
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
  ipns: ipns ? { name: ipns.name, label: ipns.label, resolved_cid: ipns.resolved_cid } : null,
  ...(manifestPinNote ? { manifest_pin_note: manifestPinNote } : {}),
  ...(pinataRefused.length ? { pinata_refused: pinataRefused } : {}),
});
if (!dryRun) await writeFile(historyPath, JSON.stringify(history, null, 2) + "\n");
console.log(JSON.stringify({ run_id: runId, root: manifest.root.cid, manifest_cid: manifestCid, objects: manifest.objects.length, dry_run: dryRun }));
