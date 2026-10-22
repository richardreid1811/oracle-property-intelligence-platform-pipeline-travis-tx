// Content addressing and the MCP server's guards: UnixFS CIDs are deterministic under the publish
// profile (src/publish/unixfs.mjs), manifests and objects are checked by hash (mcp/guards.mjs), and
// run_sql accepts only one read-only statement and is cancelled at its deadline.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { assertDigest, guardSql, rawCidSha256, withTimeout } from "../../mcp/guards.mjs";
import { importTree } from "../src/publish/unixfs.mjs";

describe("UnixFS CID determinism (publish profile)", () => {
  let dir;
  // 600 KiB of deterministic bytes: three 256 KiB chunks, so a real DAG node, not a single leaf.
  const big = Buffer.from(Array.from({ length: 600 * 1024 }, (_, i) => (i * 31 + 7) % 251));
  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "unixfs-test-"));
    await writeFile(join(dir, "big.bin"), big);
    await writeFile(join(dir, "small.json"), '{"a":1}\n');
    await writeFile(join(dir, "copy.bin"), big);
    const changed = Buffer.from(big);
    changed[123_456] ^= 1;
    await writeFile(join(dir, "changed.bin"), changed);
  });
  after(() => rm(dir, { recursive: true, force: true }));

  const cids = async (paths) => Object.fromEntries([...(await importTree(dir, paths)).entries].map(([p, e]) => [p, e.cid.toString()]));

  test("same bytes give the same CID, across imports and file names; one flipped bit changes it", async () => {
    const a = await cids(["big.bin", "small.json", "copy.bin", "changed.bin"]);
    const b = await cids(["changed.bin", "copy.bin", "small.json", "big.bin"]);
    assert.deepEqual(a, b, "input order does not matter");
    assert.equal(a["big.bin"], a["copy.bin"]);
    assert.notEqual(a["big.bin"], a["changed.bin"]);
    assert.match(a["big.bin"], /^bafybei/, "multi-chunk file is a CIDv1 dag-pb node");
  });

  test("a single-chunk file is a raw leaf whose CID is its SHA-256 (what gateways and vendors compute)", async () => {
    const { "small.json": cid } = await cids(["small.json"]);
    const bytes = await readFile(join(dir, "small.json"));
    assert.match(cid, /^bafkrei/);
    assert.equal(rawCidSha256(cid), createHash("sha256").update(bytes).digest("hex"));
  });
});

describe("hash verification", () => {
  test("the committed latest manifest hashes to its published raw CID", async () => {
    const history = JSON.parse(await readFile(new URL("../../runs/history.json", import.meta.url), "utf8"));
    const latest = history.runs.at(-1);
    const bytes = await readFile(new URL(`../../${latest.manifest_path}`, import.meta.url));
    assert.doesNotThrow(() => assertDigest(bytes, { sha256: rawCidSha256(latest.manifest_cid) }, "manifest"));
  });

  test("mismatched bytes, sizes and non-raw CIDs are rejected", () => {
    const bytes = Buffer.from("parquet bytes");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    assert.equal(assertDigest(bytes, { sha256, size: bytes.length }, "t"), bytes);
    assert.throws(() => assertDigest(Buffer.from("tampered"), { sha256 }, "t"), /does not match/);
    assert.throws(() => assertDigest(bytes, { sha256, size: 1 }, "t"), /manifest says 1/);
    assert.throws(() => assertDigest(bytes, {}, "t"), /no sha256/);
    assert.throws(() => rawCidSha256("bafybeiayzen3k5l5v5pscptqeson7ykdp6l6hjwdui5d7tquwrr6yvl5jq"), /not a raw sha2-256 CID/);
  });
});

describe("guardSql (run_sql)", () => {
  test("a single SELECT or WITH passes and is capped at 200 rows", () => {
    assert.equal(guardSql("select 1;"), "select * from (select 1) limit 200");
    assert.match(guardSql("with x as (select 1) select * from x"), /limit 200$/);
  });

  test("writes and DDL are rejected", () => {
    for (const sql of ["insert into leads values (1)", "delete from leads", "drop table leads", "update leads set x = 1",
      "create table t as select 1", "with x as (select 1) delete from leads", "select 1 from leads; set enable_external_access = true"]) {
      assert.throws(() => guardSql(sql), Error, sql);
    }
  });

  test("multiple statements are rejected", () => {
    assert.throws(() => guardSql("select 1; select 2"), /single SELECT/);
    assert.throws(() => guardSql("select 1; drop table leads;"), /single SELECT/);
  });

  test("file and network access is rejected", () => {
    for (const sql of ["select * from read_csv('/etc/passwd')", "select * from read_parquet('https://x/y.parquet')",
      "select * from '/etc/passwd'", "select * from leads join \"s3://bucket/x.csv\" using (prop_id)", "select * from glob('/*')",
      "select * from read_text('/etc/hosts')", "select 1 from (select 1) attach 'x.db'", "select * from read_json_auto('x.json')"]) {
      assert.throws(() => guardSql(sql), Error, sql);
    }
  });
});

describe("run_sql timeout", () => {
  test("a runaway query is interrupted at the deadline", async () => {
    const { DuckDBInstance } = await import("@duckdb/node-api");
    const conn = await (await DuckDBInstance.create(":memory:")).connect();
    let interrupted = false;
    const started = Date.now();
    await assert.rejects(
      withTimeout(() => conn.runAndReadAll("select count(*) from range(10000000000) a, range(100) b where a.range * b.range = -1"), 300,
        () => { interrupted = true; conn.interrupt(); }),
      /exceeded 0.3 s/,
    );
    assert.ok(interrupted);
    assert.ok(Date.now() - started < 5000);
    conn.closeSync();
  });

  test("a fast query returns normally", async () => {
    assert.equal(await withTimeout(async () => 42, 1000), 42);
  });
});
