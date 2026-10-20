// Shared text embedder for semantic retrieval. The same model, quantization and pooling run in the
// pipeline (documents), the browser and the MCP server (queries), so vectors are comparable.
// Kept separate from index.mjs so the Worker bundle never loads the model.
export const EMBED_MODEL = "Xenova/bge-small-en-v1.5";
export const EMBED_DTYPE = "q8";
export const EMBED_DIMS = 384;
// BGE v1.5 retrieval instruction for queries (documents are embedded without it).
export const QUERY_PREFIX = "Represent this sentence for searching relevant passages: ";

// Browsers load the same pinned library from jsDelivr (its ~27 MB WASM runtime exceeds static-asset
// limits on the free Worker plan); Node uses the installed package. Same version, same vectors.
const TRANSFORMERS_VERSION = "4.3.1";
const BROWSER_URL = `https://cdn.jsdelivr.net/npm/@huggingface/transformers@${TRANSFORMERS_VERSION}/dist/transformers.min.js`;
const isBrowser = typeof window !== "undefined" && typeof document !== "undefined";

let extractor = null;
async function getExtractor() {
  if (!extractor) {
    // Variable specifier so web bundlers do not pull the Node package (and its WASM) into the bundle.
    const nodePkg = "@huggingface/transformers";
    const lib = await import(/* @vite-ignore */ isBrowser ? BROWSER_URL : nodePkg);
    extractor = lib.pipeline("feature-extraction", EMBED_MODEL, { dtype: EMBED_DTYPE });
  }
  return extractor;
}

/** Embed texts; returns unit-length Float32 vectors (CLS pooling, as BGE specifies). */
export async function embed(texts, { query = false } = {}) {
  const fe = await getExtractor();
  const input = query ? texts.map((t) => QUERY_PREFIX + t) : texts;
  const out = await fe(input, { pooling: "cls", normalize: true });
  const [n, d] = out.dims;
  const data = out.data;
  return Array.from({ length: n }, (_, i) => data.subarray(i * d, (i + 1) * d));
}

/** int8 quantization of a unit vector (cosine similarity is scale-invariant, so no rescale needed). */
export const quantize = (vec) => Array.from(vec, (v) => Math.max(-127, Math.min(127, Math.round(v * 127))));
