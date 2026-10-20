import { useState } from "react";
import type { AppData } from "../App";
import { bytes, shortCid, when } from "../format";
import type { ManifestObject } from "../types";

const VERIFY_GATEWAYS = ["https://ipfs.io", "https://dweb.link"];
type Check = { state: "running" | "ok" | "bad"; detail: string };

async function sha256Hex(buf: ArrayBuffer) {
  const d = await crypto.subtle.digest("SHA-256", buf);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function verifyInBrowser(o: ManifestObject, gateway: string): Promise<Check> {
  const started = performance.now();
  const res = await fetch(`${gateway}/ipfs/${o.cid}`, { cache: "no-store" });
  if (!res.ok) return { state: "bad", detail: `HTTP ${res.status}` };
  const buf = await res.arrayBuffer();
  const digest = await sha256Hex(buf);
  const ok = buf.byteLength === o.size && digest === o.sha256;
  const secs = ((performance.now() - started) / 1000).toFixed(1);
  return { state: ok ? "ok" : "bad", detail: ok ? `${bytes(buf.byteLength)}, sha256 match, ${secs}s` : `got ${buf.byteLength} B sha256 ${digest.slice(0, 12)}…` };
}

export default function Artifacts({ data }: { data: AppData }) {
  const { manifest, verification } = data;
  const [checks, setChecks] = useState<Record<string, Check>>({});
  const [showAll, setShowAll] = useState(false);

  async function check(o: ManifestObject) {
    for (const g of VERIFY_GATEWAYS) {
      const key = `${o.cid}|${g}`;
      setChecks((c) => ({ ...c, [key]: { state: "running", detail: "fetching…" } }));
      try {
        const r = await verifyInBrowser(o, g);
        setChecks((c) => ({ ...c, [key]: r }));
      } catch (e) {
        setChecks((c) => ({ ...c, [key]: { state: "bad", detail: String((e as Error).message ?? e) } }));
      }
    }
  }

  const dirs = manifest.objects.filter((o) => o.codec === "directory");
  const files = manifest.objects.filter((o) => o.codec === "file");
  const shown = showAll ? files : files.filter((o) => !o.name.startsWith("tables/permits/"));
  const ci = (cid: string) => verification?.results.find((r) => r.cid === cid);

  return (
    <div className="stack">
      <section className="card">
        <div className="row-between">
          <h1>Artifact manifest · run {manifest.run_id}</h1>
          <a href={`${data.runsBase}/${manifest.run_id}/manifest.json`} target="_blank" rel="noreferrer">manifest.json</a>
        </div>
        <p className="muted small">
          CIDs are the durable identity (CIDv1, base32; {manifest.unixfs_profile}). Gateway URLs are derived from CIDs. Files are pinned on Filebase and
          Pinata; directory roots are pinned on Filebase and published as CARs that any IPFS node can import.
          IPNS: {manifest.ipns ? <code>{manifest.ipns.name} → {manifest.ipns.resolved_cid}</code> : "not used for this run (CIDs and run history are the pointers)"}.
        </p>
        {verification && (
          <p className={`small ${verification.all_ok ? "ok-text" : "error"}`}>
            Independent verification ({verification.verifier}, {when(verification.verified_at)}): {verification.objects} objects on{" "}
            {verification.gateways.map((g) => new URL(g).host).join(" and ")} — {verification.all_ok ? "all bytes match the manifest" : `${verification.failures} failures`}.
          </p>
        )}
      </section>

      <section className="card">
        <h2>Directory roots</h2>
        <table className="tbl">
          <thead><tr><th>Name</th><th>CID</th><th className="num">Size</th><th>CAR (sha256)</th><th>CI check</th></tr></thead>
          <tbody>
            {dirs.map((o) => (
              <tr key={o.cid}>
                <td>{o.name}</td>
                <td><code title={o.cid}>{o.cid}</code></td>
                <td className="num">{bytes(o.size)}</td>
                <td className="small"><a href={o.car?.release_asset} target="_blank" rel="noreferrer">{o.car?.file.split("/").pop()}</a> {o.car && bytes(o.car.bytes)} · {o.car?.sha256.slice(0, 12)}… · {o.car?.blocks} blocks</td>
                <td className="small">{ci(o.cid) ? Object.entries(ci(o.cid)!.gateways).map(([g, r]) => <span key={g} className={`tag ${r.ok ? "ok" : "bad"}`}>{new URL(g).host} {r.ok ? "✓" : "✗"}</span>) : "pending"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="card">
        <div className="row-between">
          <h2>Files ({files.length})</h2>
          <label className="small"><input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} /> show all {files.filter((o) => o.name.startsWith("tables/permits/")).length} permit partitions</label>
        </div>
        <div className="scroll">
          <table className="tbl">
            <thead><tr><th>Name</th><th>CID</th><th className="num">Size</th><th>sha256</th><th>Pins</th><th>CI check</th><th>Verify in this browser</th></tr></thead>
            <tbody>
              {shown.map((o) => (
                <tr key={o.cid}>
                  <td>{o.name}{o.reused_from_previous_run && <span className="tag">unchanged</span>}</td>
                  <td><a href={o.gateway_urls[0]} target="_blank" rel="noreferrer"><code title={o.cid}>{shortCid(o.cid)}</code></a></td>
                  <td className="num">{bytes(o.size)}</td>
                  <td><code className="small">{o.sha256?.slice(0, 12)}…</code></td>
                  <td className="small">{o.pins.map((p) => p.provider).join(", ")}</td>
                  <td className="small">{ci(o.cid) ? Object.entries(ci(o.cid)!.gateways).map(([g, r]) => <span key={g} className={`tag ${r.ok ? "ok" : "bad"}`}>{new URL(g).host} {r.ok ? "✓" : "✗"}</span>) : "pending"}</td>
                  <td className="small">
                    {VERIFY_GATEWAYS.some((g) => checks[`${o.cid}|${g}`]) ? (
                      VERIFY_GATEWAYS.map((g) => {
                        const c = checks[`${o.cid}|${g}`];
                        return c ? <div key={g} className={c.state === "ok" ? "ok-text" : c.state === "bad" ? "error" : "muted"}>{new URL(g).host}: {c.detail}</div> : null;
                      })
                    ) : (
                      <button onClick={() => check(o)}>ipfs.io + dweb.link</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
