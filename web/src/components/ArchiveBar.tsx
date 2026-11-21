"use client";

// The bar in place of the composer in an archived chat. In Coding it sits in the stage's child slot where `<ChatComposer>`
// would be (`dockRef` measures the slot height there) — same width and position as the composer island so the history does
// not jump on the switch.
//
// It is also the undo of archiving: after "Archive" the chat stays open, with this bar.
import { useState } from "react";
import { dateLocale, useT } from "@/lib/i18n";
import { ArchiveIcon } from "@/components/ArchiveEntry";

export function ArchiveBar({ archivedAt, onRestore }: {
  archivedAt: number | null;
  onRestore: () => Promise<unknown>;
}) {
  const t = useT();
  const [running, setRunning] = useState(false);
  const datum = archivedAt ? new Date(archivedAt).toLocaleDateString(dateLocale(), { day: "2-digit", month: "2-digit", year: "numeric" }) : "";
  return (
    <div
      data-archive-bar
      className="cb-kit-pane relative z-[1] mb-1.5 flex w-full items-center gap-3 rounded-[26px] py-2.5 pl-4 pr-2.5"
    >
      <span className="shrink-0 text-dim"><ArchiveIcon size={16} /></span>
      <span className="min-w-0 flex-1 truncate text-[13px] text-dim">
        {datum ? t("Archived on {date} — read only", { date: datum }) : t("Archived — read only")}
      </span>
      <button
        type="button"
        data-archive-bar-restore
        disabled={running}
        onClick={async () => {
          setRunning(true);
          try { await onRestore(); }
          catch (e) { alert((e as Error).message || t("Restoring failed")); }
          finally { setRunning(false); }
        }}
        className="shrink-0 rounded-full bg-dark px-3.5 py-1.5 text-[12.5px] font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
      >
        {t("Restore")}
      </button>
    </div>
  );
}
