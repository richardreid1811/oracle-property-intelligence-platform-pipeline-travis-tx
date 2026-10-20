import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { useEffect, useRef, useState } from "react";
import type { AppData } from "../App";
import { runTool, type Row } from "../db";
import { fmt } from "../format";

const MODES = {
  aged_roofs_near: { label: "Roofs older than threshold", threshold: "min_roof_age_years", dflt: 15, unit: "years" },
  open_roofing_permits_near: { label: "Open / never-finaled roofing permits", threshold: "min_open_years", dflt: 3, unit: "years open" },
  stale_ownership_near: { label: "No ownership change", threshold: "min_years", dflt: 10, unit: "years" },
  absentee_owners_near: { label: "Out-of-area owners", threshold: null, dflt: 0, unit: "" },
  semantic_search_permits: { label: "Describe the work (semantic search)", threshold: null, dflt: 0, unit: "" },
} as const;
type Mode = keyof typeof MODES;

const CONF_COLOR: Record<string, string> = { high: "#1a7f37", medium: "#9a6700", low: "#6e7781", very_low: "#a0a7b0" };
const DOWNTOWN = { lat: 30.2672, lon: -97.7431 };

export default function MapView({ data }: { data: AppData }) {
  const mapEl = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map | null>(null);
  const layer = useRef<L.LayerGroup | null>(null);
  const [center, setCenter] = useState(DOWNTOWN);
  const [place, setPlace] = useState("");
  const [mode, setMode] = useState<Mode>("aged_roofs_near");
  const [radius, setRadius] = useState(5);
  const [threshold, setThreshold] = useState<number>(MODES.aged_roofs_near.dflt);
  const [rows, setRows] = useState<Row[]>([]);
  const [semanticText, setSemanticText] = useState("hail damage roof repair");
  const [openOnly, setOpenOnly] = useState(true);
  const [count, setCount] = useState<Row | undefined>();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!mapEl.current || map.current) return;
    map.current = L.map(mapEl.current, { zoomControl: true }).setView([center.lat, center.lon], 12);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    }).addTo(map.current);
    layer.current = L.layerGroup().addTo(map.current);
    map.current.on("click", (e: L.LeafletMouseEvent) => setCenter({ lat: e.latlng.lat, lon: e.latlng.lng }));
    return () => {
      map.current?.remove();
      map.current = null;
    };
  }, []);

  useEffect(() => {
    if (!layer.current || !map.current) return;
    layer.current.clearLayers();
    L.circle([center.lat, center.lon], { radius: radius * 1609.34, color: "#0969da", weight: 1, fillOpacity: 0.04 }).addTo(layer.current);
    L.circleMarker([center.lat, center.lon], { radius: 6, color: "#0969da", fillOpacity: 1 }).bindTooltip("Search center").addTo(layer.current);
    for (const r of rows) {
      const lat = Number(r.latitude ?? NaN);
      const lon = Number(r.longitude ?? NaN);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
      const color = CONF_COLOR[String(r.roof_age_confidence)] ?? "#cf222e";
      L.circleMarker([lat, lon], { radius: 5, color, fillOpacity: 0.8, weight: 1 })
        .bindPopup(`<b>${r.situs_address ?? r.address ?? r.permit_number}</b><br/>${r.roof_age_years !== undefined ? `Roof ~${r.roof_age_years} yrs (${r.roof_age_basis})<br/>` : ""}${r.open_years !== undefined ? `Open ${r.open_years} yrs · ${r.status}<br/>` : ""}<a href="${r.source_detail_url}" target="_blank" rel="noreferrer">source record</a>`)
        .addTo(layer.current);
    }
  }, [center, radius, rows]);

  async function locate() {
    setErr(null);
    const { rows: hits } = await runTool("resolve_place", { name: place });
    if (!hits.length) return setErr(`No Travis County place matches "${place}".`);
    const p = { lat: Number(hits[0].latitude), lon: Number(hits[0].longitude) };
    setCenter(p);
    map.current?.setView([p.lat, p.lon], 12);
  }

  async function search() {
    setBusy(true);
    setErr(null);
    try {
      const m = MODES[mode];
      const args: Record<string, unknown> = { latitude: center.lat, longitude: center.lon, radius_miles: radius, limit: 200 };
      if (m.threshold) args[m.threshold] = threshold;
      if (mode === "semantic_search_permits") Object.assign(args, { query: semanticText, open_only: openOnly, limit: 100 });
      const res = await runTool(mode, args);
      setRows(res.rows);
      setCount(res.count);
    } catch (e) {
      setErr(String((e as Error).message ?? e));
    } finally {
      setBusy(false);
    }
  }

  const m = MODES[mode];
  return (
    <div className="map-layout">
      <aside className="card controls">
        <h2>Lead search</h2>
        <label>Place (city, ZIP)
          <div className="inline">
            <input value={place} onChange={(e) => setPlace(e.target.value)} placeholder="e.g. Pflugerville or 78704" onKeyDown={(e) => e.key === "Enter" && locate()} />
            <button onClick={locate} disabled={!data.dbReady || !place}>Go</button>
          </div>
        </label>
        <p className="muted small">Or click the map to drop a pin. Center: {center.lat.toFixed(4)}, {center.lon.toFixed(4)}</p>
        <label>Lead type
          <select value={mode} onChange={(e) => { const v = e.target.value as Mode; setMode(v); setThreshold(MODES[v].dflt); setRows([]); }}>
            {Object.entries(MODES).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
          </select>
        </label>
        <label>Radius: {radius} mi
          <input type="range" min={0.5} max={15} step={0.5} value={radius} onChange={(e) => setRadius(Number(e.target.value))} />
        </label>
        {mode === "semantic_search_permits" && (
          <>
            <label>Describe the work
              <input value={semanticText} onChange={(e) => setSemanticText(e.target.value)} placeholder="e.g. metal roof replacement, storm damage" />
            </label>
            <label className="small"><span><input type="checkbox" checked={openOnly} onChange={(e) => setOpenOnly(e.target.checked)} style={{ width: "auto" }} /> Only open / never-finaled permits</span></label>
            <p className="muted small">Meaning-based search over 31,968 roofing permit records (embeddings run in your browser; first use downloads a ~30 MB model).</p>
          </>
        )}
        {m.threshold && (
          <label>Threshold ({m.unit})
            <input type="number" min={0} max={100} value={threshold} onChange={(e) => setThreshold(Number(e.target.value))} />
          </label>
        )}
        <button className="primary" onClick={search} disabled={!data.dbReady || busy}>{busy ? "Searching…" : data.dbReady ? "Search" : "Loading data…"}</button>
        {err && <div className="error">{err}</div>}
        {count && <p className="small">{fmt(count.matches)} matching properties in radius ({fmt(count.permit_verified)} with permit-verified roof age). Showing top {rows.length}.</p>}
        {!count && rows.length > 0 && <p className="small">{rows.length} results (max 200).</p>}
        <div className="legend small">
          <span><i style={{ background: CONF_COLOR.high }} /> permit-verified roof</span>
          <span><i style={{ background: CONF_COLOR.medium }} /> unfinaled re-roof permit</span>
          <span><i style={{ background: CONF_COLOR.low }} /> year-built proxy</span>
          <span><i style={{ background: "#cf222e" }} /> permit / other</span>
        </div>
      </aside>
      <div className="map-col">
        <div ref={mapEl} className="map" />
        <div className="card results">
          <ResultTable rows={rows} mode={mode} />
        </div>
      </div>
    </div>
  );
}

function ResultTable({ rows, mode }: { rows: Row[]; mode: Mode }) {
  if (!rows.length) return <p className="muted">Run a search to see results.</p>;
  const cols: [string, string][] =
    mode === "aged_roofs_near"
      ? [["situs_address", "Address"], ["distance_miles", "mi"], ["roof_age_years", "Roof age"], ["roof_age_basis", "Basis"], ["roof_age_confidence", "Confidence"], ["roof_covering", "Covering"], ["open_roofing_permits", "Open roof permits"]]
      : mode === "open_roofing_permits_near"
        ? [["address", "Address"], ["permit_number", "Permit"], ["status", "Status"], ["open_years", "Years open"], ["contractor_company_name", "Contractor"], ["contractor_identity", "Registry"], ["bbb_rating", "BBB"]]
      : mode === "semantic_search_permits"
        ? [["similarity", "Match"], ["address", "Address"], ["permit_number", "Permit"], ["status", "Status"], ["open_years", "Years open"], ["description", "Work description"], ["contractor_company_name", "Contractor"], ["bbb_rating", "BBB"]]
        : mode === "stale_ownership_near"
          ? [["situs_address", "Address"], ["owner_name", "Owner"], ["deed_date", "Deed date"], ["years_since_deed", "Years"], ["roof_age_years", "Roof age"]]
          : [["situs_address", "Address"], ["owner_name", "Owner"], ["mail_city", "Mail city"], ["mail_state", "State"], ["owner_mail_region", "Region"], ["roof_age_years", "Roof age"]];
  return (
    <div className="scroll">
      <table className="tbl">
        <thead><tr>{cols.map(([, h]) => <th key={h}>{h}</th>)}<th>Source</th></tr></thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              {cols.map(([k]) => <td key={k}>{k === "bbb_rating" ? (r.bbb_rating ? String(r.bbb_rating) : r.bbb_lookup_url ? <a href={String(r.bbb_lookup_url)} target="_blank" rel="noreferrer" title="Opens BBB's own search in your browser; BBB data is not ingested">Check BBB ↗</a> : <span className="muted">—</span>) : fmt(r[k])}</td>)}
              <td><a href={String(r.source_detail_url)} target="_blank" rel="noreferrer">record</a></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
