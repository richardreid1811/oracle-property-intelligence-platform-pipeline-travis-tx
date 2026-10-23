// IPNS pointers on Filebase, following the Elephant oracle skills' conventions
// (elephant-xyz/skills: county-open-data-publish, county-query-table-publish):
//   - one label per county per dataset: oracle-open-data-<county>, oracle-query-table-<county>
//   - Filebase Platform API https://api.filebase.io/v1/names (label-keyed; NOT /v1/ipns),
//     Authorization: Bearer base64(ACCESS_KEY:SECRET_KEY); the resolvable k51… name is `network_key`
//   - create with POST {label, cid}; re-point every publish with PUT /v1/names/<label> {cid}
//   - verify by resolving through a gateway and reading the `x-ipfs-roots` header (public
//     gateways dropped the Kubo /api/v0/name/resolve endpoint)
// IPNS is a pointer; the CID is the snapshot. The resolved CID is recorded per run.
const API = "https://api.filebase.io/v1/names";
const RESOLVERS = ["https://ipfs.filebase.io/ipns/"];

export const ipnsLabel = (dataset, county) => `oracle-${dataset}-${county}`;

const auth = (env) => {
  if (!env.FILEBASE_ACCESS_KEY || !env.FILEBASE_SECRET_KEY) throw new Error("FILEBASE_ACCESS_KEY / FILEBASE_SECRET_KEY are not set");
  return { Authorization: `Bearer ${Buffer.from(`${env.FILEBASE_ACCESS_KEY}:${env.FILEBASE_SECRET_KEY}`).toString("base64")}` };
};

async function call(method, url, env, body) {
  const res = await fetch(url, {
    method,
    headers: { ...auth(env), ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(60_000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Filebase names ${method} ${url}: HTTP ${res.status} ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
}

/** Create the label if missing, otherwise re-point it. Returns { label, name, cid }. */
export async function pointName(label, cid, env = process.env) {
  const names = (await call("GET", API, env)) ?? [];
  const existing = names.find((n) => n.label === label);
  const out = existing ? await call("PUT", `${API}/${encodeURIComponent(label)}`, env, { cid }) : await call("POST", API, env, { label, cid });
  const name = out?.network_key ?? existing?.network_key;
  if (!name) throw new Error(`Filebase names: no network_key returned for ${label}`);
  return { label, name, cid };
}

/** Resolve an IPNS name via gateway headers; returns the root CID or null. */
export async function resolveName(name, { attempts = 12, delayMs = 10_000 } = {}) {
  for (let i = 0; i < attempts; i++) {
    for (const base of RESOLVERS) {
      try {
        const res = await fetch(`${base}${name}`, { method: "HEAD", redirect: "manual", signal: AbortSignal.timeout(30_000) });
        const roots = res.headers.get("x-ipfs-roots");
        if (roots) return { cid: roots.split(",")[0].trim(), via: base };
      } catch {
        /* try again */
      }
    }
    await new Promise((r) => setTimeout(r, delayMs));
  }
  return null;
}

/**
 * Point a label at cid and confirm the name resolves to it. Records what the network actually
 * returned: resolved_cid equals cid only once resolution has caught up.
 */
export async function publishPointer(label, cid, env = process.env) {
  const { name } = await pointName(label, cid, env);
  let resolved = null;
  for (let i = 0; i < 4 && resolved?.cid !== cid; i++) resolved = await resolveName(name, { attempts: 3, delayMs: 10_000 });
  return {
    label,
    name,
    target_cid: cid,
    resolved_cid: resolved?.cid ?? null,
    resolved_via: resolved?.via ?? null,
    resolved_at: new Date().toISOString(),
    resolves_to_target: resolved?.cid === cid,
  };
}

/**
 * Run the publication steps that follow a pointer move (manifest upload, history write). If one fails,
 * re-point the label at previousCid, the root it named before this run, so the name never names a run
 * that run history does not list; then rethrow. With no previousCid (dry run, first run) nothing moves.
 */
export async function withPointerRollback(label, previousCid, steps, { point = pointName, env = process.env } = {}) {
  try {
    return await steps();
  } catch (err) {
    if (previousCid) {
      try {
        await point(label, previousCid, env);
        console.error(`IPNS ${label} restored to ${previousCid} after a failed publication`);
      } catch (e) {
        console.error(`warning: could not restore IPNS ${label} to ${previousCid}: ${e.message}`);
      }
    }
    throw err;
  }
}
