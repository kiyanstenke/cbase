// The repository root — the one fact the gate needs from the configuration.
//
// Kept apart from config.mjs on purpose: config.mjs reads `deploy.local.json` and the environment (installation
// specifics: SSH host, device, paths) at import time. The gate must run without any of that, so it imports only this leaf.
import path from "node:path";
import { fileURLToPath } from "node:url";

export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
