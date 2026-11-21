// The key color per copy: lane and badge of a copy carry the same color in web and iOS — computed here, drawn there only
// as an index 0..COLORS-1. The main instance has none (`null`).
//
// THE RULE. Every live copy has a hash slot from its name (FNV-1a, 32 bit, over the UTF-16 units — stable across
// processes and platforms, no randomness, no ordering). Slots are assigned in CREATION order (store.liveStackCopies:
// `requested_at`, id): if the hash slot is free the copy gets it, otherwise the next free one (cyclic). Once all COLORS
// slots are taken (from the seventh copy on), each slot counts how often it is assigned: starting at the hash slot, the
// first one with the smallest count wins — two copies share a color only from the seventh on, and then evenly.
// Consequence of creation order: a NEW copy never shifts the color of an older one. When an older copy goes away, a
// younger one that had to step aside may move back to its hash slot — intended (colors shift as little as possible).
//
// Guard: server/backend/test/git-view-user.test.js (stable, no duplicates up to COLORS, a new copy shifts no old one).
import * as store from "../store.js";
import { COLORS } from "./contract.js";

/** The hash slot of a name (0..COLORS-1). */
export function hashSlot(name) {
  let h = 0x811c9dc5;
  const s = String(name ?? "");
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h % COLORS;
}

/** Key colors for copy names in creation order → `Map<name, index>` (rule in the header). Duplicate names count once. */
export function keyColors(namesInCreationOrder) {
  const count = new Array(COLORS).fill(0);
  const out = new Map();
  for (const raw of namesInCreationOrder || []) {
    const name = String(raw);
    if (out.has(name)) continue;
    const start = hashSlot(name);
    const fewest = Math.min(...count);
    let slot = start;
    for (let i = 0; i < COLORS; i++) {
      const p = (start + i) % COLORS;
      if (count[p] === fewest) { slot = p; break; }
    }
    count[slot] += 1;
    out.set(name, slot);
  }
  return out;
}

/** The key colors of a project's live copies → `Map<copy-name, index>` (name as used at the seam, `k1`). */
export function keyColorsOfTheProject(projectId) {
  return keyColors(store.liveStackCopies(String(projectId)).map((k) => k.name));
}

/** The key color of an instance (main ⇒ null; a copy without a live row ⇒ null). */
export function keyColor(projectId, instance) {
  if (!instance || instance === "main") return null;
  return keyColorsOfTheProject(projectId).get(String(instance)) ?? null;
}
