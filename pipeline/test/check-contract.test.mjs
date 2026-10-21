// check-contract.mjs against a tiny snapshot: one Parquet table written by DuckDB and a two-section
// contract (one table present, one absent). Passes when columns and types match; fails on drift.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { duck } from "./duck.mjs";

const script = fileURLToPath(new URL("../src/publish/check-contract.mjs", import.meta.url));
let dir;

before(async () => {
  dir = await mkdtemp(join(tmpdir(), "contract-"));
  await mkdir(join(dir, "tables"));
  const db = await duck();
  await db.run(`copy (select '1'::varchar as prop_id, 1990::integer as roof_year, 35::bigint as n, date '2020-01-01' as d, ['a']::varchar[] as tags)
    to '${join(dir, "tables", "roof_age.parquet")}' (format parquet)`);
  db.close();
});
after(() => rm(dir, { recursive: true, force: true }));

const contract = (rows) => `# Data contract

### roof_age

| Column | Type | Meaning |
|---|---|---|
${rows.map(([c, t]) => `| \`${c}\` | ${t} | test |`).join("\n")}

### owners

| \`owner_key\` | VARCHAR | not in this snapshot |
`;

const check = async (rows) => {
  const md = join(dir, `contract-${Math.random().toString(36).slice(2)}.md`);
  await writeFile(md, contract(rows));
  return spawnSync(process.execPath, [script, join(dir, "tables"), md], { encoding: "utf8" });
};

const GOOD = [["prop_id", "VARCHAR"], ["roof_year", "INTEGER"], ["n", "BIGINT"], ["d", "DATE"], ["tags", "VARCHAR[]"]];

test("passes when documented columns and types equal the Parquet schema", async () => {
  const r = await check(GOOD);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /OK {3}roof_age: 5 columns/);
  assert.match(r.stdout, /SKIP owners: not in this snapshot/);
});

test("fails on undocumented, absent and mistyped columns", async () => {
  const r = await check([["prop_id", "VARCHAR"], ["roof_year", "BIGINT"], ["d", "DATE"], ["tags", "VARCHAR[]"], ["ghost", "VARCHAR"]]);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /FAIL roof_age/);
  assert.match(r.stdout, /undocumented: n/);
  assert.match(r.stdout, /documented but absent: ghost/);
  assert.match(r.stdout, /type mismatch: roof_year \(BIGINT != INTEGER\)/);
});
