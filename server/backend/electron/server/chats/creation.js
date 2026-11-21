// Creating a coding chat as ONE computation: from the body of a creation path to the fields for `store.createChat` — or
// the refusal with status and wording. Used by `chats/routes.js:chatCreateRoute` (POST /api/chats; guard
// server/backend/test/chat-creation.test.js covers every refusal and every silent default) and by the creation path of
// scheduled jobs: same workspace, project, folder, same verdicts on provider, model, effort level, ultracode and instance
// — a job chat is a coding chat (its run values live on the chat).
//
// The only difference, at the caller's request: `modeRequired` (Scheduled) — there a missing or unknown permission mode
// is a 400; for a chat it silently stays "" (the default of the run kind).
//
// The ultracode rule (`./ultracode.js:ultracodeFollowUp`) is applied by the caller at `createChat` — the source guard
// server/backend/test/ultracode-rule.test.js reads it there.
import { getActiveProviderId, isProviderId } from "../providers/index.js";
import { defaultModelFor } from "../account/providers.js";
import * as store from "../store.js";
import { T } from "../i18n.js";
import { BROWSER_MODES } from "../toolchain/playwright.js";
import { PERMISSION_MODES } from "../toolchain/profiles.js";
import { effortSavable, ultracodeSavable } from "../workflows.js";
import { InstanceChoiceError, instanceChoice } from "../runs/instance-switch.js";

const refusal = (status, body) => ({ error: { status, body } });

/**
 * @param {object} b  the parsed body
 * @param {{modeRequired?: boolean}} [opts]
 * @returns {{fields: object} | {error: {status: number, body: object}}}  `fields` without `id`, `createdAt`, `updatedAt`
 */
export function chatCreation(b, { modeRequired = false } = {}) {
  const ws = b.workspaceId ? store.getWorkspace(b.workspaceId) : null;
  if (!ws) return refusal(400, { error: T("workspaceId required — a chat always belongs to a workspace") });
  let projectId = null;
  if (b.projectId) {
    if (!(ws.projects || []).some((pr) => pr.id === b.projectId)) return refusal(400, { error: T("Project does not belong to this workspace") });
    projectId = b.projectId;
  }
  // Folder: if it belongs to a project, the new chat INHERITS that project (a chat in a project folder that does not
  // belong to the project would be consistent in no view).
  let folderId = null;
  if (b.folderId) {
    const folder = store.getChatFolder(b.folderId);
    if (!folder || folder.workspaceId !== ws.id) {
      return refusal(400, { error: T("Folder does not belong to this workspace") });
    }
    // Genus as in the PATCH: the new chat is a coding chat, a manager folder does not take it. Without this line a mixed
    // folder would arise — the coding chat would be loose in Coding, go to the archive with the manager folder, and that
    // folder's delete confirmation would not know it.
    if ((folder.kind || "normal") !== "normal") {
      return refusal(400, { error: T("Folder belongs to a different chat kind") });
    }
    folderId = folder.id;
    if (folder.projectId) projectId = folder.projectId;
    else if (projectId) return refusal(400, { error: T("Workspace folders do not take project chats") });
  }
  // Pin the provider at creation (b.provider allowed, else the global default) so a later global switch does not break
  // this chat's session resume. An UNKNOWN identifier is a 400 instead of silently the global one (only claude, codex,
  // openrouter — guard only-three-provider.test.js); missing or empty stays the global one.
  if (b.provider !== undefined && b.provider !== null && b.provider !== "" && !isProviderId(b.provider)) {
    return refusal(400, { error: T("Unknown provider") });
  }
  const chatProvider = isProviderId(b.provider) ? b.provider : getActiveProviderId();
  // Never an empty model: missing/empty → the default model of this provider chosen in the settings.
  const chatModel = (typeof b.model === "string" && b.model.trim()) ? b.model.trim() : defaultModelFor(chatProvider);
  // profile: an empty STRING is a choice ("no persona"), a missing field is not — old clients without the option still
  // end up on "default".
  const chatProfile = typeof b.profile === "string" ? b.profile.trim().slice(0, 120) : "default";
  // Effort level: the one save verdict (workflows.js). Missing and empty yield "" (the provider's default); UNKNOWN is a
  // 400 with wording — a typo must not silently become "no level".
  const chatEffort = effortSavable(b.effort);
  if (chatEffort.kind === "unknown") return refusal(400, { error: chatEffort.error });
  // Ultracode: an unknown value is a 400. It is a toggle beside the level — the level sent along stays as it is
  // (`ultracode.js`).
  const uc = ultracodeSavable(b.ultracode);
  if (uc.kind === "unknown") return refusal(400, { error: uc.error });
  const ultracodeOn = uc.kind === "value" && uc.on;
  const chatLevel = chatEffort.kind === "level" ? chatEffort.level : "";
  // Permission mode: for a chat silently "" if unknown; with `modeRequired` (Scheduled) a 400 — a nightly run silently in
  // default mode would stop at the first approval card.
  const modeKnown = PERMISSION_MODES.includes(b.permissionMode);
  if (modeRequired && !modeKnown) {
    return refusal(400, { error: T`Permission mode required — one of ${PERMISSION_MODES.join(", ")}` });
  }
  // The instance: same rules as the PATCH (runs/instance-switch.js instanceChoice), against the project in which the chat
  // is created (including the one inherited from a folder). Without the field it works in the main instance.
  let chatInstance = null;
  if (b.instance !== undefined) {
    try { chatInstance = instanceChoice(projectId, b.instance); }
    catch (e) { if (e instanceof InstanceChoiceError) return refusal(e.status, { error: e.message, code: e.code }); throw e; }
  }
  return {
    fields: {
      workspaceId: ws.id, projectId, folderId, profile: chatProfile, model: chatModel,
      permissionMode: modeKnown ? b.permissionMode : "", effort: chatLevel, ultracode: ultracodeOn, provider: chatProvider,
      browserMode: BROWSER_MODES.includes(b.browserMode) ? b.browserMode : "", instance: chatInstance,
    },
  };
}
