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
  ipns: { name: string; resolved_cid: string } | null;
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
