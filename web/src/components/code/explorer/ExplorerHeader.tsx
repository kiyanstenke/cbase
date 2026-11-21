"use client";
// The sidebar header as in VS Code:
//   ActivityBar  the activity bar on TOP (VS Code `workbench.activityBar.location: top`): icons for Explorer, Search, Run and Debug
//                      (⇧⌘D), Outline, References, the chosen one UNDERLINED in the foreground colour; on the right the editor
//                      settings (cbase).
//   RootHeader         the root's section as a header row: arrow (collapses the tree), name in capitals, on hover the actions
//                      New File, New Folder, Refresh, Collapse All — and, which VS Code does not have, Upload (cbase).
//                      Arrow and name are ONE button with `aria-expanded` (keyboard: ↵/Space).
import { useT } from "@/lib/i18n";
import { ReferencesIcon } from "@/components/code/ReferencesBar";

export type Mode = "explorer" | "search" | "debug" | "outline" | "references";

const svg = (children: React.ReactNode, size = 16) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>{children}</svg>
);
const FilesSymbol = () => svg(<><path d="M14 3H7a2 2 0 0 0-2 2v12" /><path d="M9 7h7l4 4v8a2 2 0 0 1-2 2H11a2 2 0 0 1-2-2z" /><path d="M16 7v4h4" /></>, 18);
const SearchSymbol = () => svg(<><circle cx="10.5" cy="10.5" r="6.5" /><path d="M20 20l-4.8-4.8" /></>, 18);
// "Run and Debug" in the shape of the codicon debug-alt (triangle with bug).
const DebugSymbol = () => svg(<><path d="M5 4l9 6-9 6z" /><circle cx="17" cy="16" r="3.5" /><path d="M17 12.5v-1.5" /><path d="M13.5 16H12" /><path d="M22 16h-1.5" /></>, 18);
const LayoutSymbol = () => svg(<><path d="M9 6h12" /><path d="M9 12h12" /><path d="M9 18h12" /><path d="M4 6h.01" /><path d="M4 12h.01" /><path d="M4 18h.01" /></>, 18);
const GearSymbol = () => svg(<><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" /></>, 15);
// The section's actions in the shape of the codicons (new-file, new-folder, refresh, collapse-all) — 16 px.
const NewFileSymbol = () => svg(<><path d="M13 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V9z" /><path d="M13 3v6h6" /><path d="M12 12v6" /><path d="M9 15h6" /></>);
const NewFolderSymbol = () => svg(<><path d="M3 6a1 1 0 0 1 1-1h5l2 2h9a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z" /><path d="M12 11v6" /><path d="M9 14h6" /></>);
const RefreshSymbol = () => svg(<><path d="M20 5v5h-5" /><path d="M19.5 10A8 8 0 1 0 20 14" /></>);
const CollapseSymbol = () => svg(<><rect x="4" y="4" width="16" height="16" rx="1" /><path d="M8 12h8" /></>);
const UploadSymbol = () => svg(<><path d="M20 15v4a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1v-4" /><path d="M16 8l-4-4-4 4" /><path d="M12 4v12" /></>);
export const ArrowSymbol = ({ open }: { open: boolean }) => (
  <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden className={`transition-transform duration-100 ${open ? "rotate-90" : ""}`}>
    <path d="M6 4l4 4-4 4" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

export function ActivityBar({ mode, setMode, onSettings }: { mode: Mode; setMode: (m: Mode) => void; onSettings: () => void }) {
  const t = useT();
  const buttons: { m: Mode; title: string; symbol: React.ReactNode }[] = [
    { m: "explorer", title: t("Explorer"), symbol: <FilesSymbol /> },
    { m: "search", title: t("Search"), symbol: <SearchSymbol /> },
    { m: "debug", title: t("Run and Debug · ⇧⌘D"), symbol: <DebugSymbol /> },
    { m: "outline", title: t("Outline (symbols)"), symbol: <LayoutSymbol /> },
    { m: "references", title: t("References · ⌥⇧F12"), symbol: <ReferencesIcon /> },
  ];
  return (
    <div className="flex h-[35px] shrink-0 items-stretch gap-0.5 border-b border-edge px-1.5" role="tablist" aria-label={t("Side bar")}>
      {buttons.map(({ m, title, symbol }) => (
        <button
          key={m}
          type="button"
          role="tab"
          aria-selected={mode === m}
          title={title}
          data-activity={m}
          onClick={() => setMode(m)}
          className={`relative grid w-8 place-items-center transition-colors ${mode === m ? "text-fg" : "text-dim hover:text-fg"}`}
        >
          {symbol}
          {/* Chosen: underlined like the activity bar on top in VS Code (activityBarTop.activeBorder). */}
          {mode === m && <span aria-hidden className="absolute bottom-0 left-1 right-1 h-px bg-fg" />}
        </button>
      ))}
      <span className="flex-1" />
      <button type="button" onClick={onSettings} title={t("Editor settings")} className="grid w-8 place-items-center text-dim transition-colors hover:text-fg"><GearSymbol /></button>
    </div>
  );
}

export function RootHeader({ name, collapsed: closed, onToggle, onNewFile, onNewFolder, onRefresh, onCollapseAll, onUpload, upload }: {
  name: string; collapsed: boolean; onToggle: () => void;
  onNewFile: () => void; onNewFolder: () => void; onRefresh: () => void; onCollapseAll: () => void; onUpload: () => void;
  upload: { done: number; total: number } | null;
}) {
  const t = useT();
  const action = "grid h-[22px] w-[22px] place-items-center rounded-[5px] text-dim transition-colors hover:bg-hover hover:text-fg disabled:opacity-40";
  return (
    <div className="cb-tree-header flex h-[22px] shrink-0 items-center pr-1" data-tree-root title={name}>
      <button type="button" aria-expanded={!closed} onClick={onToggle} className="flex h-full min-w-0 flex-1 cursor-pointer items-center text-left outline-none focus-visible:outline-1 focus-visible:outline-accent" data-tree-root-button>
        <span className="grid w-[22px] shrink-0 place-items-center text-fg"><ArrowSymbol open={!closed} /></span>
        <span className="min-w-0 flex-1 truncate text-[11px] font-bold uppercase tracking-[0.04em] text-fg">{name}</span>
      </button>
      {/* On hover over the whole section as in VS Code (`group/section` in ExplorerSections) — and while something uploads
          (the count must stay visible). */}
      <span className={`shrink-0 items-center gap-px ${upload ? "flex" : "hidden group-hover/section:flex group-focus-within/section:flex"}`}>
        <button type="button" className={action} onClick={onNewFile} title={t("New File…")} data-tree-header="new-file"><NewFileSymbol /></button>
        <button type="button" className={action} onClick={onNewFolder} title={t("New Folder…")} data-tree-header="new-folder"><NewFolderSymbol /></button>
        <button type="button" className={action} onClick={onUpload} disabled={Boolean(upload)} title={t("Upload files into the selected folder")} data-tree-header="upload">
          {upload ? <span className="font-mono text-[9px] leading-none">{upload.done}/{upload.total}</span> : <UploadSymbol />}
        </button>
        <button type="button" className={action} onClick={onRefresh} title={t("Refresh Explorer")} data-tree-header="refresh"><RefreshSymbol /></button>
        <button type="button" className={action} onClick={onCollapseAll} title={t("Collapse Folders in Explorer")} data-tree-header="collapse"><CollapseSymbol /></button>
      </span>
    </div>
  );
}
