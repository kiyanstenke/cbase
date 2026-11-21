"use client";

// THE "Archive" menu entry — for chat and folder, in every menu: row, folder, header. One flow across six menus would be six
// copies of the same code.
//
// On show it loads the precheck and lists the reasons for open work as gray rows below it (`data-archive-reason`; the text
// comes from the SERVER) — then it is locked. If the open question is the ONLY reason, "Discard question and archive" appears
// below. Open shells it names in gray and asks before archiving — even if the precheck failed, then without a count
// (`archiveShellQuestion`: otherwise the PUT would end a running shell without a word). The PUT still checks open work itself:
// a precheck is a snapshot, and a 409 arrives as a message with the reasons.
//
// The flow lives in `lib/archive.ts` (`loadPrecheck`, `archiveProcedure`), and this file passes the API functions in
// unwrapped: a `.catch(() => ({ open: [], terminals: 0 }))` in the effect or a `vp ?? { terminals: 0 }` in `run` passed the
// gate and brought back the silent shell termination. There is no fallback value for the precheck here — `archive.test.mjs`
// holds that.
import { useEffect, useRef, useState } from "react";
import { archivePrecheck, folderArchivePrecheck, setArchive, setFolderArchive } from "@/lib/api";
import type { ArchivePrecheckChat, ArchivePrecheckFolder } from "@/lib/api";
import { archiveHint, archiveProcedure, loadPrecheck } from "@/lib/archive";
import { useT } from "@/lib/i18n";
import { useConfirm } from "@/components/Prompts";
import { menuSymbol, menuRow } from "@/components/CbKit";

export type ArchiveTarget = { kind: "chat" | "folder"; id: string };
type Precheck = ArchivePrecheckChat | ArchivePrecheckFolder;

/** The archive icon: a box with a lid — same stroke as the other menu icons. */
export function ArchiveIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="3" y="4" width="18" height="4" rx="1" />
      <path d="M5 8v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8" />
      <path d="M10 12h4" />
    </svg>
  );
}

/** The message of a failed archiving: the server sentence, below it the reasons (`open` on the chat, `chats` on the folder). */
export function archiveErrorText(e: unknown): string {
  const f = e as Error & { open?: { text?: string }[]; chats?: { title?: string; open?: { text?: string }[] }[] };
  const rows = [
    ...(f.open ?? []).map((o) => o.text || ""),
    ...(f.chats ?? []).map((c) => `${c.title || ""}: ${(c.open ?? []).map((o) => o.text).join(" · ")}`),
  ].filter(Boolean);
  return [f.message, ...rows].filter(Boolean).join("\n");
}

export function ArchiveEntry({ target, execute, after, prior, icon = false }: {
  target: ArchiveTarget;
  /** Instead of the default PUT (`setArchive`/`setFolderArchive`) — the coding chat header passes `archive` from `useArchive`
   *  so the open chat shows the bar immediately. */
  execute?: (opts: { dismissQuestion?: boolean }) => Promise<unknown>;
  /** After success: reload the list. */
  after?: () => void;
  /** Before the flow: close the surrounding menu (the flow continues even if the entry disappears). */
  prior?: () => void;
  /** Icon column like `MenuItem` of the Coding menus. */
  icon?: boolean;
}) {
  const t = useT();
  const question = useConfirm();
  const [vp, setVp] = useState<Precheck | null>(null);
  const load = useRef<Promise<Precheck | null> | null>(null);
  useEffect(() => {
    let alive = true;
 // Failed ⇒ `null` (unknown): the entry stays enabled — the PUT checks open work, `run` asks about shells.
    const p: Promise<Precheck | null> = target.kind === "chat"
      ? loadPrecheck(() => archivePrecheck(target.id))
      : loadPrecheck(() => folderArchivePrecheck(target.id));
    load.current = p;
    p.then((r) => { if (alive) setVp(r); });
    return () => { alive = false; };
  }, [target.kind, target.id]);

  const h = archiveHint(vp, t);

  async function run(dismissQuestion: boolean) {
    prior?.();
    // The state is the effect's promise (resolved or still pending); `null` means FAILED — not "no shell", then
    // `archiveShellQuestion` asks without a count.
    let archived: boolean;
    try {
      archived = await archiveProcedure(load.current, {
        question: (text) => question(text, { ok: t("Archive") }),
        execute: () => (execute
          ? execute(dismissQuestion ? { dismissQuestion: true } : {})
          : target.kind === "chat"
            ? setArchive(target.id, true, dismissQuestion ? { dismissQuestion: true } : undefined)
            : setFolderArchive(target.id, true)),
        t,
      });
    } catch (e) {
      alert(archiveErrorText(e) || t("Archiving failed"));
      return;
    }
    if (archived) after?.();
  }

  const identifier = target.kind === "chat" ? { "data-chat-archive": target.id } : { "data-folder-archive": target.id };
  // The Kit's menu row: shape, spacing, highlight and the disabled state come from `menuRow`.
  const row = `${menuRow} text-[12.5px] text-fg`;
  return (
    <>
      <button type="button" role="menuitem" {...identifier} disabled={h.locked} onClick={() => { void run(false); }} className={row}>
        {icon && <span aria-hidden className={menuSymbol}><ArchiveIcon /></span>}
        <span className="flex-1 truncate">{t("Archive")}</span>
      </button>
      {[...h.rows, ...(h.shells ? [h.shells] : [])].map((z, i) => (
        <div key={i} data-archive-reason className={`pb-1 pr-2.5 text-[11px] leading-snug text-dim ${icon ? "pl-[36px]" : "pl-2.5"}`}>{z}</div>
      ))}
      {h.onlyQuestion && target.kind === "chat" && (
        <button type="button" role="menuitem" data-archive-question-dismiss={target.id} onClick={() => { void run(true); }} className={row}>
          {icon && <span aria-hidden className={menuSymbol} />}
          <span className="flex-1 truncate">{t("Discard the question and archive")}</span>
        </button>
      )}
    </>
  );
}
