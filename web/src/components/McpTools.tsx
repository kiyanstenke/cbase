"use client";

import { useState } from "react";
import { api, type McpServer } from "@/lib/api";
import { Hint, Modal, ModalTitle, Toggle, ghost, ghostSm } from "@/components/CbKit";
import { useT } from "@/lib/i18n";
import { toggleMarker, statusOf, toggleChoice, toolRows, counter, type McpLabel } from "@/lib/mcp-tools";

// The tools of ONE coding MCP server (coding MCP airlock): state of the cache, "Load tools",
// counter, ONE row per tool (checkbox = choice, label reads · writes · unclear, marker = card
// before the call, "new"), above them the "Subagents inherit" toggle. Every click saves at once
// (PATCH with only that one field; a missing field means unchanged); the server's answer
// replaces the state here. The computation lives in lib/mcp-tools.ts (bound to its Swift twin).
// `onlyRead`: a workspace server adopted in the project; the choice applies everywhere and is
// changed in the workspace.

const LABEL: Record<McpLabel, { word: string; kind: string }> = {
  reads: { word: "reads", kind: "text-dim" },
  writes: { word: "writes", kind: "text-warn" },
  unresolved: { word: "unclear", kind: "text-dim" },
};

export function McpToolsSheet({ server: start, onlyRead = false, onClose, onChanged }: {
  server: McpServer;
  onlyRead?: boolean;
  onClose: () => void;
  onChanged?: (s: McpServer) => void;
}) {
  const t = useT();
  const [s, setS] = useState<McpServer>(start);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const tools = s.tools || [];
  const choice = s.choice === undefined ? null : s.choice;
  const markers = s.markers || [];
  const rows = toolRows(tools, choice, markers);
  const z = counter(tools, choice, markers);
  const state = statusOf(s.toolsAt || 0, s.toolsError || "", Date.now());

  async function save(body: Record<string, unknown>) {
    setError("");
    try {
      const fresh = await api<McpServer>(`/api/mcp-servers/${s.id}`, { method: "PATCH", body: JSON.stringify(body) });
      setS(fresh);
      onChanged?.(fresh);
    } catch (e) {
      setError(String((e as Error).message));
    }
  }

  async function load() {
    setLoading(true);
    setError("");
    try {
      const fresh = await api<McpServer>(`/api/mcp-servers/${s.id}/tools`, { method: "POST" });
      setS(fresh);
      onChanged?.(fresh);
    } catch (e) {
      setError(String((e as Error).message));
    } finally {
      setLoading(false);
    }
  }

  const stateText = state.kind === "never"
    ? t("Never loaded")
    : state.kind === "error"
      ? t("Loading failed: {error}", { error: s.toolsError || "" })
      : state.minutes < 1 ? t("Just loaded") : t("Loaded {n} min ago", { n: state.minutes });

  return (
    <Modal onClose={onClose} width={620} label={t("Tools of {name}", { name: s.name })}>
      <ModalTitle hint={onlyRead ? t("Applies everywhere — changed in the workspace.") : t("What the agents of this workspace get from this server. No agent sees a deselected tool; a card asks you before every call. Takes effect immediately.")}>
        {t("Tools of {name}", { name: s.name })}
      </ModalTitle>

      <div className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-2" data-mcp-tools-status={state.kind}>
        <span className={`text-[12.5px] ${state.kind === "error" ? "text-danger" : "text-dim"}`}>{stateText}</span>
        {tools.length > 0 && (
          <span className="text-[12.5px] tabular-nums text-dim" data-mcp-tools-counter>
            {t("{n} of {m} allowed", { n: z.free, m: z.total })}{z.card > 0 ? ` · ${t("{n} with a card", { n: z.card })}` : ""}
          </span>
        )}
        {!onlyRead && (
          <button type="button" onClick={load} disabled={loading} className={`${ghostSm} ml-auto disabled:opacity-50`} data-mcp-tools-load>
            {loading ? t("Loading…") : t("Load tools")}
          </button>
        )}
      </div>

      <label className="mb-4 flex items-start gap-2.5 text-[13px]">
        <Toggle on={s.subagentsInherit !== false} disabled={onlyRead} onClick={() => save({ subagentsInherit: s.subagentsInherit === false })} />
        <span>
          <span className="block">{t("Subagents inherit")}</span>
          <span className="mt-0.5 block text-[12px] leading-relaxed text-dim">
            {t("On: subagents and workflow agents get this server with the same selection and the same cards. Off: only the main agent — a subagent asks it.")}
          </span>
        </span>
      </label>

      {error && <div className="mb-3"><Hint tone="danger">{error}</Hint></div>}

      {tools.length === 0 ? (
        <p className="text-[12.5px] text-dim">{t("No tools known yet — “Load tools” asks the server.")}</p>
      ) : (
        <>
          {!onlyRead && (
            <div className="mb-1 flex gap-1.5">
              <button type="button" className={ghostSm} onClick={() => save({ choice: null })}>{t("All")}</button>
              <button type="button" className={ghostSm} onClick={() => save({ choice: [] })}>{t("None##neuter")}</button>
            </div>
          )}
          <div className="flex flex-col" data-mcp-tools>
            {rows.map((w) => (
              <div key={w.name} className="flex min-w-0 items-start gap-2.5 rounded-lg px-2 py-2 hover:bg-hover" data-mcp-tool={w.name}>
                <input
                  type="checkbox"
                  checked={w.selected}
                  disabled={onlyRead}
                  onChange={() => save({ choice: toggleChoice(tools, choice, w.name) })}
                  className="mt-0.5 h-4 w-4 shrink-0 accent-accent"
                  aria-label={w.name}
                />
                <div className="min-w-0 flex-1">
                  <div className="flex min-w-0 items-baseline gap-2">
                    <span className={`truncate font-mono text-[12.5px] ${w.selected ? "" : "text-dim"}`}>{w.name}</span>
                    <span className={`shrink-0 text-[11.5px] ${LABEL[w.label].kind}`} data-mcp-label={w.label}>{t(LABEL[w.label].word)}</span>
                    {w.fresh && <span className="shrink-0 text-[11.5px] text-accent" data-mcp-new>{t("new")}</span>}
                  </div>
                  {w.description && <p className="mt-0.5 line-clamp-2 text-[12px] leading-relaxed text-dim">{w.description}</p>}
                </div>
                <button
                  type="button"
                  disabled={onlyRead}
                  onClick={() => save({ markers: toggleMarker(markers, w.name) })}
                  className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium transition-colors disabled:opacity-60 ${w.card ? "bg-warn/15 text-warn" : "text-dim hover:bg-hover hover:text-fg"}`}
                  title={w.card ? t("Card before every call — click to remove") : t("No card — click so every call asks first")}
                  aria-pressed={w.card}
                  data-mcp-card={w.card ? "on" : "off"}
                >
                  {t("Card")}
                </button>
              </div>
            ))}
          </div>
        </>
      )}

      <div className="mt-5 flex justify-end">
        <button type="button" onClick={onClose} className={ghost}>{t("Close")}</button>
      </div>
    </Modal>
  );
}
