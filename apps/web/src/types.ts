export type ManifestObject = {
  name: string;
  cid: string;
  codec: "file" | "directory";
  size: number;
  sha256: string | null;
  car?: { file: string; bytes: number; sha256: string; blocks: number; release_asset: string };
  pins: { provider: string; method: string; at: string }[];
  reused_from_previous_run?: boolean;
  gateway_urls: string[];
};

export type Manifest = {
  run_id: string;
  created_at: string;
  root: { cid: string };
  unixfs_profile: string;
  previous_run: { run_id: string; root_cid: string; manifest_cid: string | null } | null;
  ipns: { name: string; label?: string; target_cid?: string; resolved_cid: string | null; resolved_at?: string; query_table_path?: string } | null;
  objects: ManifestObject[];
  counts: Record<string, string>;
};

export type HistoryRun = {
  run_id: string;
  published_at: string;
  root_cid: string;
  manifest_cid: string | null;
  manifest_path: string;
  objects: number;
  new_objects: number;
  counts: Record<string, string>;
  deltas_vs_previous: Record<string, number>;
  previous_run_id: string | null;
  ipns?: { name: string; label?: string; resolved_cid: string | null; resolved_at?: string; note?: string } | null;
};

export type HistoryCheck = { checked_at: string; source: string; window_since: string; rows: number; result: string; current_run_id: string };
export type History = { county: string; state: string; runs: HistoryRun[]; checks?: HistoryCheck[] };

export type RunSummary = {
  run_id: string;
  mode: string;
  started_at: string | null;
  summarized_at: string;
  sources: { key: string; name: string; kind: string; receipt: Record<string, unknown> | null }[];
  counts: Record<string, string>;
  limitations: string[];
};

export type GatewayReport = {
  run_id: string;
  verified_at: string;
  verifier: string;
  gateways: string[];
  objects: number;
  failures: number;
  all_ok: boolean;
  results: { name: string; cid: string; codec: string; gateways: Record<string, { ok: boolean; ms: number; error?: string }> }[];
};

export type LexiconEvidence = {
  county: { county: string; state: string; fips: string };
  group: string;
  cli: { package: string; commit: string };
  manifest_url: string;
  properties: number;
  validate_dir?: { error_rows: number; shards: { shard: number; errors: number; summary: string }[] };
  hash?: { blocks: number; root: string };
  validate_car?: { checks: Record<string, number>; passed: boolean };
  export_tables?: { tables_root: string };
  atlas_entry?: { cid: string; schema: string; tables: string } | null;
  upload?: { archive: Record<string, unknown>; tables: Record<string, unknown> };
  atlas_pr?: { url: string; state: string } | null;
  finished_at?: string;
};
