"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api, type AdoptableContextCategory, type ContextLinks, type ContextSuggestion, type ProjectCategory, type ProjectContextItem } from "@/lib/api";
import { dateLocale, useT } from "@/lib/i18n";
import { textPx } from "@/lib/appearance";
import { Markdown } from "@/components/Markdown";
import { MarkdownEditor } from "@/components/MarkdownEditor";
import { TabFade } from "@/components/TabFade";
import {
  Section, BackButton, Chevron, FACTS, Fact, SELECTED, Hint, Tile, LIST_ROW, Loading, EmptySentence, Menu, MenuEntry, Modal, Overline,
  SYM, Toggle as KitToggle, COLUMN, PagesHeader, Segments, Search, field, ghost, ghostSm, menuRow, popClass, primary, quietDangerSm, select,
} from "@/components/CbKit";
import { CategoryBar, CategorySymbol } from "@/components/CategoryBar";
import { useConfirm } from "@/components/Prompts";
import { ContainScope, Contained, useHeightMemory } from "@/lib/contain";

// ── The project context in the form of the instances ─────────────────────────
//
// The view IS the page, in the shared column (`COLUMN`) with the quiet page header (back link above, segments and
// actions on the right). Under the title the memory shows the summary ("12 entries · 5 categories · 3 from the
// workspace"); the entries are rounded rows with the tile of their category (the same icon as in the `CategoryBar`)
// in the colour of their state (yellow to verify, green verified, dimmed outdated), state words only outside the
// normal case; the curator suggestions are a `Section` with a light bulb. Expanded text and preview sit in the trough
// of the kit fields. The dumpster is a quiet input field in the trough of the kit fields (`bg-bg`), with the
// explanation standing free beside it. The entry dialog (ContextDialog) is a sheet of its own.

interface Draft {
  editing: number | null;
  category: string;
  title: string;
  body: string;
  summary: string;
  tags: string;
  validAsOf: string;
  pinned: boolean;
  // OKF
  status: string;
  owners: string;          // comma-separated
  codePaths: string;       // one line per path
  related: string;         // comma-separated slugs
  linksOther: ContextLinks; // remaining edge types (depends_on/...); kept untouched on save
}

interface DumpResult {
  status: "created" | "updated" | "error";
  item?: ProjectContextItem;
  mergedInto?: number;   // for "updated": id of the merged entry
  mergedTitle?: string;  // title of the entry BEFORE the merge
  error?: string;
}

/**
 * The height that remains below `el` down to the bottom edge of the nearest ancestor that clips its content (else the window),
 * capped at 420, at least 160. For the adoption sheet: it carries toggles and therefore cannot be the kit `Menu` (which closes
 * on the first click); it hangs `absolute` on the header of a view whose frame is `overflow-hidden` (workspaces/page.tsx,
 * `fullHeightPane`). With a fixed height of 420 that frame clipped it in a low window; now it scrolls inside itself.
 */
function slotUnder(el: HTMLElement): number {
  const bottom = el.getBoundingClientRect().bottom;
  let edge = window.innerHeight;
  for (let p = el.parentElement; p; p = p.parentElement) {
    if (getComputedStyle(p).overflowY === "visible") continue;
    edge = Math.min(edge, p.getBoundingClientRect().bottom);
    break;
  }
  return Math.max(160, Math.min(420, Math.floor(edge - bottom - 12)));
}

// Categorised project context (replaces PROJECT_INFORMATION): category filter,
// search, list of entries, create/edit/delete + folder import.
export function ProjectContextPane({
  projectId,
  projectName,
  onBack,
  // No `onChanged`: the page updates its list itself.
}: {
  projectId: string;
  projectName: string;
  onBack?: () => void;
}) {
  const t = useT();
  const question = useConfirm();
  const [schema, setSchema] = useState<ProjectCategory[]>([]);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [items, setItems] = useState<ProjectContextItem[] | null>(null);
  const [suggestions, setSuggestions] = useState<ContextSuggestion[]>([]);
  const [category, setCategory] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [draft, setDraft] = useState<Draft | null>(null);
  const [importMsg, setImportMsg] = useState<{ tone: "ok" | "warn" | "danger"; text: string } | null>(null);
  const [dumpText, setDumpText] = useState("");
  const [dumpBusy, setDumpBusy] = useState(false);
  const [dumpResult, setDumpResult] = useState<DumpResult | null>(null);
  const [subTab, setSubTab] = useState<"dumpster" | "memory">("memory");
  const [showDeprecated, setShowDeprecated] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  // Adoption of workspace context categories (opt-in, like workspace skills).
  const [adoptCats, setAdoptCats] = useState<AdoptableContextCategory[]>([]);
  const [adoptOpen, setAdoptOpen] = useState(false);
  const [adoptMaxH, setAdoptMaxH] = useState(420); // measured on opening (`slotUnder`)
  const adoptBox = useRef<HTMLDivElement>(null);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const heights = useHeightMemory();

  const labelOf = (slug: string) => t(schema.find((c) => c.slug === slug)?.label ?? slug);
  const total = Object.values(counts).reduce((a, b) => a + b, 0);

  const loadItems = useCallback(
    async (cat: string | null, q: string, withDeprecated?: boolean) => {
      const params = new URLSearchParams();
      if (cat) params.set("category", cat);
      // Semantic search instead of substring: the field is a SEARCH, not a string filter, so a query
      // like "restart gateway" also finds the entry titled "systemctl --user restart".
      // Generous limit, because a whole list is shown here and not an agent context.
      if (q.trim()) { params.set("search", q.trim()); params.set("limit", "100"); }
      if (!(withDeprecated ?? showDeprecated)) params.set("status", "active");
      setItems(await api<ProjectContextItem[]>(`/api/projects/${projectId}/context?${params}`));
    },
    [projectId, showDeprecated],
  );

  const loadCounts = useCallback(async () => {
    const rows = await api<{ category: string; n: number }[]>(`/api/projects/${projectId}/context/categories`);
    setCounts(Object.fromEntries(rows.map((r) => [r.category, r.n])));
  }, [projectId]);

  const loadSuggestions = useCallback(async () => {
    setSuggestions(await api<ContextSuggestion[]>(`/api/projects/${projectId}/context-suggestions`));
  }, [projectId]);

  const loadAdopt = useCallback(async () => {
    setAdoptCats(await api<AdoptableContextCategory[]>(`/api/projects/${projectId}/context/adopt`).catch(() => []));
  }, [projectId]);

  useEffect(() => {
    api<ProjectCategory[]>("/api/project-context/schema").then(setSchema).catch(console.error);
  }, []);

  useEffect(() => {
    loadCounts().catch(console.error);
    loadItems(null, "").catch(console.error);
    loadSuggestions().catch(console.error);
    loadAdopt().catch(console.error);
  }, [loadCounts, loadItems, loadSuggestions, loadAdopt]);

  // Stop the debounce timer on unmount; otherwise it fetches into the void after a quick tab switch.
  useEffect(() => () => clearTimeout(searchTimer.current), []);

  // The adoption sheet closes on Escape and on a pointer press outside it. No `fixed inset-0`
  // catcher: the content area is a container, and layout containment makes it the reference
  // frame for `fixed`, so the catcher would only cover the view.
  useEffect(() => {
    if (!adoptOpen) return;
    const to = (e: KeyboardEvent) => { if (e.key === "Escape") setAdoptOpen(false); };
    const beside = (e: MouseEvent) => { if (!adoptBox.current?.contains(e.target as Node)) setAdoptOpen(false); };
    window.addEventListener("keydown", to);
    document.addEventListener("mousedown", beside);
    return () => {
      window.removeEventListener("keydown", to);
      document.removeEventListener("mousedown", beside);
    };
  }, [adoptOpen]);

  async function refresh() {
    await loadCounts();
    await loadItems(category, search);
    await loadSuggestions();
  }

  // Adopt/remove a workspace category, then reload the adoption list + entries
  // (adopted entries appear read-only in the "All" view).
  async function toggleAdopt(cat: string, on: boolean) {
    setAdoptCats((prev) => prev.map((c) => (c.category === cat ? { ...c, adopted: on } : c)));
    try {
      await api(`/api/projects/${projectId}/context/adopt`, { method: "POST", body: JSON.stringify({ category: cat, enabled: on }) });
    } catch (e) {
      await loadAdopt();
      alert(t("Error: {msg}", { msg: (e as Error).message }));
      return;
    }
    await loadAdopt();
    await loadItems(category, search);
  }

  const adoptedCount = adoptCats.filter((c) => c.adopted).reduce((a, c) => a + c.n, 0);

  async function applySugg(id: number) {
    try {
      await api(`/api/projects/${projectId}/context-suggestions/${id}/apply`, { method: "POST" });
      await refresh();
    } catch (e) {
      alert(t("Error: {msg}", { msg: (e as Error).message }));
      await loadSuggestions();
    }
  }

  async function dismissSugg(id: number) {
    await api(`/api/projects/${projectId}/context-suggestions/${id}/dismiss`, { method: "POST" });
    await loadSuggestions();
  }

  const opLabel = (op: string) => (op === "create" ? t("New") : op === "update" ? t("Update") : t("Delete"));
  const titleOfTarget = (id: number | null) => (id ? (items ?? []).find((it) => it.id === id)?.title ?? `#${id}` : "");

  function onSearch(v: string) {
    setSearch(v);
    clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(() => loadItems(category, v).catch(console.error), 250);
  }

  function pick(cat: string | null) {
    setCategory(cat);
    loadItems(cat, search).catch(console.error);
  }

  function newEntry() {
    setDraft({ editing: null, category: schema[0]?.slug ?? "overview", title: "", body: "", summary: "", tags: "", validAsOf: "", pinned: false,
      status: "active", owners: "", codePaths: "", related: "", linksOther: {} });
  }

  function editEntry(it: ProjectContextItem) {
    const { related, ...linksOther } = it.links ?? {};
    setDraft({ editing: it.id, category: it.category, title: it.title, body: it.body, summary: it.summary, tags: it.tags, validAsOf: it.validAsOf, pinned: it.pinned,
      status: it.status ?? "active", owners: it.owners ?? "", codePaths: (it.codePaths ?? []).join("\n"),
      related: (related ?? []).join(", "), linksOther });
  }

  async function save(d: Draft) {
    const related = d.related.split(",").map((s) => s.trim()).filter(Boolean);
    const links: ContextLinks = { ...d.linksOther, ...(related.length ? { related } : {}) };
    const payload = {
      category: d.category,
      title: d.title.trim(),
      body: d.body,
      summary: d.summary.trim(),
      tags: d.tags.split(",").map((t) => t.trim()).filter(Boolean),
      validAsOf: d.validAsOf.trim(),
      pinned: d.pinned,
      status: d.status,
      owners: d.owners.split(",").map((s) => s.trim()).filter(Boolean),
      codePaths: d.codePaths.split("\n").map((s) => s.trim()).filter(Boolean),
      links: Object.keys(links).length ? links : null,
    };
    try {
      if (d.editing) await api(`/api/projects/${projectId}/context/${d.editing}`, { method: "PUT", body: JSON.stringify(payload) });
      else await api(`/api/projects/${projectId}/context`, { method: "POST", body: JSON.stringify({ ...payload, force: true }) });
      setDraft(null);
      await refresh();
    } catch (e) {
      alert(t("Error: {msg}", { msg: (e as Error).message }));
    }
  }

  // "Mark as verified": set the anchor to the current repo commits of the codePaths.
  async function verify(id: number) {
    try {
      await api(`/api/projects/${projectId}/context/${id}/verify`, { method: "POST" });
      await refresh();
    } catch (e) {
      alert(t("Error: {msg}", { msg: (e as Error).message }));
    }
  }

  async function del(it: ProjectContextItem) {
    if (!(await question(t('Delete entry “{title}”?', { title: it.title || t("(untitled)") }), { ok: t("Delete"), danger: true }))) return;
    await api(`/api/projects/${projectId}/context/${it.id}`, { method: "DELETE" });
    await refresh();
  }

  // Project dumpster (fully autonomous): drop in free text, the LLM sorts it in itself
  // (new entry OR merge into an existing one). No follow-up question.
  async function dump() {
    const text = dumpText.trim();
    if (!text) return;
    setDumpBusy(true);
    setDumpResult(null);
    try {
      const r = await api<DumpResult>(`/api/projects/${projectId}/context/dump`, {
        method: "POST",
        body: JSON.stringify({ text }),
      });
      setDumpResult(r);
      if (r.status === "created" || r.status === "updated") {
        setDumpText("");
        await refresh();
      }
    } catch (e) {
      setDumpResult({ status: "error", error: (e as Error).message });
    } finally {
      setDumpBusy(false);
    }
  }

  async function importFolders() {
    setImportMsg({ tone: "warn", text: t("Importing…") });
    try {
      const r = await api<{ imported: string[]; skipped: string[] }>(`/api/projects/${projectId}/context/import-folders`, { method: "POST" });
      setImportMsg({ tone: "ok", text: t("{imported} imported, {skipped} skipped.", { imported: r.imported.length, skipped: r.skipped.length }) });
      await refresh();
    } catch (e) {
      setImportMsg({ tone: "danger", text: t("Error: {msg}", { msg: (e as Error).message }) });
    }
  }

  const changeOver = (next: typeof subTab) => setSubTab(next);

  // The line under the title: how many entries in how many categories, how many from the workspace.
  const categories = Object.values(counts).filter((n) => n > 0).length;
  const summary = [
    total === 1 ? t("1 entry") : t("{n} entries", { n: total }),
    categories === 1 ? t("1 category") : t("{n} categories", { n: categories }),
    ...(adoptedCount > 0 ? [t("{n} from the workspace", { n: adoptedCount })] : []),
  ].join(" · ");

  return (
    <div className={`${COLUMN} flex min-h-0 min-w-0 flex-1 flex-col`}>
      {/* Header (the quiet page header): back link above (only if there is one), subject as title,
          on the right the two pages as a switch and the actions of the open page. */}
      <PagesHeader
        title={<>{t("Context")} · {projectName}</>}
        top={onBack && <BackButton label={t("Projects")} onClick={onBack} />}
        under={subTab === "memory" && total + adoptedCount > 0 ? (
          <span className="tabular-nums" data-context-summary>{summary}</span>
        ) : undefined}
      >
        <Segments
          label={t("Context")}
          items={[
            { key: "dumpster", label: "Dumpster" },
            { key: "memory", label: "Memory", n: total || null },
          ]}
          value={subTab}
          onChange={(k) => changeOver(k as typeof subTab)}
        />
        {subTab === "memory" && (
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            {/* Adoption of workspace context categories (opt-in, like workspace skills). The
                sheet carries toggles, so no `Menu` (it would close on the first click). */}
            <div ref={adoptBox} className="relative" data-kit-pop>
              <button
                type="button"
                onClick={(e) => {
                  if (!adoptOpen) setAdoptMaxH(slotUnder(e.currentTarget));
                  setAdoptOpen((v) => !v);
                }}
                aria-haspopup="dialog"
                aria-expanded={adoptOpen}
                title={t("Adopt workspace context into this project (select categories)")}
                className={`flex items-center gap-1.5 ${ghost} ${adoptOpen ? "bg-hover text-fg" : ""}`}
              >
                <AdoptIcon />
                {t("Workspace context")}
                {adoptedCount > 0 && <span className="tabular-nums text-fg">{adoptedCount}</span>}
              </button>
              {adoptOpen && (
                <div style={{ maxHeight: adoptMaxH }} className={`${popClass} absolute right-0 top-full mt-1 w-[min(340px,calc(100vw-2rem))] origin-top-right overflow-y-auto`}>
                  <div className="px-2.5 pb-1.5 pt-1">
                    <div className="text-[13px] font-semibold">{t("Adopt workspace context")}</div>
                    <p className="mt-0.5 text-[11px] leading-relaxed text-dim">{t("Choose workspace context categories that should also apply in this project (and its chats). Adopted entries are read-only here — maintenance stays at the workspace level.")}</p>
                  </div>
                  {adoptCats.length === 0 ? (
                    <div className="px-2 py-4 text-center text-[12px] text-dim">{t("No workspace context available.")}</div>
                  ) : (
                    adoptCats.map((c) => (
                      // The row in the form of the menu row (CbKit `menuRow`); only the toggle is clicked, hence no pointer hand.
                      <div key={c.category} className={`${menuRow} cursor-default!`}>
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-[12.5px] font-medium">{c.category}</div>
                          <div className="text-[10.5px] text-dim">{t("{n} entries", { n: c.n })}</div>
                        </div>
                        <Toggle
                          enabled={c.adopted}
                          label={c.adopted ? t("Adopted — click to remove") : t("Not adopted — click to adopt")}
                          onClick={() => toggleAdopt(c.category, !c.adopted)}
                        />
                      </div>
                    ))
                  )}
                </div>
              )}
            </div>
            {/* The folder import is a one-off action: into the menu, not into the bar. */}
            <Menu label={t("More")}>
              <MenuEntry label={t("Import folder")} hint={t("Import PROJECT_INFORMATION from the folder")} onClick={importFolders} />
            </Menu>
            <button type="button" onClick={newEntry} className={primary}>{t("+ Entry")}</button>
          </div>
        )}
      </PagesHeader>

      {subTab === "memory" && importMsg && <div className="pb-4"><Hint tone={importMsg.tone}>{importMsg.text}</Hint></div>}

      {/* The content of the sub-tab fades in on switching (dumpster ↔ memory). */}
      <TabFade token={subTab} className="flex min-h-0 flex-1 flex-col">

      {/* ── Dumpster: drop in free text, the LLM sorts it into the memory. Left the surface,
             right the way out. */}
      {subTab === "dumpster" && (
        <div className="flex min-h-0 flex-1 flex-col gap-3">
          {(dumpResult?.status === "created" || dumpResult?.status === "updated") && dumpResult.item && (
            <Hint tone="ok">
              <span className="font-semibold">{dumpResult.status === "created" ? t("New memory entry created") : t("Existing memory entry extended")}</span>
              {" · "}{dumpResult.item.title || t("(untitled)")} · {labelOf(dumpResult.item.category)}{" "}
              <button type="button" onClick={() => { changeOver("memory"); setDumpResult(null); }} className="underline underline-offset-2 hover:no-underline">
                {t("View in memory")}
              </button>
            </Hint>
          )}
          {dumpResult?.status === "error" && (
            <Hint tone="danger"><span className="font-semibold">{t("Could not be filed")}</span> · {dumpResult.error}</Hint>
          )}

          <div className="grid min-h-0 flex-1 gap-x-8 gap-y-6 pb-4 @4xl/kit:grid-cols-[minmax(0,1fr)_minmax(0,22rem)]">
            {/* The field: the trough of the kit fields, without a dashed edge. */}
            <label className="flex min-h-[220px] cursor-text flex-col rounded-2xl bg-bg p-3.5 transition-colors">
              <textarea
                autoFocus
                value={dumpText}
                onChange={(e) => setDumpText(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) dump(); }}
                placeholder={t("What should cbase remember about this project?\n\nFor example: “Authentication runs over OAuth. Refresh tokens are stored encrypted in Redis …”")}
                aria-label={t("New information")}
                className="min-h-0 w-full flex-1 resize-none rounded-xl bg-transparent px-1 py-1 text-[13.5px] leading-relaxed outline-none placeholder:text-dim"
              />
              <div className="mt-2 flex shrink-0 items-center gap-2 border-t border-edge pt-2 text-[11px] text-dim">
                <span className="tabular-nums">{dumpText.length.toLocaleString(dateLocale())} {t("characters")}</span>
                <span className="ml-auto hidden items-center gap-1.5 sm:flex"><kbd className="rounded-md bg-panel px-1.5 py-0.5 font-mono">⌘ ↵</kbd>{t("to drop it in")}</span>
              </div>
            </label>

            <aside className="cb-scroll flex min-w-0 flex-col gap-3 overflow-y-auto">
              {/* Explanation and result free on the stage, without a surface. */}
              <div className="flex flex-col gap-2">
                <Overline>{t("Drop in")}</Overline>
                <p className="text-[12px] leading-relaxed text-dim">
                  {t("Notes, decisions, technical details or loose ideas — the AI recognises the context and creates a memory entry or extends the matching existing one. It decides category and merging on its own.")}
                </p>
                <button
                  type="button"
                  onClick={() => dump()}
                  disabled={dumpBusy || !dumpText.trim()}
                  className={`${primary} mt-1 w-full disabled:opacity-40`}
                >
                  {dumpBusy ? t("Sorting in…") : t("Into memory")}
                </button>
              </div>
              <p className="mt-auto text-[11px] leading-relaxed text-dim">
                {t("Whatever arrives here ends up under Memory — searchable, and read along by every chat of this project.")}
              </p>
            </aside>
          </div>
        </div>
      )}

      {/* ── Memory: the header with search and filters stays put, the list is ONE surface
             and at the same time its own scroll area. */}
      {subTab === "memory" && (
        <div className="flex min-h-0 flex-1 flex-col gap-2.5">
          {/* The memory bar: search and the toggle for outdated entries on top, below them the categories as ONE
              scrolling bar with icon and number (`CategoryBar`); ten equal pills beside the search field would
              wrap onto two lines. */}
          <div className="flex shrink-0 flex-col gap-2">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
              <Search value={search} onChange={onSearch} placeholder={t("Search knowledge — question or keyword…")} className="w-full min-w-[180px] max-w-[420px] flex-1" />
              <label className="ml-auto flex shrink-0 cursor-pointer items-center gap-2 text-[12.5px] text-dim">
                {t("Show deprecated")}
                <KitToggle
                  on={showDeprecated}
                  title={t("Show deprecated")}
                  onClick={() => { const on = !showDeprecated; setShowDeprecated(on); loadItems(category, search, on).catch(console.error); }}
                />
              </label>
            </div>
            <CategoryBar
              label={t("Category")}
              value={category}
              onChoice={pick}
              entries={[
                { key: "", label: t("All"), n: total + adoptedCount },
                ...schema.map((c) => ({ key: c.slug, label: t(c.label), n: counts[c.slug] ?? 0 })),
              ]}
            />
          </div>

          {/* Curator suggestions above the list (a `Section` with a light-bulb tile and rounded rows without hairlines).
              The decision is carried by the two buttons on the row. */}
          {suggestions.length > 0 && (
            <Section
              symbol={SYM.suggestion(15)}
              title={t("Curator suggestions")}
              under={t("Distilled automatically from your project chats")}
              right={<span className="tabular-nums">{suggestions.length}</span>}
              className="shrink-0"
            >
              <div className="flex flex-col gap-0.5">
                {suggestions.map((s) => (
                  <div key={s.id} className="flex flex-wrap items-start gap-x-4 gap-y-1.5 rounded-xl px-2.5 py-2.5 transition-colors hover:bg-hover">
                    <div className="min-w-0 flex-1">
                      <div className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1">
                        <span className="text-[10.5px] font-semibold uppercase tracking-[0.05em] text-dim">{opLabel(s.op)}</span>
                        <span className="min-w-0 truncate text-[14px] font-medium">{s.title || titleOfTarget(s.targetId) || t("(untitled)")}</span>
                        <Fact symbol={<CategorySymbol slug={s.category} size={12} />} className="text-[12px] text-dim">{labelOf(s.category)}</Fact>
                        {s.op !== "create" && s.targetId && <span className="text-[12px] text-dim">{t("affects:")} {titleOfTarget(s.targetId)}</span>}
                      </div>
                      {s.reason && <p className="mt-1 text-[12.5px] leading-relaxed text-dim">{s.reason}</p>}
                      {s.op !== "delete" && (s.summary || s.body) && (
                        <div className="cb-scroll mt-2 max-h-[130px] overflow-y-auto rounded-lg bg-bg px-3 py-2 text-[12px]"><Markdown src={s.summary || s.body} /></div>
                      )}
                    </div>
                    <div className="flex shrink-0 items-center gap-1.5">
                      <button type="button" onClick={() => dismissSugg(s.id)} className={quietDangerSm}>{t("Dismiss")}</button>
                      <button type="button" onClick={() => applySugg(s.id)} className={`${ghostSm} bg-dark text-white hover:bg-dark hover:text-white`}>{t("Apply")}</button>
                    </div>
                  </div>
                ))}
              </div>
            </Section>
          )}

          {items === null && <Loading />}
          {items !== null && items.length === 0 && (
            <EmptySentence title={search || category ? t("No matching memories") : t("No memories yet")}>
              {search || category ? t("Adjust the search or the category filter.") : t("Drop knowledge into the dumpster or create the first entry by hand.")}
            </EmptySentence>
          )}
          {items !== null && items.length > 0 && (
            <div className="cb-scroll min-h-0 flex-1 overflow-y-auto">
              <ContainScope memory={heights}>
                <div className="flex flex-col gap-0.5" data-context-list>
                  {items.map((it) => {
                    const key = `${it.origin ?? "project"}-${it.id}`;
                    return (
                      <Contained key={key} ck={`ctx:${key}`}>
                        <EntryRow
                          it={it}
                          labelOf={labelOf}
                          open={openId === key}
                          onToggle={() => setOpenId((cur) => (cur === key ? null : key))}
                          onEdit={() => editEntry(it)}
                          onDelete={() => del(it)}
                          onVerify={() => verify(it.id)}
                        />
                      </Contained>
                    );
                  })}
                </div>
              </ContainScope>
            </div>
          )}
        </div>
      )}
      </TabFade>

      {draft && <ContextDialog draft={draft} schema={schema} onSave={save} onClose={() => setDraft(null)} />}
    </div>
  );
}

/**
 * An entry as a ROW of the list: header with title, category and states; expanded
 * (`data-open`) below it the summary, the text, the anchors (slug, paths, links, ownership,
 * state, tags) and the actions. In the form of the instances: rounded without a hairline, in
 * front the tile with the category icon in the colour of the state, state words only outside
 * the normal case, category · workspace · pinned · date as facts, the chevron on the right;
 * expanded, the header carries a hint of accent (`SELECTED`) and the text sits indented in the
 * trough of the kit fields.
 */
function EntryRow({ it, labelOf, open, onToggle, onEdit, onDelete, onVerify }: {
  it: ProjectContextItem;
  labelOf: (slug: string) => string;
  open: boolean;
  onToggle: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onVerify: () => void;
}) {
  const t = useT();
  const adopted = it.origin === "workspace";
  const deprecated = it.status === "deprecated" || it.status === "superseded";
  const fresh = it.freshness;
  const staleTitle = fresh?.stale
    ? [
        ...(fresh.commits ?? []).map((c) => `${c.sha} ${c.subject}`),
        ...(fresh.missingPaths?.length ? [t("Missing paths: {paths}", { paths: fresh.missingPaths.join(", ") })] : []),
        ...(fresh.rebased ? [t("Verification commit no longer in history")] : []),
      ].join("\n")
    : "";
  const tags = it.tags ? it.tags.split(",").map((x) => x.trim()).filter(Boolean) : [];
  const linkCount = it.links ? Object.values(it.links).flat().length : 0;

  // The state as the tile colour: dimmed outdated, yellow to verify, green verified, else neutral; the word for it
  // appears only if it is not the normal case ("Verified" is carried by the tile as a short note).
  const checked = !deprecated && fresh && !fresh.stale && !fresh.neverVerified;
  const checkedTitle = fresh?.verifiedAt ? t("Verified on {date}", { date: new Date(fresh.verifiedAt).toLocaleDateString(dateLocale()) }) : undefined;
  const color = deprecated ? "text-dim" : fresh?.stale ? "text-warn" : checked ? "text-ok" : "text-fg/80";

  return (
    <div className={`min-w-0 ${deprecated ? "opacity-60" : ""}`}>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        data-open={open ? "1" : undefined}
        className={`${LIST_ROW} items-start ${open ? SELECTED : "hover:bg-hover"}`}
      >
        <Tile color={color} title={checked ? [t("Verified"), checkedTitle].filter(Boolean).join(" · ") : undefined}>
          <CategorySymbol slug={it.category} size={16} />
        </Tile>
        <span className="flex min-h-8 min-w-0 flex-1 flex-col justify-center">
          <span className="flex min-w-0 items-baseline gap-2">
            <span className="min-w-0 truncate text-[14px] font-medium tracking-[-0.01em]">{it.title || t("(untitled)")}</span>
            {deprecated && (
              <span className="shrink-0 text-[12px] text-dim" title={it.supersededBy ? t("Superseded by {slug}", { slug: it.supersededBy }) : t("Marked as outdated")}>
                {t("Deprecated")}
              </span>
            )}
            {!deprecated && fresh?.stale && (
              <span className="shrink-0 text-[12px] text-warn" title={staleTitle}>{t("Verify · {n} commits", { n: fresh.commits?.length ?? 0 })}</span>
            )}
            {!deprecated && fresh?.neverVerified && (
              <span className="shrink-0 text-[12px] text-dim" title={t("Anchored to code but never verified against it")}>{t("Never verified")}</span>
            )}
          </span>
          <span className={`mt-0.5 ${FACTS}`}>
            <Fact symbol={<CategorySymbol slug={it.category} size={12} />} className="shrink-0">{adopted ? it.category : labelOf(it.category)}</Fact>
            {adopted && (
              <Fact symbol={SYM.takenOver(12)} className="shrink-0" title={t("Adopted from the workspace — read-only here")}>{t("Workspace")}</Fact>
            )}
            {it.pinned && <Fact symbol={SYM.pin(12)} className="shrink-0">{t("Pinned")}</Fact>}
            <Fact symbol={SYM.clock(12)} className="shrink-0 tabular-nums">{new Date(it.updatedAt).toLocaleDateString(dateLocale())}</Fact>
          </span>
        </span>
        <span className="flex h-8 shrink-0 items-center text-dim transition-colors group-hover:text-fg"><Chevron open={open} /></span>
      </button>
      {open && (
        <div className="cb-fade-in pb-4 pl-[54px] pr-2.5 pt-2">
          {it.summary && <p className="mb-2 max-w-[70ch] text-[12.5px] leading-relaxed text-dim">{it.summary}</p>}
          {it.body && (
            <div className="cb-scroll max-h-[52vh] overflow-y-auto overflow-x-hidden rounded-xl bg-bg px-2 py-1.5">
              <MarkdownEditor value={it.body} onChange={() => undefined} reading lineNumbers fontSize={textPx(11.5)} minHeight="0" maxHeight="none" />
            </div>
          )}
          <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
            {/* The anchors as dimmed words. */}
            <div className="flex min-w-0 flex-1 flex-wrap gap-x-3 gap-y-1 text-[11.5px] text-dim">
              {it.slug && <span className="max-w-[200px] truncate font-mono" title={it.slug}>{it.slug}</span>}
              {(it.codePaths?.length ?? 0) > 0 && (
                <span className="font-mono" title={it.codePaths!.join("\n")}>{t("{n} paths", { n: it.codePaths!.length })}</span>
              )}
              {linkCount > 0 && (
                <span title={Object.entries(it.links!).map(([k, v]) => `${k}: ${(v ?? []).join(", ")}`).join("\n")}>{t("{n} links", { n: linkCount })}</span>
              )}
              {it.owners && <span>{it.owners}</span>}
              {it.validAsOf && <span>{t("As of:")} {it.validAsOf}</span>}
              {tags.slice(0, 6).map((tag) => <span key={tag} className="font-mono text-dim/80">#{tag}</span>)}
            </div>
            {adopted ? (
              <span className="text-[11px] italic text-dim">{t("read-only")}</span>
            ) : (
              <div className="flex shrink-0 items-center gap-1.5">
                {(fresh?.stale || fresh?.neverVerified) && !deprecated && (
                  <button type="button" onClick={onVerify} title={t("Mark as verified — anchor to the current commits (double-check the content first)")} className={`${ghostSm} border-ok/40 text-ok hover:bg-ok/10 hover:text-ok`}>
                    {t("Verified ✓")}
                  </button>
                )}
                <button type="button" onClick={onEdit} className={ghostSm}>{t("Edit")}</button>
                <button type="button" onClick={onDelete} className={quietDangerSm}>{t("Delete")}</button>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/** A toggle as adoption lists carry it: accent only in the "on" state (it is the signal). */
function Toggle({ enabled, label, onClick }: { enabled: boolean; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={enabled}
      onClick={onClick}
      title={label}
      aria-label={label}
      className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${enabled ? "bg-accent" : "bg-edge"}`}
    >
      <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all ${enabled ? "left-[22px]" : "left-0.5"}`} />
    </button>
  );
}

function AdoptIcon() {
  // Arrow into a tray: "adopt from the workspace".
  return <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M2 10.5V13a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1v-2.5"/><path d="M8 2v7M5 6.5 8 9.5l3-3"/></svg>;
}

// The entry dialog as a sheet: the details in troughs on top, below them the editor, which fills
// the sheet's height. The app's modal covers the whole page.
function ContextDialog({
  draft,
  schema,
  onSave,
  onClose,
}: {
  draft: Draft;
  schema: ProjectCategory[];
  onSave: (d: Draft) => Promise<void>;
  onClose: () => void;
}) {
  const t = useT();
  const [d, setD] = useState(draft);
  const [reading, setReading] = useState(false);
  const label = "flex min-w-0 flex-col gap-1 text-[11.5px] font-medium text-dim";
  const fieldName = `${field} w-full`;

  return (
    <Modal onClose={onClose} width={1120} className="h-[min(820px,100%)] p-0" label={d.editing ? t("Edit context") : t("New context entry")}>
      <div className="flex shrink-0 items-start gap-4 px-6 pb-3 pt-5">
        <div className="min-w-0">
          <h2 className="text-[15px] font-semibold tracking-tight">{d.editing ? t("Edit context") : t("New context entry")}</h2>
          <p className="mt-0.5 text-[12px] text-dim">{t("Edit Markdown with live formatting and visible line numbers.")}</p>
        </div>
        <button type="button" onClick={onClose} className={`ml-auto ${ghostSm}`}>{t("Close")}</button>
      </div>

      <div className="shrink-0 border-y border-edge px-6 py-4">
        <div className="grid grid-cols-1 gap-3 md:grid-cols-[minmax(150px,0.8fr)_minmax(260px,2fr)_minmax(150px,0.8fr)]">
          <label className={label}>
            {t("Category")}
            <select value={d.category} onChange={(e) => setD({ ...d, category: e.target.value })} className={`${select} w-full py-1.5 text-fg`}>
              {schema.map((c) => (
                <option key={c.slug} value={c.slug}>{t(c.label)}</option>
              ))}
            </select>
          </label>
          <label className={label}>
            {t("Title")}
            <input value={d.title} onChange={(e) => setD({ ...d, title: e.target.value })} className={fieldName} />
          </label>
          <label className={label}>
            {t("As of (optional)")}
            <input value={d.validAsOf} onChange={(e) => setD({ ...d, validAsOf: e.target.value })} placeholder={t("e.g. Sprint 3")} className={fieldName} />
          </label>
        </div>
        <div className="mt-3 grid grid-cols-1 items-end gap-3 md:grid-cols-[minmax(260px,2fr)_minmax(180px,1fr)_auto]">
          <label className={label}>
            {t("Summary (optional, 1–2 sentences)")}
            <input value={d.summary} onChange={(e) => setD({ ...d, summary: e.target.value })} className={fieldName} />
          </label>
          <label className={label}>
            {t("Tags (comma-separated)")}
            <input value={d.tags} onChange={(e) => setD({ ...d, tags: e.target.value })} placeholder="frontend, auth" className={fieldName} />
          </label>
          <label className="mb-1.5 flex h-6 items-center gap-2 whitespace-nowrap text-[12px] font-medium text-dim">
            <input type="checkbox" checked={d.pinned} onChange={(e) => setD({ ...d, pinned: e.target.checked })} className="accent-accent" />
            {t("Pin to top")}
          </label>
        </div>
        <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-[minmax(130px,0.7fr)_minmax(150px,0.9fr)_minmax(220px,1.6fr)_minmax(180px,1.2fr)]">
          <label className={label}>
            {t("Status")}
            <select value={d.status} onChange={(e) => setD({ ...d, status: e.target.value })} className={`${select} w-full py-1.5 text-fg`}>
              <option value="active">{t("active")}</option>
              <option value="deprecated">{t("deprecated")}</option>
              <option value="superseded">{t("superseded")}</option>
            </select>
          </label>
          <label className={label}>
            {t("Owners (comma-separated)")}
            <input value={d.owners} onChange={(e) => setD({ ...d, owners: e.target.value })} placeholder="backend" className={fieldName} />
          </label>
          <label className={label} title={t("Project-relative files/folders this knowledge is anchored to — basis of staleness detection")}>
            {t("Code paths (one per line)")}
            <textarea value={d.codePaths} onChange={(e) => setD({ ...d, codePaths: e.target.value })} placeholder={"src/auth/\nsrc/api/client.ts"} rows={2} className={`${fieldName} resize-none font-mono text-[11.5px]`} />
          </label>
          <label className={label} title={t("Slugs of related entries — makes knowledge traversable")}>
            {t("Related to (slugs, comma-separated)")}
            <input value={d.related} onChange={(e) => setD({ ...d, related: e.target.value })} placeholder="auth-token-refresh" className={`${fieldName} font-mono text-[11.5px]`} />
          </label>
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col px-6 pb-4 pt-3">
        <div className="mb-2 flex shrink-0 items-center gap-3">
          <Overline>{t("Content")}</Overline>
          <span className="mb-1.5 text-[11px] tabular-nums text-dim">{d.body.length.toLocaleString(dateLocale())} {t("characters")}</span>
          <Segments
            className="mb-1.5 ml-auto"
            items={[{ key: "edit", label: t("Edit") }, { key: "read", label: t("Read") }]}
            value={reading ? "read" : "edit"}
            onChange={(k) => setReading(k === "read")}
          />
        </div>
        {/* Padding in the editor, not on the trough: the scroll area fills the round trough and the
            line-number gutter stands at its edge. */}
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl bg-bg">
          <div className="cb-scroll min-h-0 flex-1 overflow-y-auto">
            <MarkdownEditor
              value={d.body}
              onChange={(body) => setD({ ...d, body })}
              reading={reading}
              lineNumbers
              height="100%"
              padding="14px 10px 14px 2px"
              className="h-full"
            />
          </div>
        </div>
      </div>

      <div className="flex shrink-0 justify-end gap-2 border-t border-edge px-6 py-4">
        <button type="button" onClick={onClose} className={ghost}>{t("Cancel")}</button>
        <button
          type="button"
          onClick={() => onSave(d).catch((e) => alert(t("Error: {msg}", { msg: e.message })))}
          disabled={!d.title.trim() && !d.body.trim()}
          className={`${primary} disabled:opacity-40`}
        >
          {t("Save")}
        </button>
      </div>
    </Modal>
  );
}
