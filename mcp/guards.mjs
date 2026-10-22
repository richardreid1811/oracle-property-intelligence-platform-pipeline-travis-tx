// Integrity and safety helpers for the MCP server, dependency-free so the pipeline tests can import
// them: content verification of everything read from public gateways, and the read-only SQL guard.
import { createHash } from "node:crypto";

export const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

const B32 = "abcdefghijklmnopqrstuvwxyz234567";
/**
 * SHA-256 digest (hex) carried by a CIDv1 raw-codec CID (base32 "bafkrei..."): the CID of a raw
 * block is its hash, so the bytes behind it can be checked without trusting the gateway.
 */
export function rawCidSha256(cid) {
  if (!/^b[a-z2-7]+$/.test(cid)) throw new Error(`not a base32 CIDv1: ${cid}`);
  let bits = 0;
  let acc = 0;
  const out = [];
  for (const ch of cid.slice(1)) {
    acc = (acc << 5) | B32.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((acc >> bits) & 0xff);
    }
  }
  // version 1, codec raw (0x55), multihash sha2-256 (0x12) of 32 bytes (0x20)
  if (out[0] !== 0x01 || out[1] !== 0x55 || out[2] !== 0x12 || out[3] !== 0x20 || out.length !== 36) {
    throw new Error(`${cid} is not a raw sha2-256 CID; the manifest is published as one`);
  }
  return Buffer.from(out.slice(4)).toString("hex");
}

/** Throw unless bytes match the expected SHA-256 (and size, when given). */
export function assertDigest(bytes, { sha256: want, size }, what) {
  if (!want) throw new Error(`${what}: no sha256 to verify against`);
  if (size !== undefined && bytes.length !== size) throw new Error(`${what}: ${bytes.length} bytes, manifest says ${size}`);
  const got = sha256(bytes);
  if (got !== want) throw new Error(`${what}: sha256 ${got} does not match ${want}`);
  return bytes;
}

/**
 * Read-only SQL for run_sql: one SELECT/WITH statement, no DDL/DML, extensions, pragmas or file and
 * network table functions. DuckDB external access is also disabled after load; this is the first gate.
 */
export function guardSql(sql) {
  const s = String(sql ?? "").trim().replace(/;+\s*$/, "");
  if (!/^(select|with)\b/i.test(s) || s.includes(";")) throw new Error("only a single SELECT/WITH statement is allowed");
  if (/\b(attach|detach|copy|install|load|pragma|create|insert|update|delete|drop|alter|export|import|set|reset|call|checkpoint|vacuum|read_csv|read_csv_auto|read_json|read_json_auto|read_ndjson|read_parquet|parquet_scan|read_text|read_blob|glob|sniff_csv)\b/i.test(s)) {
    throw new Error("statement uses a disallowed keyword or function");
  }
  // FROM 'file.csv' / FROM "s3://..." style replacement scans read files without a function name.
  if (/\b(from|join)\s+['"]/i.test(s)) throw new Error("statement reads a file path");
  return `select * from (${s}) limit 200`;
}

export const RUN_SQL_TIMEOUT_MS = 15_000;
/**
 * Run `work()` with a deadline; on timeout call `onTimeout()` (the server interrupts the DuckDB
 * connection), let the cancelled work settle (up to 2 s, so the connection is free again) and reject,
 * so one runaway query cannot hold the server.
 */
export async function withTimeout(work, ms, onTimeout = () => {}) {
  const job = work();
  let timer;
  const TIMEOUT = Symbol("timeout");
  const deadline = new Promise((resolve) => { timer = setTimeout(() => resolve(TIMEOUT), ms); });
  try {
    const out = await Promise.race([job, deadline]);
    if (out !== TIMEOUT) return out;
  } finally {
    clearTimeout(timer);
  }
  onTimeout();
  let grace;
  await Promise.race([job.catch(() => {}), new Promise((resolve) => { grace = setTimeout(resolve, 2000); })]);
  clearTimeout(grace);
  throw new Error(`query exceeded ${ms / 1000} s and was cancelled`);
}
