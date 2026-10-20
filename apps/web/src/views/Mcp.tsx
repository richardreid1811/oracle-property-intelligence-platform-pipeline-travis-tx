import { mcpTools } from "@travis-oracle/query-tools";
import { useMemo, useState } from "react";
import type { AppData } from "../App";
import { query, runTool, type Row } from "../db";

const REPO = "https://github.com/richardreid1811/oracle-property-intelligence-platform-pipeline-travis-tx";

export default function Mcp({ data }: { data: AppData }) {
  const tools = useMemo(() => mcpTools(), []);
  const [tool, setTool] = useState(tools[1].name);
  const [args, setArgs] = useState('{"latitude": 30.2672, "longitude": -97.7431, "radius_miles": 2, "limit": 10}');
  const [sql, setSql] = useState("select roof_age_basis, roof_age_confidence, count(*) as properties\nfrom leads group by all order by properties desc");
  const [out, setOut] = useState<{ rows: Row[]; sql?: string; error?: string } | null>(null);
  const [sqlOut, setSqlOut] = useState<{ rows: Row[]; error?: string } | null>(null);

  async function call() {
    try {
      const r = await runTool(tool, JSON.parse(args));
      setOut(r);
    } catch (e) {
      setOut({ rows: [], error: String((e as Error).message ?? e) });
    }
  }
  async function runSql() {
    try {
      setSqlOut({ rows: await query(sql) });
    } catch (e) {
      setSqlOut({ rows: [], error: String((e as Error).message ?? e) });
    }
  }

  const config = JSON.stringify(
    { mcpServers: { "travis-oracle": { command: "npx", args: ["-y", `github:richardreid1811/oracle-property-intelligence-platform-pipeline-travis-tx#travis-pipeline`, "travis-oracle-mcp"] } } },
    null,
    2,
  );

  return (
    <div className="stack">
      <section className="card">
        <h1>MCP interface</h1>
        <p className="small">
          The same tool definitions power this UI, the agent and an MCP server (stdio, <code>mcp/</code> in the{" "}
          <a href={REPO} target="_blank" rel="noreferrer">repository</a>). The server loads the snapshot by CID from IPFS into DuckDB, so agents and the roofing CRM
          query the same data model with no hosted database. Add it to an MCP client:
        </p>
        <pre>{config}</pre>
      </section>
      <section className="grid-2">
        <div className="card">
          <h2>tools/list ({tools.length})</h2>
          <div className="scroll"><pre className="small">{JSON.stringify(tools, null, 2)}</pre></div>
        </div>
        <div className="card">
          <h2>tools/call (runs in this browser)</h2>
          <label>Tool
            <select value={tool} onChange={(e) => setTool(e.target.value)}>{tools.map((t) => <option key={t.name}>{t.name}</option>)}</select>
          </label>
          <label>Arguments (JSON)<textarea rows={4} value={args} onChange={(e) => setArgs(e.target.value)} /></label>
          <button className="primary" onClick={call} disabled={!data.dbReady}>Call</button>
          {out?.error && <div className="error">{out.error}</div>}
          {out && !out.error && <div className="scroll"><pre className="small">{JSON.stringify(out.rows.slice(0, 20), null, 2)}</pre></div>}
        </div>
      </section>
      <section className="card">
        <h2>SQL console (DuckDB-WASM)</h2>
        <p className="muted small">Tables: leads, roofing_permits, contractors, places. Read-only snapshot loaded from IPFS.</p>
        <textarea rows={4} value={sql} onChange={(e) => setSql(e.target.value)} className="mono" />
        <button className="primary" onClick={runSql} disabled={!data.dbReady}>Run</button>
        {sqlOut?.error && <div className="error">{sqlOut.error}</div>}
        {sqlOut && !sqlOut.error && (
          <div className="scroll">
            <table className="tbl">
              <thead><tr>{Object.keys(sqlOut.rows[0] ?? {}).map((k) => <th key={k}>{k}</th>)}</tr></thead>
              <tbody>{sqlOut.rows.slice(0, 200).map((r, i) => <tr key={i}>{Object.values(r).map((v, j) => <td key={j}>{typeof v === "object" ? JSON.stringify(v) : String(v ?? "")}</td>)}</tr>)}</tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
