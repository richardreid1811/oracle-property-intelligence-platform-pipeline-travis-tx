import { useEffect, useState } from "react";
import { initDb, READ_GATEWAYS, type LoadStep } from "./db";
import type { GatewayReport, History, Manifest, RunSummary } from "./types";
import Overview from "./views/Overview";
import MapView from "./views/MapView";
import Agent from "./views/Agent";
import Artifacts from "./views/Artifacts";
import Runs from "./views/Runs";
import Mcp from "./views/Mcp";

const TABS = [
  ["overview", "Run summary"],
  ["map", "Map search"],
  ["agent", "Agent"],
  ["artifacts", "IPFS artifacts"],
  ["runs", "Run history"],
  ["mcp", "MCP & SQL"],
] as const;
type Tab = (typeof TABS)[number][0];

export type AppData = {
  history: History;
  manifest: Manifest;
  run: RunSummary | null;
  runSource: string | null;
  verification: GatewayReport | null;
  steps: LoadStep[];
  dbReady: boolean;
  dbError: string | null;
};

async function fetchJson<T>(url: string): Promise<T | null> {
  try {
    const r = await fetch(url);
    return r.ok ? ((await r.json()) as T) : null;
  } catch {
    return null;
  }
}

export default function App() {
  const [tab, setTab] = useState<Tab>(() => (location.hash.slice(1) as Tab) || "overview");
  const [data, setData] = useState<AppData | null>(null);
  const [fatal, setFatal] = useState<string | null>(null);

  useEffect(() => {
    const onHash = () => setTab((location.hash.slice(1) as Tab) || "overview");
    addEventListener("hashchange", onHash);
    return () => removeEventListener("hashchange", onHash);
  }, []);

  useEffect(() => {
    (async () => {
      const history = await fetchJson<History>("/runs/history.json");
      if (!history?.runs.length) throw new Error("run history not found");
      const latest = history.runs.at(-1)!;
      const manifest = await fetchJson<Manifest>(`/runs/${latest.run_id}/manifest.json`);
      if (!manifest) throw new Error("manifest not found");
      const verification = await fetchJson<GatewayReport>(`/runs/${latest.run_id}/gateway-verification.json`);
      // run.json is read from IPFS by path under the run root CID, not from this site.
      let run: RunSummary | null = null;
      let runSource: string | null = null;
      for (const g of READ_GATEWAYS) {
        run = await fetchJson<RunSummary>(`${g}/ipfs/${manifest.root.cid}/run.json`);
        if (run) {
          runSource = `${g}/ipfs/${manifest.root.cid}/run.json`;
          break;
        }
      }
      const base: AppData = { history, manifest, run, runSource, verification, steps: [], dbReady: false, dbError: null };
      setData(base);
      try {
        await initDb(manifest, (s) => setData((d) => (d ? { ...d, steps: [...d.steps, s] } : d)));
        setData((d) => (d ? { ...d, dbReady: true } : d));
      } catch (err) {
        setData((d) => (d ? { ...d, dbError: String((err as Error).message ?? err) } : d));
      }
    })().catch((err) => setFatal(String(err?.message ?? err)));
  }, []);

  return (
    <div className="app">
      <header className="top">
        <div className="brand">
          <strong>Travis Oracle</strong>
          <span className="muted">Travis County, TX · property &amp; roofing-lead intelligence</span>
        </div>
        <nav>
          {TABS.map(([key, label]) => (
            <a key={key} href={`#${key}`} className={tab === key ? "active" : ""}>
              {label}
            </a>
          ))}
        </nav>
        <div className={`db-pill ${data?.dbReady ? "ok" : data?.dbError ? "bad" : ""}`}>
          {data?.dbReady ? "DuckDB ready" : data?.dbError ? "DuckDB error" : "Loading data from IPFS…"}
        </div>
      </header>
      <main>
        {fatal && <div className="error">Failed to load: {fatal}</div>}
        {!data && !fatal && <div className="loading">Loading run history…</div>}
        {data && tab === "overview" && <Overview data={data} />}
        {data && tab === "map" && <MapView data={data} />}
        {data && tab === "agent" && <Agent data={data} />}
        {data && tab === "artifacts" && <Artifacts data={data} />}
        {data && tab === "runs" && <Runs data={data} />}
        {data && tab === "mcp" && <Mcp data={data} />}
      </main>
      <footer className="muted">
        Data: TCAD 2026 certified roll, City of Austin permits, Texas Comptroller, TDLR, US Census. Published as CIDv1 snapshots on IPFS; this
        site holds no database. Root <code>{data?.manifest.root.cid ?? "…"}</code>
      </footer>
    </div>
  );
}
