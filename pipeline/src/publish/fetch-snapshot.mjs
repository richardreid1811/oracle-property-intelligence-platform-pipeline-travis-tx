#!/usr/bin/env node
// Materialize a published run from its manifest using only CIDs: download every file object from
// public IPFS gateways (sequential, with backoff and gateway fallback) and verify each against the
// manifest's size and SHA-256 before writing it under its logical name. Anyone can rebuild the
// dataset this way; the pipeline uses it to read the previous snapshot for incremental runs.
// Usage: node src/publish/fetch-snapshot.mjs <manifest.json> <out-dir> [--gateways a,b,c] [--only tables/]
import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

const [manifestPath, outDir, ...rest] = process.argv.slice(2);
if (!manifestPath || !outDir) {
  console.error("usage: fetch-snapshot.mjs <manifest.json> <out-dir> [--gateways a,b,c] [--only prefix]");
  process.exit(2);
}
const opt = (n, d) => (rest.includes(n) ? rest[rest.indexOf(n) + 1] : d);
const gateways = opt("--gateways", "https://ipfs.filebase.io,https://gateway.pinata.cloud,https://ipfs.io").split(",");
const only = opt("--only", "");
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const sha256 = (b) => createHash("sha256").update(b).digest("hex");

async function fetchVerified(o) {
  let last;
  for (let attempt = 1; attempt <= 4; attempt++) {
    for (const g of gateways) {
      try {
        const res = await fetch(`${g}/ipfs/${o.cid}`, { signal: AbortSignal.timeout(300_000) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const bytes = Buffer.from(await res.arrayBuffer());
        if (bytes.length !== o.size || sha256(bytes) !== o.sha256) throw new Error("bytes do not match manifest");
        return { bytes, gateway: g };
      } catch (e) {
        last = `${g}: ${e.message}`;
      }
    }
    await new Promise((r) => setTimeout(r, 5000 * attempt));
  }
  throw new Error(`${o.name} (${o.cid}) failed: ${last}`);
}

const files = manifest.objects.filter((o) => o.codec === "file" && o.name.startsWith(only));
let fetched = 0;
let reused = 0;
for (const o of files) {
  const path = join(outDir, o.name);
  if (existsSync(path) && (await stat(path)).size === o.size && sha256(await readFile(path)) === o.sha256) {
    reused++;
    continue;
  }
  const { bytes, gateway } = await fetchVerified(o);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, bytes);
  fetched++;
  console.error(`ok ${o.name} ${o.cid} via ${new URL(gateway).host}`);
}
console.log(JSON.stringify({ run_id: manifest.run_id, root: manifest.root.cid, files: files.length, fetched, reused, out_dir: outDir }));
