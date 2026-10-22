// Deterministic question parser: the agent's fallback when the model is unavailable (the Workers AI
// free allocation is used up). It maps a roofing-lead question to one lead tool and its arguments
// with plain patterns, so the same question always gives the same tool call. No model involved.
//   parseQuestion(text)                 -> { tool, args, place_candidates, assumptions }
//   planQuestion(text, run, { place })  -> the same, with the place resolved through resolve_place
import { toolByName } from "./index.mjs";

const WORDS = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, fifteen: 15, twenty: 20, thirty: 30, forty: 40, fifty: 50, half: 0.5 };
const NUM = `(\\d+(?:\\.\\d+)?|${Object.keys(WORDS).join("|")})`;
const toNum = (s) => (s.toLowerCase() in WORDS ? WORDS[s.toLowerCase()] : Number(s));

export const DEFAULT_RADIUS_MILES = 3;
// "Open for many years" without a number: the map's default for long-open permits.
export const MANY_YEARS = 3;

// Intent, first match wins: hail is checked before roof age ("old roofs hit by hail" is a hail
// question), open permits before everything else that mentions years.
const INTENTS = [
  ["hail_exposed_roofs_near", /\b(hail|hailstorms?|storms?)\b/i],
  ["open_roofing_permits_near", /\b(open|unfinaled|never[- ]finaled|expired|long[- ]open)\b[^.?!]*\bpermits?\b|\bpermits?\b[^.?!]*\b(open|unfinaled|never[- ]finaled|expired)\b/i],
  ["stale_ownership_near", /\bno (?:ownership|owner) change|\bnot (?:been )?(?:sold|changed hands)|\bhave(?:n't| not) sold|\bsame owners?\b|\b(?:owned|held) for\b|\bownership (?:has )?not changed\b/i],
  ["absentee_owners_near", /\babsentee\b|\bout[- ]of[- ](?:state|area|town)\b|\boutside (?:the area|travis|texas|austin)\b|\b(?:mail|mailing)\b[^.?!]*\b(?:out of|outside|elsewhere)\b|\binternational\b/i],
  ["aged_roofs_near", /\broofs?\b/i],
];

// Words that end a place phrase ("within 5 miles of Sunset Valley have roofs ...").
const STOP = "have|has|had|with|that|which|who|whose|where|and|or|older|newer|built|open|opened|since|within|over|under|for|is|are|was|were|from|whose|mail|mailing|owners?|roofs?|properties|homes|houses|permits?|show|list|find|in|near|around|of|hit|struck|damaged|affected|exposed|still|by";
const PLACE_RE = new RegExp(`\\b(?:of|near|around|in|at|by|outside)\\s+(.+?)(?=\\s+(?:${STOP})\\b|[,?.!;:]|$)`, "gi");
// Phrases after a preposition that are not places.
const NOT_PLACE = /^(?:the |this |that )?(?:travis(?: county)?|county|texas|tx|area|areas|region|there|here|it|them|years?|months?|days?|time|state|town|a while|many years|several years|the last|the past|total|a row|the city|hail|storms?)$/i;

/** Candidate place names in reading order; ZIP codes first. */
export function placeCandidates(text) {
  const out = [];
  for (const m of String(text).matchAll(/\b(78[67]\d{2})\b/g)) out.push(m[1]);
  for (const m of String(text).matchAll(PLACE_RE)) {
    const p = m[1].replace(/^(?:the city of|city of|the village of|village of|the)\s+/i, "").replace(/\s+(?:tx|texas)$/i, "").trim();
    if (!p || NOT_PLACE.test(p) || /\d/.test(p) || /\b(?:that|this|the same) area\b/i.test(m[1])) continue;
    if (!out.some((x) => x.toLowerCase() === p.toLowerCase())) out.push(p);
  }
  return out;
}

/** Radius in miles from "within N miles", "N mi of", "a mile"; default 3. */
export function radiusMiles(text) {
  const m = new RegExp(`\\b(?:within|inside|in)?\\s*${NUM}(?:\\s*-\\s*|\\s+)?(?:a\\s+)?(?:mi|miles?)\\b`, "i").exec(text);
  return m ? Math.min(25, Math.max(0.1, toNum(m[1]))) : null;
}

/** First "N years" that follows the given cue words, as a number. */
function yearsAfter(text, cue) {
  const m = new RegExp(`\\b(?:${cue})\\b[^.?!\\d]*?${NUM}\\+?\\s*(?:years?|yrs?)\\b`, "i").exec(text);
  return m ? toNum(m[1]) : null;
}
const anyYears = (text) => {
  const m = new RegExp(`\\b${NUM}\\+?\\s*(?:years?|yrs?)\\b`, "i").exec(text);
  return m ? toNum(m[1]) : null;
};

/** Pure parse: tool, arguments (place unresolved), place candidates and the assumptions made. */
export function parseQuestion(text) {
  const q = String(text ?? "").replace(/\s+/g, " ").trim();
  const intent = INTENTS.find(([, re]) => re.test(q));
  const tool = intent ? String(intent[0]) : "aged_roofs_near";
  const assumptions = [];
  const r = radiusMiles(q);
  if (r === null) assumptions.push(`no radius given; using ${DEFAULT_RADIUS_MILES} miles`);
  const args = { radius_miles: r ?? DEFAULT_RADIUS_MILES };
  if (tool === "aged_roofs_near" || tool === "hail_exposed_roofs_near") {
    const age = yearsAfter(q, "older than|over|more than|at least") ?? (/\broofs?\b[^.?!]*\bold\b/i.test(q) ? anyYears(q) : null);
    if (age !== null) args.older_than_years = age;
    else if (tool === "aged_roofs_near") assumptions.push("no roof age given; using older than 15 years");
  } else if (tool === "open_roofing_permits_near") {
    const yrs = yearsAfter(q, "open|opened|unfinaled|expired|for|over|more than|at least|longer than");
    if (yrs !== null) args.min_open_years = yrs;
    else if (/\b(?:many|several|multiple|long|longest)\b/i.test(q)) {
      args.min_open_years = MANY_YEARS;
      assumptions.push(`"many years" read as at least ${MANY_YEARS} years open`);
    }
  } else if (tool === "stale_ownership_near") {
    const yrs = anyYears(q);
    if (yrs !== null) args.min_years = yrs;
    else assumptions.push("no tenure given; using more than 10 years");
  }
  return { tool, args, place_candidates: placeCandidates(q), assumptions };
}

/**
 * Parse, then resolve the place with the resolve_place tool: the first candidate that matches the
 * gazetteer wins; with none, the previous question's place and radius (context.place,
 * context.radius_miles) are reused ("near that area"). `run(sql)` returns row objects. Throws when no
 * place can be found.
 * @param {string} text
 * @param {(sql: string) => Promise<Record<string, any>[]>} run
 * @param {{ place?: Record<string, any> | string, radius_miles?: number }} [context]
 */
export async function planQuestion(text, run, context = {}) {
  const plan = parseQuestion(text);
  for (const candidate of plan.place_candidates) {
    // Longest match first: "Sunset Valley homes" tries "Sunset Valley homes", then "Sunset Valley", ...
    const words = candidate.split(" ");
    for (let n = words.length; n > 0; n--) {
      const [hit] = await run(toolByName.resolve_place.sql({ name: words.slice(0, n).join(" ") }));
      if (hit) return { ...plan, args: { place: hit.name, ...plan.args }, place: hit };
    }
  }
  if (context.place) {
    const args = { place: context.place.name ?? context.place, ...plan.args };
    const assumptions = plan.assumptions.filter((a) => !(context.radius_miles && a.startsWith("no radius")));
    // A follow-up about "that area" keeps the previous radius unless it names a new one.
    if (context.radius_miles && radiusMiles(text) === null) args.radius_miles = context.radius_miles;
    assumptions.push(`no place named; reusing ${args.place}${context.radius_miles && radiusMiles(text) === null ? ` within ${args.radius_miles} miles` : ""}`);
    return { ...plan, args, assumptions, place: context.place };
  }
  throw new Error(plan.place_candidates.length
    ? `no Travis County place matches ${plan.place_candidates.map((p) => `"${p}"`).join(" or ")}`
    : "name a Travis County city, ZIP code or neighborhood (for example \"within 3 miles of Sunset Valley\")");
}
