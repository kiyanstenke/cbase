"use client";

// View of ONE chat folder: on the left what the user puts in (context files), on the right
// what is produced in it (the artifacts of all chats in the folder).
//
// Why two kinds with almost the same mechanics? They play different roles. CONTEXT is input: briefing,
// specification, minutes, sample data. The human drops it in, every chat of the folder may read it, no agent may
// change it. ARTIFACTS are output: each belongs to one chat, which also writes it. Separate names keep this
// difference visible in the UI and in the agent's tool set
// (cbase_folder_context_read versus cbase_artifacts_write).
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { API_BASE, api, type Chat, type ChatFolder } from "@/lib/api";
import { ArtifactModal, ArtifactTree, type ChatArtifact, type ChatArtifactContent, artifactIsText, artifactKey, artifactTree, afterTheSave } from "@/components/ArtifactBrowser";
import { useT } from "@/lib/i18n";
import { ghost } from "@/components/CbKit";
import { useConfirm } from "@/components/Prompts";

const svg = (children: React.ReactNode, size = 15) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    {children}
  </svg>
);

interface Props {
  folder: ChatFolder;
  /** Chats of THIS folder, for grouping the artifacts and for jump targets. */
  chats: Chat[];
  locale: string;
  /** Changes when the server reports a context change; then reload. */
  reloadToken?: number;
  onOpenChat: (chatId: string) => void;
  onClose: () => void;
}

export function ChatFolderView({ folder, chats, locale, reloadToken = 0, onOpenChat, onClose }: Props) {
  const t = useT();
  const question = useConfirm();
  const [context, setContext] = useState<ChatArtifact[]>([]);
  const [artifacts, setArtifacts] = useState<ChatArtifact[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [error, setError] = useState("");
  // Open file: `kind` decides which route is used for reading and writing.
  const [open, setOpen] = useState<{ kind: "context" | "artifact"; file: ChatArtifact } | null>(null);
  const [openContent, setOpenContent] = useState<ChatArtifactContent | null>(null);
  const [openLoading, setOpenLoading] = useState(false);
  // Expanded folders per tree. Kept apart because the same file "briefing.md" can be context on the left and
  // an artifact on the right, and the keys would collide.
  const [ctxDirs, setCtxDirs] = useState<Set<string>>(new Set());
  const [kindDirs, setKindDirs] = useState<Set<string>>(new Set());
  const aliveRef = useRef(true);
  const primedRef = useRef("");
  useEffect(() => () => { aliveRef.current = false; }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [ctx, arts] = await Promise.all([
        api<ChatArtifact[]>(`/api/chat-folders/${folder.id}/context`).catch(() => []),
        api<ChatArtifact[]>(`/api/chat-folders/${folder.id}/artifacts`).catch(() => []),
      ]);
      if (!aliveRef.current) return;
      setContext(ctx);
      setArtifacts(arts);
    } finally {
      if (aliveRef.current) setLoading(false);
    }
  }, [folder.id]);

  useEffect(() => { load().catch(console.error); }, [load, reloadToken]);

  const contextUrl = (file: ChatArtifact, inline: boolean) =>
    `${API_BASE}/api/chat-folders/${folder.id}/context/download?path=${encodeURIComponent(file.path)}${inline ? "&inline=1" : ""}`;
  const artifactUrl = (file: ChatArtifact, inline: boolean) =>
    `${API_BASE}/api/chats/${file.chatId}/artifacts/download?path=${encodeURIComponent(file.path)}${inline ? "&inline=1" : ""}`;

  // Reading and writing use different routes: context belongs to the FOLDER, an artifact to ITS chat.
  // The kind decides, nothing else, so the path is defined once here.
  const fileRoute = (kind: "context" | "artifact", file: ChatArtifact) =>
    kind === "context"
      ? `/api/chat-folders/${folder.id}/context/file`
      : `/api/chats/${file.chatId}/artifacts/file`;

  async function readFile(kind: "context" | "artifact", file: ChatArtifact) {
    return api<ChatArtifactContent>(`${fileRoute(kind, file)}?path=${encodeURIComponent(file.path)}&maxBytes=1048576`);
  }

  async function openFile(kind: "context" | "artifact", file: ChatArtifact) {
    setOpen({ kind, file });
    setOpenContent(null);
    if (!artifactIsText(file.mime)) return;
    setOpenLoading(true);
    try {
      const content = await readFile(kind, file);
      if (aliveRef.current) setOpenContent(content);
    } catch (e) {
      if (aliveRef.current) setOpenContent({ ...file, offset: 0, nextOffset: null, truncated: false, encoding: "utf8", content: String(e) });
    } finally {
      if (aliveRef.current) setOpenLoading(false);
    }
  }

  // Edit the open file by hand. The write goes through the OWNER's route, so the rule "only its own chat writes
  // an artifact" still holds; the human merely stands in for the agent.
  async function saveOpenFile(text: string, expectedSha256: string) {
    if (!open) throw new Error(t("No file open"));
    const { kind, file } = open;
    const saved = await api<ChatArtifact>(fileRoute(kind, file), {
      method: "PUT",
      body: JSON.stringify({ path: file.path, content: text, encoding: "utf8", expectedSha256 }),
    });
    // Update the open file AND its content, otherwise the header keeps showing the old size and timestamp.
    // Built from the response and the saved text, with no re-read and no intermediate null (`afterTheSave`,
    // same path as in ChatPane): the window recognises its own state and leaves the editor alone.
    const { file: fileItem, content } = afterTheSave(file, saved, text);
    if (aliveRef.current) {
      setOpen({ kind, file: fileItem });
      setOpenContent(content);
    }
    await load();
    return saved.sha256;
  }

  // Upload context. As with artifact upload: for an existing file the server answers 409 + `exists`;
  // we ask and retry with ?overwrite=1 only after a yes.
  async function uploadContext(list: FileList | File[]) {
    const chosen = Array.from(list);
    if (!chosen.length) return;
    setUploading(true);
    setError("");
    try {
      for (const file of chosen) {
        const name = (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;
        const put = (overwrite: boolean) =>
          api<ChatArtifact>(
            `/api/chat-folders/${folder.id}/context/upload?path=${encodeURIComponent(name)}${overwrite ? "&overwrite=1" : ""}`,
            { method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: file },
          );
        try {
          await put(false);
        } catch (e) {
          const conflict = e as Error & { exists?: boolean; path?: string };
          if (!conflict.exists) throw e;
          if (!(await question(t("\"{name}\" already exists in this folder. Overwrite?", { name: conflict.path || name }), { ok: t("Overwrite") }))) continue;
          await put(true);
        }
      }
    } catch (e) {
      setError(t("Upload failed: {msg}", { msg: String((e as Error).message) }));
    } finally {
      setUploading(false);
    }
    await load().catch(console.error);
  }

  async function deleteContext(file: ChatArtifact) {
    if (!(await question(t("Delete \"{name}\" from the folder context?", { name: file.path }), { ok: t("Delete"), danger: true }))) return;
    try {
      await api(`/api/chat-folders/${folder.id}/context/file?path=${encodeURIComponent(file.path)}&expectedSha256=${encodeURIComponent(file.sha256)}`, { method: "DELETE" });
      if (open?.kind === "context" && open.file.path === file.path) setOpen(null);
      await load();
    } catch (e) {
      setError(t("Delete failed: {msg}", { msg: String((e as Error).message) }));
    }
  }

  // The folder's artifacts each belong to one chat (`own:false`), so the tree puts them under one node PER CHAT
  // with the real directories folded below. On first load of a folder these chat nodes are open ("which chat
  // produced what" is the question one opens a folder view with). Deeper folders stay closed.
  const chatKeys = useMemo(
    () => artifactTree(artifacts, t).filter((n) => n.kind === "dir" && n.shared).map((n) => n.key),
    [artifacts, t],
  );
  useEffect(() => {
    if (!artifacts.length || primedRef.current === folder.id) return;
    primedRef.current = folder.id;
    setKindDirs(new Set(chatKeys));
  }, [artifacts.length, chatKeys, folder.id]);
  const toggle = (set: (fn: (cur: Set<string>) => Set<string>) => void) => (key: string) =>
    set((cur) => {
      const next = new Set(cur);
      if (!next.delete(key)) next.add(key);
      return next;
    });

  const deleteButton = (file: ChatArtifact) => (
    <button
      type="button"
      onClick={() => deleteContext(file)}
      title={t("Delete")}
      aria-label={t("Delete")}
      className="grid h-6 w-6 place-items-center rounded-full text-dim opacity-0 transition-opacity hover:text-danger focus-visible:opacity-100 group-hover:opacity-100"
    >
      {svg(<><path d="M4 7h16" /><path d="M10 11v6" /><path d="M14 11v6" /><path d="M6 7l1 13h10l1-13" /><path d="M9 7V4h6v3" /></>, 13)}
    </button>
  );

  return (
    // Same stage as the conversation (opaque `panel`), the two collections as flat cards.
    <div className="cb-kit cb-kit-stage flex h-full min-h-0 flex-col bg-panel">
      <header className="flex shrink-0 items-center gap-3 px-6 pb-3 pt-5">
        <span className="text-accent">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z" fill="currentColor" fillOpacity="0.2" />
          </svg>
        </span>
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-[19px] font-medium tracking-tight text-fg">{folder.name}</h1>
          <p className="truncate text-[11.5px] text-dim">
            {chats.length === 1 ? t("1 chat") : t("{n} chats", { n: chats.length })}
            {" · "}
            {context.length === 1 ? t("1 context file") : t("{n} context files", { n: context.length })}
            {" · "}
            {artifacts.length === 1 ? t("1 artifact") : t("{n} artifacts", { n: artifacts.length })}
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          className={`${ghost} shrink-0`}
        >
          {t("Back to chat")}
        </button>
      </header>

      {error && (
        <div className="mx-6 mb-2 shrink-0 rounded-xl border border-danger/40 bg-danger/10 px-3 py-2 text-[12px] text-danger">{error}</div>
      )}

      <div className="cb-scroll grid min-h-0 flex-1 grid-cols-1 gap-4 overflow-y-auto px-6 pb-6 lg:grid-cols-2 lg:overflow-hidden">
        {/* Context: what the user provides. */}
        <section
          className={`cb-kit-pane flex min-h-0 flex-col overflow-hidden rounded-2xl ${dragOver ? "outline-dashed outline-2 -outline-offset-2 outline-accent/70" : ""}`}
          onDragOver={(e) => {
            if (!e.dataTransfer.types.includes("Files")) return;
            e.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragOver(false); }}
          onDrop={(e) => {
            if (!e.dataTransfer.files.length) return;
            e.preventDefault();
            setDragOver(false);
            uploadContext(e.dataTransfer.files);
          }}
        >
          <div className="flex shrink-0 items-center gap-2 border-b border-edge px-4 py-3">
            <div className="min-w-0 flex-1">
              <h2 className="text-[13px] font-semibold text-fg">{t("Folder context")}</h2>
              <p className="truncate text-[11px] text-dim">{t("Every chat in this folder may read this — read-only.")}</p>
            </div>
            {/* <label> with the field INSIDE: a programmatic input.click() opens no file dialog
                in the Electron client (see ChatPane). */}
            <label
              title={t("Upload context files")}
              aria-label={t("Upload context files")}
              className={`${ghost} relative flex shrink-0 items-center gap-1.5 ${uploading ? "pointer-events-none opacity-40" : "cursor-pointer"}`}
            >
              {uploading
                ? <span className="h-3 w-3 animate-spin rounded-full border-[1.5px] border-edge border-t-accent" />
                : svg(<><path d="M12 19V7" /><path d="m6 12 6-6 6 6" /><path d="M5 20h14" /></>, 13)}
              {t("Upload")}
              <input
                type="file"
                multiple
                disabled={uploading}
                className="absolute h-px w-px overflow-hidden opacity-0"
                onChange={(e) => { const picked = e.target.files; e.target.value = ""; if (picked?.length) uploadContext(picked); }}
              />
            </label>
          </div>
          <div className="cb-scroll min-h-0 flex-1 overflow-y-auto p-2">
            {loading ? (
              <p className="px-3 py-6 text-center text-[12px] text-dim">{t("Loading…")}</p>
            ) : context.length === 0 ? (
              <p className="px-4 py-8 text-center text-[12px] leading-relaxed text-dim">
                {t("No context yet. Upload briefings, specifications or sample data — every chat in this folder can then read them.")}
              </p>
            ) : (
              <ArtifactTree
                artifacts={context}
                openDirs={ctxDirs}
                onToggleDir={toggle(setCtxDirs)}
                onOpenFile={(file) => openFile("context", file)}
                selectedKey={open?.kind === "context" ? artifactKey(open.file) : null}
                fileAction={deleteButton}
                locale={locale}
              />
            )}
          </div>
        </section>

        {/* Artifacts: what the chats produced. */}
        <section className="cb-kit-pane flex min-h-0 flex-col overflow-hidden rounded-2xl">
          <div className="shrink-0 border-b border-edge px-4 py-3">
            <h2 className="text-[13px] font-semibold text-fg">{t("Artifacts of the chats")}</h2>
            <p className="truncate text-[11px] text-dim">{t("Results from the chats in this folder — every file is written only in its own chat.")}</p>
          </div>
          <div className="cb-scroll min-h-0 flex-1 overflow-y-auto p-2">
            {loading ? (
              <p className="px-3 py-6 text-center text-[12px] text-dim">{t("Loading…")}</p>
            ) : artifacts.length === 0 ? (
              <p className="px-4 py-8 text-center text-[12px] leading-relaxed text-dim">
                {t("No artifacts in this folder yet.")}
              </p>
            ) : (
              <ArtifactTree
                artifacts={artifacts}
                openDirs={kindDirs}
                onToggleDir={toggle(setKindDirs)}
                onOpenFile={(file) => openFile("artifact", file)}
                selectedKey={open?.kind === "artifact" ? artifactKey(open.file) : null}
                onOpenChat={onOpenChat}
                locale={locale}
              />
            )}
          </div>
        </section>
      </div>

      {open && (
        <ArtifactModal
          artifact={open.file}
          content={openContent}
          loading={openLoading}
          downloadUrl={open.kind === "context" ? contextUrl(open.file, false) : artifactUrl(open.file, false)}
          inlineUrl={open.kind === "context" ? contextUrl(open.file, true) : artifactUrl(open.file, true)}
          onClose={() => { setOpen(null); setOpenContent(null); }}
          onSave={saveOpenFile}
        />
      )}
    </div>
  );
}
