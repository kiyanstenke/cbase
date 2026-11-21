// Address and token of an instance. A leaf: imports only node:crypto, app-state.js (BASE_URL) and address.js.
//
// tokenFor(inst)       the token of the instance: 32 bytes of randomness (hex), created once per backend start and identifier and held
//                       only in the MEMORY of this process — never in the database, never in a file except the MCP configuration of the
//                       run (which every turn rewrites). After a restart an old token is no longer valid; the runs before are gone with
//                       the process, and every new turn writes the new one. `null` without an instance.
// identifierForToken(t)     the identifier "<projectId>/<instance>" for a token, else `null`. Compared via the sha256 of the token
//                       (map key), not via the value itself.
// backendUrlFor(inst)  the address of the backend from the instance's point of view: `http://<gateway>:<port>` — the gateway of its
//                       project network (the bridge in B, measured `10.2xx.n.1:7718`), the port that of the running backend (from
//                       BASE_URL; in the test a free one). Without an instance or without a gateway: BASE_URL as today.
// mcpAccessFor(inst)   `{ backendUrl, token }` for writeMcpConfig — without an instance an EMPTY object, so the caller sets nothing and
//                       writeMcpConfig writes byte-equal to today (golden).
// forgetToken(k)     takes back the token of an identifier (delete paths; without a call the fence invalidates a token anyway as soon
//                       as the instance row is missing — projectbox/fence.js).
//
// The way to runs/: `runs/backend-access.js` (leaf) gets `mcpAccessFor` via a setter from server.js — runs/ does not import projectbox/.
import crypto from "node:crypto";
import { BASE_URL } from "../app-state.js";
import { hostPort } from "./address.js";

const TOKEN_BYTES = 32;
const identifierOf = (inst) => (inst ? String(inst.identifier || `${inst.projectId}/${inst.instance || "main"}`) : "");
const hash = (t) => crypto.createHash("sha256").update(String(t)).digest("hex");

const tokenPerIdentifier = new Map(); // identifier → token
const identifierPerHash = new Map(); // sha256(token) → identifier

export function tokenFor(inst) {
  const k = identifierOf(inst);
  if (!k) return null;
  let t = tokenPerIdentifier.get(k);
  if (!t) {
    t = crypto.randomBytes(TOKEN_BYTES).toString("hex");
    tokenPerIdentifier.set(k, t);
    identifierPerHash.set(hash(t), k);
  }
  return t;
}

export function identifierForToken(token) {
  if (typeof token !== "string" || token.length !== TOKEN_BYTES * 2) return null;
  return identifierPerHash.get(hash(token)) || null;
}

export function forgetToken(identifier) {
  const t = tokenPerIdentifier.get(String(identifier || ""));
  if (!t) return false;
  tokenPerIdentifier.delete(String(identifier));
  identifierPerHash.delete(hash(t));
  return true;
}

/** Test seam: forget all tokens (a new “backend start” in the same process). */
export function tokensForget() {
  tokenPerIdentifier.clear();
  identifierPerHash.clear();
}

export function backendUrlFor(inst) {
  if (!inst || !inst.gateway) return BASE_URL;
  let port = 7718;
  try { port = Number(new URL(BASE_URL).port) || 7718; } catch { /* BASE_URL without a port: the default port */ }
  return `http://${hostPort(inst.gateway, port)}`;
}

export function mcpAccessFor(inst) {
  if (!inst) return {};
  return { backendUrl: backendUrlFor(inst), token: tokenFor(inst) };
}
