// The one-time migration of the profile personas into the instructions.
//
// The persona used to be a file `<profilesDir>/<id>.json` (`systemPrompt`, optionally bound to a workspace); a chat chose
// one, and only the MAIN run carried its text. Now a profile with text and a workspace binding becomes exactly ONE
// section "Persona" with scope `main` in that workspace — the behavior stays the same (only the main agent carries it);
// what should apply to all agents the user moves into a section `all` afterwards. Unbound or empty profiles do not migrate.
// The files stay in place (way back); they are never read again. ONCE per store (marker
// `instructions.profile_migration` in app_settings) — a second round would create the section twice after the user
// may already have changed it.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import * as store from "../store.js";

export const MIGRATION_MARKER = "instructions.profile_migration";

/** → the number of sections created (0 also when the migration already ran). `profilesDir` from app-state DIRS. */
export function migrateProfilesIntoInstructions(profilesDir, at = Date.now()) {
  if (store.getSetting(MIGRATION_MARKER, "")) return 0;
  let files = [];
  try { files = fs.readdirSync(profilesDir).filter((f) => f.endsWith(".json")).sort(); } catch { /* no folder: nothing to migrate */ }
  // No profile file ⇒ no marker: nothing creates one any more, so a store without profiles never migrates — and the
  // golden runs (a fresh store) stay byte-equal.
  if (!files.length) return 0;
  let n = 0;
  for (const f of files) {
    let p;
    try { p = JSON.parse(fs.readFileSync(path.join(profilesDir, f), "utf8")); } catch (e) {
      console.error(`[instructions] profile ${f} not readable — not migrated:`, e?.message || e);
      continue;
    }
    const text = String(p?.systemPrompt || "").trim();
    const wid = String(p?.workspaceId || "").trim();
    if (!text || !wid || !store.getWorkspace(wid)) continue;
    store.createAgentSection({ id: crypto.randomUUID(), workspaceId: wid, projectId: null, title: "Persona", text, scope: "main", enabled: true }, at);
    n += 1;
    console.log(`[instructions] profile ${f} → section "Persona" (main agent only) in workspace ${wid}`);
  }
  store.setSetting(MIGRATION_MARKER, new Date(at).toISOString());
  return n;
}
