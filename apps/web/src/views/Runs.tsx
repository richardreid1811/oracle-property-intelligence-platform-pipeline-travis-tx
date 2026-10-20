import { useState } from "react";
import type { AppData } from "../App";
import { fmt, when } from "../format";
import type { Manifest } from "../types";
import { verifyInBrowser } from "./Artifacts";

export default function Runs({ data }: { data: AppData }) {
  const runs = [...data.history.runs].reverse();
  const [checks, setChecks] = useState<Record<string, string>>({});

  // Prove a prior run's snapshot is still retrievable and unchanged: fetch its coverage.json by CID.
  async function checkRun(runId: string) {
    setChecks((c) => ({ ...c, [runId]: "checking…" }));
    try {
      const m = (await (await fetch(`/runs/${runId}/manifest.json`)).json()) as Manifest;
      const cov = m.objects.find((o) => o.name === "coverage.json")!;
      const r = await verifyInBrowser(cov, "https://ipfs.io");
      setChecks((c) => ({ ...c, [runId]: `${r.state === "ok" ? "✓ resolves" : "✗"} coverage.json ${cov.cid.slice(0, 14)}… via ipfs.io: ${r.detail}` }));
    } catch (e) {
      setChecks((c) => ({ ...c, [runId]: `✗ ${String((e as Error).message ?? e)}` }));
    }
  }

  return (
    <div className="stack">
      <section className="card">
        <h1>Run history</h1>
        <p className="muted small">
          Each run republishes the snapshot as new immutable CIDs; prior CIDs are never mutated or unpinned. Unchanged files (for example older permit-year
          partitions) keep their CIDs and are marked as reused.
        </p>
      </section>
      {runs.map((r, i) => (
        <section key={r.run_id} className="card">
          <div className="row-between">
            <h2>{r.run_id} {i === 0 && <span className="tag ok">latest</span>}</h2>
            <button onClick={() => checkRun(r.run_id)}>Check this snapshot still resolves</button>
          </div>
          {checks[r.run_id] && <p className="small">{checks[r.run_id]}</p>}
          <dl className="kv">
            <dt>Published</dt><dd>{when(r.published_at)}</dd>
            <dt>Root CID</dt><dd><code>{r.root_cid}</code></dd>
            <dt>Manifest CID</dt><dd><code>{r.manifest_cid ?? "—"}</code> · <a href={`/runs/${r.run_id}/manifest.json`} target="_blank" rel="noreferrer">manifest</a></dd>
            <dt>Previous run</dt><dd>{r.previous_run_id ?? "— (initial full load)"}</dd>
            <dt>Objects</dt><dd>{r.objects} listed, {r.new_objects} new in this run, {r.objects - r.new_objects} reused unchanged</dd>
          </dl>
          <table className="tbl small">
            <thead><tr><th>Count</th><th className="num">Value</th><th className="num">Δ vs previous</th></tr></thead>
            <tbody>
              {Object.entries(r.counts).map(([k, v]) => (
                <tr key={k}><td>{k}</td><td className="num">{fmt(v)}</td><td className="num">{r.previous_run_id ? (r.deltas_vs_previous[k] > 0 ? "+" : "") + fmt(r.deltas_vs_previous[k]) : "initial"}</td></tr>
              ))}
            </tbody>
          </table>
        </section>
      ))}
    </div>
  );
}
