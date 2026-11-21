"use client";
// What is drawn per tab of an editor group when it is not a plain file, and what stands on the right of its title bar. CodePane keeps
// only the connection (state, buffer, actions) and passes it here; the computation is in lib/editor-inputs.ts.
//
//   EditorTitleButtons   the title-bar buttons as in VS Code (editor/title): a Markdown file "Open Preview to the Side"
//                        (navigation@1, Alt: "Open Preview" in the same group, VS Code `alt`; in the chat "Open Preview"), "Open
//                        Preview" (`markdown.reopenAsPreview`, navigation@2, codicon preview), a file with a git change "Open
//                        Changes" (`git.openChange`, navigation@2); a preview "Open Source File" (`markdown.showSource`); a diff
//                        places its buttons itself at the location `diffLocation` (components/code/DiffTab.tsx `buttonsIn`). ONLY
//                        symbol buttons as in VS Code: "Run or Debug…" (codicon run) comes first; Save and Blame are no pills any
//                        more but entries in "…" (`fileMenuPoints`); whatever has no room beside the tabs moves into "…"
//                        (`overflowPoints`; order, room and menu are computed by lib/editor-title.ts).
//   PreviewInput      the Markdown preview as a tab (components/code/PreviewTab.tsx).
//   DiffInput          the diff as a tab, the SAME building block as in the chat (components/code/DiffTab.tsx), preceded by "Open File"
//                        (`git.openFile`).
//   inputDisplay       what a tab that is not a file looks like (lib/editor-inputs.ts `tabTitle`): the preview with the Markdown
//                        preview's symbol and WITHOUT "Copy Path"/"Reveal in Explorer View" (VS Code: a webview is not a file), a diff
//                        with its file's symbol (a whole commit: diff-multiple); an untracked file opened via "Open Changes" is called
//                        "README.md (Untracked)" (VS Code "{0} (Untracked)").
//   groupMenuItems   the "…" menu of a group, modelled on VS Code (MenuId.EditorTitle).
import { useState } from "react";
import type { EditorView } from "@codemirror/view";
import type { DiffSource } from "@/lib/chat-tabs";
import type { EditorHolder, Buffer } from "@/lib/buffer";
import * as E from "@/lib/editor-inputs";
import * as G from "@/lib/editor-groups";
import { filesAddition } from "@/lib/tab-bar";
import { rootName } from "@/lib/buffer-coordinates";
import * as K from "@/lib/editor-title";
import { MoreButton, TitleButton, TitleSymbolSvg, type TitleSymbol } from "@/components/code/EditorTitleSymbols";
import { PreviewTab } from "@/components/code/PreviewTab";
import { DiffTab } from "@/components/code/DiffTab";
import { FileOpenButton } from "@/components/code/DiffButtons";
import { useLeftSaved } from "@/components/code/comparison-connection";
import type { CodeTabEntry } from "@/components/code/TabBar";
import type { MenuItem } from "@/components/code/EditorMenu";

type T = (key: string, params?: Record<string, string | number>) => string;
type Target = { apiBase: string; instance: string | null };

/** What the title bar must know about a loaded text file, and what its buttons do. */
export type FileTitle = {
  dirty: boolean; deleted: boolean; debug: boolean; blameOn: boolean;
  onBlame: () => void; onSave: () => void; onDebug: () => void;
  /** Groups: "Open Preview to the Side" (`alt`: in the same group); chat: "Open Preview". Null: not a Markdown file. */
  preview: { kind: "beside"; open: (alt: boolean) => void } | { kind: "here"; open: () => void } | null;
  /** "Open Preview": null if not a Markdown file. */
  asPreview: (() => void) | null;
  /** "Open Changes": null if no change (or in the chat, whose title row has no git button). */
  change: (() => void) | null;
};

/** A symbol button of a text file: glyph, title, marker on the button and what it does (`alt`: clicked with Alt). */
type FileAction = { id: K.TitleAction; symbol: TitleSymbol; title: string; data: Record<`data-${string}`, string>; execute: (alt: boolean) => void };

/** The symbol buttons of a text file in VS Code's order (lib/editor-title.ts `titleActions`). */
export function fileActions(t: T, d: FileTitle): FileAction[] {
  const ids = K.titleActions({ debug: d.debug, preview: Boolean(d.preview), asPreview: Boolean(d.asPreview), change: Boolean(d.change) });
  return ids.map((id) => action(t, d, id));
}
function action(t: T, d: FileTitle, id: K.TitleAction): FileAction {
  const v = d.preview;
  switch (id) {
    // VS Code: the submenu `EditorTitleRun` ("Run or Debug...", codicon run); cbase has exactly one entry in it: Node debug.
    case "debug.run": return { id, symbol: "run", title: t("Run or Debug…"), data: { "data-title-debug": "" }, execute: () => d.onDebug() };
    case "markdown.showPreviewToSide": return v?.kind === "beside"
      ? { id, symbol: "open-preview", title: t("Open Preview to the Side"), data: { "data-preview-beside": "" }, execute: (alt) => v.open(alt) }
      : { id, symbol: "open-preview", title: t("Open Preview"), data: { "data-preview-beside": "" }, execute: () => { if (v?.kind === "here") v.open(); } };
    case "markdown.reopenAsPreview": return { id, symbol: "preview", title: t("Open as Preview"), data: { "data-as-preview": "" }, execute: () => d.asPreview?.() };
    case "git.openChange": return { id, symbol: "compare-changes", title: t("Open Changes"), data: { "data-changes-open": "" }, execute: () => d.change?.() };
  }
}

/** What does not fit in the bar stands at the top of "…", in the same order, without Alt. */
export function overflowPoints(actions: readonly FileAction[]): MenuItem[][] {
  return actions.length ? [actions.map((a) => ({ id: a.id, label: a.title, execute: () => a.execute(false) }))] : [];
}

/** The entries of a text file in "…": "Save" (Cmd+S, grey without unsaved text) and the toggle for Git Blame (lib/editor-title.ts
 *  `fileMenu`). */
export function fileMenuPoints(t: T, d: FileTitle): MenuItem[][] {
  return [K.fileMenu(d).map((e): MenuItem => e.id === "workbench.action.files.save"
    ? { id: e.id, label: t("Save"), right: "⌘S", disabled: e.inactive, execute: d.onSave }
    : { id: e.id, label: t("Toggle Git Blame Editor Decoration"), on: e.on, execute: d.onBlame })];
}

/** The overflow and file entries for a group's "…": what does not fit from `slot` on, then the file's entries. */
export function titleMenuItems(t: T, d: FileTitle | null, slot: number): MenuItem[][] {
  if (!d) return [];
  return [...overflowPoints(K.splitActions(fileActions(t, d), slot).overflow), ...fileMenuPoints(t, d)];
}

/** The title-bar buttons. `slot`: how many buttons of a file fit (lib/editor-title.ts `titleSlot`; without: all). `more`: its own "…"
 *  with the overflow and the file's entries (in the chat; in the groups `GroupsButtons` carries the "…"). */
export function EditorTitleButtons({ t, kind, onSource, diffLocation, file, slot, more = false }: {
  t: T; kind: "file" | "preview" | "diff"; onSource?: () => void; diffLocation?: (el: HTMLElement | null) => void; file?: FileTitle | null;
  slot?: number; more?: boolean;
}) {
  if (kind === "preview") return onSource ? <TitleButton name="file-code" title={t("Open Source File")} onClick={onSource} data={{ "data-preview-source": "" }} /> : null;
  if (kind === "diff") return diffLocation ? <span ref={diffLocation} className="flex items-center gap-0.5" data-diff-buttons-location /> : null;
  if (!file) return null;
  const all = fileActions(t, file);
  const n = slot ?? all.length;
  return (
    <>
      {K.splitActions(all, n).visible.map((a) => <TitleButton key={a.id} name={a.symbol} title={a.title} data={a.data} onClick={(ev) => a.execute(ev.altKey)} />)}
      {more && <MoreButton t={t} menu={() => titleMenuItems(t, file, n)} />}
    </>
  );
}

/** The preview as a tab: the text from the buffer if the file is open in the window (live, unsaved too), otherwise the disk; scrolls in
 *  sync with the editor of the same file visible beside it (`editor`). */
export function PreviewInput({ t, tabKey, path, target, buffer, status: revision, imageUrl, location, editor, onFile, onDisk, onError }: {
  t: T; tabKey: string; path: string; target: Target; buffer: Buffer | null; status: number; imageUrl: (path: string) => string; location: string;
  editor: { view: () => EditorView | null; key: string } | null;
  onFile: (path: string, row: number | null, markdown: boolean) => void; onDisk: (missing: boolean) => void; onError: (e: unknown) => void;
}) {
  return (
    <PreviewTab key={tabKey} t={t} target={target} path={path} previewKey={E.previewKey(path)} buffer={buffer} state={revision} imageUrl={imageUrl}
      onError={onError} onFile={onFile} location={location} onDisk={onDisk} {...(editor ? { editor: editor.view, editorKey: editor.key } : {})} />
  );
}

/** The diff as a tab. An unstaged change has the file's buffer on the right (editable, Cmd+S); typing pins the tab (`onFixed`). After
 *  saving the tab re-reads itself; `onSaved` only triggers the git state (so it is not read three times). */
export function DiffInput({ t, tabKey, source, target, editor, buttonsIn, location, status: revision, onFileOpen, onSaved, onFixed, onError }: {
  t: T; tabKey: string; source: DiffSource; target: Target; editor: EditorHolder; buttonsIn: HTMLElement | null; location: string; status: number;
  onFileOpen: (() => void) | null; onSaved: () => void; onFixed: () => void; onError: (e: unknown) => void;
}) {
  // The left side of a comparison, saved anywhere in the window (a chat, another level): the tab re-reads.
  const [leftSaves, setLeftSaves] = useState(0);
  useLeftSaved(source, () => setLeftSaves((n) => n + 1));
  return (
    <div className="absolute inset-0 flex min-h-0 flex-col bg-panel" data-diff-tab-wrapper>
      <DiffTab key={tabKey} source={source} target={target} bufferTarget={target} editor={editor} header={false} buttonsIn={buttonsIn} location={location}
        buttonsExtra={onFileOpen ? <FileOpenButton t={t} onClick={onFileOpen} /> : null}
        onSaved={onSaved} onUnsaved={(d) => { if (d) onFixed(); }} state={revision + leftSaves} onError={onError} />
    </div>
  );
}

/** What a tab that is not a plain file looks like; undefined: a file (name from the path). `untracked`: the file came via
 *  "Open Changes" on an untracked file. */
export function inputDisplay(k: string, t: T, untracked = false): CodeTabEntry["display"] {
  const e = E.inputOf(k);
  if (!e) return undefined;
  if (e.kind === "file") return untracked ? { kind: "file", name: E.untrackedTitle(e.path, t), hint: e.path, symbolPath: e.path, relPath: e.path, explorer: true } : undefined;
  const tt = E.tabTitle(k, t, rootName), d = E.fileOf(k);
  if (e.kind === "preview") return { kind: "preview", name: tt.name, hint: tt.hint, symbolPath: null, icon: <TitleSymbolSvg name="markdown-preview" />, relPath: null, explorer: false };
  // Two files of the same name from different folders: the tab shows the folders (VS Code `forceDescription`), from two targets
  // including the root.
  return { kind: "diff", name: tt.name, hint: tt.hint, symbolPath: d, icon: d ? undefined : <TitleSymbolSvg name="diff-multiple" />, relPath: d, explorer: Boolean(d), addition: filesAddition(e.source, rootName) };
}

/** The "…" menu of a group, modelled on VS Code (MenuId.EditorTitle): if a preview is in front, first the group "1_markdown" of the
 *  Markdown extension (Refresh Preview, Toggle Preview Locked to Group) | "Show Opened Editors" | Close All, Close Saved | "Enable
 *  Preview Editors" (check mark) | Maximize/Unmaximize Group (only with several groups) | "Configure Editors". cbase cannot "Lock
 *  Group"; "Keep Open" is (as in VS Code) in the tab's context menu. */
export function groupMenuItems(t: T, p: {
  previewFront: boolean; several: boolean; maximized: boolean; previewEditors: boolean;
  refresh: () => void; lock: () => void; opened: () => void; allClose: () => void; closeSaved: () => void;
  togglePreviewEditors: () => void; maximize: () => void; configure: () => void;
}): MenuItem[][] {
  return [
    p.previewFront ? [
      { id: "markdown.preview.refresh", label: t("Refresh Preview"), execute: p.refresh },
      { id: "markdown.preview.toggleLock", label: t("Toggle Preview Locking"), execute: p.lock },
    ] : [],
    [{ id: "workbench.action.showEditorsInActiveGroup", label: t("Show Opened Editors"), execute: p.opened }],
    [
      { id: "workbench.action.closeEditorsInGroup", label: t("Close All"), right: G.shortcutOf("workbench.action.closeEditorsInGroup"), execute: p.allClose },
      { id: "workbench.action.closeUnmodifiedEditors", label: t("Close Saved"), right: G.shortcutOf("workbench.action.closeUnmodifiedEditors"), execute: p.closeSaved },
    ],
    [{ id: "workbench.action.toggleEditorPreview", label: t("Enable Preview Editors"), on: p.previewEditors, execute: p.togglePreviewEditors }],
    p.several ? [{
      id: "workbench.action.toggleMaximizeEditorGroup", label: p.maximized ? t("Unmaximize Group") : t("Maximize Group"),
      right: G.shortcutOf("workbench.action.toggleMaximizeEditorGroup"), execute: p.maximize,
    }] : [],
    [{ id: "workbench.action.configureEditor", label: t("Configure Editors"), execute: p.configure }],
  ];
}
