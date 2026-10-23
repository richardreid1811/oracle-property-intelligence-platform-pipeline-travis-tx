#!/usr/bin/env node
// Travis Oracle MCP server (stdio).
// Loads the published snapshot by CID from public IPFS gateways into an in-process DuckDB and serves
// the shared roofing-lead tools (packages/query-tools) plus a read-only SQL tool. No hosted database.
//
// Snapshot selection (first match wins):
//   TRAVIS_ORACLE_MANIFEST_CID  pin an exact run manifest by CID
//   TRAVIS_ORACLE_HISTORY_URL   run history JSON (default: runs/history.json in the GitHub repo)
// Gateways: TRAVIS_ORACLE_GATEWAYS (comma-separated; default Filebase, Pinata, orbitor.dev, dget.top).
// Nothing a gateway returns is trusted: the manifest must hash to its raw CID, and every table and
// run.json must match the manifest's SHA-256 and size before it is loaded.
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DuckDBInstance } from "@duckdb/node-api";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { mcpTools, PLACES_SQL, resolveArgs, snapshotDate, toolByName, withLookupLinks } from "@travis-oracle/query-tools";
import { embed } from "@travis-oracle/query-tools/embed.mjs";
import { assertDigest, guardSql, rawCidSha256, RUN_SQL_TIMEOUT_MS, withTimeout } from "./guards.mjs";

const HISTORY_URL =
  process.env.TRAVIS_ORACLE_HISTORY_URL ??
  "https://raw.githubusercontent.com/richardreid1811/oracle-property-intelligence-platform-pipeline-travis-tx/travis-pipeline/runs/history.json";
const GATEWAYS = (process.env.TRAVIS_ORACLE_GATEWAYS ?? "https://ipfs.filebase.io,https://gateway.pinata.cloud,https://ipfs.orbitor.dev,https://dget.top").split(",");
const TABLES = ["leads", "roofing_permits", "contractors", "hail_events"];
const log = (...a) => console.error("[travis-oracle-mcp]", ...a); // stdout is the MCP channel

async function getJson(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}
// Bytes at /ipfs/<path> from the first gateway whose response passes `verify` (throws on mismatch).
async function verifiedBytes(path, verify, what) {
  let last;
  for (const g of GATEWAYS) {
    try {
      const res = await fetch(`${g}/ipfs/${path}`, { signal: AbortSignal.timeout(300_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const bytes = verify(Buffer.from(await res.arrayBuffer()));
      log(`verified ${what} via ${g}`);
      return bytes;
    } catch (e) {
      log(`gateway ${g} failed for ${what}: ${e.message}`);
      last = e;
    }
  }
  throw new Error(`could not load a verified ${what} from any gateway (${last?.message})`);
}
const manifestObject = (manifest, name) => manifest.objects.find((o) => o.name === name);

let state = null; // { conn, manifest, manifestCid, run }
let loading = null;
async function ensureLoaded() {
  if (state) return state;
  loading ??= (async () => {
    let manifestCid = process.env.TRAVIS_ORACLE_MANIFEST_CID;
    if (!manifestCid) {
      const history = await getJson(HISTORY_URL);
      manifestCid = history.runs.at(-1).manifest_cid;
    }
    // The manifest is a raw block: its CID is its SHA-256.
    const manifestSha = rawCidSha256(manifestCid);
    const manifest = JSON.parse(await verifiedBytes(manifestCid, (b) => assertDigest(b, { sha256: manifestSha }, "manifest"), `manifest ${manifestCid}`));
    log(`snapshot ${manifest.run_id} root ${manifest.root.cid}`);
    const db = await DuckDBInstance.create(":memory:");
    const conn = await db.connect();
    // Tables are downloaded whole and hash-checked, then read from a local copy (a remote
    // read_parquet would range-read bytes that were never verified).
    const dir = await mkdtemp(join(tmpdir(), "travis-oracle-mcp-"));
    const loadTable = async (t) => {
      const obj = manifestObject(manifest, `tables/${t}.parquet`);
      if (!obj) throw new Error(`manifest has no tables/${t}.parquet`);
      const bytes = await verifiedBytes(obj.cid, (b) => assertDigest(b, obj, obj.name), `${t} (${obj.cid})`);
      const file = join(dir, `${t}.parquet`);
      await writeFile(file, bytes);
      await conn.run(`create or replace table ${t} as select * from read_parquet('${file}')`);
    };
    for (const t of TABLES) await loadTable(t);
    await conn.run(PLACES_SQL);
    // Semantic retrieval table (present in runs published after embeddings were added).
    if (manifestObject(manifest, "tables/permit_embeddings.parquet")) {
      try {
        await loadTable("permit_embeddings");
      } catch (e) {
        log(`permit_embeddings not loaded: ${e.message}`);
      }
    }
    // All data is now in memory. Lock DuckDB down so run_sql (and anything else) cannot read local
    // files or the network: a keyword blocklist cannot catch file-path table scans like FROM '/path'.
    await conn.run("SET enable_external_access = false");
    await conn.run("SET lock_configuration = true");
    let run = null;
    const runObj = manifestObject(manifest, "run.json");
    try {
      run = JSON.parse(await verifiedBytes(`${manifest.root.cid}/run.json`, (b) => assertDigest(b, runObj ?? {}, "run.json"), "run.json"));
    } catch (e) {
      log(`run summary not loaded: ${e.message}`); // optional
    }
    state = { conn, manifest, manifestCid, run };
    return state;
  })().catch((e) => {
    loading = null; // a failed load (network, gateways, DuckDB) is retried on the next request, not cached
    throw e;
  });
  return loading;
}

const rows = async (sql) => (await (await ensureLoaded()).conn.runAndReadAll(sql)).getRowObjectsJson();

// Read-only SQL for agents that need ad-hoc questions: a single SELECT/WITH statement (guards.mjs),
// cancelled after RUN_SQL_TIMEOUT_MS.
const SQL_TOOL = {
  name: "run_sql",
  description: "Run one read-only SQL SELECT (DuckDB dialect) over tables leads, roofing_permits, contractors, places, permit_embeddings. Returns at most 200 rows.",
  inputSchema: { type: "object", properties: { sql: { type: "string" } }, required: ["sql"] },
};

const server = new Server({ name: "travis-oracle", version: "0.1.0" }, { capabilities: { tools: {}, resources: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [...mcpTools(), SQL_TOOL] }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args = {} } = req.params;
  try {
    if (name === "run_sql") {
      const sql = guardSql(args.sql);
      const { conn } = await ensureLoaded();
      const out = await withTimeout(() => rows(sql), RUN_SQL_TIMEOUT_MS, () => conn.interrupt());
      return { content: [{ type: "text", text: JSON.stringify({ rows: out }, null, 2) }] };
    }
    const tool = toolByName[name];
    if (!tool) throw new Error(`unknown tool ${name}`);
    const { manifest } = await ensureLoaded();
    // Durations are measured to the snapshot date, so a snapshot always returns the same rows.
    const resolved = await resolveArgs(name, { ...args, _as_of: snapshotDate(manifest) }, rows, async (text) => (await embed([text], { query: true }))[0]);
    const out = withLookupLinks(await rows(tool.sql(resolved)));
    const count = tool.count_sql ? (await rows(tool.count_sql(resolved)))[0] : undefined;
    const payload = {
      snapshot: { run_id: manifest.run_id, root_cid: manifest.root.cid },
      ...(resolved.resolved_place ? { search_center: resolved.resolved_place } : {}),
      ...(count ? { total_matches: count } : {}),
      returned_rows: out.length,
      rows: out,
    };
    return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
  } catch (e) {
    return { isError: true, content: [{ type: "text", text: String(e.message ?? e) }] };
  }
});

server.setRequestHandler(ListResourcesRequestSchema, async () => ({
  resources: [
    { uri: "travis-oracle://manifest", name: "Artifact manifest (CIDs, sizes, digests)", mimeType: "application/json" },
    { uri: "travis-oracle://run", name: "Run summary (sources, counts, limitations, deltas)", mimeType: "application/json" },
  ],
}));

server.setRequestHandler(ReadResourceRequestSchema, async (req) => {
  const { manifest, manifestCid, run } = await ensureLoaded();
  const body = req.params.uri === "travis-oracle://manifest" ? { manifest_cid: manifestCid, ...manifest } : run;
  return { contents: [{ uri: req.params.uri, mimeType: "application/json", text: JSON.stringify(body, null, 2) }] };
});

await server.connect(new StdioServerTransport());
log("ready (snapshot loads on first request)");
