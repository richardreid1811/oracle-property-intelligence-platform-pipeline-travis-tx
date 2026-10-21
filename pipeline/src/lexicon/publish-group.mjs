#!/usr/bin/env node
// Publish one Lexicon data group for Travis County, following the Elephant oracle publication
// sequence exactly (soofi-xyz-team-kit use-oracle/reference/car-publication.md):
//
//   1. elephant-cli validate <group-dir>        every property, against the live lexicon
//   2. elephant-cli hash <group-dir> --output-car   one CAR per county per data group
//   3. elephant-cli validate <car>              integrity, root, index, graph, lexicon, orphans
//   4. elephant-cli export-tables <car> --atlas-page   per-class tables + this group's Atlas entry
//   5. elephant-cli upload <car> / <tables-dir> --api https://rpc.filebase.io   (with readback)
//
// Step 1 runs as a pool of validator processes over shards of the group (the kit's scaling note:
// a warm worker pool; the output contract and checks are identical). Each step must pass before
// the next starts. Upload is human-gated like every Elephant bulk-PII publication: it runs only
// when runs/publication-approval.json approves this county (see docs/lexicon-publication.md).
// Evidence for every step is written to runs/lexicon/<group>.json.
//
// Usage: node src/lexicon/publish-group.mjs <lexicon-dir> --group county|property_improvement
//          [--shards 6] [--skip-validate-dir] [--upload]
//        node src/lexicon/publish-group.mjs <lexicon-dir> --group <g> --upload-only
//          (upload a group already validated, hashed, CAR-validated and exported by an earlier run;
//           refuses unless that run's evidence shows zero property errors and a passing CAR)
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, statSync } from "node:fs";
import { existsSync } from "node:fs";
import { link, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../../..");
const CLI = join(repo, "tools/elephant-cli/node_modules/.bin/elephant-cli");
const CLI_COMMIT = "44bb182b9f7f904662e9b33e1fde70bdeab62322";
const MANIFEST_URL = process.env.ELEPHANT_SCHEMA_MANIFEST_URL ?? "https://lexicon.elephant.xyz/api/manifest";
const COUNTY = { county: "travis", state: "TX", fips: "48453" };

const [lexDir, ...rest] = process.argv.slice(2);
const opt = (n, d) => (rest.includes(n) ? rest[rest.indexOf(n) + 1] : d);
const group = opt("--group");
const shards = Number(opt("--shards", "6"));
const uploadOnly = rest.includes("--upload-only");
const upload = rest.includes("--upload") || uploadOnly;
if (!lexDir || !["county", "property_improvement"].includes(group)) {
  console.error("usage: publish-group.mjs <lexicon-dir> --group county|property_improvement [--shards 6] [--upload]");
  process.exit(2);
}
const base = resolve(lexDir);
const groupDir = join(base, group);
const work = join(base, `${group}-work`);
const evidencePath = join(repo, "runs/lexicon", `${group}.json`);
const name = `${COUNTY.county}-${group}`;

const run = (args, cwd, env = {}) =>
  new Promise((ok, fail) => {
    const p = spawn(CLI, args, { cwd, env: { ...process.env, ...env } });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (out += d));
    p.on("close", (code) => ok({ code, out }));
    p.on("error", fail);
  });
const csvRows = async (path) => {
  if (!existsSync(path)) return -1;
  const lines = (await readFile(path, "utf8")).trim().split("\n");
  return Math.max(0, lines.length - 1);
};
const step = (label) => console.error(`\n[${new Date().toISOString()}] ${label}`);

const fileStats = async (path) => {
  const h = createHash("sha256");
  for await (const chunk of createReadStream(path)) h.update(chunk);
  return { bytes: statSync(path).size, sha256: h.digest("hex") };
};
const evidence = uploadOnly
  ? JSON.parse(await readFile(evidencePath, "utf8"))
  : { county: COUNTY, group, cli: { package: "@elephant-xyz/cli", commit: CLI_COMMIT }, manifest_url: MANIFEST_URL, started_at: new Date().toISOString() };
if (uploadOnly && !(evidence.validate_dir?.error_rows === 0 && evidence.validate_car?.passed && evidence.export_tables?.tables_root)) {
  throw new Error(`refusing to upload ${group}: evidence does not show zero property errors, a passing CAR and exported tables`);
}
await mkdir(work, { recursive: true });
await mkdir(dirname(evidencePath), { recursive: true });
const properties = (await readdir(groupDir)).filter((f) => f.endsWith(".zip")).sort();
evidence.properties = properties.length;

// 1. Validate every property, in a pool of validator processes over shards.
if (!uploadOnly && !rest.includes("--skip-validate-dir")) {
  step(`validate ${properties.length} properties in ${shards} shards`);
  const jobs = [];
  for (let s = 0; s < shards; s++) {
    const dir = join(work, `shard-${s}`);
    await rm(dir, { recursive: true, force: true });
    await mkdir(join(dir, "input"), { recursive: true });
    for (let i = s; i < properties.length; i += shards) await link(join(groupDir, properties[i]), join(dir, "input", properties[i]));
    jobs.push(run(["validate", "./input", "--output-csv", "errors.csv"], dir).then(async (r) => ({ shard: s, code: r.code, errors: await csvRows(join(dir, "errors.csv")), summary: r.out.split("\n").filter((l) => /processed|failed:/.test(l)).join(" ") })));
  }
  const results = await Promise.all(jobs);
  const errors = results.reduce((a, r) => a + Math.max(0, r.errors), 0);
  evidence.validate_dir = { shards: results, error_rows: errors, finished_at: new Date().toISOString() };
  await writeFile(evidencePath, JSON.stringify(evidence, null, 2) + "\n");
  if (errors || results.some((r) => r.code !== 0)) throw new Error(`directory validation failed: ${errors} error rows (see ${work}/shard-*/errors.csv)`);
}

const car = join(work, `${name}.car`);
const tablesDir = join(work, `${name}-tables`);
const atlasPage = join(repo, "atlas/counties/TX/travis.json");
let root = evidence.hash?.root;
if (!uploadOnly) {
// 2. Hash every property and pack the group into one CAR.
step("hash");
await rm(join(work, "hashed"), { recursive: true, force: true });
const h = await run(["hash", groupDir, "--output-zip", join(work, "hashed"), "--output-csv", join(work, `${name}-hash.csv`), "--output-car", car], work);
const carLine = h.out.split("\n").find((l) => l.startsWith("CAR written"));
if (h.code !== 0 || !carLine) throw new Error(`hash failed:\n${h.out.slice(-2000)}`);
const [, blocks, carRoot] = carLine.match(/\((\d+) blocks, root (\S+)\)/);
root = carRoot;
evidence.hash = { car_written: carLine, blocks: Number(blocks), root, car: await fileStats(car) };

// 3. Prove the archive.
step("validate CAR");
const cv = await run(["validate", car, "--output-csv", join(work, `${name}-car-errors.csv`)], work);
const checks = Object.fromEntries([...cv.out.matchAll(/^\s*(\w+) errors:\s+(\d+)/gm)].map((m) => [m[1], Number(m[2])]));
evidence.validate_car = { checks, passed: /CAR passed every check/.test(cv.out) };
if (cv.code !== 0 || !evidence.validate_car.passed) throw new Error(`CAR validation failed:\n${cv.out.slice(-2000)}`);

// 4. Tables + this group's Atlas page entry.
step("export tables");
await mkdir(dirname(atlasPage), { recursive: true });
await rm(tablesDir, { recursive: true, force: true });
const ex = await run(["export-tables", car, "--output", tablesDir, "--part-size", "1g", "--output-json", join(work, `${name}-tables-export.json`),
  "--atlas-page", atlasPage, "--county", COUNTY.county, "--state", COUNTY.state, "--fips", COUNTY.fips], work);
const tablesLine = ex.out.split("\n").find((l) => l.startsWith("Tables written"));
if (ex.code !== 0 || !tablesLine) throw new Error(`export-tables failed:\n${ex.out.slice(-2000)}`);
evidence.export_tables = { tables_written: tablesLine, tables_root: tablesLine.match(/root (\S+)\)/)[1], atlas_page: "atlas/counties/TX/travis.json" };
evidence.atlas_entry = JSON.parse(await readFile(atlasPage, "utf8")).groups?.[group] ?? null;
evidence.export_tables.tables_car = await fileStats(join(tablesDir, "tables.car"));
await writeFile(evidencePath, JSON.stringify(evidence, null, 2) + "\n");
}
if (uploadOnly) {
  // Evidence from the earlier run predates the size/digest fields; add them from the same files.
  evidence.hash.car ??= await fileStats(car);
  evidence.export_tables.tables_car ??= await fileStats(join(tablesDir, "tables.car"));
}

// 5. Upload (human-gated), with readback through the gateway.
if (upload) {
  const approvalPath = join(repo, "runs/publication-approval.json");
  const approval = existsSync(approvalPath) ? JSON.parse(await readFile(approvalPath, "utf8")) : null;
  if (approval?.county !== COUNTY.county || approval?.approved !== true) {
    throw new Error("upload not approved: runs/publication-approval.json must approve county travis (human gate for bulk PII to public IPFS)");
  }
  for (const k of ["FILEBASE_ACCESS_KEY", "FILEBASE_SECRET_KEY", "FILEBASE_BUCKET"]) if (!process.env[k]) throw new Error(`${k} is not set`);
  step("upload CAR");
  const u1 = await run(["upload", car, "--api", "https://rpc.filebase.io", "--output-json", join(work, `${name}-upload.json`)], work);
  if (u1.code !== 0) throw new Error(`CAR upload failed:\n${u1.out.slice(-2000)}`);
  step("upload tables");
  const u2 = await run(["upload", tablesDir, "--api", "https://rpc.filebase.io", "--output-json", join(work, `${name}-tables-upload.json`)], work);
  if (u2.code !== 0) throw new Error(`tables upload failed:\n${u2.out.slice(-2000)}`);
  evidence.upload = {
    archive: JSON.parse(await readFile(join(work, `${name}-upload.json`), "utf8")),
    tables: JSON.parse(await readFile(join(work, `${name}-tables-upload.json`), "utf8")),
    approval,
  };
}
evidence.finished_at = new Date().toISOString();
await writeFile(evidencePath, JSON.stringify(evidence, null, 2) + "\n");
console.log(JSON.stringify({ group, properties: properties.length, root, tables_root: evidence.export_tables.tables_root, uploaded: upload }));
