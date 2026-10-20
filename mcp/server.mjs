#!/usr/bin/env node
// Travis Oracle MCP server (stdio).
// Loads the published snapshot by CID from public IPFS gateways into an in-process DuckDB and serves
// the shared roofing-lead tools (packages/query-tools) plus a read-only SQL tool. No hosted database.
//
// Snapshot selection (first match wins):
//   TRAVIS_ORACLE_MANIFEST_CID  pin an exact run manifest by CID
//   TRAVIS_ORACLE_HISTORY_URL   run history JSON (default: runs/history.json in the GitHub repo)
// Gateways: TRAVIS_ORACLE_GATEWAYS (comma-separated; default Filebase, Pinata, orbitor.dev, dget.top).
import { DuckDBInstance } from "@duckdb/node-api";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { mcpTools, PLACES_SQL, resolveArgs, toolByName, withLookupLinks } from "@travis-oracle/query-tools";

const HISTORY_URL =
  process.env.TRAVIS_ORACLE_HISTORY_URL ??
  "https://raw.githubusercontent.com/richardreid1811/oracle-property-intelligence-platform-pipeline-travis-tx/travis-pipeline/runs/history.json";
const GATEWAYS = (process.env.TRAVIS_ORACLE_GATEWAYS ?? "https://ipfs.filebase.io,https://gateway.pinata.cloud,https://ipfs.orbitor.dev,https://dget.top").split(",");
const TABLES = ["leads", "roofing_permits", "contractors"];
const log = (...a) => console.error("[travis-oracle-mcp]", ...a); // stdout is the MCP channel

async function getJson(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}
async function byCid(cid) {
  let last;
  for (const g of GATEWAYS) {
    try {
      return { url: `${g}/ipfs/${cid}`, json: await getJson(`${g}/ipfs/${cid}`) };
    } catch (e) {
      last = e;
    }
  }
  throw last;
}

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
    const { json: manifest } = await byCid(manifestCid);
    log(`snapshot ${manifest.run_id} root ${manifest.root.cid}`);
    const db = await DuckDBInstance.create(":memory:");
    const conn = await db.connect();
    await conn.run("install httpfs; load httpfs");
    for (const t of TABLES) {
      const obj = manifest.objects.find((o) => o.name === `tables/${t}.parquet`);
      let done = false;
      for (const g of GATEWAYS) {
        try {
          await conn.run(`create or replace table ${t} as select * from read_parquet('${g}/ipfs/${obj.cid}')`);
          log(`loaded ${t} (${obj.cid}) via ${g}`);
          done = true;
          break;
        } catch (e) {
          log(`gateway ${g} failed for ${t}: ${e.message}`);
        }
      }
      if (!done) throw new Error(`could not load ${t} from any gateway`);
    }
    await conn.run(PLACES_SQL);
    let run = null;
    try {
      run = (await byCid(`${manifest.root.cid}/run.json`)).json;
    } catch {
      /* run summary is optional */
    }
    state = { conn, manifest, manifestCid, run };
    return state;
  })();
  return loading;
}

const rows = async (sql) => (await (await ensureLoaded()).conn.runAndReadAll(sql)).getRowObjectsJson();

// Read-only SQL for agents that need ad-hoc questions: a single SELECT/WITH statement.
const SQL_TOOL = {
  name: "run_sql",
  description: "Run one read-only SQL SELECT (DuckDB dialect) over tables leads, roofing_permits, contractors, places. Returns at most 200 rows.",
  inputSchema: { type: "object", properties: { sql: { type: "string" } }, required: ["sql"] },
};
function guardSql(sql) {
  const s = String(sql ?? "").trim().replace(/;+\s*$/, "");
  if (!/^(select|with)\b/i.test(s) || s.includes(";")) throw new Error("only a single SELECT/WITH statement is allowed");
  if (/\b(attach|copy|install|load|pragma|create|insert|update|delete|drop|alter|export|import|read_csv|read_json|read_parquet|read_text|glob)\b/i.test(s)) {
    throw new Error("statement uses a disallowed keyword or function");
  }
  return `select * from (${s}) limit 200`;
}

const server = new Server({ name: "travis-oracle", version: "0.1.0" }, { capabilities: { tools: {}, resources: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [...mcpTools(), SQL_TOOL] }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args = {} } = req.params;
  try {
    if (name === "run_sql") {
      const out = await rows(guardSql(args.sql));
      return { content: [{ type: "text", text: JSON.stringify({ rows: out }, null, 2) }] };
    }
    const tool = toolByName[name];
    if (!tool) throw new Error(`unknown tool ${name}`);
    const resolved = await resolveArgs(name, args, rows);
    const out = withLookupLinks(await rows(tool.sql(resolved)));
    const count = tool.count_sql ? (await rows(tool.count_sql(resolved)))[0] : undefined;
    const { manifest } = await ensureLoaded();
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
