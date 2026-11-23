// The product version the backend carries: server/backend/package.json (in the image /app/package.json), written only by
// tools/version.mjs. A LEAF (node:* only), so the MCP client of the engine and GET /api/version read the same number without
// pulling each other in. The MCP server (electron/mcp/) is a process of its own and reads the same file itself (mcp/lib.js).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const BACKEND_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const PACKAGE_FILE = path.join(BACKEND_DIR, "package.json");

/** The `version` of a package.json, or null if it is missing or unreadable. */
export function readPackageVersion(file = PACKAGE_FILE) {
  try {
    const v = JSON.parse(fs.readFileSync(file, "utf8")).version;
    return typeof v === "string" && v ? v : null;
  } catch {
    return null;
  }
}

export const PRODUCT_VERSION = readPackageVersion() ?? "unknown";
