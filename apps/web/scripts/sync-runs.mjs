// Copy run history and per-run manifests/verification evidence from the repo's runs/ directory into
// public/runs so the UI can show them. Data tables are NOT copied: the browser reads them from IPFS.
import { cp, mkdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const src = join(here, "../../../runs");
const dest = join(here, "../public/runs");
if (!existsSync(join(src, "history.json"))) throw new Error(`no runs/history.json at ${src}`);
await rm(dest, { recursive: true, force: true });
await mkdir(dest, { recursive: true });
await cp(src, dest, { recursive: true, filter: (p) => !p.endsWith(".car") });
console.log(`synced runs -> ${dest}`);
