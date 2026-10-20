#!/usr/bin/env node
// Extract the TCAD appraisal-export members the roll build needs, and write a receipt
// (source URL, zip digest, member sizes) so every downstream record can cite its snapshot.
// Usage: node src/sources/tcad-extract.mjs <export.zip> <out-dir> <source-url>
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

const MEMBERS = [
  "APPR_HDR.TXT",
  "PROP.TXT",
  "PROP_ENT.TXT",
  "IMP_INFO.TXT",
  "IMP_DET.TXT",
  "IMP_ATR.TXT",
  "STATE_CD.TXT",
  "TOTALS.TXT",
];

const [zipPath, outDir, sourceUrl] = process.argv.slice(2);
if (!zipPath || !outDir || !sourceUrl) {
  console.error("usage: tcad-extract.mjs <export.zip> <out-dir> <source-url>");
  process.exit(2);
}

async function sha256(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

await mkdir(outDir, { recursive: true });
const res = spawnSync("unzip", ["-o", "-j", zipPath, ...MEMBERS, "-d", outDir], { stdio: "inherit" });
if (res.status !== 0) process.exit(res.status ?? 1);

const members = {};
for (const m of MEMBERS) members[m] = (await stat(join(outDir, m))).size;
const receipt = {
  source_url: sourceUrl,
  zip_sha256: await sha256(zipPath),
  zip_bytes: (await stat(zipPath)).size,
  extracted_at: new Date().toISOString(),
  members,
};
await writeFile(join(outDir, "receipt.json"), JSON.stringify(receipt, null, 2) + "\n");
console.log(JSON.stringify(receipt));
