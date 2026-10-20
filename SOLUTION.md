# Travis County, TX Oracle pipeline: solution

**Live runtime:** https://travis-oracle.travis-oracle-web.workers.dev (public, no login)
**Run history and manifests:** [`runs/`](runs/) · **CARs:** [GitHub Releases](https://github.com/richardreid1811/oracle-property-intelligence-platform-pipeline-travis-tx/releases)
**Data contract (tables, keys, enums, tools):** [`docs/data-contract.md`](docs/data-contract.md) · **Discovery and readiness:** [`pipeline/docs/travis-county-findings.md`](pipeline/docs/travis-county-findings.md), [`pipeline/docs/travis-sources.yaml`](pipeline/docs/travis-sources.yaml) (kit readiness validator: PASS)

The pipeline loads all available Travis County property, permit, ownership, business, contractor, licensing and coordinate data. It reconciles them into roofing-lead signals and publishes each run as an immutable, CID-addressed snapshot on public IPFS. The data is queried in the browser with DuckDB-WASM, through an agent, and through an MCP server. **Oracle runs no database and no servers, and pays $0 a month.**

## Architecture

```
Sources ──► pipeline/ (Node + DuckDB) ──► deterministic Parquet + run summary ──► IPFS (CIDv1)
  TCAD appraisal roll (bulk export)        roll build · permit build · derive          pinned on Filebase + Pinata
  TCAD parcel centroids (ArcGIS)           export · deltas · publish                   CARs → GitHub Releases
  City of Austin permits (Socrata)                                                     manifest + history → runs/
  TX Comptroller, TDLR (Socrata)
  US Census ZCTA→county                         ▲ scheduled incremental refresh
                                                │ (GitHub Actions, free) reads the previous
                                                │ snapshot back by CID
                                                │
Hosted runtime (Cloudflare Worker, free plan)   │
  static UI ── DuckDB-WASM reads Parquet by CID from public gateways (no Oracle DB)
  /api/chat ── Workers AI (Llama 3.3 70B) picks tools; tools run as SQL in the browser
MCP server (mcp/, stdio) ── loads the same snapshot by CID into DuckDB; same tool definitions
```

| Path | Purpose |
|---|---|
| `pipeline/src/sources/` | Harvesters: TCAD export extract with receipt, ArcGIS centroids, Austin permits (full pull or business-date window), generic Socrata, BBB sitemap reader (stopped on 403) |
| `pipeline/src/build/` | `tcad-roll` builds properties; `permits` + shared `permit-sql` handle classification, status, deterministic parcel links and roof age; `derive` builds owner signals, contractors, businesses and licenses; `incremental` layers a window onto the previous snapshot |
| `pipeline/src/publish/` | `export` (byte-stable Parquet, samples, coverage), `deltas`, `run-summary`, `unixfs` (Kubo-profile CIDs + CARs), `publish` (pins + manifest), `verify-gateways`, `fetch-snapshot`, `check-contract`, `prune-pins` |
| `pipeline/src/run-incremental.mjs` | One incremental run end to end (what CI runs) |
| `packages/query-tools/` | One definition per roofing tool (JSON Schema + DuckDB SQL), shared by the UI, agent and MCP; `embed.mjs` is the shared embedder for semantic retrieval |
| `apps/web/` | React UI + Worker (`wrangler.jsonc`) |
| `mcp/` | stdio MCP server |
| `.github/workflows/` | `refresh.yml` (weekly incremental run + on-demand, retention), `verify-gateways.yml` (independent retrieval proof) |

## Acceptance criteria → evidence

| Criterion | How it is met | Where to see it |
|---|---|---|
| Travis County as primary county | All sources scoped to Travis (FIPS 48453); 23 jurisdictions enumerated from TCAD taxing entities | Findings §4 |
| Load all available property records | 441,972 assessed real parcels (TCAD 2026, supplement 335) | UI › Run summary |
| Permits, roofing emphasis | 2,380,939 City of Austin permits; 31,968 roofing (23,403 re-roof building permits, classifier on Building Permits only) | UI › Run summary, Map |
| Permit status, open/close dates, duration | `status`, `status_bucket` (open / expired_unfinaled / closed / void), applied/issued/completed dates; days open computed as of today | Map › open roofing permits |
| Ownership | Owner name and mailing address from the roll; deed date (424k parcels) | `stale_ownership_near`, `absentee_owners_near` |
| Contractors | 32,467 contractors deduplicated across permits; 10,745 resolved to a Texas Comptroller entity on an unambiguous exact match | Agent and Map answers |
| BBB ratings where available | **Excluded from automated ingestion.** bbb.org returned HTTP 403, robots.txt bars search and pagination, and BBB offers no public API. Per the kit, the block is not circumvented. Instead, BBB lookup is **ad hoc and viewer-initiated**: every contractor row carries `bbb_lookup_url`, which opens BBB's own search for that contractor in the user's browser (UI link, agent answer, MCP field). The pipeline never fetches BBB | Map › open roofing permits › Check BBB |
| Businesses | 367,843 Travis County businesses (sales-tax outlets + franchise taxpayers) | Run summary |
| Coordinates | 430,761 parcels with coordinates (390k own centroid, 40k parent lot for condos), labelled by basis | Map |
| Roof age / proxies, configurable threshold | Per-property roof year with basis and confidence: finaled re-roof permit (high), unfinaled (medium), year built (low; very_low if more than 50 years). Threshold is a parameter, default 15 | `aged_roofs_near` |
| Reconcile duplicate entities | Parcels keyed on PROP_ID (padding normalized); permits deduplicated by number; deterministic geo_id links with ambiguity flagged; contractors deduplicated by normalized name and resolved to the Comptroller registry; **owners reconciled across properties** (normalized name + mailing address → `owners`, 376k entities, 21.8k multi-property portfolios) and linked to the business registry; businesses deduplicated by taxpayer number | `owners`, `link_basis`, `identity_status`, `registry_link` |
| Source provenance | Every row carries its source URL or record link; every source has a receipt (URL, digest, counts, timestamp) in `run.json` | UI › Run summary › Sources |
| Continuous / incremental | Business-date windows (Socrata `:updated_at` is rewritten nightly), idempotent upserts, carried records re-classified under current rules, record-level deltas, **weekly** scheduled CI refresh plus on-demand runs, no-change checks recorded. Published tables hold only stable facts (durations and tenure are computed at query time), so unchanged data never creates new pins | `runs/history.json`, UI › Run history |
| Visible run history | Timestamps, sources, counts, deltas, limitations and CIDs per run | UI › Run history |
| Performance / slow sources / limits | See [Speed and source constraints](#speed-and-source-constraints) | |
| No ongoing Oracle infrastructure cost | Cloudflare free plan (no card), free pinning tiers, GitHub Actions on a public repo, browser-side DuckDB | [Cost](#cost) |
| IPFS: CIDv1, public, manifest fields | Kubo-default UnixFS profile; locally computed CIDs must equal the Filebase and Pinata CIDs or publication fails. Manifest lists cid, name, size, codec, sha256, pins and CARs | `runs/<run>/manifest.json`, UI › IPFS artifacts |
| New CIDs on republish, prior CIDs immutable | Byte-deterministic export: unchanged files keep CIDs, changed files get new ones, nothing is ever unpinned. Both runs' CIDs remain in history | UI › Run history ("Check this snapshot still resolves") |
| CARs for directories | Root and `tables/permits` CARs attached to each run's GitHub Release, with their sha256 in the manifest (runs 1–3 also include the since-retired `tiles/leads` CAR) | Releases |
| Two independent public gateways | `verify-gateways` fetches every CID from **ipfs.orbitor.dev** and **dget.top** (independent operators, not our pinning vendors) and checks size + sha256; evidence committed per run. The UI re-verifies any file in your own browser. The README's examples, ipfs.io and dweb.link, **retired programmatic HTTP access on 2026-09-21** (service-worker-only; plain HTTP clients now get 429 with a notice pointing to gatewaychanges.ipfs.io). They still work in a browser via the service worker | `runs/<run>/gateway-verification.json`, UI › IPFS artifacts |
| DuckDB / MCP-ready / agent access | DuckDB-WASM in the browser and DuckDB in the MCP server, over the same Parquet; MCP `tools/list`, `tools/call`, `run_sql` and resources. A published **data contract** documents every table, key, enum and tool; each publish is gated on an exact schema match | UI › MCP & SQL, `mcp/`, `docs/data-contract.md` |
| Agent: retrieval-augmented, source-backed | Two retrieval paths feed the model: structured tools (radius, roof age, permits, ownership) and **semantic retrieval**. Semantic retrieval embeds the 31,968 roofing permits with bge-small-en-v1.5 (vectors published as `permit_embeddings.parquet`) and ranks them by cosine similarity in DuckDB. Answers cite rows and source links | UI › Agent, Map › "Describe the work" |
| UI | Hosted React app | Live runtime |
| Roofing queries (radius, roof > N years, open permits, contractor + BBB, ownership > 10 years, out-of-area owners) | Six tools with source-backed rows; place names resolve via an in-data gazetteer | UI › Map, Agent |

## Texas adaptations of the Florida-oriented kit

- **No roofing license.** Texas does not license roofers, so the DBPR rule "no license match → no contractor" would drop every roofer. The permit-listed contractor is kept as permit evidence and linked to a Texas Comptroller entity only on an unambiguous normalized-name match. TDLR licenses cover the trades Texas does license.
- **Business registry.** Sunbiz is replaced by Comptroller franchise-tax and sales-tax data (free). SOSDirect is pay-per-search and is not used.
- **Appraisal export.** The appraisal-district export replaces Florida DOR NAL rolls. PROP_ID is digits-only by design and is keyed as a string; `geo_id` is the permit join key.
- **No sale prices.** Texas is a non-disclosure state, so ownership age comes from deed dates.
- **No county building permits.** Texas counties have no building-code authority, so unincorporated Travis County has no re-roof permits and its roof age is year-built based.
- **Permit vendors.** Austin uses Socrata open data, a new adapter. Suburbs use MGO, GovWell, GovBuilt or Tyler; these are classified, with Texas Public Information Act request routes (not sent).
- **Infrastructure.** The kit's AWS BBB execution and Neon destination are replaced by local DuckDB and Docker Postgres at $0. Restate was not needed: every source is bulk or API, the slowest is about 20 minutes, and steps are idempotent scripts.
- **Atlas.** Registration in `elephant-xyz/atlas` was not attempted. The README's manifest-and-gateway requirements are met independently, and the lexicon CAR path remains future work.

## Speed and source constraints

| Step | Volume | Time | Constraint |
|---|---|---|---|
| TCAD export download / extract | 557 MB zip → 18 GB | ~1 min / 75 s | traviscad.org HTML blocks non-browser clients; direct file links work |
| Roll build (DuckDB) | 441,972 parcels | 54 s | Fixed-width, 9,922-char records |
| TCAD centroids | 386,682 features | 2 m 19 s | ArcGIS 2,000-feature pages, concurrency 2 |
| Austin permits full pull | 2,380,939 | 19 m 42 s | Socrata 50k pages; `:updated_at` unusable for change detection |
| Austin permit window | tens to thousands of rows | seconds | Business-date filters |
| Franchise taxpayers (statewide) | 3,487,662 | 9 m 18 s | Needed for contractor identity |
| Permit build / derive / export | 2.4M permits | ~4 m / 25 s / ~2 m | |
| Publish (pins + verification) | 72 objects, ~240 MB | ~4–5 min | Free-plan Pinata accepts no CAR or pin-by-CID, so files are uploaded and CIDs compared |
| Incremental run end to end | | ~2–3 min | Previous snapshot fetched by CID and sha256-verified |
| BBB | | excluded | HTTP 403, robots.txt, no public API |
| Other municipalities | 17 jurisdictions, ~11% of parcels | n/a | Account-gated portals; records-request routes cataloged |

## Cost

| Component | Plan | Monthly cost |
|---|---|---|
| UI + agent relay | Cloudflare Workers free plan, no card on file (over-limit requests fail rather than bill) | $0 |
| LLM | Workers AI free daily allocation | $0 |
| IPFS pinning | Filebase free + Pinata free (500 pinned files and 1–5 GB each). Kept inside the quotas by directory-node-only directory pins, stable published facts, a weekly cadence, and retention (initial run + latest 7 pinned on both vendors; older runs stay in history and in their release CARs) | $0 |
| Scheduled refresh + verification | GitHub Actions on a public repository | $0 |
| Query engine | DuckDB in the user's browser / MCP host | $0 |

## Runbook

```bash
npm ci                                   # Node 22.18+
cp .env.example .env                     # FILEBASE_*, PINATA_JWT
# full rebuild (local, large sources)
cd pipeline
node src/sources/tcad-extract.mjs <export.zip> data/raw/tcad/<snap>/extracted <url>
node src/sources/tcad-gis-centroids.mjs data/raw/gis/tcad-centroids.ndjson
node src/sources/austin-permits.mjs data/raw/permits/austin/full.ndjson
node src/sources/socrata.mjs ...         # Comptroller / TDLR (see pipeline/docs)
node src/build/tcad-roll.mjs ... && node src/build/permits.mjs ... && node src/build/derive.mjs ...
node src/publish/export.mjs ... && node src/publish/run-summary.mjs ... && node src/publish/publish.mjs ...
# incremental (what CI runs weekly / on demand)
node src/run-incremental.mjs --runs ../runs
# rebuild any published run from CIDs alone
node src/publish/fetch-snapshot.mjs ../runs/<run>/manifest.json <dir>
# hosted UI
cd apps/web && npm run deploy
```

## Adversarial review (2026-10-20)

Every acceptance criterion and module was reviewed against real output; fixes were verified on a full incremental dry run before publishing.

| Finding | Impact | Fix |
|---|---|---|
| Free-tier pin quotas (500 files per vendor) would be exhausted within days by full directory re-imports and calendar-dependent columns | Pipeline would stop publishing; "$0" claim at risk | Directory-only CAR pins, stable published facts, weekly cadence, retention (`prune-pins.mjs`) |
| Refresh workflow masked pipeline failures (`tee` exit code) | Broken runs reported green | `set -o pipefail` |
| Terminal statuses (Cancelled…, Aborted, Denied…, Revoked, Rejected) bucketed as open | ~300 false open permits | Prefix rules; carried permits re-classified every run |
| Deed age counted calendar-year boundaries | 2,624 properties misclassified at 10 years | Exact tenure from `deed_date` at query time |
| PO-box mailing ZIPs (no Census ZIP area) fell through to "elsewhere in Texas" | ~11.6k local owners counted as out-of-area | Mailing-city / Austin ZIP-prefix fallback |
| MCP `run_sql` could read local files via DuckDB path scans | Prompt-injected agents could read the host's files | `enable_external_access=false` + locked configuration after load (verified) |
| Out-of-area coordinates were clamped, "older than 15" was ≥ 15, commercial roofs excluded by default | Wrong or silently narrowed answers | Reject out-of-area points; strict `>`; `residential_only` defaults to false |
| Map popups interpolated data into HTML | XSS from source records | HTML escaping and https-only links |
| Non-deterministic tie-breaks in the roll build; owner money total exported as DOUBLE | CID churn; inexact money | Explicit tie-breaks; BIGINT cast; contract check caught both |
| Owners not reconciled across properties | Acceptance gap | `owners` table + registry link |
