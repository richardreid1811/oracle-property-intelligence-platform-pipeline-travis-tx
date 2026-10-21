# Demo recording script (10–13 minutes)

This follows the README's demo transcript in order. Record the browser at https://travis-oracle.travis-oracle-web.workers.dev with your voice-over.

**Before you start**
- Open the site and wait for the header pill to read **DuckDB ready** (about 20 s).
- Open these in other tabs:
  - the GitHub repo `runs/` folder
  - the Releases page
  - the latest `refresh` workflow run under Actions

Lines in quotes are suggested narration; say them in your own words.

## 1. Intro (30 s)
> "I'll show that the Oracle pipeline has loaded the available Travis County, Texas dataset, that it's queryable through DuckDB, that artifacts are published on IPFS as content-addressed snapshots, and that the UI and an agent answer roofing-lead questions. I acted as both Oracle and builder."

## 2. Pipeline run summary (1.5 min) — tab **Run summary**
- Point at: run ID (run 6), published time, the number of runs in history, mode, the gateway-verification badge, and the root and manifest CIDs.
- Scroll to **Sources and provenance**. Each source shows a snapshot receipt: record counts, source-reported counts, collection timestamps and SHA-256. Point at the new source **Overture Maps places** (release 2026-09-23.1) and at the two blocked sources: BBB and **Pflugerville**, whose permit portal requires a login. Mention that City of Lakeway permits are being harvested from its public portal and join in the next run.
- Scroll to **Source limitations** and read one or two: BBB, and municipal permit coverage (Austin plus Austin's ETJ cover 66% of parcels).

## 3. Total records by source (45 s) — same page, **Records by dataset**
> "441,972 parcels, 2.38 million Austin permits with about 32,000 roofing permits, 32,467 contractors (10,745 resolved to the Texas Comptroller registry), 367,843 businesses, 93,331 Overture business locations, and 430,761 parcels with coordinates."

## 4. DuckDB query layer (45 s) — **DuckDB query layer** panel
- Show the three tables, each loaded **by CID** from a public IPFS gateway, with row counts.
> "There's no Oracle-hosted database. The browser runs DuckDB over the published Parquet."
- Optional: tab **MCP & SQL** › SQL console › click **Run** on the default query.

## 5. Artifact manifest, IPNS and Lexicon archives (2 min) — tab **IPFS artifacts**
- Open **manifest.json** and show CID, name, size, codec and SHA-256 for objects, then the directory roots with their CARs.
> "Gateway URLs are derived from the CIDs. The CID is the artifact."
- Show the **IPNS pointer** card: the name `oracle-open-data-travis` (`k51qzi…yq8noj`) and the CID it resolves to, which matches this run's root. Click **Resolve now**; the resolved CID appears with the time.
> "The IPNS name always points at the latest run. The query table is at `/ipns/<name>/tables/leads.parquet`, because Filebase's free plan allows one name."
- Show the **Elephant Lexicon archives** card: for each data group, the archive root CID, the tables root CID, the elephant-cli validation result and the upload status.
> "These are the same records in the Elephant Lexicon, packed and validated with elephant-cli and uploaded to Filebase. The property improvement archive is on Filebase; the full county archive is still validating and goes out in a later run."
- Narrate what the card shows on the day: if the `county` archive has been uploaded by then, say so instead.

## 6. Retrieve from two independent public gateways (1 min)
- In **Files**, click **orbitor.dev + dget.top** on `coverage.json` and `tables/leads.parquet`.
- Both rows should turn green with "sha256 match".
- Point at the **CI check** column: this is independent verification run by GitHub Actions.
> "ipfs.io and dweb.link retired programmatic access on September 21, 2026, so verification uses two other independent public gateways. Neither is our pinning vendor."

## 7. Incremental publish = new CID, old CID still resolves (2 min) — tab **Run history**
- Show the runs with different root CIDs, "new vs reused" object counts, and deltas.
- Point at run 6: the IPNS name now resolves to run 6's root CID, not run 5's.
- On **run 5**, click **Check this snapshot still resolves**; it should resolve with a SHA-256 match. Do the same on the **oldest** run.
> "Republishing moved the IPNS pointer to the new CID. The old CID is immutable and still resolves."
- Switch to the GitHub tab: the Releases page has one release per run, each with CARs.
- Show a `refresh` workflow run that published a run with no laptop involved.

## 8. UI: aged roofs in a radius (1 min) — tab **Map search**
- Type **Pflugerville**, click **Go**, leave the radius at 5 mi and the type on "Roofs older than threshold" at 15, then click **Search**.
- Show the match count, the markers (colour shows how roof age was determined), and the table columns: basis, confidence, covering, and the **record** link to TCAD.

## 9. UI: long-open roofing permits with contractor + BBB (1 min)
- Set the type to **Open / never-finaled roofing permits** with a threshold of 3 years, place **78704** (or click the map near downtown), radius 3, then **Search**.
- Show status, years open and contractor, then click **Check BBB ↗**. BBB's own site opens; the rating is looked up on demand, not stored.

## 9b. Semantic search (45 s) — **Map search**
- Set the type to **Describe the work (semantic search)** and type `hail damage roof repair`. Keep "only open" ticked and click **Search**.
- The first search downloads the small embedding model into the browser (a few seconds).
- Show the **Match** scores and descriptions that use different wording (e.g. "replace/repair hail/wind damaged roof").
> "Retrieval by meaning over 32,000 roofing permit records, with vectors published on IPFS alongside the tables."

## 9c. Hail on current roofs (30 s) — **Map search**
- Set the type to **Recent hail on current roof (NOAA)**, keep 1.75 inches, search **Allandale** with a 2-mile radius (the April 9, 2024 storm: about 10,000 matches).
- Show hail reports, max size (up to 2.5 in) and last hail date next to roof age and basis.
- Optional: search Manor and show 0 matches. NOAA has no severe hail within a mile there in the last 3 years, and the tool says so instead of guessing.
> "A countywide storm signal from NOAA, counted only against the current roof, so it also works where no permit data exists."

## 10. Agent (2 min) — tab **Agent**
- Click the first example question (Sunset Valley roofs older than 15 years). Expand the **Tool** line to show the SQL, then read the answer: total matches, basis and confidence, source links.
- Click the second example question (Sunset Valley long-open roofing permits plus contractor). Show years open, contractors, BBB links and the stated assumptions.
- Type a semantic question, e.g. *"Find open permits for metal roof replacements on commercial buildings"*. The tool line shows `semantic_search_permits`.

## 11. MCP-ready (45 s) — tab **MCP & SQL**
- Show `tools/list`, call `aged_roofs_near` with `{"place": "Hyde Park", "radius_miles": 1}`, and show the setup snippet.
- Mention `docs/data-contract.md`: every table, key, enum and tool is documented, and each publish is checked against it.
> "The same tool definitions back the UI, the agent and a stdio MCP server that loads the snapshot by CID. The roofing CRM's agent can use it without changing the data model."

## 12. Close (20 s)
> "Total ongoing infrastructure cost for Oracle is zero: Cloudflare free plan, free IPFS pinning tiers, GitHub Actions on a public repo, and DuckDB running in the browser. Details and the acceptance-criteria map are in SOLUTION.md."
