// DuckDB-WASM over IPFS: the published Parquet tables are fetched by CID from public gateways and
// queried in the browser. No Oracle-hosted database.
import * as duckdb from "@duckdb/duckdb-wasm";
import { PLACES_SQL, resolveArgs, toolByName, withLookupLinks } from "@travis-oracle/query-tools";
import type { Manifest } from "./types";

// Vendor gateways serve CORS + HTTP range requests for reads; independent gateways (orbitor.dev, dget.top) verify.
// Vendor gateways first (fast, CORS + range); independent public gateways as fallbacks so the site
// keeps working if a free-tier egress quota (10 GB/month per vendor) is reached.
export const READ_GATEWAYS = ["https://ipfs.filebase.io", "https://gateway.pinata.cloud", "https://ipfs.orbitor.dev", "https://dget.top"];
const TABLES = ["leads", "roofing_permits", "contractors"] as const;

export type Row = Record<string, unknown>;
export type LoadStep = { table: string; cid: string; gateway: string; ms: number; rows: number };

let conn: duckdb.AsyncDuckDBConnection | null = null;
let dbRef: duckdb.AsyncDuckDB | null = null;

async function pickGateway(cid: string): Promise<string> {
  for (const g of READ_GATEWAYS) {
    try {
      const res = await fetch(`${g}/ipfs/${cid}`, { headers: { Range: "bytes=0-3" } });
      if (res.ok) return g;
    } catch {
      /* try next gateway */
    }
  }
  throw new Error(`no gateway could serve ${cid}`);
}

export async function initDb(manifest: Manifest, onStep: (s: LoadStep) => void): Promise<void> {
  const bundle = await duckdb.selectBundle(duckdb.getJsDelivrBundles());
  const workerUrl = URL.createObjectURL(new Blob([`importScripts("${bundle.mainWorker}");`], { type: "text/javascript" }));
  const db = new duckdb.AsyncDuckDB(new duckdb.ConsoleLogger(duckdb.LogLevel.WARNING), new Worker(workerUrl));
  await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
  dbRef = db;
  manifestRef = manifest;
  URL.revokeObjectURL(workerUrl);
  conn = await db.connect();
  for (const table of TABLES) {
    const obj = manifest.objects.find((o) => o.name === `tables/${table}.parquet`);
    if (!obj) throw new Error(`manifest has no tables/${table}.parquet`);
    const started = performance.now();
    const gateway = await pickGateway(obj.cid);
    await db.registerFileURL(`${table}.parquet`, `${gateway}/ipfs/${obj.cid}`, duckdb.DuckDBDataProtocol.HTTP, false);
    await conn.query(`create or replace table ${table} as select * from read_parquet('${table}.parquet')`);
    const rows = Number((await query(`select count(*) as n from ${table}`))[0].n);
    onStep({ table, cid: obj.cid, gateway, ms: Math.round(performance.now() - started), rows });
  }
  await conn.query(PLACES_SQL);
}

const plain = (v: unknown): unknown => {
  if (typeof v === "bigint") return Number(v);
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (Array.isArray(v)) return v.map(plain);
  if (v && typeof v === "object" && "toJSON" in v && typeof (v as { toJSON: unknown }).toJSON === "function") {
    return plain((v as { toJSON: () => unknown }).toJSON());
  }
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, plain(x)]));
  return v;
};

export async function query(sql: string): Promise<Row[]> {
  if (!conn) throw new Error("database not ready");
  const table = await conn.query(sql);
  const dateCols = new Set(table.schema.fields.filter((f) => String(f.type).startsWith("Date")).map((f) => f.name));
  return table.toArray().map((r) => {
    const obj = plain(r.toJSON()) as Row;
    for (const c of dateCols) if (typeof obj[c] === "number") obj[c] = new Date(obj[c] as number).toISOString().slice(0, 10);
    return obj;
  });
}

// Semantic retrieval: the embedding table and the model are loaded only on first use.
let embeddingsReady: Promise<void> | null = null;
let manifestRef: Manifest | null = null;
async function ensureEmbeddings() {
  embeddingsReady ??= (async () => {
    const obj = manifestRef?.objects.find((o) => o.name === "tables/permit_embeddings.parquet");
    if (!obj) throw new Error("this snapshot has no permit embeddings yet");
    const gateway = await pickGateway(obj.cid);
    await dbRef!.registerFileURL("permit_embeddings.parquet", `${gateway}/ipfs/${obj.cid}`, duckdb.DuckDBDataProtocol.HTTP, false);
    await conn!.query("create or replace table permit_embeddings as select * from read_parquet('permit_embeddings.parquet')");
  })();
  return embeddingsReady;
}
async function embedQuery(text: string): Promise<Float32Array> {
  const { embed } = await import("@travis-oracle/query-tools/embed.mjs");
  return (await embed([text], { query: true }))[0];
}

export async function runTool(
  name: string,
  rawArgs: Record<string, unknown>,
): Promise<{ rows: Row[]; count?: Row; sql: string; resolved?: Row }> {
  const tool = toolByName[name];
  if (!tool) throw new Error(`unknown tool ${name}`);
  if (tool.needs_embedding) await ensureEmbeddings();
  const args = await resolveArgs(name, rawArgs, query, tool.needs_embedding ? embedQuery : undefined);
  const sql = tool.sql(args);
  const rows = withLookupLinks(await query(sql));
  const count = tool.count_sql ? (await query(tool.count_sql(args)))[0] : undefined;
  return { rows, count, sql, resolved: args.resolved_place as Row | undefined };
}
