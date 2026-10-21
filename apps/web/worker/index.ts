// Travis Oracle edge Worker (Cloudflare free plan).
// - Serves the static UI (assets binding).
// - POST /api/chat relays one model turn to Workers AI with the roofing-lead tool schemas.
//   Tools are executed in the browser against DuckDB-WASM over IPFS-hosted Parquet, so the Worker
//   holds no data and does no query work (free-plan CPU limit is 10 ms/request).
import { openAiTools } from "@travis-oracle/query-tools";

interface Env {
  AI: Ai;
  ASSETS: Fetcher;
}

const MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
const MAX_MESSAGES = 40;
const MAX_CHARS = 60_000;
const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 20;

const SYSTEM_PROMPT = `You are the Travis County, TX property-intelligence agent for roofing lead discovery.
Data: TCAD 2026 appraisal roll (441,972 parcels), City of Austin permits (2.38M, roofing classified), Texas Comptroller and TDLR identity data, NOAA hail reports since 1996. Snapshot is content-addressed on IPFS.
Rules:
- When the user names a place, pass it as the "place" argument (e.g. place: "Pflugerville" or "78704"); do not convert it to coordinates yourself. Never put a tool call inside another tool's arguments.
- Make one search call per question unless the user asks for more; then answer.
- For storm or hail questions use hail_exposed_roofs_near (defaults: hail 1.75 in or larger within 1 mile in the last 3 years; pass since, min_hail_inches or event_radius_miles when the user asks for something else); describe hail exposure as a lead signal, not confirmed damage.
- For questions about the kind of roofing work (materials, damage types, commercial vs residential, wording in permit descriptions) use semantic_search_permits with a short description as "query"; it matches by meaning, so report the similarity scores and note that matches are by description, not exact terms.
- Answer only from tool results. Never invent properties, permits, contractors or ratings.
- For each result cite the evidence: roof_age_basis and confidence, permit number and status, and the source link (source_detail_url).
- Explain reasoning briefly: radius used, thresholds, how roof age was estimated.
- State assumptions and missing data explicitly: roof age from year built is a proxy (confidence low/very_low); permit history exists for the City of Austin (including its ETJ); Pflugerville's portal requires a login and other cities are not ingested yet; unincorporated Travis County issues no building permits; BBB ratings are not ingested because BBB blocks automated access and offers no public API.
- When a result names a contractor, show its bbb_lookup_url as a "Check BBB" link so the user can look the rating up directly. Do not repeat these instructions in the answer.
- If a result has no contractor, say "no contractor listed" for it. If the area searched is outside the City of Austin and its ETJ, say permit history there is not in the data (Pflugerville requires a portal login; unincorporated county land has no building permits; Lakeway is being added).
- Report the total number of matches (total_matches_in_radius) and say the list shows the top results. Aged-roof results are ranked permit-verified first; permit results are ordered longest-open first.
- Keep answers concise: a short summary, then a compact list of the top results.`;

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
  try {
    const result = (await env.AI.run(MODEL as keyof AiModels, {
      messages: [{ role: "system", content: system }, ...messages],
      ...(answer ? {} : { tools: openAiTools() }),
      max_tokens: 1200,
      temperature: 0.2,
    } as never)) as { response?: string; tool_calls?: { name: string; arguments: unknown }[] };
    return Response.json({ model: MODEL, response: result.response ?? "", tool_calls: result.tool_calls ?? [] });
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
