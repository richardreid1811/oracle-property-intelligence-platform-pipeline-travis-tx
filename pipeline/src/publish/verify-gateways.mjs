#!/usr/bin/env node
// Verify every manifest object is retrievable by CID from independent public gateways that this
// project does not operate, and that the bytes match the manifest.
//   files:       full GET, compare byte length and SHA-256 to the manifest
//   directories: GET ?format=car, check the CAR root equals the CID, re-hash every block against its
//                CID, and require the block count to equal the published CAR's
// Writes runs/<run>/gateway-verification.json. Exit 1 if any object fails on any gateway.
// Usage: node src/publish/verify-gateways.mjs <manifest.json> [--gateways https://ipfs.io,https://dweb.link]
import { CarBlockIterator } from "@ipld/car/iterator";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const [manifestPath, ...rest] = process.argv.slice(2);
if (!manifestPath) {
  console.error("usage: verify-gateways.mjs <manifest.json> [--gateways a,b]");
  process.exit(2);
}
const gi = rest.indexOf("--gateways");
const gateways = gi >= 0 ? rest[gi + 1].split(",") : ["https://ipfs.io", "https://dweb.link"];
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const SHA2_256 = 0x12;
const sha256hex = (b) => createHash("sha256").update(b).digest("hex");

async function fetchBytes(url, accept) {
  let last;
  for (let attempt = 1; attempt <= 6; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": "travis-oracle-verifier (github actions)", ...(accept ? { Accept: accept } : {}) },
        signal: AbortSignal.timeout(300_000),
      });
      if (res.ok) return { bytes: Buffer.from(await res.arrayBuffer()), status: res.status, finalUrl: res.url };
      last = `HTTP ${res.status}`;
    } catch (err) {
      last = err.message;
    }
    await new Promise((r) => setTimeout(r, 5000 * attempt)); // gateways rate-limit shared runners
  }
  throw new Error(last);
}

async function verifyDirectory(gateway, o) {
  const { bytes, finalUrl } = await fetchBytes(`${gateway}/ipfs/${o.cid}?format=car&dag-scope=all`, "application/vnd.ipld.car");
  const it = await CarBlockIterator.fromBytes(bytes);
  const roots = (await it.getRoots()).map(String);
  let blocks = 0;
  let bad = 0;
  for await (const { cid, bytes: b } of it) {
    blocks++;
    if (cid.multihash.code !== SHA2_256 || sha256hex(b) !== Buffer.from(cid.multihash.digest).toString("hex")) bad++;
  }
  const ok = roots.length === 1 && roots[0] === o.cid && bad === 0 && blocks === o.car.blocks;
  return { ok, url: finalUrl, car_bytes: bytes.length, car_sha256: sha256hex(bytes), roots, blocks, expected_blocks: o.car.blocks, bad_blocks: bad };
}

async function verifyFile(gateway, o) {
  const { bytes, finalUrl } = await fetchBytes(`${gateway}/ipfs/${o.cid}`);
  const digest = sha256hex(bytes);
  return { ok: bytes.length === o.size && digest === o.sha256, url: finalUrl, bytes: bytes.length, sha256: digest };
}

const results = [];
let failures = 0;
for (const o of manifest.objects) {
  const per = {};
  for (const g of gateways) {
    const started = Date.now();
    try {
      per[g] = { ...(o.codec === "directory" ? await verifyDirectory(g, o) : await verifyFile(g, o)), ms: Date.now() - started };
    } catch (err) {
      per[g] = { ok: false, error: err.message, ms: Date.now() - started };
    }
    if (!per[g].ok) failures++;
    console.log(`${per[g].ok ? "OK  " : "FAIL"} ${g} ${o.codec} ${o.name} ${o.cid}`);
  }
  results.push({ name: o.name, cid: o.cid, codec: o.codec, gateways: per });
}

const report = {
  run_id: manifest.run_id, manifest_sha256: sha256hex(await readFile(manifestPath)),
  verified_at: new Date().toISOString(), verifier: process.env.GITHUB_ACTIONS ? `github-actions ${process.env.GITHUB_RUN_ID ?? ""}`.trim() : "local",
  gateways, objects: results.length, failures,
  all_ok: failures === 0,
  results,
};
await writeFile(join(dirname(manifestPath), "gateway-verification.json"), JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify({ run_id: report.run_id, objects: report.objects, failures, all_ok: report.all_ok }));
process.exit(failures === 0 ? 0 : 1);
