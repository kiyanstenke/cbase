"use client";

// The "Outputs" folder under Artifacts. It shows the output location of the open chat LIVE and read-only: what agents and
// subagents leave there (reports, screenshots, check scripts). Two building blocks:
//   OutputsFolder  the "Outputs" row in the artifact tree of the right bar, with the tree below it (lib/outputs.ts
//                  outputsTree: newest first, `agents/` and `workflows/` collapsed under "Internal"); a jump from the
//                  chat text expands and filters (a folder with a `*` pattern). While open it refetches the list every
//                  10 s (live) as long as the page is visible. Every file and real folder row (and the "Outputs" row itself)
//                  carries a download link that shows on hover (always on touch screens): a file as it is, a folder as ZIP
//                  streamed by the server (GET …/outputs/folder; the "Internal" node is not a real folder and has none).
//   OutputsWindow  the open file: the SAME window as an artifact (ArtifactModal without `onSave`: read-only). Images and
//                  Markdown directly, other text as source (up to 1 MiB), everything else as a download. Always mounted
//                  in the bar: a click on a path in the chat opens the file and the bar on Artifacts (`onJump`).
import { useEffect, useMemo, useState } from "react";
import { ArtifactModal, type ChatArtifact, type ChatArtifactContent } from "@/components/ArtifactBrowser";
import { outputFolderUrl, outputUrl } from "@/lib/api";
import { type OutputEntry, type OutputsNode, INTERNAL_KEY, outputMime, outputsTree, outputsWay, filterOutputs } from "@/lib/outputs";
import { fmtSize } from "@/lib/chat-format";
import { useT } from "@/lib/i18n";
import { reloadOutputs, openOutputFile, useOutputs, useOutputsJump, useOpenOutput } from "@/components/chat/outputsStore";

const LIVE_MS = 10_000;
const PREVIEW_MAX = 1 << 20;

const svg = (children: React.ReactNode, size = 14) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    {children}
  </svg>
);
const Chevron = ({ open }: { open: boolean }) => (
  <span className={`inline-flex transition-transform duration-150 ${open ? "rotate-90" : ""}`}>{svg(<path d="M9 18l6-6-6-6" />, 12)}</span>
);
const Folder = ({ open }: { open: boolean }) => svg(<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z" fill="currentColor" fillOpacity={open ? 0.28 : 0.14} />);
// The output location is an inbox for the agents: a tray with an arrow going in, not an ordinary folder.
const Deposit = () => svg(<><path d="M22 12h-6l-2 3h-4l-2-3H2" /><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" /></>);
const File = ({ mime }: { mime: string }) => mime.startsWith("image/")
  ? svg(<><rect x="3" y="4" width="18" height="16" rx="2" /><circle cx="9" cy="10" r="1.6" /><path d="m5 18 5-5 4 4 2-2 3 3" /></>)
  : svg(<><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5z" /><path d="M14 3v5h5" /><path d="M9 13h6" /><path d="M9 17h4" /></>);

// The download as an anchor, not fetch+Blob: the browser (and Electron) stream straight to disk; the name comes from
// Content-Disposition. Hidden until the row is hovered or the link focused; on touch screens (no hover) always visible.
// It lies OVER the row's trailing size or count (absolute, out of the flow): no space is held for it while it is hidden, and on
// hover it takes the place of the number, which fades out (SWAPS_FOR_DOWNLOAD). `right` moves it left of a following button.
const DownloadLink = ({ href, label, right = "right-1" }: { href: string; label: string; right?: string }) => (
  <a href={href} download="" rel="noopener" data-output-download title={label} aria-label={label}
    className={`absolute top-1/2 ${right} grid h-6 w-6 -translate-y-1/2 place-items-center rounded-md text-dim opacity-0 transition-[opacity,color,background-color] hover:bg-hover hover:text-fg focus-visible:opacity-100 group-hover:opacity-100 pointer-coarse:opacity-100`}>
    {svg(<><path d="M12 4v11" /><path d="m7 10 5 5 5-5" /><path d="M5 20h14" /></>, 13)}
  </a>
);

const ROW = "group relative flex items-center rounded-lg transition-colors hover:bg-hover";
// The trailing size or count of a row WITH a download link: it gives way where the link appears (hover, keyboard focus, touch).
const SWAPS_FOR_DOWNLOAD = "transition-opacity group-hover:opacity-0 group-focus-within:opacity-0 pointer-coarse:opacity-0";
// The folder name: "Spend" already stands for COSTS (usage) in lib/i18n-de.ts, so the same key would read "Spend"
// here. Hence a separate key with a context suffix.
const useFolderName = () => useT()("Outputs##folder");
// The last applied jump (module-wide): the "Artifacts" section often only appears AFTER the click (the bar switches to
// it) and applies the jump on mount, but not again on a later remount (section switched away and back).
let applied = 0;

/** The "Outputs" row and its tree (see header). */
export function OutputsFolder({ chatId }: { chatId: string }) {
  const t = useT();
  const name = useFolderName();
  const state = useOutputs(chatId);
  const jump = useOutputsJump();
  const openFile = useOpenOutput();
  const [open, setOpen] = useState(false);
  const [dirs, setDirs] = useState<Set<string>>(() => new Set());
  const [filter, setFilter] = useState<{ folder: string; pattern: string | null } | null>(null);

  // Chat switch: collapsed, no filter.
  useEffect(() => { setOpen(false); setDirs(new Set()); setFilter(null); }, [chatId]);

  // A jump from the chat text: expand down to the target; a folder (with a pattern) becomes the filter.
  useEffect(() => {
    if (!jump || jump.chatId !== chatId || jump.seq <= applied) return;
    applied = jump.seq;
    setOpen(true);
    const z = jump.target;
    if (z.kind === "folder") {
      setFilter(z.path || z.pattern ? { folder: z.path, pattern: z.pattern } : null);
      setDirs((d) => new Set([...d, ...outputsWay(`${z.path}/x`, false)]));
    } else {
      setFilter(null);
      const e = state.list?.entries.find((x) => x.path === z.path);
      setDirs((d) => new Set([...d, ...outputsWay(z.path, e?.internal ?? false)]));
    }
    // React only to the jump itself (its number), not to every reload of the list.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jump?.seq, chatId]);

  // LIVE: open and visible => refetch every 10 s (and immediately on expand).
  useEffect(() => {
    if (!open) return;
    void reloadOutputs(chatId, { force: true });
    const id = window.setInterval(() => { if (document.visibilityState === "visible") void reloadOutputs(chatId, { force: true }); }, LIVE_MS);
    return () => window.clearInterval(id);
  }, [open, chatId]);

  const entries = state.list?.entries ?? [];
  const visible = useMemo(() => (filter ? filterOutputs(entries, filter.folder, filter.pattern) : entries), [entries, filter]);
  const tree = useMemo(() => outputsTree(visible, t("Internal")), [visible, t]);
  const toggle = (k: string) => setDirs((d) => { const n = new Set(d); if (n.has(k)) n.delete(k); else n.add(k); return n; });

  const rows = (node: OutputsNode[], depth: number): React.ReactNode => node.map((k) => {
    const pad = { paddingLeft: `${8 + depth * 13}px` };
    if (k.kind === "folder") {
      const on = dirs.has(k.key) || Boolean(filter && !k.internal);
      return (
        <div key={k.key} data-outputs-folder={k.key}>
          <div style={pad} className={ROW}>
            <button type="button" onClick={() => toggle(k.key)} aria-expanded={on} title={k.internal ? t("cbase working files: subagent outputs, workflow scripts") : undefined}
              className="flex min-w-0 flex-1 items-center gap-1.5 py-1.5 pr-2 text-left text-[12.5px] text-fg">
              <span className="shrink-0 text-dim"><Chevron open={on} /></span>
              <span className={`shrink-0 ${k.internal ? "text-dim" : "text-accent/80"}`}><Folder open={on} /></span>
              <span className={`min-w-0 flex-1 truncate ${k.internal ? "text-dim" : "font-medium"}`}>{k.name}</span>
              <span className={`shrink-0 tabular-nums text-[10px] text-dim ${k.key !== INTERNAL_KEY ? SWAPS_FOR_DOWNLOAD : ""}`}>{k.files}</span>
            </button>
            {k.key !== INTERNAL_KEY && (
              <DownloadLink href={outputFolderUrl(chatId, k.key.replace(/\/$/, ""))} label={t("Download as ZIP")} />
            )}
          </div>
          {on && rows(k.children, depth + 1)}
        </div>
      );
    }
    const selected = openFile?.chatId === chatId && openFile.path === k.entry.path;
    return (
      <div key={k.key} style={pad} className={`${ROW} ${selected ? "bg-hover" : ""}`}>
        <button type="button" onClick={() => openOutputFile(chatId, k.entry.path)} data-output-file={k.entry.path}
          title={`${k.entry.path} · ${fmtSize(k.entry.size)} · ${new Date(k.entry.changed).toLocaleString()}`}
          className={`flex min-w-0 flex-1 items-center gap-1.5 py-1.5 pr-2 text-left text-[12.5px] ${selected ? "text-fg" : "text-dim"}`}>
          <span className="w-3 shrink-0" aria-hidden />
          <span className="shrink-0 text-dim"><File mime={outputMime(k.name)} /></span>
          <span className="min-w-0 flex-1 truncate font-mono text-[11.5px]">{k.name}</span>
          <span className={`shrink-0 text-[10px] tabular-nums text-dim ${SWAPS_FOR_DOWNLOAD}`}>{fmtSize(k.entry.size)}</span>
        </button>
        <DownloadLink href={outputUrl(chatId, k.entry.path)} label={t("Download")} />
      </div>
    );
  });

  const list = state.list;
  return (
    <div className="mb-1 flex flex-col" data-outputs role="tree" aria-label={name}>
      <div className={ROW} style={{ paddingLeft: "8px" }}>
        <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open}
          title={t("What this chat's agents left for you — reports, screenshots, files. Read only.")}
          className="flex min-w-0 flex-1 items-center gap-1.5 py-1.5 pr-1 text-left text-[12.5px] text-fg">
          <span className="shrink-0 text-dim"><Chevron open={open} /></span>
          <span className="shrink-0 text-accent"><Deposit /></span>
          <span className="min-w-0 flex-1 truncate font-medium">{name}</span>
          <span className={`shrink-0 tabular-nums text-[10px] text-dim ${entries.length > 0 ? SWAPS_FOR_DOWNLOAD : ""}`}>{list ? (list.clipped ? `${list.total}+` : entries.length) : ""}</span>
        </button>
        {entries.length > 0 && <DownloadLink href={outputFolderUrl(chatId, "")} label={t("Download all as ZIP")} right={open ? "right-8" : "right-1"} />}
        {open && (
          <button type="button" onClick={() => void reloadOutputs(chatId, { force: true })} title={t("Refresh")} aria-label={t("Refresh")}
            className={`mr-1 grid h-6 w-6 shrink-0 place-items-center rounded-md text-dim transition-colors hover:bg-hover hover:text-fg ${state.loading ? "animate-pulse" : ""}`}>
            {svg(<><path d="M21 12a9 9 0 1 1-3-6.7" /><path d="M21 4v5h-5" /></>, 13)}
          </button>
        )}
      </div>
      {open && (
        <>
          {filter && (
            <div className="mx-2 my-1 flex items-center gap-1.5 text-[11px] text-dim" data-outputs-filter>
              <span className="min-w-0 flex-1 truncate font-mono" title={[filter.folder, filter.pattern].filter(Boolean).join("/")}>
                {t("Filter: {pattern}", { pattern: [filter.folder, filter.pattern].filter(Boolean).join("/") })}
              </span>
              <button type="button" onClick={() => setFilter(null)} className="shrink-0 rounded-md px-1.5 py-0.5 hover:bg-hover hover:text-fg">{t("Clear filter")}</button>
            </div>
          )}
          {state.error && !list ? (
            <p className="px-3 py-2 text-[11.5px] text-danger">{t("Outputs could not be loaded: {error}", { error: state.error })}</p>
          ) : !list ? (
            <p className="px-3 py-2 text-[11.5px] text-dim">{t("Loading…")}</p>
          ) : !visible.length ? (
            <p className="px-3 py-2 text-[11.5px] text-dim">{filter ? t("No file matches the filter.") : t("Nothing here yet.")}</p>
          ) : (
            rows(tree, 1)
          )}
          {list?.clipped && (
            // A cap says that it is one: the server returns the newest `max`.
            <p className="px-3 py-1.5 text-[11px] text-dim" data-outputs-clipped>
              {t("Newest {n} of {total} files — older ones are not listed.", { n: list.entries.length, total: list.total })}
            </p>
          )}
        </>
      )}
    </div>
  );
}

/** The open file (see header). `onJump`: a click on a path in the chat; the bar switches to Artifacts. */
export function OutputsWindow({ chatId, onJump }: { chatId: string | null; onJump: () => void }) {
  const open = useOpenOutput();
  const jump = useOutputsJump();
  const state = useOutputs(chatId);
  const [content, setContent] = useState<ChatArtifactContent | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (jump && chatId && jump.chatId === chatId) onJump();
    // React only to the jump itself (its number).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jump?.seq]);

  const entry: OutputEntry | null = open && chatId && open.chatId === chatId
    ? state.list?.entries.find((e) => e.path === open.path) ?? { path: open.path, size: 0, changed: 0, internal: false }
    : null;
  const file: ChatArtifact | null = useMemo(() => entry && ({
    path: entry.path, name: entry.path.split("/").pop() || entry.path, mime: outputMime(entry.path), size: entry.size,
    createdAt: entry.changed, modifiedAt: entry.changed, sha256: "",
  }), [entry?.path, entry?.size, entry?.changed]); // eslint-disable-line react-hooks/exhaustive-deps

  // Read text (Markdown, plain text, JSON, code) up to 1 MiB: the same route as the download, only `inline`.
  useEffect(() => {
    setContent(null);
    if (!file || !chatId) return;
    const text = file.mime.startsWith("text/") || /json|yaml/.test(file.mime);
    if (!text || file.size > PREVIEW_MAX) return;
    let cancelled = false;
    setLoading(true);
    fetch(outputUrl(chatId, file.path, true))
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const s = await r.text();
        if (!cancelled) setContent({ ...file, offset: 0, nextOffset: null, truncated: false, encoding: "utf8", content: s });
      })
      .catch(() => { if (!cancelled) setContent(null); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [file, chatId]);

  if (!file || !chatId) return null;
  return (
    <ArtifactModal
      artifact={file}
      content={content}
      loading={loading}
      downloadUrl={outputUrl(chatId, file.path)}
      inlineUrl={outputUrl(chatId, file.path, true)}
      onClose={() => openOutputFile(chatId, null)}
    />
  );
}
