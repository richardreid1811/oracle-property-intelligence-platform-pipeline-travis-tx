import { Fragment, useState } from "react";
import type { AppData } from "../App";
import { runTool, type Row } from "../db";

type Msg = { role: "user" | "assistant" | "tool"; content: string; name?: string };
type Turn =
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string }
  | { kind: "tool"; name: string; args: Record<string, unknown>; rows: number; total?: unknown; sql: string; error?: string }
  | { kind: "error"; text: string };

const MAX_STEPS = 6;
const MAX_TOOL_ROUNDS = 1;
const MAX_ROWS_TO_MODEL = 15;
const EXAMPLES = [
  "Which properties in Travis County within five miles of Sunset Valley have roofs older than 15 years?",
  "Which properties near Sunset Valley have open roofing permits that have been open for many years, and who is the listed contractor?",
  "Within 3 miles of 78704, which owners have not sold in over 10 years and mail their tax bills out of state?",
];

// Llama sometimes nests resolve_place inside another tool's arguments, e.g.
// {latitude: {function_name: "resolve_place", args: ["Pflugerville"]}}. Resolve it here instead of failing.
async function unnest(args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const out = { ...args };
  for (const [k, v] of Object.entries(args)) {
    if (v && typeof v === "object" && (v as { function_name?: string }).function_name === "resolve_place") {
      const name = String(((v as { args?: unknown[] }).args ?? [])[0] ?? "");
      const [hit] = (await runTool("resolve_place", { name })).rows;
      if (!hit) throw new Error(`no Travis County place matches "${name}"`);
      out[k] = k.startsWith("lon") ? hit.longitude : hit.latitude;
    }
  }
  return out;
}

// On permit rows (top-level or nested permit lists), an empty contractor is spelled out so the model
// says "no contractor listed" instead of omitting it or guessing. Only the model's copy changes.
const CONTRACTOR_KEYS = ["contractor_company_name", "contractor"];
const isEmpty = (v: unknown) => v === null || v === undefined || (typeof v === "string" && !v.trim());
function markNoContractor(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(markNoContractor);
  if (!v || typeof v !== "object") return v;
  const o = Object.fromEntries(Object.entries(v as Row).map(([k, x]) => [k, markNoContractor(x)]));
  if ("permit_number" in o || "permit" in o) for (const k of CONTRACTOR_KEYS) if (k in o && isEmpty(o[k])) o[k] = "no contractor listed";
  return o;
}

// Keep tool payloads small for the model's context: top rows, truncated strings.
const compact = (rows: Row[]) =>
  rows.slice(0, MAX_ROWS_TO_MODEL).map((r) =>
    markNoContractor(
      Object.fromEntries(Object.entries(r).map(([k, v]) => [k, typeof v === "string" && v.length > 160 ? v.slice(0, 160) + "…" : v])),
    ),
  );

// Minimal, safe markdown: **bold**, [text](https://…) links, bare https links, and the
// <a href="…">text</a> the model sometimes writes instead (often without the scheme). No HTML
// injection (React escapes text); links are https only, a scheme-less www. host gets https://.
const MD_LINK = /^\[([^\]]+)\]\(((?:https:\/\/|www\.)[^\s)]+)\)$/;
const HTML_LINK = /^<a\s+href=["']((?:https:\/\/|www\.)[^"'\s]+)["'][^>]*>([^<]+)<\/a>$/i;
const httpsUrl = (u: string) => (u.startsWith("www.") ? `https://${u}` : u);
function Rich({ text }: { text: string }) {
  const parts = text.split(/(<a\s+href=["'](?:https:\/\/|www\.)[^"'\s]+["'][^>]*>[^<]+<\/a>|\[[^\]]+\]\((?:https:\/\/|www\.)[^\s)]+\)|\*\*[^*]+\*\*|https?:\/\/[^\s)<]+)/gi);
  return (
    <>
      {parts.map((p, i) => {
        const md = MD_LINK.exec(p);
        const html = HTML_LINK.exec(p);
        return md ? <a key={i} href={httpsUrl(md[2])} target="_blank" rel="noreferrer">{md[1]}</a>
        : html ? <a key={i} href={httpsUrl(html[1])} target="_blank" rel="noreferrer">{html[2]}</a>
        : p.startsWith("**") && p.endsWith("**") ? <strong key={i}>{p.slice(2, -2)}</strong>
        : /^https:\/\//.test(p) ? <a key={i} href={p} target="_blank" rel="noreferrer">{p.replace(/^https:\/\//, "")}</a>
        : <Fragment key={i}>{p}</Fragment>;
      })}
    </>
  );
}

export default function Agent({ data }: { data: AppData }) {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [history, setHistory] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);

  async function ask(question: string) {
    if (!question.trim() || busy) return;
    setBusy(true);
    setInput("");
    setTurns((t) => [...t, { kind: "user", text: question }]);
    let msgs: Msg[] = [...history, { role: "user", content: question }];
    let mode: "auto" | "answer" = "auto";
    let toolRounds = 0;
    const seen = new Set<string>();
    try {
      for (let step = 0; step < MAX_STEPS; step++) {
        const res = await fetch("/api/chat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ messages: msgs, mode }) });
        const out = (await res.json()) as { message?: string; error?: string; response?: unknown; tool_calls?: { name: string; arguments: unknown }[] };
        if (!res.ok) throw new Error(out.message ?? out.error ?? `HTTP ${res.status}`);
        const calls: { name: string; arguments: unknown }[] = out.tool_calls ?? [];
        if (!calls.length) {
          const text = String(out.response ?? "").trim() || "(no answer)";
          msgs = [...msgs, { role: "assistant", content: text }];
          setTurns((t) => [...t, { kind: "assistant", text }]);
          break;
        }
        // Workers AI Llama tends to repeat the same call instead of answering: after the tool round
        // (or on an exact repeat) ask for the answer with tools withheld.
        const signature = JSON.stringify(calls);
        if (seen.has(signature)) {
          mode = "answer";
          continue;
        }
        seen.add(signature);
        for (const call of calls) {
          const raw = (typeof call.arguments === "string" ? JSON.parse(call.arguments || "{}") : call.arguments ?? {}) as Record<string, unknown>;
          const args = await unnest(raw);
          msgs = [...msgs, { role: "assistant", content: `Calling tool ${call.name} with ${JSON.stringify(args)}` }];
          try {
            const { rows, count, sql, resolved } = await runTool(call.name, args);
            setTurns((t) => [...t, { kind: "tool", name: call.name, args, rows: rows.length, total: count?.matches, sql }]);
            const payload = { ...(resolved ? { search_center: resolved } : {}), returned_rows: rows.length, ...(count ? { total_matches_in_radius: count } : {}), rows: compact(rows) };
            msgs = [...msgs, { role: "tool", name: call.name, content: JSON.stringify(payload) }];
          } catch (e) {
            const error = String((e as Error).message ?? e);
            setTurns((t) => [...t, { kind: "tool", name: call.name, args, rows: 0, sql: "", error }]);
            msgs = [...msgs, { role: "tool", name: call.name, content: JSON.stringify({ error }) }];
          }
        }
        toolRounds++;
        if (toolRounds >= MAX_TOOL_ROUNDS) mode = "answer";
        if (step === MAX_STEPS - 1) setTurns((t) => [...t, { kind: "error", text: "Stopped after the maximum number of tool steps." }]);
      }
    } catch (e) {
      setTurns((t) => [...t, { kind: "error", text: String((e as Error).message ?? e) }]);
    } finally {
      setHistory(msgs.filter((m) => m.role !== "tool").slice(-8));
      setBusy(false);
    }
  }

  return (
    <div className="agent">
      <section className="card">
        <h1>Roofing-lead agent</h1>
        <p className="muted small">
          Llama 3.3 70B on Cloudflare Workers AI chooses tools; each tool runs as SQL in your browser against the IPFS-hosted snapshot
          ({data.manifest.root.cid.slice(0, 16)}…). Every tool call and its SQL are shown below.
        </p>
        <div className="examples">
          {EXAMPLES.map((q) => (
            <button key={q} onClick={() => ask(q)} disabled={!data.dbReady || busy}>{q}</button>
          ))}
        </div>
      </section>
      <section className="card chat">
        {turns.map((t, i) =>
          t.kind === "user" ? <div key={i} className="msg user">{t.text}</div>
          : t.kind === "assistant" ? <div key={i} className="msg assistant"><Rich text={t.text} /></div>
          : t.kind === "error" ? <div key={i} className="msg error">{t.text}</div>
          : (
            <details key={i} className="msg tool">
              <summary>
                Tool <code>{t.name}</code> {JSON.stringify(t.args)} → {t.error ? <span className="error">{t.error}</span> : `${t.rows} rows${t.total !== undefined ? ` (of ${t.total} matches)` : ""}`}
              </summary>
              <pre>{t.sql.trim()}</pre>
            </details>
          ),
        )}
        {busy && <div className="msg assistant muted">Working…</div>}
        {!turns.length && <p className="muted">Ask about roof age, open roofing permits, ownership tenure or absentee owners anywhere in Travis County.</p>}
      </section>
      <form className="ask" onSubmit={(e) => { e.preventDefault(); ask(input); }}>
        <input value={input} onChange={(e) => setInput(e.target.value)} placeholder={data.dbReady ? "Ask a question…" : "Loading data from IPFS…"} disabled={!data.dbReady || busy} />
        <button className="primary" disabled={!data.dbReady || busy || !input.trim()}>Ask</button>
      </form>
    </div>
  );
}
