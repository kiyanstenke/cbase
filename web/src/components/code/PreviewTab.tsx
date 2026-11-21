"use client";
// The Markdown preview as its own tab (tab computation in lib/editor-inputs.ts, in the chat lib/chat-tabs.ts `TabPreview`). It takes
// the editor's place in its group when its tab is in front, with the same rendering (components/code/MarkdownPreview.tsx).
//
// THE TEXT: if the file is open in the window (its buffer, `buffer`, subscribed), live from it, unsaved too, as in VS Code.
// Otherwise from disk (`GET …/files/read`), re-read when `revision` grows (a save, a new git state). The preview does NOT hold the
// buffer (VS Code: a preview is not an editor of the file; whoever closes the last editor is asked, and afterwards it shows the disk).
//
// THE START LINE (the preview sits where the line was at the top of the editor): whoever triggers Shift+Cmd+V stores it under the
// tab's key (`rememberStartLine`), and the tab takes it ONCE on mount (`takeStartRow`), so the same holds for the groups and for the
// chat, which draws the tab elsewhere than where the key arrived. If the tab is already mounted (Cmd+K V on a preview that is in front
// beside it; VS Code `openDynamicPreview`: `reveal` + `update(line)`), IT takes the line at once and scrolls there (`listenStart`),
// so no entry stays behind that would jump to an old line on the next mount.
//
// THE SCROLL STATE: only the tab in front is mounted; without a start line and without sync the preview stands where it was on
// remount (components/code/view-locations.ts, key `location` + file; VS Code keeps the state per editor).
// THE FILE IS MISSING: a tab restored from storage drops when its file is gone (`onDisk`, like a file tab).
import { useEffect, useReducer, useState } from "react";
import type { EditorView } from "@codemirror/view";
import { api } from "@/lib/api";
import { instancePath } from "@/lib/code-instance";
import { fromReading, isMissingReading } from "@/lib/file-status";
import { MarkdownPreview } from "@/components/code/MarkdownPreview";
import type { Buffer } from "@/lib/buffer";

type T = (key: string, params?: Record<string, string | number>) => string;

const START = new Map<string, number>();
const LISTENERS = new Map<string, Set<(row: number) => void>>();
/** The line the preview `key` starts at when opened (0-based, fractional), stored before opening. If it is already mounted, IT scrolls
 *  there and nothing is stored. */
export function rememberStartLine(key: string, row: number | null | undefined): void {
  const ok = typeof row === "number" && Number.isFinite(row);
  const h = LISTENERS.get(key);
  if (ok && h?.size) { START.delete(key); for (const f of h) f(row); return; }
  if (ok) START.set(key, row); else START.delete(key);
}
/** A mounted tab listens for its start line. */
function listenStart(key: string, f: (row: number) => void): () => void {
  const h = LISTENERS.get(key) ?? new Set();
  h.add(f);
  LISTENERS.set(key, h);
  return () => { h.delete(f); if (!h.size) LISTENERS.delete(key); };
}
/** … and taken once on mount. */
export function takeStartRow(key: string): number | undefined {
  const z = START.get(key);
  START.delete(key);
  return z;
}

export function PreviewTab({ t, target, path, previewKey, buffer, state: revision = 0, imageUrl, onFile, focus = false, editor, editorKey, onError, location, onDisk }: {
  t: T;
  target: { apiBase: string; instance: string | null };
  path: string;
  /** The tab's key (for the start line). */
  previewKey: string;
  /** The file's buffer if it is open in the window (loaded), otherwise null (then from disk). */
  buffer: Buffer | null;
  state?: number;
  imageUrl: (path: string) => string;
  onFile: (path: string, row: number | null, markdown: boolean) => void;
  focus?: boolean;
  editor?: () => EditorView | null;
  editorKey?: string;
  onError?: (e: unknown) => void;
  /** Where the tab sits (components/code/view-locations.ts); the scroll state on remount. */
  location?: string;
  /** After every read from disk: is the file missing? (A restored tab then drops.) */
  onDisk?: (missing: boolean) => void;
}) {
  const [row] = useState(() => takeStartRow(previewKey));
  const [jump, setJump] = useState<{ seq: number; row: number } | undefined>(undefined);
  useEffect(() => listenStart(previewKey, (z) => setJump((x) => ({ seq: (x?.seq ?? 0) + 1, row: z }))), [previewKey]);
  const [, tick] = useReducer((n: number) => n + 1, 0);
  useEffect(() => buffer?.subscribe(tick), [buffer]);
  const text = buffer && buffer.status.state === "loaded" ? buffer.text : null;
  const [disk, setDisk] = useState<{ path: string; text: string | null; error: string | null } | null>(null);
  const withoutBuffer = text === null;
  useEffect(() => {
    if (!withoutBuffer) return;
    let alive = true;
    api<{ content?: unknown; sha?: unknown }>(instancePath(`${target.apiBase}/files/read?path=${encodeURIComponent(path)}`, target.instance))
      .then((r) => { if (!alive) return; setDisk({ path, text: fromReading(r)?.text ?? "", error: null }); onDisk?.(false); })
      .catch((e: unknown) => { if (!alive) return; onError?.(e); setDisk({ path, text: null, error: String((e as Error)?.message || e) }); onDisk?.(isMissingReading(e)); });
    return () => { alive = false; };
  }, [withoutBuffer, path, target.apiBase, target.instance, revision]); // eslint-disable-line react-hooks/exhaustive-deps
  const own = disk && disk.path === path ? disk : null;
  return (
    <div className="absolute inset-0 flex min-h-0 flex-col bg-panel" data-preview-tab={path}>
      {withoutBuffer && own?.error
        ? <div className="p-4 text-[13px] text-danger" role="alert">{t("Error: {msg}", { msg: own.error })}</div>
        : <MarkdownPreview t={t} path={path} text={text ?? own?.text ?? null} imageUrl={imageUrl} onFile={onFile} focus={focus} row={row}
            editor={editor} editorKey={editorKey} jump={jump} scrollKey={location ? `${location}|${path}` : undefined} />}
    </div>
  );
}
