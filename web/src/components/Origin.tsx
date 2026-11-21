"use client";

import { createContext, useContext } from "react";
import { useT } from "@/lib/i18n";
import { Section } from "@/components/CbKit";

// The origin of an entry inside an entered project: does it belong to the PROJECT, or does it come from the WORKSPACE?
//
// ONE component for all tabs with this pattern (agents, MCP, credentials, workflows); otherwise the same
// distinction would look different in four places. The icons are the app's own: the folder for the project (as in the
// chat list), the stacked layers for the workspace (as in the rail, WorkspaceRail.tsx). The project carries the
// accent, the workspace the neutral tone: what is the project's own comes first, what is inherited is one step quieter.
//
// The names come from a context that the Coding page sets ONCE (app/workspaces/page.tsx); no tab threads
// them through. If one is missing, only the word shows.
//
// A section header is a whole section in the form of the instances (`OriginSection` over the kit `Section`: small
// tinted tile, the rows indented below it). Its twin on iOS (Kit/CbKit.swift `OriginHeader`) keeps that name.

export type OriginKind = "project" | "workspace";

/** The names of the entered project and its workspace, set by the page and read by `OriginSection`. */
export const OriginNames = createContext<{ project?: string; workspace?: string }>({});

const Character = ({ kind, size }: { kind: OriginKind; size: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    {kind === "project"
      ? <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z" />
      : <><path d="M12 3 3 7.5 12 12l9-4.5L12 3z" /><path d="M3 12.5 12 17l9-4.5" /></>}
  </svg>
);

const TONE: Record<OriginKind, string> = {
  project: "bg-accent/12 text-accent",
  workspace: "bg-edge text-dim",
};

/** The small marker on a row: icon and word, project in the accent, workspace neutral. */
export function OriginMarker({ kind }: { kind: OriginKind }) {
  const t = useT();
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1 rounded-full px-1.5 py-[1px] text-[10.5px] font-semibold ${TONE[kind]}`}
      title={kind === "project" ? t("Belongs to this project") : t("Comes from the workspace — edit it there")}
    >
      <Character kind={kind} size={10} />
      {kind === "project" ? t("Project") : t("Workspace")}
    </span>
  );
}

/**
 * A section by origin (in the form of the instances, kit `Section`): the same icon in the small tinted tile, "Project · <name>"
 * or "Workspace · <name>", optionally a sentence below it (`hint`), a number or action on the right; the rows (`children`)
 * sit indented below.
 */
export function OriginSection({ kind, hint, right, children }: {
  kind: OriginKind;
  hint?: React.ReactNode;
  right?: React.ReactNode;
  children?: React.ReactNode;
}) {
  const t = useT();
  const names = useContext(OriginNames);
  const name = kind === "project" ? names.project : names.workspace;
  return (
    <Section
      symbol={<Character kind={kind} size={14} />}
      tile={TONE[kind]}
      title={
        <span className="flex min-w-0 items-baseline gap-1.5">
          <span className="shrink-0">{kind === "project" ? t("Project") : t("Workspace")}</span>
          {name && <span className="min-w-0 truncate font-normal text-dim">· {name}</span>}
        </span>
      }
      under={hint}
      right={right}
      data={{ "data-origin": kind }}
    >
      {children}
    </Section>
  );
}
