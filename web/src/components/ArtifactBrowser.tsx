"use client";

// Artifacts as a FILE SYSTEM instead of a flat list: the sidebar is ONLY the tree — folders to expand and collapse, files to
// open — and the file itself appears large in a modal in the middle of the screen.
//
// Artifacts of shared chats (same chat folder, `own === false`) sit under a folder of their own per origin chat. Otherwise
// two "plan.md" would lie side by side indistinguishably.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Markdown } from "@/components/Markdown";
import { MarkdownEditor } from "@/components/MarkdownEditor";
import { useT } from "@/lib/i18n";
import { ghost, primary, quietDanger, useFlat } from "@/components/CbKit";
import { fmtSize } from "@/lib/chat-format";

export interface ChatArtifact {
  path: string;
  name: string;
  mime: string;
  size: number;
  createdAt: number;
  modifiedAt: number;
  sha256: string;
  // If the chat lives in a folder, the artifacts of the sibling chats are in the list too: own=false plus origin
  // (chatId/chatTitle). Foreign artifacts are read-only.
  chatId?: string;
  chatTitle?: string;
  own?: boolean;
}

export interface ChatArtifactContent extends ChatArtifact {
  offset: number;
  nextOffset: number | null;
  truncated: boolean;
  encoding: "utf8" | "base64";
  content: string;
}

// An artifact is unique by chat origin + path — in a folder two chats can carry the same path (both "plan.md"), and the
// selection must not jump to the wrong file.
export const artifactKey = (a: { path: string; chatId?: string }) => `${a.chatId ?? ""}:${a.path}`;
export const artifactIsText = (mime: string) => mime.startsWith("text/") || /(?:json|yaml|xml|javascript|typescript)/.test(mime);

const svg = (children: React.ReactNode, size = 15) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    {children}
  </svg>
);
const ChevronIcon = ({ open }: { open: boolean }) => (
  <span className={`inline-flex transition-transform duration-150 ${open ? "rotate-90" : ""}`}>{svg(<path d="M9 18l6-6-6-6" />, 12)}</span>
);
const DirIcon = ({ open }: { open: boolean }) => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z" fill="currentColor" fillOpacity={open ? 0.28 : 0.14} />
  </svg>
);
// Shared artifacts sit under one node per NEIGHBOUR chat. It must differ from a real folder — else "Testplan" reads as a
// subdirectory instead of a chat.
const SharedChatIcon = () => svg(<><path d="M21 11.5a8.38 8.38 0 0 1-8.5 8.5 8.5 8.5 0 0 1-3.9-.9L3 21l1.9-5.6A8.5 8.5 0 1 1 21 11.5z" /></>, 14);
const FileIcon = ({ mime }: { mime: string }) => {
  if (mime.startsWith("image/")) return svg(<><rect x="3" y="4" width="18" height="16" rx="2" /><circle cx="9" cy="10" r="1.6" /><path d="m5 18 5-5 4 4 2-2 3 3" /></>, 14);
  if (mime === "application/pdf") return svg(<><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5z" /><path d="M14 3v5h5" /><path d="M9 15h6" /></>, 14);
  return svg(<><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5z" /><path d="M14 3v5h5" /><path d="M9 13h6" /><path d="M9 17h4" /></>, 14);
};

// ── Tree ──────────────────────────────────────────────────────────────────────
type TreeNode =
  | { kind: "dir"; key: string; name: string; children: TreeNode[]; files: number; shared?: string }
  | { kind: "file"; key: string; name: string; artifact: ChatArtifact };

// Fold paths ("a/b/c.md") into nested nodes. `prefix` keeps the keys of the shared trees apart — else "uploads" of two chats
// would collide.
//
// IMPORTANT: only `rest` (the path not yet consumed) travels through the recursion; the artifact itself stays UNCHANGED. A copy
// with a shortened path would be fatal: the node would carry "01-login.md" instead of "issues/01-login.md" — the server would
// not find the file, and the selection could never be matched against the list.
interface Pending { artifact: ChatArtifact; rest: string }

function buildTree(items: Pending[], prefix: string): TreeNode[] {
  const dirs = new Map<string, { node: Extract<TreeNode, { kind: "dir" }>; items: Pending[] }>();
  const files: TreeNode[] = [];
  for (const item of items) {
    const parts = item.rest.split("/");
    if (parts.length === 1) {
      files.push({ kind: "file", key: artifactKey(item.artifact), name: parts[0], artifact: item.artifact });
      continue;
    }
    const head = parts[0];
    const key = `${prefix}${head}/`;
    let bucket = dirs.get(head);
    if (!bucket) {
      bucket = { node: { kind: "dir", key, name: head, children: [], files: 0 }, items: [] };
      dirs.set(head, bucket);
    }
    bucket.items.push({ artifact: item.artifact, rest: parts.slice(1).join("/") });
    bucket.node.files += 1;
  }
  const dirNodes = [...dirs.values()].map(({ node, items: inner }) => ({
    ...node,
    children: buildTree(inner, node.key),
  }));
  const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name);
  return [...dirNodes.sort(byName), ...files.sort(byName)];
}

const pending = (items: ChatArtifact[]): Pending[] => items.map((artifact) => ({ artifact, rest: artifact.path }));

// Own artifacts at the root, foreign ones per origin chat in a folder of their own.
export function artifactTree(artifacts: ChatArtifact[], t: (s: string) => string): TreeNode[] {
  const own = artifacts.filter((a) => a.own !== false);
  const shared = new Map<string, ChatArtifact[]>();
  for (const a of artifacts) {
    if (a.own !== false) continue;
    const id = a.chatId ?? "";
    const bucket = shared.get(id);
    if (bucket) bucket.push(a); else shared.set(id, [a]);
  }
  const sharedNodes: TreeNode[] = [...shared.entries()].map(([id, items]) => ({
    kind: "dir" as const,
    key: `chat:${id}/`,
    name: items[0]?.chatTitle || t("Another chat"),
    children: buildTree(pending(items), `chat:${id}/`),
    files: items.length,
    shared: id,
  }));
  return [...buildTree(pending(own), ""), ...sharedNodes.sort((a, b) => a.name.localeCompare(b.name))];
}

/** All folder keys on the way to a file — so "show me this file" expands them. */
export function artifactDirPath(artifact: ChatArtifact): string[] {
  const prefix = artifact.own === false ? `chat:${artifact.chatId ?? ""}/` : "";
  const parts = artifact.path.split("/");
  const out: string[] = [];
  if (prefix) out.push(prefix);
  let current = prefix;
  for (const part of parts.slice(0, -1)) {
    current = `${current}${part}/`;
    out.push(current);
  }
  return out;
}

interface TreeProps {
  artifacts: ChatArtifact[];
  openDirs: Set<string>;
  onToggleDir: (key: string) => void;
  onOpenFile: (artifact: ChatArtifact) => void;
  selectedKey?: string | null;
  locale?: string;
  /** Jump to the origin chat, offered on the nodes of foreign chats. Without it such a node only expands and collapses (so the
   *  sidebar stays in the chat as it was). */
  onOpenChat?: (chatId: string) => void;
  /** Extra control at the end of a file row — e.g. delete in a folder context. It sits NEXT TO the open button, not inside it:
   *  a button in a button is invalid HTML and receives no touch on some platforms. */
  fileAction?: (artifact: ChatArtifact) => React.ReactNode;
}

export function ArtifactTree({ artifacts, openDirs, onToggleDir, onOpenFile, selectedKey, locale, onOpenChat, fileAction }: TreeProps) {
  const t = useT();
  const tree = useMemo(() => artifactTree(artifacts, t), [artifacts, t]);

  const rows = (nodes: TreeNode[], depth: number): React.ReactNode =>
    nodes.map((node) => {
      const pad = { paddingLeft: `${8 + depth * 13}px` };
      if (node.kind === "dir") {
        const open = openDirs.has(node.key);
        return (
          <div key={node.key}>
            {/* Row = container, buttons inside: the chat jump needs a surface of its own. */}
            <div style={pad} className="group flex items-center rounded-lg transition-colors hover:bg-hover">
              <button
                type="button"
                onClick={() => onToggleDir(node.key)}
                aria-expanded={open}
                className="flex min-w-0 flex-1 items-center gap-1.5 py-1.5 pr-1 text-left text-[12.5px] text-fg"
              >
                <span className="shrink-0 text-dim"><ChevronIcon open={open} /></span>
                <span className={`shrink-0 ${node.shared ? "text-accent" : "text-accent/80"}`}>
                  {node.shared ? <SharedChatIcon /> : <DirIcon open={open} />}
                </span>
                <span className="min-w-0 flex-1 truncate font-medium">{node.name}</span>
                <span className="shrink-0 tabular-nums text-[10px] text-dim">{node.files}</span>
              </button>
              {node.shared && onOpenChat ? (
                <button
                  type="button"
                  onClick={() => onOpenChat(node.shared as string)}
                  title={t("Open chat")}
                  aria-label={t("Open chat")}
                  className="mr-1 ml-1 grid h-6 w-6 shrink-0 place-items-center rounded-full text-dim opacity-0 transition-opacity hover:text-accent focus-visible:opacity-100 group-hover:opacity-100"
                >
                  {svg(<><path d="M5 12h13" /><path d="m12 5 7 7-7 7" /></>, 13)}
                </button>
              ) : (
                <span className="w-2 shrink-0" aria-hidden />
              )}
            </div>
            {open && rows(node.children, depth + 1)}
          </div>
        );
      }
      const selected = selectedKey === node.key;
      const extra = fileAction?.(node.artifact);
      return (
        <div
          key={node.key}
          style={pad}
          className={`group flex items-center rounded-lg transition-colors hover:bg-hover ${selected ? "bg-hover" : ""}`}
        >
          <button
            type="button"
            onClick={() => onOpenFile(node.artifact)}
            title={`${node.artifact.path} · ${fmtSize(node.artifact.size)}`}
            className={`flex min-w-0 flex-1 items-center gap-1.5 py-1.5 pr-1 text-left text-[12.5px] ${selected ? "text-fg" : "text-dim"}`}
          >
            <span className="w-3 shrink-0" aria-hidden />
            <span className="shrink-0 text-dim"><FileIcon mime={node.artifact.mime} /></span>
            <span className="min-w-0 flex-1 truncate font-mono text-[11.5px]">{node.name}</span>
            <span className="shrink-0 text-[10px] tabular-nums text-dim">{fmtSize(node.artifact.size)}</span>
          </button>
          {extra ? <span className="mr-1 ml-1 shrink-0">{extra}</span> : <span className="w-2 shrink-0" aria-hidden />}
        </div>
      );
    });

  if (!artifacts.length) return null;
  return (
    <div className="flex flex-col" role="tree" aria-label={t("Artifacts")} data-locale={locale}>
      {rows(tree, 0)}
    </div>
  );
}


// ── Modal ─────────────────────────────────────────────────────────────────────
interface ModalProps {
  artifact: ChatArtifact;
  content: ChatArtifactContent | null;
  loading: boolean;
  /** Download (Content-Disposition: attachment). */
  downloadUrl: string;
  /** Show in the window (image/PDF) — the same route with `inline=1`. */
  inlineUrl: string;
  onClose: () => void;
  /** Save the file. If the function is MISSING the text is read-only — so foreign artifacts (neighbour chat in the same folder)
   *  stay what they are. `expectedSha256` is the state the work was based on; the server rejects with 409 if someone else wrote
   *  in the meantime, instead of overwriting silently. The NEW sha256 comes back — by it the window recognises which reloaded
   *  content is the one just saved and which is still the old one. The caller then passes file and content from
   *  `afterTheSave` in — NOT via a reload with `content = null`/`loading`: that made the editor give way to "Loading…" and be
   *  recreated (cursor, scroll position and undo were gone after every save). */
  onSave?: (text: string, expectedSha256: string) => Promise<string>;
}

/** File and content AFTER a manual save — from the server's response and the text that was saved, without re-reading and
 *  without an intermediate step through `null`. The window recognises by it (same sha256 as the save response) that it gets its
 *  own state back, and leaves the editor alone. The origin (`chatId`, `chatTitle`, `own`) stays that of the open file — the
 *  server's response does not know it. Used by ChatPane and the folder view so both paths pass in the same state. */
export function afterTheSave(file: ChatArtifact, saved: ChatArtifact, text: string): { file: ChatArtifact; content: ChatArtifactContent } {
  const fresh: ChatArtifact = { ...file, ...saved, chatId: file.chatId, chatTitle: file.chatTitle, own: file.own };
  return { file: fresh, content: { ...fresh, offset: 0, nextOffset: null, truncated: false, encoding: "utf8", content: text } };
}

// Is the text read as Markdown (large headings, markers hidden) or as bare source? Markdown and plain text yes, JSON/YAML/code
// no — there `**` and `#` mean nothing, and a rendering that swallows them would simply be wrong.
const editsAsMarkdown = (mime: string) => mime.startsWith("text/markdown") || mime.startsWith("text/plain");

export function ArtifactModal({ artifact, content, loading, downloadUrl, inlineUrl, onClose, onSave }: ModalProps) {
  const t = useT();
  const flat = useFlat();
  // There is NO switch between reading and editing: the text stands as it reads and can be touched. It is editable only when
  // the FULL content is present — a truncated copy (>1 MiB) would shrink the file to the preview on save.
  const canEdit = !!onSave && content?.encoding === "utf8" && !content.truncated && !loading;
  const [draft, setDraft] = useState("");
  // State the draft is based on. It decides "changed?" AND goes to the server as expectedSha256 — not the file's current state,
  // else a save would overwrite exactly the foreign change the check is meant to protect against.
  const [base, setBase] = useState<{ sha: string; text: string } | null>(null);
  // sha256 we expect from the server after a save. Until the expected state arrives, every incoming content is still the OLD
  // one and must not replace the text just saved.
  const [awaiting, setAwaiting] = useState("");
  // The file changed elsewhere WHILE unsaved text stood here. Set during reconciliation, not guessed from checksums — only
  // there is it known that an adoption was skipped because of open work.
  const [stale, setStale] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedOnce, setSavedOnce] = useState(false);
  const [error, setError] = useState("");
  // Closing with unsaved text: instead of silently discarding (or silently saving) a line with the choice appears below the
  // header.
  const [askToClose, setCloseQuestions] = useState(false);
  const dirty = base !== null && draft !== base.text;
  // Is there an editor? As soon as a draft of this file exists (`base`), and then until the file changes — explicitly NOT tied
  // to `loading` or the content just loaded. If the caller reloads the file (the agent wrote, rejoin after a stream gap), the
  // editor stays with cursor, scroll position and undo; the new text arrives through the reconciliation below. Only WITH `base`
  // (not already with `canEdit`): an editor that is created empty and gets its text afterwards carries the insertion in its undo
  // list — ⌘Z would then empty the whole file.
  const edited = !!onSave && base !== null;
  // The one tick between the content arriving and the reconciliation: the editor follows right away — until then "Loading…"
  // stays instead of the read text for one tick.
  const editorComes = canEdit && base === null;
  const canSave = edited && dirty && !saving;

  // File switch: the draft is dropped. Without it the next file would carry the previous one's text. Stands FIRST so the
  // reconciliation below is not reset immediately on the first render.
  const fileKey = artifactKey(artifact);
  useEffect(() => {
    setBase(null);
    setDraft("");
    setAwaiting("");
    setStale(false);
    setSavedOnce(false);
    setError("");
    setCloseQuestions(false);
  }, [fileKey]);

  const dirtyRef = useRef(false);
  dirtyRef.current = dirty;
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const baseRef = useRef(base);
  baseRef.current = base;
  // The text currently on its way to the server. The server reports the change in the event stream BEFORE its response; if the
  // caller then reloads, exactly this text arrives here before the save knows its sha — that is not a conflict but our own save.
  const inFlightRef = useRef<string | null>(null);

  // New content from the server (another file opened, or the agent overwrote it): adopt it into the draft — but NEVER over
  // unsaved work.
  useEffect(() => {
    // No content: it is being (re)loaded. Draft AND base text stay — the editor stays (`edited`), and unsaved work keeps
    // counting as unsaved instead of being written away by the reloaded text.
    if (!content) return;
    if (content.encoding !== "utf8" || content.truncated) { if (!dirtyRef.current) setBase(null); return; }
    if (awaiting) {
      if (content.sha256 !== awaiting) return;
      setAwaiting("");
    }
    if (base?.sha === content.sha256) { setStale(false); return; }
    // Our own text on its way to the server: the save response sets the base text.
    if (content.content === inFlightRef.current) return;
    // The same text that already stands here is no conflict — only the new base state.
    if (content.content === draftRef.current) { setBase({ sha: content.sha256, text: content.content }); setStale(false); return; }
    if (dirtyRef.current) { setStale(true); return; }
    setBase({ sha: content.sha256, text: content.content });
    setDraft(content.content);
    setStale(false);
    setError("");
  }, [content, base?.sha, awaiting]);

  // ── Manual save ─────────────────────────────────────────────────────────────
  // Writing happens only via the button, ⌘S/Ctrl+S or the question on closing — for EVERY file kind of this window (Markdown,
  // text, JSON, code), not by autosave.
  //
  // Saves still hang on ONE chain: each write carries the sha of the previous one, two simultaneous ones (double click, ⌘S
  // twice) would shoot each other down with 409. The next starts only when the previous is done, and then takes the then-current
  // text along.
  const chainRef = useRef<Promise<unknown>>(Promise.resolve());
  // `onSave` arrives as a freshly bound function on EVERY render of the calling view — via a ref, so `save` keeps a stable
  // identity (shortcut below).
  const saveRef = useRef(onSave);
  saveRef.current = onSave;

  /** Writes the draft; `true` if nothing unsaved from this run remains afterwards. */
  const save = useCallback((): Promise<boolean> => {
    const run = chainRef.current.then(async () => {
      const current = baseRef.current;
      const text = draftRef.current;
      const write = saveRef.current;
      if (!write || !current) return false;
      if (text === current.text) return true;
      inFlightRef.current = text;
      setSaving(true);
      try {
        const sha = await write(text, current.sha);
        setBase({ sha, text });
        setAwaiting(sha);
        setStale(false);
        setSavedOnce(true);
        setError("");
        return true;
      } catch (e) {
        // Do not retry: on 409 ("changed elsewhere") every attempt failed. The text stays.
        setError(String((e as Error).message || e));
        return false;
      } finally {
        inFlightRef.current = null;
        setSaving(false);
      }
    });
    chainRef.current = run.catch(() => undefined);
    return run;
  }, []);

  const closeRef = useRef<() => void>(() => {});
  closeRef.current = () => {
    if (dirtyRef.current) setCloseQuestions(true);
    else onClose();
  };
  const requestClose = () => closeRef.current();
  const saveAndClose = async () => {
    if (await save()) onClose();
  };
  const asksRef = useRef(false);
  asksRef.current = askToClose && dirty;

  // Escape closes (if the question is showing, Escape first takes it back — the text stays). ⌘S/Ctrl+S saves; the combination
  // is always intercepted, else the browser would open "Save page".
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (asksRef.current) setCloseQuestions(false);
        else closeRef.current();
        return;
      }
      if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "s") {
        e.preventDefault();
        void save();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [save]);

  // Short state next to path and size.
  const note = error
    ? { text: error, tone: "text-danger" }
    : saving
    ? { text: t("saving…"), tone: "text-dim" }
    : dirty
    ? { text: t("unsaved"), tone: "text-dim" }
    : savedOnce
    ? { text: t("saved"), tone: "text-ok" }
    : null;

  // The file changed elsewhere while unsaved text stands here. A line above the text, no box — the content lies flat in the
  // sheet.
  const staleRow = stale && (
    <p className="shrink-0 px-4 pt-3 text-[11.5px] text-warn">
      {t("The file has changed elsewhere in the meantime. Saving will fail — copy your text and open the file again.")}
    </p>
  );

  // EXACTLY ONE scroll area per view. The surface under the header used to scroll (`overflow-auto`) AND inside it the text field
  // of an editable non-Markdown file (JSON, YAML, code, …): its height came from `rows` = line count, wrapped long lines did not
  // fit, and it scrolled on its own as well. The same with the PDF once the window was lower than `min-h-[420px]`. Now: if the
  // content scrolls itself (Markdown editor, text field, PDF viewer) the surface is fixed; otherwise (read text, image, notices)
  // only it scrolls.
  //
  // The Markdown editor is itself the scroll area (height="100%"), not a child of the scrolling surface. CodeMirror renders only
  // the visible part and ESTIMATES the height of the remaining lines; if an outer surface scrolls, it cannot follow the scroll
  // position when re-measuring — the document "breathes" under the scrollbar, and a jump to the end lands short of it. As its
  // own scroll area CodeMirror holds the anchor itself.
  const markdownEditor = edited && editsAsMarkdown(artifact.mime);
  const textEditor = edited && !markdownEditor;
  const pdf = artifact.mime === "application/pdf";
  const selfScrolling = edited || pdf;

  const read = (body: ChatArtifactContent) => (
    <div className="min-w-0 text-[13px]">
      {editsAsMarkdown(artifact.mime) ? (
        <Markdown src={body.content} />
      ) : (
        <pre className="whitespace-pre-wrap break-words font-mono text-[12px] leading-relaxed text-fg">{body.content}</pre>
      )}
      {body.truncated && (
        <p className="mt-4 text-[11.5px] text-warn">
          {t("Preview truncated after 1 MiB. Download the file for the full content.")}
        </p>
      )}
    </div>
  );

  // A click beside it closes — but only if the POINTER PRESS was beside it too. Whoever starts a text selection in the editor and
  // releases it over the veil has, for the browser, clicked the veil; without this check the sheet would close mid-edit.
  const pressOnVeil = useRef(false);
  if (typeof document === "undefined") return null;

  return createPortal(
    // Veil and sheet from the Kit vocabulary (`cb-overlay` + `cb-sheet`): the same shape as every other modal of the house.
    // `cb-kit` tints the roles inside coolly.
    //
    // Via PORTAL to the body, not in place: the Coding stage is `@container/kit`, and layout containment makes it the reference
    // frame for `position: fixed`. Rendered in the tree, `inset-0` would only fill the stage — the 88vh sheet would stick out at
    // the bottom and be clipped by it (the scroll area ended before the last line), and in the folder view the conversation's
    // header (z-20, later in the DOM) lay over the modal.
    <div
      className={`cb-kit cb-overlay cb-overlay-in fixed inset-0 z-[70] flex items-center justify-center p-3 sm:p-6${flat}`}
      onMouseDown={(e) => { pressOnVeil.current = e.target === e.currentTarget; }}
      onClick={(e) => { if (e.target === e.currentTarget && pressOnVeil.current) requestClose(); }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={artifact.path}
        className="cb-sheet cb-pop-in flex h-[min(88vh,900px)] max-h-full w-[min(980px,calc(100vw-2rem))] flex-col overflow-hidden rounded-3xl text-fg"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex shrink-0 items-center gap-3 border-b border-edge px-4 py-3">
          <span className="shrink-0 text-accent"><FileIcon mime={artifact.mime} /></span>
          <div className="min-w-0 flex-1">
            <div className="truncate font-mono text-[13px] font-medium text-fg">{artifact.path}</div>
            <div className="truncate text-[11px] text-dim">
              {artifact.mime} · {fmtSize(artifact.size)}
              {artifact.own === false && <> · {t("shared from \"{chat}\"", { chat: artifact.chatTitle || "" })}</>}
              {note && <> · <span className={note.tone} title={note.text}>{note.text}</span></>}
            </div>
          </div>
          {edited && (
            <button
              type="button"
              data-artifact-save
              onClick={() => { void save(); }}
              disabled={!canSave}
              className={`${primary} shrink-0 disabled:opacity-35`}
            >
              {t("Save")}
            </button>
          )}
          <a
            href={downloadUrl}
            download={artifact.name}
            className="shrink-0 rounded-full border border-edge px-3 py-1.5 text-[11.5px] font-medium text-dim transition-colors hover:bg-hover hover:text-fg"
          >
            {t("Download")}
          </a>
          <button
            type="button"
            onClick={requestClose}
            aria-label={t("Close")}
            className="grid h-7 w-7 shrink-0 place-items-center rounded-full text-dim transition-colors hover:bg-hover hover:text-fg"
          >
            {svg(<><path d="M18 6 6 18" /><path d="m6 6 12 12" /></>, 15)}
          </button>
        </header>
        {/* Closing with unsaved text: a line below the header, on a hairline — no second sheet (the app's confirmation sheets sit
            at z-60, BELOW this window). */}
        {askToClose && dirty && (
          <div role="alert" data-artifact-close className="flex shrink-0 flex-wrap items-center gap-2 border-b border-edge px-4 py-2.5">
            <span className="min-w-0 flex-1 text-[12.5px] text-fg">{t("Unsaved changes")}</span>
            <button type="button" onClick={() => setCloseQuestions(false)} className={ghost}>{t("Cancel")}</button>
            <button type="button" onClick={onClose} className={quietDanger}>{t("Discard changes")}</button>
            <button
              type="button"
              autoFocus
              onClick={() => { void saveAndClose(); }}
              disabled={saving}
              className={`${primary} disabled:opacity-35`}
            >
              {t("Save")}
            </button>
          </div>
        )}
        <div className={selfScrolling ? "flex min-h-0 flex-1 flex-col overflow-hidden" : "cb-scroll min-h-0 flex-1 overflow-auto p-4"}>
          {markdownEditor ? (
            <div className="flex min-h-0 min-w-0 flex-1 flex-col text-[13px]">
              {staleRow}
              <div className="min-h-0 min-w-0 flex-1 px-4">
                <MarkdownEditor value={draft} onChange={setDraft} variant="reading" height="100%" padding="16px 0" className="h-full" />
              </div>
            </div>
          ) : textEditor ? (
            <div className="flex min-h-0 min-w-0 flex-1 flex-col">
              {staleRow}
              {/* Not Markdown: bare source in the font of the read view's <pre>. The field is itself the scroll area (fills the
                  surface); long lines wrap as before. */}
              <textarea
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                spellCheck={false}
                aria-label={artifact.path}
                className="cb-scroll min-h-0 w-full flex-1 resize-none overflow-y-auto whitespace-pre-wrap break-words bg-transparent p-4 font-mono text-[12px] leading-relaxed text-fg outline-none"
              />
            </div>
          ) : loading || editorComes ? (
            <div className="grid h-full place-items-center text-[12px] text-dim">{t("Loading…")}</div>
          ) : artifact.mime.startsWith("image/") ? (
            <div className="grid min-h-full place-items-center">
              <img src={inlineUrl} alt={artifact.name} className="max-h-full max-w-full rounded-lg object-contain" />
            </div>
          ) : pdf ? (
            // The PDF viewer scrolls itself; it fills the surface instead of forcing a scroll through a minimum height.
            <div className="flex min-h-0 flex-1 flex-col p-4">
              <iframe src={inlineUrl} title={artifact.name} className="min-h-0 w-full flex-1 rounded-lg border border-edge" />
            </div>
          ) : content?.encoding === "utf8" ? (
            read(content)
          ) : (
            <div className="grid h-full place-items-center px-5 text-center text-[12.5px] text-dim">
              <div>
                <p>{t("No preview is available for this file type.")}</p>
                <p className="mt-1">{t("You can download the file.")}</p>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
