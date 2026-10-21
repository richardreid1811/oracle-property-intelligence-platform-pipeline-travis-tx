# Elephant publication: Lexicon archives, elephant-cli, Filebase and IPNS

The README requires eligible data to be published to Elephant IPFS "following Lexicon / elephant-cli /
Filebase+IPNS conventions used by the Elephant oracle skills". This pipeline does that in two layers:

1. **Lexicon archives (the Elephant data layer).** Travis County records are transformed into the
   Elephant Lexicon, validated and packed with `elephant-cli`, and uploaded to Filebase, one CAR per
   county per data group, exactly as `use-oracle/reference/car-publication.md` (soofi-xyz-team-kit)
   prescribes. Each archive gets an entry in the Atlas county page `atlas/counties/TX/travis.json`;
   the Atlas registration pull request is prepared but on hold by operator decision (section 3).
2. **Snapshot + IPNS (the query layer).** Every run's DuckDB-ready Parquet snapshot is listed in a
   manifest; its files are pinned on Filebase and Pinata, its directory roots on Filebase with a CAR
   in the run's GitHub Release; the IPNS name `oracle-open-data-travis` (Filebase
   names API, `elephant-xyz/skills` `county-open-data-publish` convention) is re-pointed at each new run.

## 1. Lexicon archives

### Data groups

| Group | Properties | Source | Lexicon classes written |
|---|---|---|---|
| `county` (+ Seed) | every assessed property in the TCAD roll | TCAD appraisal export, Travis County parcel map | property, address, parcel, geometry, structure, tax, sales_history, deed, person, company, mailing address |
| `property_improvement` (+ Seed) | properties with a linked City of Austin roofing permit | City of Austin Issued Construction Permits (Socrata `3syk-w9eu`), Texas Comptroller registry | property, address, parcel, property_improvement, company (contractor) |

Every property directory carries the Seed group (address + parcel), so the same property gets the
same CID in every archive.

### Commands (per group)

`pipeline/src/lexicon/transform.mjs` writes one ZIP per property; `pipeline/src/lexicon/publish-group.mjs`
then runs, in order, stopping at the first failure:

```bash
elephant-cli validate <group-dir> --output-csv errors.csv          # every property, live lexicon
elephant-cli hash <group-dir> --output-zip hashed --output-csv hash.csv --output-car travis-<group>.car
elephant-cli validate travis-<group>.car --output-csv car-errors.csv # integrity, root, index, graph, lexicon, orphans
elephant-cli export-tables travis-<group>.car --output travis-<group>-tables --part-size 1g \
  --atlas-page atlas/counties/TX/travis.json --county travis --state TX --fips 48453
elephant-cli upload travis-<group>.car --api https://rpc.filebase.io            # with gateway readback
elephant-cli upload travis-<group>-tables --api https://rpc.filebase.io
```

Directory validation runs as a pool of validator processes over shards of the group (the kit's
scaling note); the checks are identical. The CLI is pinned to `elephant-xyz/elephant-cli` `main`
at `44bb182b9f7f904662e9b33e1fde70bdeab62322` (`tools/elephant-cli`), as the kit requires (the npm
release lacks CAR hash/validate/upload and `export-tables`). The lexicon manifest is read live from
`https://lexicon.elephant.xyz/api/manifest`; data-group schema CIDs are resolved at run time.

Evidence for every step (CSV error counts, `CAR written` line, the six CAR check counts, tables
root, upload summaries with the gateway that served each root, CLI commit, manifest URL) is
written to `runs/lexicon/<group>.json`. The Atlas page entry is in `atlas/counties/TX/travis.json`.

### Status (2026-10-21)

| Group | Result | Evidence |
|---|---|---|
| `property_improvement` | 16,217 properties validated in 6 shards, 0 errors; CAR of 146,207 blocks; all six CAR checks (integrity, root, index, graph, lexicon, orphans) passed; archive root `baguqeeraabcjfnhgmvywt4lmkldznv4jgd2bw7azec4ujpnie2w46vrmf4tq`; tables root `baguqeeraddzenc37adtill3pzcxgcjanaqha5xwrnxrgbirb23qhelnmataa` (9 parts); both uploaded to Filebase at 15:51 UTC; Atlas page entry written | `runs/lexicon/property_improvement.json`, `atlas/counties/TX/travis.json` |
| `county` | directory validation still running (expected to finish later on 2026-10-21); hashed, CAR-validated and uploaded after that | none yet |

A run's manifest lists the Lexicon archive and tables roots (`lexicon/<group>/archive`,
`lexicon/<group>/tables`) from the first run published after the upload. Runs 6 and 7
(`20261021T150751Z`, `20261021T154604Z`) predate the `property_improvement` upload, so their
manifests do not list it.

Second copy and gateway checks. Both CARs are attached to the GitHub Release
`lexicon-property_improvement` (`runs/lexicon/property_improvement.json` › `release`), so anyone can
`ipfs dag import` them and get the same roots. Run 8's gateway check (`20261021T162552Z`) asked the
independent gateways for the whole DAG (`dag-scope=all`) and failed on all four Lexicon checks
(two roots on each of two gateways): two timeouts at 120 s on ipfs.orbitor.dev, and on dget.top
one 403 and one timeout. A 146,207-block archive, or a tables root and the Parquet parts it links
to, cannot be crawled within one gateway request. The checks now fetch each root block
(`dag-scope=block`) and re-hash it against its CID. elephant-cli's CAR validation and the release
CAR are what prove every block.

### Provenance

Every entity carries the exact request its data came from, never a reconstructed one:

| Entity | `source_http_request` | `request_identifier` |
|---|---|---|
| property, address, parcel, structure, tax, sales history, deed, owners | GET of the TCAD export ZIP the roll was read from | TCAD property id |
| geometry | the ArcGIS FeatureServer page request that returned the parcel centroid | TCAD property id |
| property_improvement | the Socrata API request that returned the permit row | permit number |
| contractor company | the Texas Comptroller franchise-taxpayer dataset request | Texas taxpayer number |

Query strings are carried in `multiValueQueryString`, as the lexicon's URL pattern requires.

### Mapping decisions and lexicon gaps

Values are written only where the lexicon has an exact home; anything else is left out (null),
never guessed.

- **County name.** `Travis` is not yet in the lexicon's county enums (`address.county_name`,
  `unnormalized_address.county_jurisdiction`); lexicon PR
  [elephant-xyz/lexicon#194](https://github.com/elephant-xyz/lexicon/pull/194) adds it and is not
  merged. `county_name` is optional on `address`, so it is omitted, and the Seed group uses
  `address_has_parcel` (the `unnormalized_address` class, which requires the enum, is not used).
- **Property type.** Texas PTAD state codes map to `property_type` / `property_usage_type`
  (A1 SingleFamily, A2 ManufacturedHome, A4 Condominium, B2 Duplex, B3 3Units, B4 4Units,
  C1 VacantLand, D1 LandParcel/Agricultural, F1 Building/Commercial, …); codes without an exact
  match fall back to the generic `MiscellaneousResidential`, `Building` or `LandParcel`.
- **Roof.** `roof_material_type` from TCAD roof covering (Composition, Metal, Tile, Wood),
  `roof_covering_material` only where exact (Built-Up Roof, Wood Shingle), `roof_design_type` from
  roof style (Hip, Gable, Flat, Mansard, Gambrel). `roof_age_years` and `roof_date` are written
  **only** from re-roof permit evidence (finaled or issued); a year-built estimate is not a roof
  date. The lexicon has no roof-age confidence field (gap).
- **Owners.** TCAD's last deed date and book/page become `sales_history` + `deed`; the owners of
  record are its grantees (`sales_history_has_person` / `_has_company`). Individuals are parsed
  from TCAD's "LAST FIRST MIDDLE" form; names that cannot be read unambiguously are left
  unlinked rather than guessed. Texas does not disclose sale prices, so `purchase_price_amount`
  is absent. Confidential (withheld) mailing addresses are not written.
- **Coordinates.** `geometry` is written only for a parcel's own GIS centroid; condo units that
  borrow their building lot's centroid in the query layer get no geometry here.
- **Taxes.** The appraisal export has values, not tax bills: `property_market_value_amount` and
  `property_assessed_value_amount` for the roll year; tax amounts are null.
- **Permits.** `improvement_type` Roofing, `improvement_action` Replacement / Repair, status
  Completed / Permitted / Cancelled. "Expired without a final inspection" has no lexicon status
  (gap): its status is null, and the missing completion and close dates carry the fact.
- **Contractors.** A company is linked (`property_improvement_has_contractor`) only when the
  permit's contractor resolves to exactly one Texas Comptroller franchise taxpayer (official
  identity, as the kit requires for company edges). Texas has no Sunbiz, so
  `sunbiz_document_number` is null; the Texas taxpayer number has no lexicon field (gap) and is the
  record's `request_identifier`. Unresolved contractors are not written.
- **Not in the lexicon archives:** hail exposure, owner-region labels, roof-age confidence,
  permit-history coverage labels, embeddings. They remain in the query-layer tables
  (`docs/data-contract.md`).

## 2. IPNS

Convention (`elephant-xyz/skills` `county-open-data-publish`, `county-query-table-publish`): one
Filebase IPNS label per county per dataset, created and re-pointed through
`https://api.filebase.io/v1/names` on every publish, verified by resolving through a gateway and
reading `x-ipfs-roots`.

| Label | Name | Points at |
|---|---|---|
| `oracle-open-data-travis` | `k51qzi5uqu5dme32gxohimdgqm9s09u1dzud92xhdp7fpg38xz201064yq8noj` | the latest run's root CID |

Filebase's free plan allows one IPNS name, so the query table (`oracle-query-table-<county>` in
the convention) is addressed by path under the same name:
`/ipns/<name>/tables/leads.parquet` (verified to return a Parquet file). Each run's manifest
records the name, the CID it was pointed at and the CID it resolved to (`ipns`); the run history
records the same per run. The Lexicon archives are not given a county IPNS name: the kit routes
them through Atlas, whose global IPNS name `elephant-atlas` is re-pointed by Elephant on merge.

## 3. Atlas registration

`elephant-cli export-tables --atlas-page` writes `atlas/counties/TX/travis.json` (one entry per
group: archive root `cid`, data-group `schema`, `tables` root). Registration is a pull request to
[elephant-xyz/atlas](https://github.com/elephant-xyz/atlas) (branch `publish/tx-travis`, title
`Publish TX travis county`) that an Elephant code owner merges; on merge Elephant copies the
archive into its own Filebase account and re-points the global Atlas IPNS. The page entry for
`property_improvement` is written; the pull request is prepared but not opened (on hold by
operator decision), so no archive is listed in Atlas yet.

## 4. Human gate

Elephant's publish skills gate bulk PII to public IPFS on a human approval per county. Uploads of
the Lexicon archives run only when `runs/publication-approval.json` approves county `travis`.
