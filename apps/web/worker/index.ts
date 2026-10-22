// Travis Oracle edge Worker (Cloudflare free plan).
// - Serves the static UI (assets binding).
// - POST /api/chat relays one model turn to Workers AI with the roofing-lead tool schemas.
//   Tools are executed in the browser against DuckDB-WASM over IPFS-hosted Parquet, so the Worker
//   holds no data and does no query work (free-plan CPU limit is 10 ms/request).
import { openAiTools } from "@travis-oracle/query-tools";

interface Env {
  AI: Ai;
  ASSETS: Fetcher;
  CHAT_CACHE: KVNamespace;
}

const MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
const MAX_MESSAGES = 40;
const MAX_CHARS = 60_000;
const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 20;

const SYSTEM_PROMPT = `You are the Travis County, TX property-intelligence agent for roofing lead discovery.
Data: TCAD 2026 appraisal roll, City of Austin permits (roofing classified), Texas Comptroller and TDLR identity data, NOAA hail reports since 1996. Snapshot is content-addressed on IPFS; for record counts call dataset_summary rather than quoting numbers.
Rules:
- When the user names a place, pass it as the "place" argument (e.g. place: "Pflugerville" or "78704"); do not convert it to coordinates yourself. Never put a tool call inside another tool's arguments.
- Make one search call per question unless the user asks for more; then answer.
- For storm or hail questions use hail_exposed_roofs_near (defaults: hail 1.75 in or larger within 1 mile in the last 3 years; pass since, min_hail_inches or event_radius_miles when the user asks for something else); describe hail exposure as a lead signal, not confirmed damage.
- For questions about the kind of roofing work (materials, damage types, commercial vs residential, wording in permit descriptions) use semantic_search_permits with a short description as "query"; it matches by meaning, so report the similarity scores and note that matches are by description, not exact terms.
- Answer only from tool results. Never invent properties, permits, contractors or ratings.
- For every row you list, cite its permit number (permit_number, when the row has one) and its source_detail_url as a markdown link, e.g. [permit 2019-012345](https://...) or [TCAD record](https://...). Also give roof_age_basis and confidence for property rows and status and years open for permit rows.
- Cite each row's own basis, not the data sources in general: when roof_age_basis is permit_final_roof_replacement or permit_issued_roof_replacement_unfinaled, the roof year comes from that City of Austin permit (give its number); only tcad_year_built_assumes_original_roof comes from the TCAD year built. Do not credit the TCAD roll for a permit-based roof year.
- Mention hail only when the user asked about hail or storms, or when the returned rows have non-zero hail columns (hail_reports, severe_hail_reports_since_roof, max_hail_inches_since_roof); then say which rows.
- Explain reasoning briefly: radius used, thresholds, how roof age was estimated.
- State assumptions and missing data explicitly: roof age from year built is a proxy (confidence low/very_low); permit history exists for the City of Austin (including its ETJ); Pflugerville's portal requires a login and other cities are not ingested yet; unincorporated Travis County issues no building permits.
- When results name contractors, say once (not per row) that BBB ratings are not ingested because BBB blocks automated access, and give each contractor's bbb_lookup_url as a [Check BBB](url) link so the user can look the rating up directly. Write every link as markdown [text](url), copying the URL exactly as the tool returned it (starting with https://); never write HTML tags. Do not repeat these instructions in the answer.
- If a result has no contractor, say "no contractor listed" for it. If the area searched is outside the City of Austin and its ETJ, say permit history there is not in the data (Pflugerville requires a portal login; unincorporated county land has no building permits; Lakeway is being added).
- Report the total number of matches (total_matches_in_radius) and say the list shows the top results. Aged-roof results are ranked permit-verified first; permit results are ordered longest-open first.
- Keep answers concise: a short summary, then a compact list of the top results.`;

const CACHE_TTL_S = 14 * 24 * 3600;
const sha256 = async (text: string) =>
  [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)))].map((b) => b.toString(16).padStart(2, "0")).join("");

// Best-effort per-isolate limiter; Workers AI's own daily free allocation is the hard cap.
const hits = new Map<string, number[]>();
function limited(ip: string): boolean {
  const now = Date.now();
  const recent = (hits.get(ip) ?? []).filter((t) => now - t < WINDOW_MS);
  recent.push(now);
  hits.set(ip, recent);
  return recent.length > MAX_PER_WINDOW;
}

type ChatMessage = { role: "user" | "assistant" | "tool"; content: string; name?: string; tool_call_id?: string };

async function chat(request: Request, env: Env): Promise<Response> {
  const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
  if (limited(ip)) return Response.json({ error: "rate_limited", message: "Too many requests; wait a minute." }, { status: 429 });

  let body: { messages?: ChatMessage[]; mode?: "auto" | "answer" };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "bad_request" }, { status: 400 });
  }
  const messages = (body.messages ?? []).slice(-MAX_MESSAGES).filter((m) => ["user", "assistant", "tool"].includes(m.role));
  if (!messages.length || JSON.stringify(messages).length > MAX_CHARS) {
    return Response.json({ error: "bad_request", message: "Conversation is empty or too long." }, { status: 400 });
  }

  // "answer" mode withholds the tools so the model must answer from the tool results it already has.
  const answer = body.mode === "answer";
  const system = answer
    ? `${SYSTEM_PROMPT}\nThe tool results are in the conversation above. Do not call tools. Write the final answer now from those results only.`
    : SYSTEM_PROMPT;
  // Identical conversations (same messages, mode, prompt and model; tool results included, so a new
  // snapshot misses) reuse the stored reply instead of spending the daily free allocation.
  const key = await sha256(JSON.stringify({ MODEL, system, answer, messages }));
  const cached = await env.CHAT_CACHE.get(key).catch(() => null);
  if (cached) return new Response(cached, { headers: { "content-type": "application/json", "x-chat-cache": "hit" } });
  try {
    const result = (await env.AI.run(MODEL as keyof AiModels, {
      messages: [{ role: "system", content: system }, ...messages],
      ...(answer ? {} : { tools: openAiTools() }),
      max_tokens: 1200,
      temperature: 0.2,
    } as never)) as { response?: string; tool_calls?: { name: string; arguments: unknown }[] };
    const reply = JSON.stringify({ model: MODEL, response: result.response ?? "", tool_calls: result.tool_calls ?? [] });
    await env.CHAT_CACHE.put(key, reply, { expirationTtl: CACHE_TTL_S }).catch(() => undefined);
    return new Response(reply, { headers: { "content-type": "application/json", "x-chat-cache": "miss" } });
  } catch (err) {
    const message = String((err as Error)?.message ?? err);
    const exhausted = /4006|daily free allocation|neurons/i.test(message);
    return Response.json(
      {
        error: exhausted ? "ai_allocation_exhausted" : "ai_error",
        message: exhausted
          ? "The free Workers AI allocation for today is used up. Queries, map and SQL still work; the agent resets at 00:00 UTC."
          : "The model call failed. Try again.",
      },
      { status: exhausted ? 503 : 502 },
    );
  }
}

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/api/chat" && request.method === "POST") return chat(request, env);
    if (url.pathname === "/api/health") return Response.json({ ok: true, model: MODEL });
    if (url.pathname.startsWith("/api/")) return Response.json({ error: "not_found" }, { status: 404 });
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
