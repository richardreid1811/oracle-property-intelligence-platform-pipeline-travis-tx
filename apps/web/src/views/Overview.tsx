import type { AppData } from "../App";
import { fmt, shortCid, when } from "../format";

const COUNT_LABELS: [string, string][] = [
  ["properties", "Properties (assessed parcels)"],
  ["properties_with_coordinates", "Properties with coordinates"],
  ["permits", "Permits (City of Austin)"],
  ["permits_linked_to_parcel", "Permits linked to a parcel"],
  ["roofing_permits", "Roofing permits"],
  ["roofing_permits_open_or_unfinaled", "Roofing permits open / never finaled"],
  ["contractors", "Contractors (deduplicated)"],
  ["contractors_resolved", "Contractors resolved to TX registry"],
  ["contractors_with_bbb", "Contractors with BBB rating"],
  ["businesses", "Businesses (Travis County)"],
  ["licenses", "TDLR contractor licenses"],
  ["roof_15y_plus", "Roofs 15+ years old"],
  ["owners", "Owner entities (reconciled across properties)"],
  ["multi_property_owners", "Owners with multiple properties"],
  ["deed_over_10y", "No ownership change in 10+ years"],
  ["owner_out_of_state", "Out-of-state / international owners"],
];

function receiptLine(r: Record<string, unknown> | null): string {
  if (!r) return "no receipt";
  const parts: string[] = [];
  const n = r.written ?? r.features ?? (r.members ? Object.keys(r.members as object).length + " files" : undefined);
  if (n !== undefined) parts.push(`${fmt(n)} records`);
  if (r.reported !== undefined) parts.push(`source reported ${fmt(r.reported)}`);
  const at = r.fetched_at ?? r.extracted_at ?? r.observed_at;
  if (at) parts.push(when(String(at)));
  const digest = r.zip_sha256 ?? r.sha256;
  if (digest) parts.push(`sha256 ${String(digest).slice(0, 12)}…`);
  if (!parts.length && r.url) parts.push(String(r.url).replace(/^https?:\/\//, "").slice(0, 60));
  if (r.status) parts.push(`HTTP ${r.status}`);
  return parts.join(" · ");
}

export default function Overview({ data }: { data: AppData }) {
  const { manifest, run, history, steps, verification } = data;
  const latest = history.runs.at(-1)!;
  return (
    <div className="stack">
      <section className="card">
        <div className="row-between">
          <div>
            <h1>Pipeline run {manifest.run_id}</h1>
            <p className="muted">
              Published {when(manifest.created_at)} · {history.runs.length} run{history.runs.length === 1 ? "" : "s"} in history · mode{" "}
              {run?.mode ?? "?"}
            </p>
          </div>
          <div className={`badge ${verification?.all_ok ? "ok" : verification ? "bad" : ""}`}>
            {verification
              ? verification.all_ok
                ? `Verified on ${verification.gateways.map((g) => new URL(g).host).join(" + ")}`
                : `${verification.failures} gateway failures`
              : "Gateway verification pending"}
          </div>
        </div>
        <dl className="kv">
          <dt>Root CID</dt>
          <dd><code>{manifest.root.cid}</code></dd>
          <dt>Manifest CID</dt>
          <dd><code>{latest.manifest_cid ?? "—"}</code></dd>
          <dt>Run summary</dt>
          <dd>{data.runSource ? <a href={data.runSource} target="_blank" rel="noreferrer">run.json read from IPFS by path under the root CID</a> : "not reachable"}</dd>
        </dl>
      </section>

      <section className="grid-2">
        <div className="card">
          <h2>Records by dataset</h2>
          <table className="tbl">
            <tbody>
              {COUNT_LABELS.map(([k, label]) => (
                <tr key={k}>
                  <td>{label}</td>
                  <td className="num">{fmt(manifest.counts[k])}</td>
                  <td className="num muted">{!latest.previous_run_id ? "initial" : latest.deltas_vs_previous?.[k] ? (latest.deltas_vs_previous[k] > 0 ? "+" : "") + fmt(latest.deltas_vs_previous[k]) : "0"}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="muted small">Third column: change versus the previous run.</p>
        </div>
        <div className="card">
          <h2>DuckDB query layer (in this browser)</h2>
          <p className="muted small">Tables are fetched by CID from public IPFS gateways and queried locally with DuckDB-WASM. No Oracle-hosted database.</p>
          <table className="tbl">
            <thead><tr><th>Table</th><th className="num">Rows</th><th>CID</th><th>Gateway</th><th className="num">Load</th></tr></thead>
            <tbody>
              {steps.map((s) => (
                <tr key={s.table}>
                  <td>{s.table}</td>
                  <td className="num">{fmt(s.rows)}</td>
                  <td><code title={s.cid}>{shortCid(s.cid)}</code></td>
                  <td>{new URL(s.gateway).host}</td>
                  <td className="num">{(s.ms / 1000).toFixed(1)}s</td>
                </tr>
              ))}
              {!data.dbReady && !data.dbError && <tr><td colSpan={5} className="muted">Loading…</td></tr>}
              {data.dbError && <tr><td colSpan={5} className="error">{data.dbError}</td></tr>}
            </tbody>
          </table>
        </div>
      </section>

      <section className="card">
        <h2>Sources and provenance</h2>
        <table className="tbl">
          <thead><tr><th>Source</th><th>Mode</th><th>Snapshot</th></tr></thead>
          <tbody>
            {(run?.sources ?? []).map((s) => (
              <tr key={s.key}>
                <td>{s.name}</td>
                <td><span className={`tag ${s.kind === "blocked" ? "bad" : ""}`}>{s.kind}</span></td>
                <td className="small">{receiptLine(s.receipt)}{(s as { carried_from?: string }).carried_from ? <span className="muted"> · carried from run {(s as { carried_from?: string }).carried_from}</span> : null}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="card">
        <h2>Source limitations</h2>
        <ul className="limits">{(run?.limitations ?? []).map((l, i) => <li key={i}>{l}</li>)}</ul>
      </section>
    </div>
  );
}
