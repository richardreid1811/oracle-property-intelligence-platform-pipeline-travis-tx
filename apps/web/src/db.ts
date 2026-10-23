// DuckDB-WASM over IPFS: the published Parquet tables are fetched by CID from public gateways and
// queried in the browser. No Oracle-hosted database.
import * as duckdb from "@duckdb/duckdb-wasm";
import { PLACES_SQL, resolveArgs, snapshotDate, toolByName, withLookupLinks } from "@travis-oracle/query-tools";
import type { Manifest } from "./types";

// Vendor gateways serve CORS + HTTP range requests for reads; independent gateways (orbitor.dev, dget.top) verify.
// Vendor gateways first (fast, CORS + range); independent public gateways as fallbacks so the site
// keeps working if a free-tier egress quota (10 GB/month per vendor) is reached.
export const READ_GATEWAYS = ["https://ipfs.filebase.io", "https://gateway.pinata.cloud", "https://ipfs.orbitor.dev", "https://dget.top"];
const TABLES = ["leads", "roofing_permits", "contractors", "hail_events"] as const;

export type Row = Record<string, unknown>;
export type LoadStep = { table: string; cid: string; gateway: string; ms: number; rows: number };

let conn: duckdb.AsyncDuckDBConnection | null = null;
let dbRef: duckdb.AsyncDuckDB | null = null;

// Load one Parquet table by CID, trying each gateway in turn for the whole load (not just a probe), so a
// gateway that fails partway through a range read falls through to the next one. Returns the gateway used.
async function loadTable(db: duckdb.AsyncDuckDB, c: duckdb.AsyncDuckDBConnection, table: string, cid: string): Promise<string> {
  const errors: string[] = [];
  for (const [i, g] of READ_GATEWAYS.entries()) {
    const file = `${table}-${i}.parquet`;
    try {
      await db.registerFileURL(file, `${g}/ipfs/${cid}`, duckdb.DuckDBDataProtocol.HTTP, false);
      await c.query(`create or replace table ${table} as select * from read_parquet('${file}')`);
      return g;
    } catch (e) {
      errors.push(`${g}: ${e instanceof Error ? e.message.slice(0, 120) : String(e)}`);
      await db.dropFile(file).catch(() => {});
    }
  }
  throw new Error(`no gateway could serve ${table} (${cid}): ${errors.join("; ")}`);
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
    const gateway = await loadTable(db, conn, table, obj.cid);
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
    await loadTable(dbRef!, conn!, "permit_embeddings", obj.cid);
  })().catch((e) => {
    embeddingsReady = null; // a failed load is retried on the next search, not cached
    throw e;
  });
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
  // Durations (days open, years since deed) are measured to the snapshot date, so one snapshot always
  // gives the same rows (and the agent's cached answers stay valid) instead of shifting daily.
  const args = await resolveArgs(name, { ...rawArgs, _as_of: snapshotDate(manifestRef) }, query, tool.needs_embedding ? embedQuery : undefined);
  const sql = tool.sql(args);
  const rows = withLookupLinks(await query(sql));
  const count = tool.count_sql ? (await query(tool.count_sql(args)))[0] : undefined;
  return { rows, count, sql, resolved: args.resolved_place as Row | undefined };
}
