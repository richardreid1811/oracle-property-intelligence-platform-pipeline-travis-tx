# Travis County, TX — county findings

County-discovery profile (kit skill `county-discovery`). Machine-readable catalog: [`travis-sources.yaml`](./travis-sources.yaml).
Readiness validator (`county-readiness-preflight`): **PASS** on 2026-10-20 (parcel PASS under an approved exception, permit 23/23 classified, destination proven).

Slug `travis`, FIPS `48453`, state `TX`.

## 1. Appraiser (Travis Central Appraisal District, TCAD)

- **Bulk export, no scraping needed.** TCAD publishes the PACS "Legacy 8.0.33" fixed-width appraisal export.
  - 2026 certified export: 557 MB zip, 18 GB unzipped, sha256 `62d0d1cd…aa02`, dated 2026-07-18.
  - Supplemental export: 511 MB, dated 2026-10-08. Republished as supplements post, so it is the incremental feed.
  - A 3.5 GB JSON variant also exists. It is not used.
- **Access.** traviscad.org HTML pages return 403 to non-browser clients. The `wp-content/largefiles/*.zip` URLs return 200 with a browser user agent.
- **Per-property page:** `https://travis.prodigycad.com/property-detail/<PROP_ID>` (True Prodigy). Used as the human provenance link only.
- **Files used:**

  | File | Size | Contents |
  |---|---|---|
  | `PROP.TXT` | 4.9 GB, 9,922-char records | Owner, mailing address, situs, legal, values, deed book/page/date, exemptions, state codes |
  | `IMP_INFO.TXT` | | Improvements |
  | `IMP_DET.TXT` | | Improvement details, including **yr_built** |
  | `IMP_ATR.TXT` | | Attributes, including **Roof Covering** and **Roof Style** per improvement |
  | `TOTALS.TXT` | | Taxing-entity names |
  | `PROP_ENT.TXT` | 9.8 GB | Property-to-entity links. Used only to derive municipality. |

- **Counts (2026 certified, sup 0):**
  - 493,324 records: 442,039 real (`R`), 39,536 business personal property, 11,744 mobile homes, 5 mineral.
  - **441,961 distinct real PROP_IDs.** 112 rows are extra partial-owner rows.
  - 424,072 real rows (96%) carry a deed date.

## 2. Parcel identifier

- **PROP_ID**
  - The roll stores it zero-padded to 12 digits (`000000100008`).
  - GIS, Prodigy and permits use the bare number.
  - The canonical key is the **unpadded decimal string**; the raw value is kept as `prop_id_raw`.
  - It is digits-only by design. The kit's "never key on digits-only" warning targets normalizing *punctuated* IDs, which does not apply here.
- **geo_id**
  - A 10-character string with leading zeros (`0174230307`).
  - Equals GIS `PID_10`/`geo_id` and the Austin permit `tcad_id`.
  - It is the permit-to-parcel join key.
- **Deed date** format: `MM-DD-YYYY`.

## 3. Geometry and coordinates

- **Sources:**
  - Travis County MapServer `TCAD_public/MapServer/0`.
  - City of Austin-hosted `EXTERNAL_tcad_parcel/FeatureServer/0`. Both have 386,682 features, and the hosted layer supports `returnCentroid`.
- **Harvest.** `pipeline/src/sources/tcad-gis-centroids.mjs`, 194 pages × 2,000, concurrency 2: 2m19s, 386,682 of 386,682 reconciled, 0 null centroids.
- **Roll-to-GIS join:**

  | Basis | Parcels |
  |---|---|
  | Own polygon (PROP_ID) | 379,608 |
  | Own polygon (`geo_id` only) | 10,737 |
  | Parent lot centroid (condo unit sharing an 8-char `geo_id` prefix) | 40,405 |
  | No coordinate yet (permit/address geocode pending) | 11,211 |

  6,634 GIS features have no current roll record (retired or split parcels).
- **Discrepancy.**
  - GIS is 12.5% below the assessed roll, above the kit's 2% threshold.
  - Of the 51,616 assessed parcels without a polygon, 46,441 have condo/unit legal descriptions.
  - Approved exception (Oracle operator, 2026-10-20): seed from the roll and never fabricate geometry.

## 4. Permits

Jurisdictions were enumerated from TCAD taxing entities: 22 municipalities plus unincorporated Travis County = 23. Each parcel is assigned to a jurisdiction by its city entity in `PROP_ENT.TXT`.

| Jurisdiction | Parcels | Share | Status | Source |
|---|---|---|---|---|
| Austin | 248,560 | 56.2% | supported | data.austintexas.gov `3syk-w9eu` (Socrata), anonymous, 2,380,939 rows since 1921 |
| Unincorporated | 111,546 | 25.2% | custodian-only | Pre-2014 TNR document search (PDF images); 2014+ MyGovernmentOnline (login) |
| Pflugerville | 23,659 | 5.4% | supported (planned) | `ams.pflugervilletx.gov/PublicAccess`, Guest option present |
| Lago Vista | 13,235 | 3.0% | custodian-only | MGO (login) |
| Lakeway | 10,132 | 2.3% | supported (planned) | Tyler EnerGov Civic Access; reuse kit `tyler-civic-access` |
| Manor | 8,687 | 2.0% | custodian-only | GovWell |
| 17 others | 25,142 | 5.7% | custodian-only / manual-only | MGO, GovBuilt, Round Rock portal, Leander Development Hub, or paper offices |

- **No county roofing permits.** Texas counties have no building-code authority, so unincorporated Travis issues development, septic and driveway permits but **no re-roof permits**. Roof age there falls back to year built and TCAD roof attributes, labelled as such.
- **Automated permit-history coverage:** 66% of parcels: City of Austin (56.2%) plus unincorporated parcels in Austin's ETJ / limited-purpose areas, where Austin issues permits (9.8%). The Pflugerville and Lakeway adapters above were planned but not built.
- **Records requests.** Every custodian-only or manual-only row in `travis-sources.yaml` names a Texas Public Information Act records-first request: office, scope, and portal or email. Rows whose contact is a city homepage are marked `contact_verified: false`. **None have been sent; sending is the Oracle operator's decision.**
- **Austin tags other cities' rows.** The Austin dataset also carries ~20k Austin-issued trade permits (mostly electrical/mechanical) tagged to Lakeway, Bee Cave, West Lake Hills, Rollingwood, The Hills, Sunset Valley and Pflugerville. These are kept as a supplement, not counted as those cities' building history.

### Austin roofing vocabulary

- `work_class = 'Roof'` (64 rows) is **not** roofing. It is mostly electrical work on roofs.
- Roofing is identified from the description: about 65k rows mention "roof"; 22,084 contain "re-roof" / "reroof" / "roof replace".
- **Statuses of the 22,084 re-roof permits:**

  | Status | Count |
  |---|---|
  | Final | 16,629 |
  | VOID | 2,365 |
  | **Expired (never finaled)** | **2,113** |
  | Active | 94 |
  | Withdrawn / Cancelled / Suspended / other | 89 |

  The kit's roof-age profile maps `Expired` to `other`. For lead discovery, expired-unfinaled is the core "long-open permit" signal and is modelled separately.
- **Contractor:** `contractor_company_name` is filled on about 32% of re-roof rows. Trade is often "General Contractor".
- **Incremental key:** permit business dates (status, applied, issued, completed), from the previous run's watermark minus one day. Socrata `:updated_at` is not usable: the portal rewrites it on every row nightly.

## 5. Identity, licensing, enrichment (Texas replacements for the Florida kit stages)

- **Business identity:** Texas Comptroller Active Franchise Tax Permit Holders and Sales Tax Permit Holders (data.texas.gov). These replace Sunbiz; SOSDirect is pay-per-search and is not used.
- **Licensing:** TDLR licenses (data.texas.gov). Texas has **no roofing contractor license**, so the DBPR-style rule ("no license match → write no contractor") would drop every roofer.
  - The permit-listed contractor is kept as permit evidence.
  - It is linked to an official Comptroller entity only when its normalized name matches exactly one franchise-taxpayer name (`identity_status = resolved_exact_name`). Several matches are labelled `ambiguous_<n>_registry_matches`; no address or fuzzy matching is used.
- **BBB:** not ingested. bbb.org returns HTTP 403 to automated requests, robots.txt disallows search and category pagination, and there is no public BBB API, so the kit's `bbb-harvest` was not run (operator decision, 2026-10-20). Contractors carry `bbb_status = excluded_no_public_api_http_403`. The roofing CRM links to BBB's own search and lets reps record ratings they look up themselves.
- **Places:** not ingested. The kit's `overture-places-ingest` was not run; no roofing-lead requirement depends on business POIs, and Travis County business identity comes from the Comptroller files.
- **Ownership:**
  - Texas is a non-disclosure state, so there are no sale prices.
  - Ownership age comes from the deed date.
  - Out-of-area owners come from the mailing address versus Travis County / Austin MSA ZIPs.

## 6. Feasibility and speed

| Source | Mode | Measured / expected |
|---|---|---|
| TCAD export | bulk download | 557 MB in about 1 min; PROP.TXT streamed from the zip in 19 s |
| TCAD GIS centroids | ArcGIS paging | 2m19s for 386,682 |
| Austin permits | Socrata API | 2.38M rows; full pull 19m42s, bounded by Socrata paging (app token recommended); incremental by business-date window, seconds |
| Pflugerville / Lakeway | portal adapters | not built |
| Records-request jurisdictions | TPIA | statutory response 10 business days; not on the demo critical path |

## 7. Risks

- **traviscad.org blocks non-browser HTML requests.** Only direct file links are used.
- **Public IPFS gateways (ipfs.io, dweb.link) rate-limit or stall CLI requests from the operator's network, and since 2026-09-21 serve content only through a browser service worker.** Two-gateway verification therefore runs from GitHub Actions against ipfs.orbitor.dev and dget.top.
- **MGO, GovWell and GovBuilt jurisdictions require accounts.** The pipeline does not create portal accounts.
- **Roof-age coverage is uneven.** Strong evidence (permit completion) exists mainly in Austin; elsewhere it is year built or roof attributes only.
