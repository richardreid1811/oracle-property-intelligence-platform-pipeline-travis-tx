#!/usr/bin/env node
// Pin retention for free-tier pinning (Filebase and Pinata each allow 500 pinned files).
// Policy: keep pinned on both vendors every CID referenced by the initial full-load run and the latest
// KEEP runs, plus every run manifest. CIDs referenced only by older runs are unpinned; those runs stay
// in history (their CIDs never change) and remain importable from their CAR files in GitHub Releases.
// Each release is recorded in runs/history.json (pins_released) so availability is never implied.
// Dry run by default; --apply unpins. --extra <cid,...> also unpins listed CIDs (e.g. setup test pins)
// unless a kept run references them.
// Usage: node src/publish/prune-pins.mjs <runs-dir> [--keep 7] [--apply] [--extra cid1,cid2]
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const [runsDir, ...rest] = process.argv.slice(2);
const opt = (n, d) => (rest.includes(n) ? rest[rest.indexOf(n) + 1] : d);
const keep = Number(opt("--keep", "7"));
const apply = rest.includes("--apply");
const extra = (opt("--extra", "") || "").split(",").filter(Boolean);
if (!runsDir) {
  console.error("usage: prune-pins.mjs <runs-dir> [--keep 7] [--apply] [--extra cid,...]");
  process.exit(2);
}
const env = process.env;
const historyPath = join(runsDir, "history.json");
const history = JSON.parse(await readFile(historyPath, "utf8"));
const runs = history.runs;
const kept = new Set([runs[0]?.run_id, ...runs.slice(-keep).map((r) => r.run_id)].filter(Boolean));

const cidsOf = async (r) => {
  const m = JSON.parse(await readFile(join(runsDir, r.run_id, "manifest.json"), "utf8"));
  return new Set(m.objects.map((o) => o.cid));
};
const keepCids = new Set(runs.filter((r) => r.manifest_cid).map((r) => r.manifest_cid));
for (const r of runs.filter((r) => kept.has(r.run_id))) for (const c of await cidsOf(r)) keepCids.add(c);

const release = new Map(); // cid -> run ids
for (const r of runs.filter((r) => !kept.has(r.run_id) && !r.pins_released)) {
  for (const c of await cidsOf(r)) if (!keepCids.has(c)) release.set(c, [...(release.get(c) ?? []), r.run_id]);
}
for (const c of extra) if (!keepCids.has(c)) release.set(c, ["setup-test"]);

console.error(`runs ${runs.length}; kept ${[...kept].join(", ")}; ${keepCids.size} CIDs kept; ${release.size} to release`);
if (!apply) {
  console.log(JSON.stringify({ dry_run: true, kept_runs: [...kept], release: [...release.keys()] }, null, 2));
  process.exit(0);
}

const fbToken = Buffer.from(`${env.FILEBASE_ACCESS_KEY}:${env.FILEBASE_SECRET_KEY}:${env.FILEBASE_BUCKET}`).toString("base64");
async function filebaseUnpin(cid) {
  const res = await fetch(`https://rpc.filebase.io/api/v0/pin/rm?arg=${cid}`, { method: "POST", headers: { Authorization: `Bearer ${fbToken}` } });
  const text = await res.text();
  return res.ok ? "unpinned" : /not pinned|no such/i.test(text) ? "not_pinned" : `error: HTTP ${res.status} ${text.slice(0, 120)}`;
}
async function pinataUnpin(cid) {
  const res = await fetch(`https://api.pinata.cloud/v3/files/public?cid=${cid}&limit=100`, { headers: { Authorization: `Bearer ${env.PINATA_JWT}` } });
  if (!res.ok) return `error: list HTTP ${res.status}`;
  const files = (await res.json()).data?.files ?? [];
  if (!files.length) return "not_pinned";
  for (const f of files) {
    const del = await fetch(`https://api.pinata.cloud/v3/files/public/${f.id}`, { method: "DELETE", headers: { Authorization: `Bearer ${env.PINATA_JWT}` } });
    if (!del.ok) return `error: delete HTTP ${del.status}`;
  }
  return `unpinned ${files.length}`;
}

const results = [];
for (const [cid, runIds] of release) {
  const r = { cid, runs: runIds, filebase: await filebaseUnpin(cid), pinata: await pinataUnpin(cid) };
  results.push(r);
  console.error(`${cid} filebase=${r.filebase} pinata=${r.pinata}`);
}
const at = new Date().toISOString();
for (const r of runs.filter((r) => !kept.has(r.run_id) && !r.pins_released)) {
  r.pins_released = { at, policy: `keep initial run + latest ${keep}`, archive: `GitHub Release run-${r.run_id} (CARs)` };
}
history.retention = { policy: `keep initial run + latest ${keep} runs pinned on both vendors; older runs archived as CARs`, last_applied: at };
await writeFile(historyPath, JSON.stringify(history, null, 2) + "\n");
console.log(JSON.stringify({ applied: true, released: results.length, errors: results.filter((r) => /error/.test(r.filebase + r.pinata)).length }));
