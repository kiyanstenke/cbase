import { api } from "./core.js";

// ── Adjust: reword marked text according to an instruction ────────────────────────────────
/** A remembered instruction — title for recognition, `used` orders the list. */
export interface AdjustPrompt { id: string; title: string; prompt: string; used: number; created: number }
export const getAdjustPrompts = () => api<{ items: AdjustPrompt[]; max: number }>("/api/adjust/prompts");
export const updateAdjustPrompt = (id: string, body: { title?: string; prompt?: string }) =>
  api<AdjustPrompt>(`/api/adjust/prompts/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(body) });
export const deleteAdjustPrompt = (id: string) =>
  api<{ ok: boolean; items: AdjustPrompt[] }>(`/api/adjust/prompts/${encodeURIComponent(id)}`, { method: "DELETE" });
/** A model call: text + instruction (new or via `promptId`) ⇒ the new text. The instruction is remembered in the process. */
export const adjustText = (body: { text: string; prompt?: string; promptId?: string; title?: string }) =>
  api<{ fresh: string; model: string; promptId: string; title: string }>("/api/adjust", { method: "POST", body: JSON.stringify(body) });

