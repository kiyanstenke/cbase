"use client";

// The shape of the "Projects" tab: a calm page (no cards), and clicking a project shows a tab menu on the left to switch
// between services, layout, instances, git and timeline. Only the SHAPE: colour roles, accent and font stay the app's.
//
// The calm page header, the dot with a word and the shared column live in the kit (CbKit.tsx). What stays here is the
// project view itself: back link, name and short info on top, the tabs on the left (below `@3xl/kit` horizontal above the
// content: a container query, not a window query, since the same page is 1,400 px wide alone and 940 next to a bar), the
// content on the right. The tabs have the form of the settings modal's category list (settings/SettingsModal.tsx): `edge`
// means "selected", the selected one's icon carries the accent. The header has a large tile with the folder in the project
// container's colour, each tab a small tile with its icon; selected = accent tint (`SELECTED`), no hairline under the
// horizontal bar. `instanceColor` lives in ProjectForm.tsx and is only passed on from here.
//
// ProjectsPane renders the contents (ProjectServicesPane, LayoutPage, InstancesPage, git, timeline) and passes them in as
// `children`; they run embedded, without their own header and back link. The instances and git tabs exist only for a
// converted project (`instances`, `git`), the timeline tab for EVERY project (the timeline belongs to the project, not its
// container). Two entries into the same component: from the workspace (rail → projects → row, with back link and "Enter") and
// inside an entered project (rail → project, without both: `onBack` and `onEnter` are missing).
import { useT } from "@/lib/i18n";
import { BackButton, COLUMN, TITLE, ghost } from "@/components/CbKit";
import { SELECTED, Tile, S, instanceColor, textOf } from "@/components/projects/ProjectForm";
import { TIMELINE_SYMBOL } from "@/components/timeline/TimelineForm";

export { instanceColor };
// The list of tabs lives ONCE here: app/workspaces/page.tsx reads a remembered tab via `asProjectTab`, so a new tab is
// picked up there automatically.
export const PROJECT_TAB = ["services", "layout", "instances", "git", "timeline"] as const;
export type ProjectTab = (typeof PROJECT_TAB)[number];

/** A remembered value as a tab — `null` if it does not (or no longer) exist (the caller picks its default). */
export function asProjectTab(v: unknown): ProjectTab | null {
  return typeof v === "string" && (PROJECT_TAB as readonly string[]).includes(v) ? (v as ProjectTab) : null;
}

/**
 * The view of a project. `layout`: `null` = no tab (without server mode there is no layout); otherwise `reason` = why it
 * cannot be chosen right now (as `title`), `null` = selectable. An open tab stays open even if it would be locked (a row's
 * "waitlist" / "re-check" question opens the layout as before; the page itself then shows what works). `instances`: the tab
 * exists only for a converted project; `git` likewise. `onBack` is missing in an entered project: there the view itself is
 * the place, there is no list to go back to.
 */
export function ProjectView({ projectId, name, state, tooltip, tab, onTab, layout, instances, git, onBack, onEnter, children }: {
  projectId: string;
  name: string;
  /** State of the project container (main) — colours the tile; absent without server mode. */
  state?: string | null;
  tooltip?: React.ReactNode;
  tab: ProjectTab;
  onTab: (r: ProjectTab) => void;
  layout: { reason: string | null } | null;
  instances: boolean;
  git: boolean;
  onBack?: () => void;
  onEnter?: () => void;
  children: React.ReactNode;
}) {
  const t = useT();
  const entries: { key: ProjectTab; label: string; icon: React.ReactNode; reason: string | null }[] = [
    { key: "services", label: t("Services"), icon: S.services(15), reason: null },
    ...(layout ? [{ key: "layout" as const, label: t("Outline"), icon: S.layout(15), reason: layout.reason }] : []),
    ...(instances ? [{ key: "instances" as const, label: t("Instances"), icon: S.copy(15), reason: null }] : []),
    ...(git ? [{ key: "git" as const, label: t("Git"), icon: S.repos(15), reason: null }] : []),
    { key: "timeline", label: t("Timeline"), icon: TIMELINE_SYMBOL(15), reason: null },
  ];
  return (
    <div className={`${COLUMN} flex min-h-0 flex-1 flex-col`} data-project-view={projectId}>
      {/* The header like the instance detail's: large tile, name and short info beside it (same dimensions as the kit's page header). */}
      <header className="shrink-0 pb-7">
        {onBack && <div className="mb-3"><BackButton label={t("Projects")} onClick={onBack} /></div>}
        <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
          <div className="flex min-w-0 items-center gap-3.5">
            <Tile large color={state ? textOf(instanceColor(state)) : "text-fg/80"} data={{ "data-project-tile": state ?? "" }}>{S.project(20)}</Tile>
            <div className="min-w-0">
              <h2 className={`truncate ${TITLE}`}>{name}</h2>
              {tooltip && <div className="mt-1 flex max-w-[64ch] flex-wrap items-center gap-x-3 gap-y-1 text-[13px] leading-relaxed text-dim">{tooltip}</div>}
            </div>
          </div>
          {onEnter && (
            <button type="button" onClick={onEnter} title={t("Enter the project — focused chat (workspace skills remain)")} className={ghost}>
              {t("Enter")}
            </button>
          )}
        </div>
      </header>
      <div className="flex min-h-0 flex-1 flex-col gap-5 @3xl/kit:flex-row @3xl/kit:gap-10">
        <nav
          aria-label={t("Project view")}
          className="cb-strip flex shrink-0 gap-1 overflow-x-auto pb-1 @3xl/kit:w-[196px] @3xl/kit:flex-col @3xl/kit:gap-0.5 @3xl/kit:overflow-visible @3xl/kit:pb-0"
        >
          {entries.map((e) => {
            const on = e.key === tab;
            const locked = !on && e.reason !== null;
            return (
              <button
                key={e.key}
                type="button"
                onClick={() => { if (!on) onTab(e.key); }}
                disabled={locked}
                title={locked ? e.reason ?? undefined : undefined}
                aria-current={on ? "page" : undefined}
                data-active={on ? "1" : undefined}
                data-project-tab={e.key}
                className={`group flex shrink-0 items-center gap-2.5 whitespace-nowrap rounded-xl py-1.5 pl-1.5 pr-3 text-left text-[13.5px] font-medium transition-colors @3xl/kit:w-full @3xl/kit:shrink ${
                  on ? `${SELECTED} text-fg` : "text-dim hover:bg-hover hover:text-fg disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-dim"
                }`}
              >
                <Tile small color={on ? "text-accent" : "text-fg/70"}>{e.icon}</Tile>
                {e.label}
              </button>
            );
          })}
        </nav>
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">{children}</div>
      </div>
    </div>
  );
}
