#!/usr/bin/env node
// Rebuild a published run from its CIDs alone and prove it is the same dataset:
//   1. the manifest's own bytes hash to the manifest CID recorded in runs/history.json (raw CIDv1)
//   2. every `codec: "file"` object is downloaded by CID from independent public gateways only
//      (fetch-snapshot.mjs with --gateways), then re-checked on disk: byte length + SHA-256
//   3. the downloaded tree is re-imported with the publishing UnixFS profile (unixfs.mjs): every
//      file CID, the tables/permits directory CID and the root CID must equal the manifest's
//   4. the Parquet tables are opened in DuckDB and the snapshot's counts recomputed from them
//      (same definitions as export.mjs); each must equal manifest.counts and the downloaded
//      coverage.json. Counts that depend on today's date (roof age, deed tenure) are not compared.
// Lexicon dag-json roots are outside the UnixFS tree; verify-gateways.mjs covers them.
// Always writes its report (default: rebuild-from-cids.json next to the manifest). Exit 1 on any failure.
// Usage: node src/publish/rebuild-from-cids.mjs <manifest.json> <out-dir> [--history runs/history.json]
//          [--gateways https://ipfs.orbitor.dev,https://dget.top] [--report path] [--fetch-timeout-min 60]
import { DuckDBInstance } from "@duckdb/node-api";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CID } from "multiformats/cid";
import * as raw from "multiformats/codecs/raw";
import { sha256 as sha256Hasher } from "multiformats/hashes/sha2";
import { importTree } from "./unixfs.mjs";

const [manifestPath, outDir, ...rest] = process.argv.slice(2);
if (!manifestPath || !outDir) {
  console.error("usage: rebuild-from-cids.mjs <manifest.json> <out-dir> [--history h.json] [--gateways a,b] [--report path] [--fetch-timeout-min 60]");
  process.exit(2);
}
const opt = (n, d) => (rest.includes(n) ? rest[rest.indexOf(n) + 1] : d);
const gateways = opt("--gateways", "https://ipfs.orbitor.dev,https://dget.top");
const reportPath = opt("--report", join(dirname(manifestPath), "rebuild-from-cids.json"));
const historyPath = opt("--history", null);
const fetchTimeoutMs = Number(opt("--fetch-timeout-min", "60")) * 60_000;
const manifestBytes = await readFile(manifestPath);
const manifest = JSON.parse(manifestBytes);
const sha256 = (b) => createHash("sha256").update(b).digest("hex");
const files = manifest.objects.filter((o) => o.codec === "file");
const t0 = Date.now();

const report = {
  run_id: manifest.run_id,
  manifest_sha256: sha256(manifestBytes),
  rebuilt_at: new Date().toISOString(),
  verifier: process.env.GITHUB_ACTIONS ? `github-actions run ${process.env.GITHUB_RUN_ID ?? ""}`.trim() : "local",
  gateways: gateways.split(","),
  method: "inputs: runs/history.json + this manifest only. Files downloaded by CID from the gateways above (no project-operated or pinning-vendor gateway), byte length + sha256 checked against the manifest, tree re-imported with the publishing UnixFS profile (file, directory and root CIDs must match), Parquet tables opened in DuckDB and counts recomputed (export.mjs definitions) against manifest.counts and coverage.json; date-dependent counts not compared",
  checks: {},
};
let failures = 0;
const check = (name, ok, detail) => {
  report.checks[name] = { ok, ...detail };
  if (!ok) failures++;
  console.log(`${ok ? "OK  " : "FAIL"} ${name}${ok ? "" : ` ${JSON.stringify(detail)}`}`);
};
const finish = async () => {
  report.seconds = Math.round((Date.now() - t0) / 1000);
  report.failures = failures;
  report.all_ok = failures === 0;
  await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify({ run_id: report.run_id, failures, all_ok: report.all_ok, report: reportPath }));
  process.exit(failures === 0 ? 0 : 1);
};

// 1. Manifest CID (manifests are published as single raw blocks).
if (historyPath) {
  const entry = JSON.parse(await readFile(historyPath, "utf8")).runs.find((r) => r.run_id === manifest.run_id);
  const cid = CID.create(1, raw.code, await sha256Hasher.digest(manifestBytes)).toString();
  check("manifest_cid", entry?.manifest_cid === cid, { expected: entry?.manifest_cid ?? null, computed: cid });
}

// 2. Download by CID (fetch-snapshot.mjs: per-request timeout, retries, verifies before writing).
const via = {};
const fetchResult = await new Promise((resolve) => {
  const child = spawn(process.execPath, [fileURLToPath(new URL("./fetch-snapshot.mjs", import.meta.url)), manifestPath, outDir, "--gateways", gateways],
    { stdio: ["ignore", "pipe", "pipe"] });
  const timer = setTimeout(() => child.kill("SIGTERM"), fetchTimeoutMs);
  let out = "";
  let err = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => {
    err += d;
    process.stderr.write(d);
  });
  child.on("close", (code, signal) => {
    clearTimeout(timer);
    for (const m of err.matchAll(/^ok (\S+) \S+ via (\S+)$/gm)) via[m[1]] = m[2];
    resolve({ code, signal, summary: out.trim().split("\n").pop() ?? "", error: code === 0 ? null : err.trim().split("\n").slice(-3).join(" | ") });
  });
});
check("download", fetchResult.code === 0, { files: files.length, summary: fetchResult.summary, error: fetchResult.error, timed_out: fetchResult.signal === "SIGTERM" });

// Re-check bytes on disk, independently of the downloader.
const perFile = [];
for (const o of files) {
  const path = join(outDir, o.name);
  if (!existsSync(path)) {
    perFile.push({ name: o.name, cid: o.cid, ok: false, error: "missing" });
    continue;
  }
  const bytes = await readFile(path);
  const digest = sha256(bytes);
  perFile.push({ name: o.name, cid: o.cid, bytes: bytes.length, sha256: digest, via: via[o.name] ?? "reused local copy", ok: bytes.length === o.size && digest === o.sha256 });
}
const badBytes = perFile.filter((f) => !f.ok);
check("bytes", badBytes.length === 0, { files: perFile.length, mismatched: badBytes.map((f) => f.name) });
report.files = perFile;
if (badBytes.length) await finish();

// 3. Re-import with the publishing profile; CIDs must match the manifest.
const { entries } = await importTree(outDir, files.map((o) => o.name));
const cidOf = (name) => entries.get(name === "." ? "" : name)?.cid?.toString() ?? null;
const cidMismatch = manifest.objects.filter((o) => o.codec === "file" || o.codec === "directory").filter((o) => cidOf(o.name) !== o.cid)
  .map((o) => ({ name: o.name, expected: o.cid, computed: cidOf(o.name) }));
check("cids", cidMismatch.length === 0, { recomputed: files.length + manifest.objects.filter((o) => o.codec === "directory").length, mismatched: cidMismatch });
check("root_cid", cidOf(".") === manifest.root.cid, { expected: manifest.root.cid, computed: cidOf(".") });

// 4. Open the tables and recompute the snapshot counts (export.mjs definitions).
const db = await DuckDBInstance.create(":memory:");
const c = await db.connect();
const t = (name) => `'${join(outDir, "tables", name).replaceAll("'", "''")}'`;
const tables = files.map((o) => o.name).filter((n) => /^tables\/[a-z_]+\.parquet$/.test(n)).map((n) => n.slice(7, -8));
for (const name of tables) await c.run(`create view ${name} as select * from read_parquet(${t(`${name}.parquet`)})`);
await c.run(`create view permits as select * from read_parquet(${t("permits/**/*.parquet")})`);
const rows = {};
for (const name of [...tables, "permits"]) rows[name] = Number((await c.runAndReadAll(`select count(*) as n from ${name}`)).getRowObjectsJson()[0].n);
report.table_rows = rows;
const q = {
  properties: "select count(*) from properties",
  properties_with_coordinates: "select count(*) from properties where coordinate_basis <> 'none'",
  permits: "select count(*) from permits",
  permits_linked_to_parcel: "select count(*) from permits where prop_id is not null",
  roofing_permits: "select count(*) from permits where roofing_work is not null",
  roofing_permits_open_or_unfinaled: "select count(*) from permits where roofing_work in ('roof_replacement','roof_repair') and status_bucket in ('open','expired_unfinaled')",
  contractors: "select count(*) from contractors",
  contractors_resolved: "select count(*) from contractors where identity_status = 'resolved_exact_name'",
  contractors_with_bbb: "select count(*) from contractors where bbb_rating is not null",
  businesses: "select count(*) from businesses",
  licenses: "select count(*) from licenses",
  owners: "select count(*) from owners",
  multi_property_owners: "select count(*) from owners where property_count > 1",
  owner_out_of_state: "select count(*) from owner_signals where owner_mail_region in ('out_of_state', 'international')",
  permits_lakeway: "select count(*) from permits where issuing_authority = 'City of Lakeway'",
  business_locations: "select count(*) from business_locations",
  business_locations_linked_to_parcel: "select count(prop_id) from business_locations",
  business_locations_linked_to_registry: "select count(business_key) from business_locations",
};
const coverage = existsSync(join(outDir, "coverage.json")) ? JSON.parse(await readFile(join(outDir, "coverage.json"), "utf8")).counts : {};
const counts = {};
for (const [k, sql] of Object.entries(q)) {
  if (manifest.counts?.[k] === undefined) continue;
  try {
    const n = Number(Object.values((await c.runAndReadAll(sql)).getRowObjectsJson()[0])[0]);
    counts[k] = { recomputed: n, manifest: Number(manifest.counts[k]), coverage_json: coverage[k] === undefined ? null : Number(coverage[k]) };
    counts[k].ok = counts[k].recomputed === counts[k].manifest && (counts[k].coverage_json === null || counts[k].coverage_json === counts[k].recomputed);
  } catch (err) {
    counts[k] = { ok: false, error: err.message };
  }
}
// roofing_permits.parquet is the roofing subset of permits.
if (rows.roofing_permits !== undefined && manifest.counts?.roofing_permits !== undefined) {
  counts.roofing_permits_table = { recomputed: rows.roofing_permits, manifest: Number(manifest.counts.roofing_permits) };
  counts.roofing_permits_table.ok = counts.roofing_permits_table.recomputed === counts.roofing_permits_table.manifest;
}
const badCounts = Object.entries(counts).filter(([, v]) => !v.ok).map(([k]) => k);
check("counts", badCounts.length === 0, { compared: Object.keys(counts).length, mismatched: badCounts,
  not_compared: Object.keys(manifest.counts ?? {}).filter((k) => !(k in counts)) });
report.counts = counts;
c.closeSync();
report.bytes_downloaded = (await Promise.all(files.map(async (o) => (existsSync(join(outDir, o.name)) ? (await stat(join(outDir, o.name))).size : 0)))).reduce((a, b) => a + b, 0);
await finish();
