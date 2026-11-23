// What the server runs, as the gateway reports it on GET /gw/info.
// Rules in VERSIONING.md. Pure functions plus one file read; index.js wires them. Guard: build-info.test.js.
//
//  · The build stamp is `<root>/current/build.json`, written by the deploy into every release (`current` points at the live one;
//    the gateway itself lives in `<root>/gateway/`). GW_BUILD_FILE overrides the path. Read per request, re-parsed only when the
//    file's mtime or size changes. Missing or malformed ⇒ null — and then /gw/info shows the gateway's own package version with
//    build "unknown": a missing stamp never looks like a clean release build.
//  · The API level: the gateway carries a copy of the backend's numbers (API_LEVEL below — it is rolled out on its own and cannot
//    import the backend); build-info.test.js binds the copy to server/backend/electron/server/api-level.js. The gateway refuses
//    no client by its level: an app below `oldest` reads /gw/info and says itself that it needs an update.
import fs from "node:fs";

export const API_LEVEL = Object.freeze({ level: 1, oldest: 1 });

const SEMVER = /^\d+\.\d+\.\d+$/;
const text = (v) => (typeof v === "string" && v ? v : null);

/** A build stamp reader with an mtime cache: `read()` → the parsed stamp or null. */
export function buildStampReader(file) {
  let seen = null; // { key, stamp }
  return function read() {
    let st;
    try { st = fs.statSync(file); } catch { seen = null; return null; }
    const key = `${st.mtimeMs}:${st.size}:${st.ino}`;
    if (seen?.key === key) return seen.stamp;
    let stamp = null;
    try {
      const j = JSON.parse(fs.readFileSync(file, "utf8"));
      if (j && SEMVER.test(String(j.version)) && text(j.build)) stamp = j;
    } catch { /* unreadable: null */ }
    seen = { key, stamp };
    return stamp;
  };
}

/** The version fields of /gw/info. `stamp` null ⇒ the gateway's own version, build "unknown", commit and release null. */
export function infoVersionFields(stamp, gatewayVersion) {
  return {
    version: stamp ? stamp.version : gatewayVersion,
    build: stamp ? stamp.build : "unknown",
    commit: stamp ? text(stamp.commit) : null,
    release: stamp ? text(stamp.release) : null,
    api: { level: API_LEVEL.level, oldest: API_LEVEL.oldest },
    gatewayVersion,
  };
}
