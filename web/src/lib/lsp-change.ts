// A change by the language service across several files (WorkspaceEdit from `rename` and `code_action_apply`) into the BUFFERS of the
// window (unsaved as in VS Code; a file without a tab opens as a background tab; undo per file). B never writes.
//
// ALL OR NOTHING in the window: first every affected file is loaded and held (lib/buffer.ts — "whoever loads a file only for this holds
// it meanwhile"), then every change list is checked against ITS text (`asAreas` throws on an overlap or a range beyond the text), and only
// if everything fits is it applied — without an `await` in between, so in one go. A file that cannot be loaded (binary, too large, gone,
// read-only) lets NOTHING change.
//
// THE RECONCILE BEFORE (`reconcileWith`): a change list is calculated by the server against ITS state of each file. Therefore before
// `rename` and `code_action_apply` EVERY open buffer of the same target and the same language goes out once (`sync`, the pure reconcile
// action) — not only unsaved ones with an unknown state: a clean buffer that took over an agent's state via `checkBack`, or a state the
// server forgot after a lease expired, would otherwise fall through (`TEXT_MISSING` heals that, lib/api/lsp.ts). Clean ones look first
// (an agent may have written in the meantime).
//
// THE VERSIONS: `reconcileWith` returns per reconciled buffer the version the server now knows; the trigger carries its own (that of the
// request). If an affected buffer stands on another version when applying — typing or `checkBack` within the 1–2 s the server
// calculates —, the ranges would apply to another text: then NOTHING is changed (`kind: "changed"`, like `formatDocument`). A buffer that
// was not part of the reconcile counts only if clean (the server then read the disk).
//
// UNDO: the triggering view takes its file over itself (`view`); every other already open file gets its share into the history of its
// last focused view (`change(…, { history: true })`) — ⌘Z there takes it back.
//
// web/test/lsp-editor.test.mjs runs both with a fake server (counter-proofs built in).
import { lspQuestion, lspLanguageOf, type LspWorkspaceEdit } from "./api/lsp.js";
import { allBuffers, asAreas, buffer, type Area, type EditorHolder, type Buffer, type BufferTarget } from "./buffer.js";

export type ChangeResult = { kind: "ok"; files: string[] } | { kind: "error"; text: string; file?: string } | { kind: "changed"; file: string };
/** Per buffer the version the server calculated against (`reconcileWith` + the trigger). */
export type ReconcileStatus = Map<Buffer, number>;

/** A WorkspaceEdit into the buffers of the target. `editor`: the editor that triggered it (background tabs). `view`: the triggering view —
 *  its file is changed VIA it (one step in ITS history, ⌘Z takes it back), every other via the buffer. `state`: the versions at the
 *  reconcile — if an affected buffer deviates, nothing is changed. */
export async function applyWorkspaceEdit(
  target: BufferTarget, edit: LspWorkspaceEdit | null | undefined,
  o: { editor?: EditorHolder | null; view?: { buffer: Buffer; apply: (areas: Area[]) => boolean } | null; state?: ReconcileStatus | null } = {},
): Promise<ChangeResult> {
  const changes = (edit?.changes ?? []).filter((c) => c && typeof c.file === "string" && Array.isArray(c.edits) && c.edits.length);
  if (!changes.length) return { kind: "ok", files: [] };
  // ONE entry per file (a server naming the same file twice gets its lists merged).
  const perFile = new Map<string, LspWorkspaceEdit["changes"][number]["edits"]>();
  for (const c of changes) perFile.set(c.file, [...(perFile.get(c.file) ?? []), ...c.edits]);
  const held: { p: Buffer; release: () => void }[] = [];
  try {
    for (const file of perFile.keys()) {
      const p = buffer(target, file);
      held.push({ p, release: p.hold("other") });
      const r = await p.load();
      if (r.kind !== "text") return { kind: "error", file: file, text: r.kind === "error" ? String((r.error as Error)?.message ?? r.error) : "not a text file" };
      if (p.readonly) return { kind: "error", file: file, text: "read-only" };
    }
    // Changed in the meantime? Then the ranges would apply to another text — nothing is touched.
    for (const { p } of held) {
      const v = o.state?.get(p);
      if (o.state && (v === undefined ? p.dirty : v !== p.version)) return { kind: "changed", file: p.path };
    }
    // Check (throws nothing into the buffers), then apply in one go.
    const areas = new Map<Buffer, Area[]>();
    for (const { p } of held) {
      try { areas.set(p, asAreas(p.text, perFile.get(p.path) ?? [])); } catch (e) { return { kind: "error", file: p.path, text: String((e as Error)?.message ?? e) }; }
    }
    for (const { p } of held) {
      const b = areas.get(p) ?? [];
      if (!(o.view?.buffer === p && o.view.apply(b))) p.change(b, { editor: o.editor ?? null, history: true });
    }
    return { kind: "ok", files: held.map((x) => x.p.path) };
  } finally {
    for (const { release } of held) release();
  }
}

/** Before a change across several files: reconcile every open, writable buffer of the same target and the same language — clean ones
 *  first look at the disk, then each goes out with `sync` (errors do not count: the buffer is then missing from the state). `except`: the
 *  triggering one (it goes out with the request itself — the caller enters its version into the state immediately before the request).
 *  → per reconciled buffer the version the server now knows. */
export async function reconcileWith(target: BufferTarget, language: string, except: Buffer | null = null): Promise<ReconcileStatus> {
  const open = allBuffers().filter((p) => p !== except && !p.readonly && p.status.state === "loaded" && p.target.apiBase === target.apiBase
    && (p.target.instance ?? null) === (target.instance ?? null) && lspLanguageOf(p.path)?.language === language);
  await Promise.all(open.filter((p) => !p.dirty).map((p) => p.checkBack().catch(() => null)));
  const status: ReconcileStatus = new Map();
  await Promise.all(open.map(async (p) => {
    const v = p.version;
    try { await lspQuestion(p, "sync", {}); status.set(p, v); } catch { /* the server then reads the disk — the buffer counts only if clean */ }
  }));
  return status;
}
