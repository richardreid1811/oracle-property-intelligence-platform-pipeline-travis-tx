#!/usr/bin/env node
// Build `permit_embeddings` for semantic retrieval over roofing permits.
// Each document is the permit's work description plus work class, status, contractor, address and
// year. Vectors come from the shared embedder (packages/query-tools/embed.mjs), are int8-quantized,
// and keyed by permit_key with the SHA-256 of the exact text embedded. With --prev-dir, vectors
// whose text is unchanged are reused, so incremental runs only embed new or edited permits and
// unchanged vectors keep identical bytes (and CIDs).
// Usage: node src/build/embeddings.mjs <county.duckdb> [--prev-dir <run-dir>]
import { DuckDBInstance } from "@duckdb/node-api";
import { EMBED_DIMS, EMBED_MODEL, embed, quantize } from "@travis-oracle/query-tools/embed.mjs";
import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { lit } from "./permit-sql.mjs";

const [dbPath, ...rest] = process.argv.slice(2);
const prevDir = rest.includes("--prev-dir") ? rest[rest.indexOf("--prev-dir") + 1] : null;
if (!dbPath) {
  console.error("usage: embeddings.mjs <county.duckdb> [--prev-dir <run-dir>]");
  process.exit(2);
}
const BATCH = 128;
const db = await DuckDBInstance.create(dbPath);
const c = await db.connect();
const t0 = Date.now();

await c.run(`
create or replace temp table docs as
select permit_key,
       -- Long free-text descriptions are capped; the model reads at most 512 tokens anyway.
       concat_ws(' | ', left(description, 600), work_class, permit_class, 'status ' || status,
                 case when contractor_company_name is not null then 'contractor ' || contractor_company_name end,
                 address, city, cast(year(opened_date) as varchar)) as doc
from permits where roofing_work is not null;
alter table docs add column text_sha256 varchar;
update docs set text_sha256 = sha256(doc);`);

const prevFile = prevDir ? join(prevDir, "tables/permit_embeddings.parquet") : null;
if (prevFile && existsSync(prevFile)) {
  await c.run(`create or replace temp table prev as select * from read_parquet(${lit(prevFile)}) where model = ${lit(EMBED_MODEL)}`);
} else {
  await c.run(`create or replace temp table prev (permit_key varchar, text_sha256 varchar, model varchar, embedding TINYINT[${EMBED_DIMS}])`);
}
const todo = (await c.runAndReadAll(`
  select d.permit_key, d.doc, d.text_sha256 from docs d
  left join prev p on p.permit_key = d.permit_key and p.text_sha256 = d.text_sha256
  where p.permit_key is null
  -- Similar-length batches avoid padding every batch to its longest document.
  order by length(d.doc), d.permit_key`)).getRowObjectsJson();
const total = Number((await c.runAndReadAll("select count(*) as n from docs")).getRowObjectsJson()[0].n);
console.error(`${total} roofing permits; ${total - todo.length} reused; ${todo.length} to embed`);

// New vectors go through a temp NDJSON file into DuckDB (fast bulk load of fixed-size arrays).
const tmp = join(dirname(dbPath), `embeddings-${process.pid}.ndjson`);
await mkdir(dirname(tmp), { recursive: true });
const lines = [];
for (let i = 0; i < todo.length; i += BATCH) {
  const batch = todo.slice(i, i + BATCH);
  const vecs = await embed(batch.map((r) => r.doc));
  batch.forEach((r, j) => lines.push(JSON.stringify({ permit_key: r.permit_key, text_sha256: r.text_sha256, embedding: quantize(vecs[j]) })));
  if (i % (BATCH * 20) === 0) process.stderr.write(`\rembedded ${Math.min(i + BATCH, todo.length)}/${todo.length}`);
}
process.stderr.write("\n");
await writeFile(tmp, lines.join("\n") + (lines.length ? "\n" : ""));

await c.run(`
create or replace table permit_embeddings as
with fresh as (
  ${lines.length
    ? `select permit_key, text_sha256, ${lit(EMBED_MODEL)} as model, embedding::TINYINT[${EMBED_DIMS}] as embedding
       from read_json(${lit(tmp)}, format='newline_delimited', columns={permit_key:'VARCHAR', text_sha256:'VARCHAR', embedding:'TINYINT[]'})`
    : `select * from prev where false`}
),
kept as (
  select p.* from prev p join docs d on d.permit_key = p.permit_key and d.text_sha256 = p.text_sha256
)
select * from kept union all select * from fresh
order by permit_key`);
await rm(tmp, { force: true });

const n = Number((await c.runAndReadAll("select count(*) as n from permit_embeddings")).getRowObjectsJson()[0].n);
if (n !== total) throw new Error(`embedding count ${n} != roofing permits ${total}`);
console.log(JSON.stringify({ model: EMBED_MODEL, dims: EMBED_DIMS, documents: total, reused: total - todo.length, embedded: todo.length, seconds: Math.round((Date.now() - t0) / 1000) }));
