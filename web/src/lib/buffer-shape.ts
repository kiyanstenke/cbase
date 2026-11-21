// What a HOLDER of a buffer must see, without the text: CodePane only renders when the SHAPE of a held buffer changes, i.e. its state
// without `text` and `version` (status, saved text, base, prompt, save error …), plus `dirty`, read-only and location. A keystroke
// changes none of that (except `dirty` at the first character): tab dot, bars and lines above the editor stay right, and whatever needs
// text (layout, problems, drafts, all only after a pause) listens to the changes itself (components/code/BufferEditor.tsx
// `useBufferTabs` → `change`). VS Code likewise does not render the workbench per keystroke: the model reports `onDidChangeContent`,
// the parts listen, and the editor's title only listens to `onDidChangeDirty`.
// A module without imports (the guard web/test/buffer-shape.test.mjs runs it).

/** The fields that are NOT shape: text and version. */
const ONLY_TEXT = new Set(["text", "version"]);

export type ShapeSource = { readonly status: object; readonly dirty: boolean; readonly readonly: boolean; readonly key: string };
export type Shape = readonly unknown[];

/** The shape of a buffer; comparing with `sameShape` says whether a holder must redraw. */
export function shapeOf(p: ShapeSource): Shape {
  const state = p.status as Record<string, unknown>;
  const fields = Object.keys(state).filter((k) => !ONLY_TEXT.has(k)).sort();
  return [p.dirty, p.readonly, p.key, ...fields.flatMap((k) => [k, state[k]])];
}

/** Equal if every field is the same (objects by identity: the buffer only replaces them when they change). */
export function sameShape(a: Shape | null | undefined, b: Shape | null | undefined): boolean {
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
