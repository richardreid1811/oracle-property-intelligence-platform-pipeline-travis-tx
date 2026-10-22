# Data contract: Travis County Oracle snapshot

This is the interface between the Oracle pipeline and its consumers: the roofing CRM, agents, and the MCP server. A consumer can rely on everything here without knowing how the pipeline works.

- Each pipeline run publishes an **immutable snapshot**. Its root CID and artifact manifest are listed in [`runs/history.json`](../runs/history.json) and `runs/<run>/manifest.json`.
- Tables are Parquet files, addressed **by CID**. Gateway URLs are only convenience locators.
- `pipeline/src/publish/check-contract.mjs` checks the column lists below against a published snapshot, so this document cannot drift from the data.

**How to consume**

| Consumer | How |
|---|---|
| Browser / CRM front end | DuckDB-WASM `read_parquet('<gateway>/ipfs/<cid>')` with CIDs from the latest manifest; or reuse `packages/query-tools` (the same SQL the reference UI runs) |
| Agent / CRM back end | MCP server `mcp/server.mjs` (stdio): tools below plus read-only `run_sql`; resources `travis-oracle://manifest` and `travis-oracle://run` |
| Offline / third party | `node pipeline/src/publish/fetch-snapshot.mjs runs/<run>/manifest.json <dir>` downloads every file by CID and verifies its sha256 |

**Conventions**

- **Keys:**
  - `prop_id` is the TCAD property ID as an unpadded decimal string. It is stable across runs and is the CRM's lead anchor.
  - `permit_key` is `austin:<permit_number>`.
  - `contractor_key` is `contractor:<md5(normalized name)>`.
- **Dates** are ISO `DATE`. Durations are not stored: compute "open for N days" as `date_diff('day', opened_date, <as of>)`, so a snapshot never goes stale. The shared tools take `<as of>` from the snapshot (`_as_of`, the run id's date, set by the UI and MCP server), so one snapshot always returns the same rows; ad-hoc SQL can use `current_date`.
- **Coordinates** are WGS84 decimal degrees. Always read `coordinate_basis` alongside them.
- **Provenance:** every row has a `source_detail_url` (the record's page at TCAD or the City of Austin) and/or a `source_url` (the exact API request). Source receipts (URLs, digests, counts, timestamps) are in `run.json` under the snapshot root.
- **Missing evidence** is null, never zero. Each of the following columns says why a value exists or is absent: `roof_age_basis`, `roof_age_confidence`, `coordinate_basis`, `link_basis`, `identity_status`, `bbb_status`, `permit_history_coverage`.
- **Change policy:**
  - Adding a column is non-breaking.
  - Removing or renaming a column, or changing an enum, is a breaking change announced here.
  - Each run's `deltas.json` (under the snapshot root) reports added, changed and removed records and any schema changes.

## Tools (shared by UI, agent and MCP)

| Tool | Purpose | Key inputs | Returns |
|---|---|---|---|
| `resolve_place` | Place name → center point (city/village, ZIP, Austin landmark) | `name` | name, kind, latitude, longitude |
| `aged_roofs_near` | Properties in a radius with roofs strictly older than the threshold, permit-verified first | `place` or `latitude`/`longitude`, `radius_miles` (5), `older_than_years` (15; alias `min_roof_age_years`), `residential_only` (false) | lead rows + `total_matches` |
| `open_roofing_permits_near` | Open or never-finaled roofing permits, longest-open first, with contractor | location, `radius_miles`, `min_open_years`, `issued_since` | permit rows + `total_matches` |
| `hail_exposed_roofs_near` | Properties whose current roof was hit by hail in a time window (NOAA reports joined at query time; reports before the roof year are ignored) | location, `radius_miles`, `since` (3 years ago), `min_hail_inches` (1.75), `event_radius_miles` (1, max 3), optional `older_than_years` | lead rows with `hail_reports`, `max_hail_inches`, `last_hail_date` + `total_matches` |
| `semantic_search_permits` | Meaning-based search over roofing permit descriptions | `query`, optional location/radius, `open_only` | permit rows with `similarity` |
| `stale_ownership_near` | No ownership change in more than N years (exact, from `deed_date`) | location, `radius_miles`, `min_years` (10) | lead rows with `years_since_deed`, `owner_property_count` |
| `absentee_owners_near` | Owner mails tax bills outside the area | location, `radius_miles`, `regions` | lead rows |
| `property_detail` | One property with all its roofing permits | `prop_id` | lead row + `roofing_permits` list |
| `dataset_summary` | Row counts of loaded tables | — | table, rows |

All tools attach `bbb_lookup_url` to rows that name a contractor (see `bbb_status`). Coordinates outside the Travis County area are rejected, never clamped.

## Enumerations

| Column | Values |
|---|---|
| `roof_age_basis` | `permit_final_roof_replacement`, `permit_issued_roof_replacement_unfinaled`, `tcad_year_built_assumes_original_roof`, `unknown` |
| `roof_age_confidence` | `high` (finaled re-roof permit), `medium` (issued, not finaled), `low` (year built), `very_low` (year built more than 50 years ago), `none` |
| `status_bucket` | `open`, `expired_unfinaled` (expired without a final inspection: the long-open lead signal), `closed`, `void` |
| `roofing_work` | `roof_replacement`, `roof_repair`, `roof_mention` (Building Permits only); null = not roofing |
| `coordinate_basis` | `own_parcel_centroid`, `parent_parcel_centroid` (condo unit → parent lot), `none` |
| `owner_mail_region` | `travis_county`, `austin_metro`, `texas_other`, `out_of_state`, `international`, `unknown` |
| `identity_status` | `resolved_exact_name`, `ambiguous_<n>_registry_matches`, `unresolved_no_registry_match`, `pending_registry_refresh` |
| `bbb_status` | `excluded_no_public_api_http_403` (earlier runs: `blocked_http_403_pending_bbb_api`) |
| `registry_link` | `business_registry_exact_name`, `business_registry_ambiguous`, `no_business_registry_match` |
| `link_basis` | `tcad_id=geo_id`, `tcad_id=geo_id+address (<n> parcels share geo_id)`, `tcad_id=geo_id (ambiguous <n>, lowest prop_id)`, `tcad_id=prop_id`; null = permit not linked to a current parcel |
| `permit_history_coverage` | `austin_permit_history_1978_plus`, `austin_etj_or_limited_purpose_permits` (unincorporated parcels where the City of Austin issues permits), `lakeway_permit_history` (City of Lakeway permits from its public Tyler EnerGov portal), `no_county_building_permits_in_texas`, `municipal_permits_not_yet_ingested` |

## Tables

### leads
`tables/leads.parquet`: one row per assessed property, denormalized for lead search. This is the CRM's primary table.

| Column | Type | Meaning |
|---|---|---|
| `prop_id` | VARCHAR | TCAD property ID (key) |
| `geo_id` | VARCHAR | TCAD geographic ID; equals the City of Austin permit `tcad_id` |
| `situs_address` | VARCHAR | Property street address with number and unit |
| `situs_zip` | VARCHAR | Property ZIP |
| `jurisdiction` | VARCHAR | Municipality, or `TRAVIS COUNTY (UNINCORPORATED)` |
| `latitude` | DOUBLE | WGS84 latitude |
| `longitude` | DOUBLE | WGS84 longitude |
| `coordinate_basis` | VARCHAR | How the coordinate was derived (enum) |
| `owner_name` | VARCHAR | Owner of record (TCAD) |
| `owner_count` | BIGINT | Number of owner records (partial ownership) |
| `mail_city` | VARCHAR | Owner mailing city |
| `mail_state` | VARCHAR | Owner mailing state |
| `mail_zip` | VARCHAR | Owner mailing ZIP |
| `owner_mail_region` | VARCHAR | Where the owner's tax bill goes (enum) |
| `mails_to_property` | BOOLEAN | The mailing address repeats the property address |
| `owner_occupied_homestead` | BOOLEAN | Homestead exemption granted (owner-occupied) |
| `deed_date` | DATE | Last deed date; null if missing or invalid in source. Tenure is computed at query time as whole years since this date |
| `owner_key` | VARCHAR | Reconciled owner entity (link to `owners`) |
| `owner_property_count` | BIGINT | Properties held by the same owner entity in Travis County (portfolio size) |
| `year_built` | INTEGER | Year built of the main improvement (TCAD) |
| `roof_year` | BIGINT | Estimated year of the current roof |
| `roof_age_years` | INTEGER | Estimated roof age as of the snapshot year |
| `roof_age_basis` | VARCHAR | Evidence for `roof_year` (enum) |
| `roof_age_confidence` | VARCHAR | Confidence in `roof_year` (enum) |
| `evidence_permit_key` | VARCHAR | Permit that dates the roof, when permit-based |
| `roof_covering` | VARCHAR | TCAD roof covering (e.g. `COMPOSITIO`, `METAL`, `TILE`) |
| `roof_style` | VARCHAR | TCAD roof style (e.g. `HIP`, `GABLE`, `FLAT`) |
| `permit_history_coverage` | VARCHAR | Whether permit history exists for this jurisdiction (enum) |
| `open_roofing_permits` | BIGINT | Number of open or never-finaled roofing permits on the parcel |
| `oldest_open_date` | DATE | Opened date of the oldest such permit |
| `oldest_open_permit` | VARCHAR | Permit number of the oldest such permit |
| `oldest_open_contractor` | VARCHAR | Contractor named on the oldest such permit |
| `market_val` | BIGINT | TCAD market value (USD) |
| `imprv_state_cd` | VARCHAR | Texas PTAD state code of the improvement (`A*` single-family, `B*` multifamily, …) |
| `severe_hail_reports_since_roof` | BIGINT | NOAA hail reports of 1.75 inches or more (golf ball) within 1 mile, in or after `roof_year`; 0 if none or if `roof_year` is null |
| `max_hail_inches_since_roof` | DOUBLE | Largest hail (1 inch or more) reported within 1 mile since `roof_year`; null if none |
| `last_severe_hail_date_since_roof` | DATE | Most recent severe report counted in `severe_hail_reports_since_roof` |
| `source_detail_url` | VARCHAR | TCAD property page |

### roofing_permits
`tables/roofing_permits.parquet`: City of Austin permits with roofing work. It has the same columns as `permits` except `year` (below).

### permits
`tables/permits/year=YYYY/part0.parquet`: every City of Austin permit (2.38M) and every City of Lakeway permit from its public portal, partitioned by opened year. The partition column `year` exists only in the folder name.

| Column | Type | Meaning |
|---|---|---|
| `permit_key` | VARCHAR | `austin:<permit_number>` or `lakeway:<permit_number>` (key) |
| `issuing_authority` | VARCHAR | `City of Austin` or `City of Lakeway` |
| `permit_number` | VARCHAR | Permit number as issued |
| `permit_type` | VARCHAR | Type code (`BP` building, `EP` electrical, `MP` mechanical, `PP` plumbing, …) |
| `permit_type_desc` | VARCHAR | Type description |
| `permit_class_mapped` | VARCHAR | Residential / Commercial |
| `permit_class` | VARCHAR | Detailed class |
| `work_class` | VARCHAR | Work class as issued (note: `Roof` is mostly electrical work on roofs) |
| `description` | VARCHAR | Work description (free text) |
| `tcad_id` | VARCHAR | Parcel ID recorded on the permit |
| `applied_date` | DATE | Applied |
| `issued_date` | DATE | Issued |
| `status_date` | DATE | Last status change |
| `expires_date` | DATE | Expiry |
| `completed_date` | DATE | Final inspection / completion |
| `status` | VARCHAR | Status as issued (`Final`, `Expired`, `Active`, …) |
| `address` | VARCHAR | Permit address |
| `city` | VARCHAR | Permit city |
| `zip` | VARCHAR | Permit ZIP |
| `source_jurisdiction` | VARCHAR | Jurisdiction tag from the source (e.g. `AUSTIN FULL PURPOSE`) |
| `project_id` | VARCHAR | City project/folder ID |
| `masterpermitnum` | VARCHAR | Master permit for companion permits |
| `latitude` | DOUBLE | Permit location latitude (Austin: source; Lakeway: the linked parcel's centroid, the portal has no coordinates) |
| `longitude` | DOUBLE | Permit location longitude (Austin: source; Lakeway: the linked parcel's centroid) |
| `job_valuation` | DOUBLE | Declared job valuation (USD) |
| `contractor_company_name` | VARCHAR | Contractor as listed on the permit |
| `contractor_full_name` | VARCHAR | Contractor contact as listed |
| `contractor_trade` | VARCHAR | Contractor trade as listed |
| `contractor_phone` | VARCHAR | Digits only |
| `contractor_address` | VARCHAR | Contractor street address |
| `contractor_city` | VARCHAR | Contractor city |
| `contractor_zip` | VARCHAR | Contractor ZIP |
| `source_detail_url` | VARCHAR | City of Austin permit page |
| `source_url` | VARCHAR | Exact Socrata API request that returned the row |
| `socrata_id` | VARCHAR | Socrata row ID |
| `fetched_at` | VARCHAR | Harvest timestamp (ISO) |
| `roofing_work` | VARCHAR | Roofing classification (enum) |
| `status_bucket` | VARCHAR | Normalized status (enum) |
| `opened_date` | DATE | Issued date, else applied date |
| `closed_date` | DATE | Completion date when closed |
| `prop_id` | VARCHAR | Linked TCAD property; null = valid but unlinked |
| `link_basis` | VARCHAR | How `prop_id` was linked (enum) |
| `window_source` | VARCHAR | Harvest that produced the row: `full` or `window><date>` (Austin), `lakeway` (Lakeway) |
| `county_fips` | VARCHAR | County of the permit (48453 = Travis) |
| `contractor_key` | VARCHAR | Link to `contractors` |
| `source_request_json` | VARCHAR | Lakeway only: the exact JSON body of the portal search POST that returned the row (`source_url` is its endpoint); null for Austin |

### contractors
`tables/contractors.parquet`: contractors deduplicated across permits.

| Column | Type | Meaning |
|---|---|---|
| `contractor_key` | VARCHAR | Key |
| `name_norm` | VARCHAR | Normalized name used for deduplication and matching |
| `display_name` | VARCHAR | Most frequent name as written on permits |
| `city` | VARCHAR | Most frequent contractor city |
| `zip` | VARCHAR | Most frequent contractor ZIP |
| `permit_count` | BIGINT | Permits naming this contractor |
| `roofing_permit_count` | BIGINT | Roofing permits naming this contractor |
| `first_permit` | DATE | Earliest permit opened |
| `last_permit` | DATE | Latest permit opened |
| `taxpayer_number` | VARCHAR | Texas Comptroller taxpayer number when resolved |
| `sos_file_number` | VARCHAR | Texas Secretary of State file number when resolved |
| `legal_name` | VARCHAR | Registered legal name when resolved |
| `right_to_transact_business` | VARCHAR | Comptroller right-to-transact code |
| `identity_status` | VARCHAR | Registry resolution outcome (enum) |
| `bbb_rating` | VARCHAR | BBB letter rating; null (see `bbb_status`) |
| `bbb_status` | VARCHAR | Why there is no rating (enum) |
| `phones` | VARCHAR | Up to five phones, `;`-separated |
| `trades` | VARCHAR | Trades listed on permits, `;`-separated |
| `tdlr_licenses` | VARCHAR | Matching TDLR licenses (`type number`), `;`-separated |

### permit_embeddings
`tables/permit_embeddings.parquet`: vectors for semantic retrieval over `roofing_permits`. Present from the first run after semantic search was added.

| Column | Type | Meaning |
|---|---|---|
| `permit_key` | VARCHAR | Key into `roofing_permits` |
| `text_sha256` | VARCHAR | SHA-256 of the exact text embedded (description, work class, status, contractor, address, year) |
| `model` | VARCHAR | `Xenova/bge-small-en-v1.5` (q8, CLS pooling, normalized) |
| `embedding` | TINYINT[] | int8-quantized unit vector, always 384 values (Parquet stores it as a list); compare with `array_cosine_similarity(embedding::FLOAT[384], query_vec)` where the query is embedded by the same model with the BGE query prefix |

### properties
`tables/properties.parquet`: the full TCAD roll record per property (superset of `leads` property fields).

| Column | Type | Meaning |
|---|---|---|
| `prop_id` | VARCHAR | Key |
| `prop_id_raw` | VARCHAR | Zero-padded ID as in the TCAD export |
| `geo_id` | VARCHAR | Geographic ID |
| `situs_address` | VARCHAR | Property address |
| `situs_city` | VARCHAR | Situs city (often blank in source; use `jurisdiction`) |
| `situs_zip` | VARCHAR | Situs ZIP |
| `legal_desc` | VARCHAR | Legal description |
| `jurisdiction` | VARCHAR | Municipality or unincorporated |
| `imprv_state_cd` | VARCHAR | Improvement state code |
| `land_state_cd` | VARCHAR | Land state code |
| `owner_name` | VARCHAR | Owner of record |
| `owner_dba` | VARCHAR | Doing-business-as |
| `owner_count` | BIGINT | Owner records |
| `owner_address_withheld` | BOOLEAN | Confidential owner address (Tax Code §25.025); address fields null |
| `mail_line1` | VARCHAR | Mailing address line 1 |
| `mail_line2` | VARCHAR | Mailing address line 2 |
| `mail_line3` | VARCHAR | Mailing address line 3 |
| `mail_city` | VARCHAR | Mailing city |
| `mail_state` | VARCHAR | Mailing state |
| `mail_zip` | VARCHAR | Mailing ZIP |
| `mail_country` | VARCHAR | Mailing country |
| `deed_date` | DATE | Deed date (validated) |
| `deed_date_raw` | VARCHAR | Deed date as in source |
| `deed_book` | VARCHAR | Deed book |
| `deed_page` | VARCHAR | Deed page |
| `homestead_exempt` | BOOLEAN | Homestead exemption |
| `over65_exempt` | BOOLEAN | Over-65 exemption |
| `market_val` | BIGINT | Market value |
| `appraised_val` | BIGINT | Appraised value |
| `assessed_val` | BIGINT | Assessed value |
| `year_built` | INTEGER | Year built (main improvement) |
| `year_built_basis` | VARCHAR | `tcad_main_floor_yr_built` or `tcad_largest_detail_yr_built` |
| `main_area_sqft` | DOUBLE | Main living area |
| `roof_covering` | VARCHAR | TCAD roof covering |
| `roof_style` | VARCHAR | TCAD roof style |
| `longitude` | DOUBLE | WGS84 longitude |
| `latitude` | DOUBLE | WGS84 latitude |
| `coordinate_basis` | VARCHAR | Coordinate derivation (enum) |
| `source_url` | VARCHAR | TCAD export file |
| `source_sha256` | VARCHAR | SHA-256 of that export |
| `source_detail_url` | VARCHAR | TCAD property page |

### roof_age
`tables/roof_age.parquet`: roof estimate per property (also denormalized into `leads`).

| Column | Type | Meaning |
|---|---|---|
| `prop_id` | VARCHAR | Key |
| `roof_year` | BIGINT | Estimated roof year |
| `roof_age_basis` | VARCHAR | Evidence (enum) |
| `roof_age_confidence` | VARCHAR | Confidence (enum) |
| `evidence_permit_key` | VARCHAR | Dating permit, if any |
| `roof_covering` | VARCHAR | TCAD roof covering |
| `roof_style` | VARCHAR | TCAD roof style |
| `permit_history_coverage` | VARCHAR | Coverage (enum) |
| `roof_age_years` | INTEGER | Roof age as of the snapshot year |

### owner_signals
`tables/owner_signals.parquet`: ownership-tenure and absentee signals per property.

| Column | Type | Meaning |
|---|---|---|
| `prop_id` | VARCHAR | Key |
| `deed_date` | DATE | Last deed date |
| `owner_occupied_homestead` | BOOLEAN | Homestead exemption |
| `mails_to_property` | BOOLEAN | Mailing address is the property |
| `owner_mail_region` | VARCHAR | Mailing region (enum) |
| `owner_mail_county_fips` | VARCHAR | County FIPS of the mailing ZIP |
| `owner_key` | VARCHAR | Reconciled owner entity (link to `owners`) |

### owners
`tables/owners.parquet`: owners reconciled across properties. One entity per normalized owner name and mailing address (legal-form suffixes, punctuation and spacing normalized), linked to the Texas Comptroller registry when the name matches exactly one Travis County taxpayer.

| Column | Type | Meaning |
|---|---|---|
| `owner_key` | VARCHAR | `owner:<md5(normalized name, mailing address, ZIP)>` (key) |
| `owner_name` | VARCHAR | Owner name as recorded |
| `name_norm` | VARCHAR | Normalized name used for reconciliation |
| `mail_city` | VARCHAR | Mailing city |
| `mail_state` | VARCHAR | Mailing state |
| `mail_zip` | VARCHAR | Mailing ZIP |
| `property_count` | BIGINT | Properties held (portfolio size) |
| `total_market_val` | BIGINT | Sum of TCAD market values (USD) |
| `taxpayer_number` | VARCHAR | Comptroller taxpayer number when `registry_link` is exact |
| `registry_link` | VARCHAR | Link to `businesses` (enum) |

### hail_events
`tables/hail_events.parquet`: NOAA NCEI Storm Events hail reports in and around Travis County (county extent plus ~10 miles), 1996 to present. Source of the `hail_*` lead columns.

| Column | Type | Meaning |
|---|---|---|
| `event_id` | VARCHAR | NOAA event ID (key) |
| `episode_id` | VARCHAR | NOAA episode ID |
| `event_date` | DATE | Report date |
| `latitude` | DOUBLE | Report latitude |
| `longitude` | DOUBLE | Report longitude |
| `hail_inches` | DOUBLE | Hail size (inches) |
| `county_zone` | VARCHAR | NOAA county/zone name |
| `report_source` | VARCHAR | Who reported it (spotter, public, law enforcement, …) |
| `source_url` | VARCHAR | NOAA yearly details file the row came from |

### business_locations
`tables/business_locations.parquet`: Overture Maps places (business and point-of-interest locations) inside the Census TIGER/Line Travis County boundary, from a pinned Overture release. Overture is a numerator, not a census of all businesses. Licence: Overture Maps Foundation (CDLA-Permissive-2.0) with per-provider terms (`license_url`); no OpenStreetMap rows (licence gate).

| Column | Type | Meaning |
|---|---|---|
| `gers_id` | VARCHAR | Overture GERS ID (key) |
| `overture_version` | INTEGER | Overture feature version |
| `name` | VARCHAR | Primary name |
| `taxonomy_primary` | VARCHAR | Most specific Overture category |
| `taxonomy_hierarchy` | VARCHAR | Category path, broad to specific, joined with ` > ` |
| `basic_category` | VARCHAR | Coarse Overture category |
| `operating_status` | VARCHAR | Overture operating status |
| `confidence` | DOUBLE | Overture existence confidence (0-1) |
| `brand_name` | VARCHAR | Brand, when known |
| `address` | VARCHAR | Street address as supplied |
| `locality` | VARCHAR | City |
| `zip` | VARCHAR | 5-digit ZIP |
| `latitude` | DOUBLE | WGS84 latitude |
| `longitude` | DOUBLE | WGS84 longitude |
| `providers` | VARCHAR | Source datasets, `;`-separated (lower-case) |
| `website` | VARCHAR | First website |
| `phone` | VARCHAR | First phone |
| `prop_id` | VARCHAR | TCAD property when the street address and ZIP match exactly one parcel's situs address |
| `parcel_link_basis` | VARCHAR | `exact_situs_address_unique` or null |
| `business_key` | VARCHAR | Link to `businesses` when name and street address match exactly one Comptroller business |
| `business_link_basis` | VARCHAR | `exact_name_and_address_unique` or null |
| `overture_release` | VARCHAR | Overture release the row came from |
| `license_url` | VARCHAR | Attribution and licence terms |

### businesses
`tables/businesses.parquet`: Travis County businesses (Texas Comptroller sales-tax outlets and franchise taxpayers).

| Column | Type | Meaning |
|---|---|---|
| `business_key` | VARCHAR | `txcpa:<taxpayer>[:<outlet>]` |
| `taxpayer_number` | VARCHAR | Comptroller taxpayer number |
| `business_name` | VARCHAR | Outlet or taxpayer name |
| `legal_name` | VARCHAR | Taxpayer legal name |
| `address` | VARCHAR | Address |
| `city` | VARCHAR | City |
| `zip` | VARCHAR | ZIP |
| `naics` | VARCHAR | NAICS industry code (outlets) |
| `sales_tax_permit_issued` | VARCHAR | Sales-tax permit issue date |
| `sos_file_number` | VARCHAR | Secretary of State file number |
| `organization_type` | VARCHAR | Organization type code |
| `source` | VARCHAR | `tx_comptroller_sales_tax_outlet` or `tx_comptroller_franchise_taxpayer` |
| `source_url` | VARCHAR | Exact API request |
| `fetched_at` | TIMESTAMP | Harvest time |

### licenses
`tables/licenses.parquet`: TDLR contractor-class licenses (statewide). Texas does not license roofing contractors.

| Column | Type | Meaning |
|---|---|---|
| `license_type` | VARCHAR | License type |
| `license_number` | VARCHAR | License number |
| `license_subtype` | VARCHAR | Subtype |
| `business_name` | VARCHAR | Business name |
| `owner_name` | VARCHAR | License holder |
| `business_address_line1` | VARCHAR | Address |
| `business_city_state_zip` | VARCHAR | City, state, ZIP |
| `business_county` | VARCHAR | County |
| `business_telephone` | VARCHAR | Phone |
| `license_expiration` | VARCHAR | Expiration (MMDDCCYY) |
| `source_url` | VARCHAR | Exact API request |
| `fetched_at` | TIMESTAMP | Harvest time |

## Run-level files (under each snapshot root)

| File | Content |
|---|---|
| `run.json` | Run ID, mode, sources with receipts (URL, digest, counts, timestamps), counts, corrections, record-level deltas, limitations |
| `deltas.json` | Added, removed and changed properties and permits versus the previous run, plus schema changes |
| `coverage.json` | Dataset counts |
| `samples/*.csv` | Small human-readable extracts |

## Change log

| Effective | Change | Type |
|---|---|---|
| run after 20261020T225920Z | Added City of Lakeway permits (`issuing_authority` `City of Lakeway`, column `source_request_json`, coverage value `lakeway_permit_history`) and the `business_locations` table (Overture places) | additive |
| run after 20261020T223321Z | Added `hail_events` and the lead columns `severe_hail_reports_since_roof`, `max_hail_inches_since_roof`, `last_severe_hail_date_since_roof`; new `permit_history_coverage` value `austin_etj_or_limited_purpose_permits` | additive |
| run after 20261020T194930Z | Removed `years_since_deed` from `leads` and `owner_signals`: tenure is computed at query time so snapshots do not change with the calendar. Tools still return it | breaking |
| run after 20261020T194930Z | Removed the `tiles/leads/` index directory (unused by any consumer) | breaking |
| run after 20261020T194930Z | Added `owners`, `leads.owner_key`, `leads.owner_property_count`, `owner_signals.owner_key`, `permit_embeddings` | additive |
| run after 20261020T194930Z | `status_bucket`: statuses such as `Cancelled - …`, `Aborted`, `Denied but Closed`, `Revoked`, `Rejected` now map to `void`; `Expired - License` maps like `Expired` | correction |
| 20261020T194930Z | Removed `open_days` and `max_open_days` (computed at query time); added `oldest_open_date` | breaking |
