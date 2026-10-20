#!/usr/bin/env node
// One incremental pipeline run, end to end, from the previous published snapshot:
//   1. previous run from runs/history.json; its run.json read by CID under the root (watermark)
//   2. City of Austin permit window since watermark - 1 day (overlap; the upsert de-duplicates)
//   3. no permit changes -> record an ingestion check in history and stop (no new CIDs)
//   4. fetch the previous snapshot by CID (sha256-verified), then incremental build -> export ->
//      record deltas -> run summary -> publish (pins + manifest)
// Each step is an existing idempotent script; any failure stops the run before publication.
// Usage: node src/run-incremental.mjs [--runs ../runs] [--gateway https://ipfs.filebase.io] [--dry-run]
import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const args = process.argv.slice(2);
const opt = (n, d) => (args.includes(n) ? args[args.indexOf(n) + 1] : d);
const runsDir = resolve(opt("--runs", join(root, "../runs")));
const gateway = opt("--gateway", "https://ipfs.filebase.io");
const dryRun = args.includes("--dry-run");
const data = join(root, "data");
const node = (script, ...a) => {
  console.error(`\n$ node ${script} ${a.join(" ")}`);
  return execFileSync(process.execPath, [join(root, script), ...a], { cwd: root, stdio: ["ignore", "pipe", "inherit"], env: process.env }).toString();
};

const startedAt = new Date().toISOString();
const runId = startedAt.replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
const historyPath = join(runsDir, "history.json");
const history = JSON.parse(await readFile(historyPath, "utf8"));
const prev = history.runs.at(-1);
const prevManifestPath = join(runsDir, prev.run_id, "manifest.json");

// Watermark lives in the previous run summary, read by path under its root CID.
const prevRunRes = await fetch(`${gateway}/ipfs/${prev.root_cid}/run.json`, { signal: AbortSignal.timeout(60_000) });
if (!prevRunRes.ok) throw new Error(`cannot read previous run.json (HTTP ${prevRunRes.status})`);
const prevRun = await prevRunRes.json();
const prevRunPath = join(data, "state", `${prev.run_id}.run.json`);
execFileSync("mkdir", ["-p", join(data, "state")]);
await writeFile(prevRunPath, JSON.stringify(prevRun));
const permits = prevRun.sources.find((s) => s.key === "austin_permits");
const watermark = permits?.receipt?.next_watermark;
if (!watermark) throw new Error("previous run has no Austin permit watermark");
const since = new Date(Date.parse(`${watermark}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);

const windowFile = join(data, "raw/permits/austin", `window-${runId}.ndjson`);
const harvest = JSON.parse(node("src/sources/austin-permits.mjs", windowFile, "--since", since).trim().split("\n").pop());
console.error(`window since ${since}: ${harvest.written} permits`);

if (harvest.written === 0) {
  history.checks = [...(history.checks ?? []), {
    checked_at: startedAt, source: "austin_permits", window_since: since, rows: 0,
    result: "no source changes; snapshot unchanged", current_run_id: prev.run_id,
  }];
  if (!dryRun) await writeFile(historyPath, JSON.stringify(history, null, 2) + "\n");
  console.log(JSON.stringify({ run_id: null, result: "no_changes", window_since: since }));
  process.exit(0);
}

// Previous snapshot materialized by CID (verified against the manifest) rather than range-read
// remotely: public gateways rate-limit the many parallel requests a remote scan would make.
const prevDir = join(data, "snapshots", prev.run_id);
node("src/publish/fetch-snapshot.mjs", prevManifestPath, prevDir, "--only", "tables/");
const db = join(data, "build", `incr-${runId}.duckdb`);
const runDir = join(data, "publish/runs", runId);
execFileSync("mkdir", ["-p", join(data, "build")]);
node("src/build/incremental.mjs", db, prevManifestPath, windowFile, "--prev-dir", prevDir);
node("src/publish/export.mjs", db, runDir);
node("src/publish/deltas.mjs", db, prevManifestPath, runDir, "--prev-dir", prevDir);
node("src/publish/run-summary.mjs", runDir, runId, join(data, "raw"), "incremental", startedAt, "--prev-run", prevRunPath,
  "--note", `Austin permit business-date window since ${since} (${harvest.written} permits) layered over run ${prev.run_id}; TCAD roll and identity sources carried forward.`);
const out = node("src/publish/publish.mjs", runDir, runId, runsDir, join(data, "publish/cars"), ...(dryRun ? ["--dry-run"] : []));
console.log(out.trim().split("\n").pop());
