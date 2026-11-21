// Pure helpers of the data layer (JSON read, timestamps, ISO date, workspace view over project items) — NOT
// re-exported by the facade store.js, with one exception: `slugifyTitle` is passed through individually.
// Answers: how does the store read JSON columns tolerantly, and why no bit operators on timestamps.

// Workspace view over all item types: the workspace items PLUS the items of ALL projects of the workspace. A
// workspace chat may access everything — only project chats are isolated from each other. On equal keys the
// workspace item wins, then the project created first (listProjects sorts by created_at).
// `listProjects` comes as an ARGUMENT, not as an import: it was the only edge that kept this file from being a
// leaf — and with it every `_util.js` import pulled in the whole data layer.
function withAllProjectItems(workspaceId, wsItems, listForProject, listProjects, keyOf = (x) => x.name) {
  const byKey = new Map();
  for (const it of wsItems) byKey.set(keyOf(it), it);
  for (const p of listProjects(workspaceId)) {
    for (const it of listForProject(p.id, p)) if (!byKey.has(keyOf(it))) byKey.set(keyOf(it), it);
  }
  return [...byKey.values()];
}
function safeJson(s, fallback) { try { const v = JSON.parse(s); return v ?? fallback; } catch { return fallback; } }
// CAUTION: no bit operators on timestamps — `ms | 0` computes in 32 bits and turns 1785585600000 into nonsense
// (the wait state then lay in the past). SQLite INTEGER is 64 bits.
const TS = (v) => Math.trunc(Number(v) || 0);
const jsonOr = (s, fb) => { if (!s) return fb; try { return JSON.parse(s); } catch { return fb; } };
const parseJson = (s, fb) => { try { return s ? JSON.parse(s) : fb; } catch { return fb; } };
// Local ISO date (YYYY-MM-DD). event_at/valid_until are ISO texts — the comparison is lexicographic,
// substr(…,1,10) also copes with date+time.
function localIsoDate(offsetDays = 0) {
  const d = new Date(Date.now() + offsetDays * 86400000);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
const numOrNull = (v) => (v == null || v === "" ? null : Number(v));
// Slugs are the stable reference between entries (links/superseded_by) — human-readable, unique per project or
// workspace. It lives here and not in `context.js` because `db.js` needs it for the backfill and would otherwise
// pull in a whole topic file.
function slugifyTitle(title) {
  return String(title || "")
    .toLowerCase()
    .replaceAll("ä", "ae").replaceAll("ö", "oe").replaceAll("ü", "ue").replaceAll("ß", "ss")
    .normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")
    .slice(0, 64).replace(/-+$/, "")
    // Never purely numeric — otherwise the slug would be indistinguishable from an entry id
    // (get/by-slug take pure digits as an id).
    .replace(/^(\d+)$/, "entry-$1");
}

export { TS, jsonOr, localIsoDate, numOrNull, parseJson, safeJson, slugifyTitle, withAllProjectItems };
