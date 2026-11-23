// What the backend runs: the product version (server/backend/package.json) and the API level — `GET /api/version`
// (VERSIONING.md). Clients reach it through the gateway like every other /api route.
//
// The build id is not here on purpose: the image carries no build stamp (a stamp in it would change the image on every deploy
// and swap every user container even with an unchanged backend). The build id of a rollout is answered by the gateway on
// `GET /gw/info` from `<root>/current/build.json`.
import { API_LEVEL } from "./api-level.js";
import { PACKAGE_FILE, readPackageVersion } from "./product-version.js";
import { NEXT, send } from "./runtime/http.js";

/** Pure over one file: the answer of GET /api/version. */
export function readVersionInfo({ packageFile = PACKAGE_FILE } = {}) {
  return { version: readPackageVersion(packageFile), api: { ...API_LEVEL } };
}

let cached = null; // the image does not change under a running process

// GET /api/version
export async function versionRoute({ res, p, m }) {
  if (p === "/api/version" && m === "GET") {
    cached ??= readVersionInfo();
    return send(res, 200, { ...cached, api: { ...cached.api } });
  }
  return NEXT;
}
