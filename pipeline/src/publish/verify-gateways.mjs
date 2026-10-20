#!/usr/bin/env node
// Verify every manifest object is retrievable by CID from independent public gateways that this
// project does not operate, and that the bytes match the manifest.
//   files:       full GET; byte length and SHA-256 must equal the manifest
//   directories: GET ?format=car. Small DAGs use dag-scope=all (every block re-hashed, block count
//                must equal the published CAR). Large roots use dag-scope=entity (root node plus its
//                directory listing): their data files are each verified byte-for-byte as manifest
//                file objects, so the full DAG is still covered.
// Bounded: per-request timeout, few retries, overall time budget; always writes its report so the
// evidence is committed even when a gateway is slow. Exit 1 if anything failed or was not attempted.
// Usage: node src/publish/verify-gateways.mjs <manifest.json> [--gateways a,b] [--budget-min 50]
import { CarBlockIterator } from "@ipld/car/iterator";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const [manifestPath, ...rest] = process.argv.slice(2);
if (!manifestPath) {
  console.error("usage: verify-gateways.mjs <manifest.json> [--gateways a,b] [--budget-min 50]");
  process.exit(2);
}
const opt = (n, d) => (rest.includes(n) ? rest[rest.indexOf(n) + 1] : d);
const gateways = opt("--gateways", "https://ipfs.io,https://dweb.link").split(",");
const deadline = Date.now() + Number(opt("--budget-min", "50")) * 60_000;
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const SHA2_256 = 0x12;
const FULL_CAR_MAX_BYTES = 80 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 120_000;
const ATTEMPTS = 3;
const CONCURRENCY = 2;
const sha256hex = (b) => createHash("sha256").update(b).digest("hex");

async function fetchBytes(url, accept) {
  let last;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    if (Date.now() > deadline) throw new Error(`time budget exhausted (${last ?? "no attempt"})`);
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": "travis-oracle-verifier (github actions)", ...(accept ? { Accept: accept } : {}) },
        signal: AbortSignal.timeout(Math.min(REQUEST_TIMEOUT_MS, Math.max(1000, deadline - Date.now()))),
      });
      if (res.ok) return { bytes: Buffer.from(await res.arrayBuffer()), finalUrl: res.url };
      last = `HTTP ${res.status}`;
    } catch (err) {
      last = err.name === "TimeoutError" ? `timeout after ${REQUEST_TIMEOUT_MS / 1000}s` : err.message;
    }
    await new Promise((r) => setTimeout(r, 10_000 * attempt)); // gateways rate-limit shared runners
  }
  throw new Error(last);
}

async function verifyDirectory(gateway, o) {
  const full = (o.car?.bytes ?? Infinity) <= FULL_CAR_MAX_BYTES;
  const scope = full ? "all" : "entity";
  const { bytes, finalUrl } = await fetchBytes(`${gateway}/ipfs/${o.cid}?format=car&dag-scope=${scope}`, "application/vnd.ipld.car");
  const it = await CarBlockIterator.fromBytes(bytes);
  const roots = (await it.getRoots()).map(String);
  let blocks = 0;
  let bad = 0;
  let rootSeen = false;
  for await (const { cid, bytes: b } of it) {
    blocks++;
    if (String(cid) === o.cid) rootSeen = true;
    if (cid.multihash.code !== SHA2_256 || sha256hex(b) !== Buffer.from(cid.multihash.digest).toString("hex")) bad++;
  }
  const ok = roots.length === 1 && roots[0] === o.cid && rootSeen && bad === 0 && (!full || blocks === o.car.blocks);
  return { ok, scope, url: finalUrl, car_bytes: bytes.length, roots, blocks, expected_blocks: full ? o.car.blocks : null, bad_blocks: bad };
}

async function verifyFile(gateway, o) {
  const { bytes, finalUrl } = await fetchBytes(`${gateway}/ipfs/${o.cid}`);
  const digest = sha256hex(bytes);
  return { ok: bytes.length === o.size && digest === o.sha256, url: finalUrl, bytes: bytes.length, sha256: digest };
}

const results = new Array(manifest.objects.length);
let next = 0;
async function worker() {
  while (next < manifest.objects.length) {
    const i = next++;
    const o = manifest.objects[i];
    const per = {};
    for (const g of gateways) {
      const started = Date.now();
      if (Date.now() > deadline) {
        per[g] = { ok: false, not_attempted: true, error: "time budget exhausted" };
      } else {
        try {
          per[g] = { ...(o.codec === "directory" ? await verifyDirectory(g, o) : await verifyFile(g, o)), ms: Date.now() - started };
        } catch (err) {
          per[g] = { ok: false, error: err.message, ms: Date.now() - started };
        }
      }
      console.log(`${per[g].ok ? "OK  " : "FAIL"} ${g} ${o.codec} ${o.name} ${o.cid} ${per[g].error ?? ""}`);
    }
    results[i] = { name: o.name, cid: o.cid, codec: o.codec, gateways: per };
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, worker));

const failures = results.reduce((n, r) => n + Object.values(r.gateways).filter((x) => !x.ok).length, 0);
const report = {
  run_id: manifest.run_id,
  manifest_sha256: sha256hex(await readFile(manifestPath)),
  verified_at: new Date().toISOString(),
  verifier: process.env.GITHUB_ACTIONS ? `github-actions run ${process.env.GITHUB_RUN_ID ?? ""}`.trim() : "local",
  gateways,
  method: "files: full GET + sha256; directories: CAR, dag-scope=all when CAR <= 80 MB else entity (data files verified individually)",
  objects: results.length,
  failures,
  all_ok: failures === 0,
  results,
};
await writeFile(join(dirname(manifestPath), "gateway-verification.json"), JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify({ run_id: report.run_id, objects: report.objects, failures, all_ok: report.all_ok }));
process.exit(failures === 0 ? 0 : 1);
