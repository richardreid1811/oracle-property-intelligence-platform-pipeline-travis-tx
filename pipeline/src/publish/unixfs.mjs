// UnixFS import + CAR export using the Kubo default profile (CIDv1, raw leaves, 256 KiB fixed
// chunks, balanced DAG with 174 links per node). Pinning vendors that `add` with CIDv1 (Filebase,
// Pinata) produce the same CIDs for the same bytes, so a CID computed here is the CID everywhere.
import { CarWriter } from "@ipld/car/writer";
import * as dagPb from "@ipld/dag-pb";
import { MemoryBlockstore } from "blockstore-core";
import { CID } from "multiformats/cid";
import { importer } from "ipfs-unixfs-importer";
import { fixedSize } from "ipfs-unixfs-importer/chunker";
import { balanced } from "ipfs-unixfs-importer/layout";
import { createReadStream, createWriteStream } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

export const KUBO_PROFILE = Object.freeze({
  cidVersion: 1,
  rawLeaves: true,
  chunker: fixedSize({ chunkSize: 262144 }),
  layout: balanced({ maxChildrenPerNode: 174 }),
  reduceSingleLeafToSelf: true,
  wrapWithDirectory: true,
});
export const PROFILE_DESCRIPTION = "unixfs cidv1 raw-leaves chunker=size-262144 layout=balanced max-links=174 (kubo default)";

const DAG_PB = 0x70;
const RAW = 0x55;

/**
 * Import files (paths relative to baseDir, '/'-separated) as one wrapped UnixFS tree.
 * Returns the blockstore plus a CID for every file and directory ('' is the root).
 */
export async function importTree(baseDir, relPaths) {
  const blockstore = new MemoryBlockstore();
  const sorted = [...relPaths].sort();
  const source = sorted.map((path) => ({ path, content: createReadStream(`${baseDir}/${path}`) }));
  const entries = new Map();
  for await (const entry of importer(source, blockstore, KUBO_PROFILE)) {
    entries.set(entry.path, { cid: entry.cid, size: Number(entry.size), isDir: entry.unixfs?.type === "directory" });
  }
  if (!entries.has("")) throw new Error("importer did not produce a wrapping root");
  return { blockstore, entries };
}

// blockstore-core 7 returns a (sync or async) generator of byte chunks; older versions a
// Uint8Array or a Promise of one. Accept all of them.
async function getBlock(blockstore, cid) {
  let got = blockstore.get(cid);
  if (got instanceof Promise) got = await got;
  if (got instanceof Uint8Array) return got;
  const parts = [];
  if (typeof got?.[Symbol.asyncIterator] === "function") for await (const p of got) parts.push(p);
  else if (typeof got?.[Symbol.iterator] === "function") for (const p of got) parts.push(p);
  else throw new Error(`unreadable block ${cid}`);
  return Buffer.concat(parts);
}

/** Write a CARv1 containing every block reachable from rootCid (depth-first, deterministic). */
export async function writeCar(blockstore, rootCid, outPath) {
  // The importer and @ipld/car may resolve different multiformats copies; normalize via string form.
  const asCarCid = (cid) => CID.parse(cid.toString());
  const { writer, out } = CarWriter.create([asCarCid(rootCid)]);
  const done = pipeline(Readable.from(out), createWriteStream(outPath));
  const seen = new Set();
  const visit = async (cid) => {
    const key = cid.toString();
    if (seen.has(key)) return;
    seen.add(key);
    const bytes = await getBlock(blockstore, cid);
    await writer.put({ cid: asCarCid(cid), bytes: new Uint8Array(bytes) });
    if (cid.code === DAG_PB) {
      for (const link of dagPb.decode(bytes).Links) await visit(link.Hash);
    } else if (cid.code !== RAW) {
      throw new Error(`unexpected codec ${cid.code} in ${key}`);
    }
  };
  await visit(rootCid);
  await writer.close();
  await done;
  return { blocks: seen.size };
}
