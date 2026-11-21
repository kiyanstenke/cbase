"use client";
// Debugging like VS Code:
//
//   DebugConsole  the DEBUG CONSOLE tab in the bottom panel; like VS Code only the REPL: session output with the input below;
//                 Enter evaluates the expression in the session (input and result appear in the output, up/down arrows page through inputs).
//   DebugView     the "Run and Debug" side bar (activity bar on top, Shift+Cmd+D): step buttons in the title (VS Code
//                 `debug.toolBarLocation: docked`; there is no floating bar over the editor), below them VARIABLES, WATCH,
//                 CALL STACK, BREAKPOINTS as collapsible sections. Without a session it shows the "Run and Debug" button (welcome view).
import { useState } from "react";
import type { DebugPaused } from "@/lib/api";
import { useT } from "@/lib/i18n";
import { ArrowSymbol } from "@/components/code/explorer/ExplorerHeader";

type Status = "starting" | "running" | "paused" | "terminated";

/** The DEBUG CONSOLE tab: output and REPL input. */
export function DebugConsole({ output, onEvaluate }: { output: string[]; onEvaluate: (expression: string) => void }) {
  const t = useT();
  const [inputText, setInput] = useState("");
  const [history, setHistory] = useState<{ list: string[]; i: number }>({ list: [], i: -1 });
  return (
    <div className="flex h-full flex-col">
      <div className="cb-scroll min-h-0 flex-1 overflow-auto px-3 py-1 font-mono text-[12px] leading-[1.5] whitespace-pre-wrap" data-debug-output>
        {output.map((l, i) => <div key={i}>{l}</div>)}
      </div>
      <div className="flex shrink-0 items-center gap-1.5 border-t border-edge px-3 py-1">
        <span aria-hidden className="font-mono text-[12px] text-accent">›</span>
        <input
          value={inputText}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && inputText.trim()) {
              e.preventDefault();
              onEvaluate(inputText.trim());
              setHistory((v) => ({ list: [...v.list.filter((x) => x !== inputText.trim()), inputText.trim()].slice(-50), i: -1 }));
              setInput("");
            } else if ((e.key === "ArrowUp" || e.key === "ArrowDown") && history.list.length) {
              e.preventDefault();
              const n = history.list.length;
              const i = e.key === "ArrowUp" ? (history.i < 0 ? n - 1 : Math.max(0, history.i - 1)) : (history.i < 0 ? -1 : history.i + 1 >= n ? -1 : history.i + 1);
              setHistory({ ...history, i });
              setInput(i < 0 ? "" : history.list[i]);
            }
          }}
          aria-label={t("Debug Console input")}
          className="min-w-0 flex-1 bg-transparent font-mono text-[12px] text-fg outline-none"
          data-panel-focus
          data-debug-input
        />
      </div>
    </div>
  );
}

function Section({ title, collapsed: closed, onToggle, children, data }: { title: string; collapsed: boolean; onToggle: () => void; children: React.ReactNode; data: string }) {
  return (
    <div className="flex min-h-0 flex-col" data-debug-section={data}>
      <button type="button" aria-expanded={!closed} onClick={onToggle} className="cb-tree-header flex h-[22px] shrink-0 items-center pr-1 text-left outline-none focus-visible:outline-1 focus-visible:outline-accent">
        <span className="grid w-[22px] shrink-0 place-items-center text-fg"><ArrowSymbol open={!closed} /></span>
        <span className="min-w-0 flex-1 truncate text-[11px] font-bold uppercase tracking-[0.04em] text-fg">{title}</span>
      </button>
      {!closed && <div className="pb-1">{children}</div>}
    </div>
  );
}

/** The "Run and Debug" side bar. */
export function DebugView({ status, paused, watches, breakpoints, onCmd, onStop, onJump, onAddWatch, onRemoveWatch, onStart }: {
  status: Status;
  paused: DebugPaused | null;
  watches: { expr: string; value?: string; error?: string }[];
  breakpoints: Record<string, number[]>;
  onCmd: (cmd: string) => void;
  onStop: () => void;
  onJump: (file: string, line: number) => void;
  onAddWatch: (expr: string) => void;
  onRemoveWatch: (expr: string) => void;
  /** Start a session for the active file; null: no file. */
  onStart: (() => void) | null;
}) {
  const t = useT();
  const [w, setW] = useState("");
  const [closed, setClosed] = useState<Record<string, boolean>>({});
  const toggle = (k: string) => setClosed((z) => ({ ...z, [k]: !z[k] }));
  const isPaused = status === "paused";
  const active = status !== "terminated";
  const buttonEl = (title: string, cmd: string, dis: boolean, icon: React.ReactNode) => (
    <button type="button" onClick={() => onCmd(cmd)} disabled={dis} title={title} aria-label={title} data-debug-button={cmd}
      className="grid h-[22px] w-[22px] place-items-center rounded-[5px] text-fg hover:bg-hover disabled:opacity-30">{icon}</button>
  );
  const row = "flex h-[22px] w-full min-w-0 items-center gap-1.5 pl-[22px] pr-2 text-left text-[13px] hover:bg-hover";
  const holdList = Object.entries(breakpoints).flatMap(([file, rows]) => rows.map((z) => ({ file, row: z })));
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-debug-view>
      <div className="flex h-[35px] shrink-0 items-center gap-0.5 pl-3 pr-1">
        <span className="min-w-0 flex-1 truncate text-[11px] uppercase tracking-[0.04em] text-fg">{t("Run and Debug")}</span>
        {active && (<>
          {buttonEl(t("Continue (F5)"), "continue", !isPaused, <PlayIcon />)}
          {buttonEl(t("Step over (F10)"), "stepOver", !isPaused, <StepOverIcon />)}
          {buttonEl(t("Step into (F11)"), "stepInto", !isPaused, <StepIntoIcon />)}
          {buttonEl(t("Step out (⇧F11)"), "stepOut", !isPaused, <StepOutIcon />)}
          <button type="button" onClick={onStop} title={t("Stop")} aria-label={t("Stop")} data-debug-button="stop" className="grid h-[22px] w-[22px] place-items-center rounded-[5px] text-danger hover:bg-hover"><StopIcon /></button>
        </>)}
      </div>
      {!active && (
        <div className="shrink-0 px-5 pb-3 pt-1" data-debug-welcome>
          <button type="button" onClick={onStart ?? undefined} disabled={!onStart} className="h-[26px] w-full rounded-[2px] bg-accent px-3 text-[13px] text-white hover:opacity-90 disabled:opacity-40" data-debug-start>{t("Run and Debug")}</button>
          <p className="mt-2 text-[12px] leading-[1.45] text-dim">{t("Debug (Node) — stops at breakpoints")}</p>
        </div>
      )}
      <div className="cb-scroll min-h-0 flex-1 overflow-auto">
        <Section title={t("Variables")} collapsed={Boolean(closed.variables)} onToggle={() => toggle("variables")} data="variables">
          {paused?.scopes.map((sc, i) => (
            <div key={i}>
              <div className="flex h-[22px] items-center pl-[22px] text-[13px] text-fg">{sc.name}</div>
              {sc.vars.map((v, j) => (
                <div key={j} className="flex h-[22px] min-w-0 items-center gap-1.5 pl-[34px] pr-2 font-mono text-[12px]">
                  <span className="shrink-0 text-accent">{v.name}:</span>
                  <span className="min-w-0 flex-1 truncate text-fg" title={v.value}>{v.value}</span>
                </div>
              ))}
            </div>
          ))}
        </Section>
        <Section title={t("Watch")} collapsed={Boolean(closed.monitor)} onToggle={() => toggle("monitor")} data="monitor">
          {watches.map((wt) => (
            <div key={wt.expr} className="group flex h-[22px] min-w-0 items-center gap-1.5 pl-[22px] pr-2 font-mono text-[12px]">
              <span className="shrink-0 text-accent">{wt.expr}:</span>
              <span className={`min-w-0 flex-1 truncate ${wt.error ? "text-danger" : "text-fg"}`} title={wt.error || wt.value}>{wt.error ? wt.error : wt.value ?? "…"}</span>
              <button type="button" onClick={() => onRemoveWatch(wt.expr)} aria-label={t("Remove")} className="shrink-0 text-dim opacity-0 hover:text-danger group-hover:opacity-100">×</button>
            </div>
          ))}
          <input
            value={w}
            onChange={(e) => setW(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && w.trim()) { onAddWatch(w.trim()); setW(""); } }}
            placeholder={t("Watch expression…")}
            className="ml-[22px] mr-2 mt-0.5 w-[calc(100%-30px)] rounded-[2px] border border-edge bg-bg px-1.5 py-[1px] font-mono text-[12px] outline-none placeholder:text-dim focus:border-accent"
          />
        </Section>
        <Section title={t("Call Stack")} collapsed={Boolean(closed.callList)} onToggle={() => toggle("callList")} data="callList">
          {paused?.frames.map((f, i) => (
            <button key={i} type="button" onClick={() => onJump(f.file, f.line)} className={row} title={`${f.file}:${f.line}`}>
              <span className="min-w-0 flex-1 truncate">{f.name}</span>
              <span className="shrink-0 text-[12px] text-dim">{f.file.split("/").pop()}:{f.line}</span>
            </button>
          ))}
          {active && !isPaused && <div className="flex h-[22px] items-center pl-[22px] text-[12px] text-dim">{t("running…")}</div>}
        </Section>
        <Section title={t("Breakpoints")} collapsed={Boolean(closed.breakpoints)} onToggle={() => toggle("breakpoints")} data="breakpoints">
          {holdList.map((h) => (
            <button key={`${h.file}:${h.row}`} type="button" onClick={() => onJump(h.file, h.row)} className={row} title={`${h.file}:${h.row}`}>
              <span aria-hidden className="h-2 w-2 shrink-0 rounded-full bg-danger" />
              <span className="min-w-0 flex-1 truncate">{h.file.split("/").pop()}</span>
              <span className="shrink-0 text-[12px] text-dim">{h.row}</span>
            </button>
          ))}
        </Section>
      </div>
    </div>
  );
}

const svg = (children: React.ReactNode, size = 15) => (<svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden>{children}</svg>);
const PlayIcon = () => svg(<path d="M6 4l14 8-14 8z" fill="currentColor" stroke="none" />);
const StepOverIcon = () => svg(<><path d="M4 12a8 8 0 1 1 3 6.2" /><path d="M4 20v-4h4" /></>);
const StepIntoIcon = () => svg(<><path d="M12 4v10" /><path d="M8 10l4 4 4-4" /><circle cx="12" cy="19" r="1.6" fill="currentColor" stroke="none" /></>);
const StepOutIcon = () => svg(<><path d="M12 20V10" /><path d="M8 14l4-4 4 4" /><circle cx="12" cy="5" r="1.6" fill="currentColor" stroke="none" /></>);
const StopIcon = () => svg(<rect x="6" y="6" width="12" height="12" rx="1.5" fill="currentColor" stroke="none" />);
