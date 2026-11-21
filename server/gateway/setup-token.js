// The first-time setup token. While the gateway has no user, POST /gw/setup creates the first ADMIN — and an admin controls every
// user's container, where agents run with shell access. Without a secret, whoever reached a fresh gateway first became that admin
// (an operator who opened the port before finishing the setup handed the server to a stranger).
//
// So the setup needs a token only the operator can read: GW_SETUP_TOKEN if set, else a random one, written to <data>/setup-token
// (mode 0600) and printed in the gateway's log at start. The file is removed once the first admin exists. Guard: setup-token.test.js.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const tokenFile = (dataDir) => path.join(dataDir, "setup-token");

/** The token the setup needs: the environment's, else the stored one, else a new one (stored with mode 0600). */
export function ensureSetupToken(dataDir, env = process.env) {
  const fromEnv = String(env.GW_SETUP_TOKEN || "").trim();
  if (fromEnv) return { token: fromEnv, source: "GW_SETUP_TOKEN" };
  const file = tokenFile(dataDir);
  try {
    const stored = fs.readFileSync(file, "utf8").trim();
    if (stored) return { token: stored, source: file };
  } catch { /* none yet */ }
  const token = crypto.randomBytes(18).toString("base64url");
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(file, `${token}\n`, { mode: 0o600 });
  fs.chmodSync(file, 0o600); // the write mode is ignored for an existing file; set it explicitly
  return { token, source: file };
}

/** Constant-time comparison; a missing or empty `given` never matches. */
export function setupTokenMatches(expected, given) {
  if (typeof given !== "string" || !given || !expected) return false;
  const a = crypto.createHash("sha256").update(expected).digest();
  const b = crypto.createHash("sha256").update(given.trim()).digest();
  return crypto.timingSafeEqual(a, b);
}

export function removeSetupToken(dataDir) {
  try { fs.rmSync(tokenFile(dataDir), { force: true }); } catch { /* best effort */ }
}
