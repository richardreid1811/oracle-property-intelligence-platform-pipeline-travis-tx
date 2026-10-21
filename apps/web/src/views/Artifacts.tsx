import { useEffect, useState } from "react";
import type { AppData } from "../App";
import { bytes, shortCid, when } from "../format";
import type { LexiconEvidence, ManifestObject } from "../types";

// Independent public gateways (not our pinning vendors). ipfs.io/dweb.link retired HTTP access 2026-09-21.
const VERIFY_GATEWAYS = ["https://ipfs.orbitor.dev", "https://dget.top"];
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

// Lexicon archives and the Atlas page are evidence files in the repository (written by the publish step).
const REPO_RAW = "https://raw.githubusercontent.com/richardreid1811/oracle-property-intelligence-platform-pipeline-travis-tx/travis-pipeline";
const LEXICON_GROUPS = ["county", "property_improvement"] as const;

async function resolveIpns(name: string): Promise<string | null> {
  const res = await fetch(`https://ipfs.filebase.io/ipns/${name}`, { method: "HEAD", cache: "no-store" });
  return res.headers.get("x-ipfs-roots")?.split(",")[0].trim() ?? null;
}

export default function Artifacts({ data }: { data: AppData }) {
  const { manifest, verification } = data;
  const [checks, setChecks] = useState<Record<string, Check>>({});
  const [showAll, setShowAll] = useState(false);
  const [lexicon, setLexicon] = useState<LexiconEvidence[]>([]);
  const [ipnsNow, setIpnsNow] = useState<{ state: "running" | "ok" | "bad"; detail: string } | null>(null);
  // Runs before IPNS was introduced record it in the history entry instead of the (immutable) manifest.
  const latestRun = data.history.runs.at(-1);
  const ipns = manifest.ipns ?? latestRun?.ipns ?? null;

  useEffect(() => {
    Promise.all(
      LEXICON_GROUPS.map((g) => fetch(`${REPO_RAW}/runs/lexicon/${g}.json`, { cache: "no-store" }).then((r) => (r.ok ? (r.json() as Promise<LexiconEvidence>) : null)).catch(() => null)),
    ).then((rows) => setLexicon(rows.filter((r): r is LexiconEvidence => r !== null)));
  }, []);

  async function checkIpns() {
    if (!ipns) return;
    setIpnsNow({ state: "running", detail: "resolving…" });
    try {
      const cid = await resolveIpns(ipns.name);
      setIpnsNow(cid ? { state: cid === manifest.root.cid ? "ok" : "bad", detail: cid === manifest.root.cid ? `resolves to this run's root ${shortCid(cid)}` : `resolves to ${cid ? shortCid(cid) : "nothing"} (this run's root is ${shortCid(manifest.root.cid)})` } : { state: "bad", detail: "no x-ipfs-roots header returned" });
    } catch (e) {
      setIpnsNow({ state: "bad", detail: String((e as Error).message ?? e) });
    }
  }

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

  // Directory roots and Elephant Lexicon archive/table roots (dag-json): DAGs published with a CAR.
  const dirs = manifest.objects.filter((o) => o.codec !== "file");
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
        </p>
        {verification && (
          <p className={`small ${verification.all_ok ? "ok-text" : "error"}`}>
            Independent verification ({verification.verifier}, {when(verification.verified_at)}): {verification.objects} objects on{" "}
            {verification.gateways.map((g) => new URL(g).host).join(" and ")} — {verification.all_ok ? "all bytes match the manifest" : `${verification.failures} failures`}.
          </p>
        )}
      </section>

      <section className="card">
        <h2>IPNS pointer</h2>
        {ipns ? (
          <>
            <p className="small">
              <code>{ipns.label ?? "oracle-open-data-travis"}</code> = <code>{ipns.name}</code> (Filebase names API, re-pointed at every run). Recorded for this
              run: resolved to <code>{ipns.resolved_cid ?? "—"}</code>{ipns.resolved_at ? ` at ${when(ipns.resolved_at)}` : ""}. IPNS is a pointer; the CID is the snapshot.
            </p>
            <p className="small">
              Query table by path: <a href={`https://ipfs.filebase.io/ipns/${ipns.name}/tables/leads.parquet`} target="_blank" rel="noreferrer"><code>/ipns/{shortCid(ipns.name)}/tables/leads.parquet</code></a>{" "}
              <button onClick={checkIpns}>Resolve now</button>{" "}
              {ipnsNow && <span className={ipnsNow.state === "ok" ? "ok-text" : ipnsNow.state === "bad" ? "error" : "muted"}>{ipnsNow.detail}</span>}
            </p>
          </>
        ) : (
          <p className="small muted">No IPNS name recorded for this run.</p>
        )}
      </section>

      <section className="card">
        <h2>Elephant Lexicon archives</h2>
        <p className="muted small">
          One CAR per county per data group, built with elephant-cli from records in the Elephant Lexicon and validated against the live lexicon manifest, then
          uploaded to Filebase. Each group's archive root, tables root and schema form its entry on the Atlas county page (<a href={`${REPO_RAW}/atlas/counties/TX/travis.json`} target="_blank" rel="noreferrer">travis.json</a>).
        </p>
        {lexicon.length ? (
          <table className="tbl">
            <thead><tr><th>Group</th><th className="num">Properties</th><th>Validation</th><th>Archive root</th><th>Tables root</th><th>Upload</th><th>Atlas</th></tr></thead>
            <tbody>
              {lexicon.map((l) => (
                <tr key={l.group}>
                  <td>{l.group}</td>
                  <td className="num">{l.properties.toLocaleString()}</td>
                  <td className="small">{l.validate_dir ? `${l.validate_dir.error_rows} property errors` : "—"} · {l.validate_car ? (l.validate_car.passed ? "CAR passed all 6 checks" : "CAR failed") : "CAR pending"}</td>
                  <td>{l.hash ? <a href={`https://ipfs.filebase.io/ipfs/${l.hash.root}`} target="_blank" rel="noreferrer"><code title={l.hash.root}>{shortCid(l.hash.root)}</code></a> : "—"}</td>
                  <td>{l.export_tables ? <code title={l.export_tables.tables_root}>{shortCid(l.export_tables.tables_root)}</code> : "—"}</td>
                  <td className="small">{l.upload ? "uploaded to Filebase, root read back" : "not uploaded yet"}</td>
                  <td className="small">{l.atlas_pr ? <a href={l.atlas_pr.url} target="_blank" rel="noreferrer">{l.atlas_pr.state}</a> : "PR not opened"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="small muted">No Lexicon archive evidence published yet.</p>
        )}
      </section>

      <section className="card">
        <h2>Directory and archive roots</h2>
        <table className="tbl">
          <thead><tr><th>Name</th><th>CID</th><th className="num">Size</th><th>CAR (sha256)</th><th>CI check</th></tr></thead>
          <tbody>
            {dirs.map((o) => (
              <tr key={o.cid}>
                <td>{o.name}</td>
                <td><code title={o.cid}>{o.cid}</code></td>
                <td className="num">{bytes(o.size)}</td>
                <td className="small">{o.car?.release_asset ? <a href={o.car.release_asset} target="_blank" rel="noreferrer">{o.car.file.split("/").pop()}</a> : <a href={`https://ipfs.filebase.io/ipfs/${o.cid}?format=car`} target="_blank" rel="noreferrer">{o.car?.file.split("/").pop()} (gateway CAR)</a>} {o.car && bytes(o.car.bytes)} · {o.car?.sha256.slice(0, 12)}… · {o.car?.blocks} blocks</td>
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
                  <td><a href={`https://ipfs.orbitor.dev/ipfs/${o.cid}`} target="_blank" rel="noreferrer"><code title={o.cid}>{shortCid(o.cid)}</code></a></td>
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
                      <button onClick={() => check(o)}>orbitor.dev + dget.top</button>
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
