"use client";

// Rich rendering of an assistant history in the Claude Code style: text, thinking blocks, tool calls WITH result + diff, todo
// lists and nested subagent activity (Task → child calls). Purely presentational — the streaming/mutation state lives in
// ChatPane, this only renders.
//
// No line carries a leading symbol: paragraph, summary row, thinking block and subagent mark start at ONE edge, the left
// content edge of the reading column — as in Claude Desktop. A state shows only through word, color and the light effect of a
// running row. WHEN a row runs and WHICH word a subagent carries is computed by lib/history-state.ts (one leaf, bound in the
// gate and to the iOS revision); there is no chain of its own here.
import { createContext, memo, useContext, useState } from "react";
import { Markdown } from "@/components/Markdown";
import { Contained } from "@/lib/contain";
import { useT, tr } from "@/lib/i18n";
import { buildDiff, toolSummary, toolFile, type DiffLine } from "@/lib/tool-summary";
import { openFileTab, relativeToRoot } from "@/lib/chat-tabs";
// A subagent's task and report status come from the SAME source as in the agent bar (lib/agents.ts). A second parser here
// would mean the mark in the history and the row in the bar could name different tasks.
import { agentsList, type AgentBlock } from "@/lib/agents";
import { applyToolInput, applyToolResult, mutateUnderParent } from "@/lib/tool-result";
import { isSkillWrite, readSkillWriteResult } from "@/lib/skill-change";
import { ROW_FULL_EVENT } from "@/lib/api/log-window";
import { SkillToolCard } from "@/components/SkillToolCard";
import { TONE_CLASS, agentState, groupRunning, shimmerClass, toolRunning, type AgentState } from "@/lib/history-state";

// The diff builder lives in lib/tool-summary.ts, the result mapping in lib/tool-result.ts (both without React, so the gate can
// check them); whoever imported them from here (PermissionPrompt, the three histories) still gets them.
export { buildDiff, applyToolInput, applyToolResult, mutateUnderParent };

export type Block =
  | { kind: "text"; text: string }
  | { kind: "thinking"; text: string }
  | {
      kind: "tool";
      id?: string; // tool_use_id — links the call to its result
      name: string;
      detail: string;
      count: number;
      input?: Record<string, unknown>;
      result?: string; // output of the tool (tool_result)
      resultIsError?: boolean;
      truncated?: number; // row id of the result shortened in the window (server chats/log-window.js) — full on expand
      done?: boolean; // result is present
      children?: Block[]; // subagent activity (for name === "Task")
    }
  | { kind: "error"; text: string };

// There is no icon column before history rows: every row starts at the edge of the answer text. The working display and the
// metrics row carry their hexagon in a 1-em box (chat/RunDisplay.tsx), the agent bar's dot has its own shell (components/AgentBar.tsx).

// Canonical tool names (providers/contract.js) → display name. `apply_patch` is the name under which Codex file changes
// arrive — without this entry it would show raw.
const TOOL_LABEL: Record<string, string> = { Bash: "Shell", apply_patch: "Change files" };
// mcp__server__tool → tool; Bash → Shell (Claude Code wording).
export function formatToolName(name: string): string {
  if (TOOL_LABEL[name]) return TOOL_LABEL[name];
  return name.replace(/^mcp__/, "").split("__").pop() ?? name;
}

// tool_result.content is sometimes a string, sometimes an array of {type,text} blocks.
export function resultToText(content: unknown): string {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => (typeof c === "string" ? c : c?.text ?? (c?.type === "image" ? tr("[Image]") : "")))
      .join("");
  }
  return String(content);
}

const MAX_DIFF_LINES = 44;
const MAX_RESULT_CHARS = 4000;

// A tool's result in the fold: the first MAX_RESULT_CHARS characters, then "Show all". If the server shortened it in the window
// (`truncated`, server chats/log-window.js — never below MAX_RESULT_CHARS), the button requests the full row (`ROW_FULL_EVENT`,
// chat/chatCache.ts); until it arrives, "Loading …" shows. Without shortening it shows the rest that is already there.
function ResultText({ block }: { block: Extract<Block, { kind: "tool" }> }) {
  const t = useT();
  const [everything, setEverything] = useState(false);
  const full = block.result ? resultToText(block.result) : "";
  if (!full) return null;
  const truncated = block.truncated;
  const more = full.length > MAX_RESULT_CHARS || truncated !== undefined;
  const show = () => {
    setEverything(true);
    if (truncated !== undefined) window.dispatchEvent(new CustomEvent(ROW_FULL_EVENT, { detail: truncated }));
  };
  return (
    <div className="overflow-x-auto rounded-lg border border-edge bg-code px-2.5 py-1.5" data-tool-result>
      <pre className={`whitespace-pre-wrap break-words cb-cs-12 leading-[1.5] ${block.resultIsError ? "text-danger" : "text-fg/80"}`}>
        {everything ? full : full.slice(0, MAX_RESULT_CHARS)}
        {more && !everything && <span className="text-dim">{"\n" + t("… truncated") + " · "}<button type="button" className="text-accent hover:underline" onClick={show} data-result-everything>{t("Show all")}</button></span>}
        {everything && truncated !== undefined && <span className="text-dim">{"\n" + t("Loading …")}</span>}
      </pre>
    </div>
  );
}

// ── small inline icons (no emojis, consistent with the rest of the UI) ──
const ic = (children: React.ReactNode, size = 13) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    {children}
  </svg>
);
export const Chevron = ({ open }: { open: boolean }) => (
  <span className={`inline-flex transition-transform duration-150 ${open ? "rotate-90" : ""}`}>{ic(<path d="M9 18l6-6-6-6" />, 12)}</span>
);
const CheckSm = () => ic(<path d="M20 6L9 17l-5-5" />, 12);

// ── Diff view from the tool input (Edit/MultiEdit/Write) ──────────────────────
export function DiffView({ lines }: { lines: DiffLine[] }) {
  const t = useT();
  const shown = lines.slice(0, MAX_DIFF_LINES);
  const rest = lines.length - shown.length;
  return (
    <div className="overflow-x-auto rounded-lg border border-edge bg-code">
      <pre className="min-w-full cb-cs-12 leading-[1.5]">
        {shown.map((l, i) => (
          <div
            key={i}
            className={
              l.sign === "+"
                ? "bg-ok/15 text-ok"
                : l.sign === "-"
                ? "bg-danger/15 text-danger"
                : "text-dim"
            }
          >
            <span className="inline-block w-5 select-none pl-1.5 opacity-70">{l.sign === " " ? "" : l.sign}</span>
            <span className="whitespace-pre">{l.text || " "}</span>
          </div>
        ))}
        {rest > 0 && <div className="px-2 py-0.5 text-dim">{t("… {n} more lines", { n: rest })}</div>}
      </pre>
    </div>
  );
}

// ── Todo list ───────────────────────────────────────────────────────────────────
// Two sources feed the same rendering:
//  • TodoWrite — one call carries the WHOLE list. Only our own loop engine offers it; the Claude CLI replaced it with the Task*
//    tools.
//  • TaskCreate/TaskUpdate — each call concerns ONE task, the id appears only in the result ("Task #3 created successfully:
//    …"). So the list state emerges only from the sequence.
type Todo = { content?: string; status?: string; activeForm?: string };
function TodoList({ todos }: { todos: Todo[] }) {
  return (
    <div className="flex flex-col gap-1 rounded-lg border border-edge bg-code px-3 py-2">
      {todos.map((t, i) => {
        const done = t.status === "completed";
        const active = t.status === "in_progress";
        return (
          <div key={i} className="flex items-start gap-2 cb-cs-12-5">
            <span className={`mt-[3px] grid h-3.5 w-3.5 shrink-0 place-items-center rounded-[4px] border ${done ? "border-ok bg-ok text-white" : active ? "border-accent text-accent" : "border-edge text-dim"}`}>
              {done ? <CheckSm /> : active ? <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent" /> : null}
            </span>
            <span className={done ? "text-dim line-through" : active ? "font-medium text-fg" : "text-fg"}>
              {active ? t.activeForm || t.content : t.content}
            </span>
          </div>
        );
      })}
    </div>
  );
}

// The CURRENT state of the CLI task list, derived from the sequence of Task* calls over the whole history. It is shown not in
// the history but in a fixed bar above the composer (as in the CLI) — inline the list moved one position at every tick and
// flickered. Failed calls stay ordinary tool blocks (error visible).
const TASK_TOOLS = new Set(["TaskCreate", "TaskUpdate"]);
export const isTaskCall = (bl?: Block) =>
  Boolean(bl && bl.kind === "tool" && TASK_TOOLS.has(bl.name) && !bl.resultIsError);

export type NativeTask = { id: string; content: string; status: string; activeForm?: string };

export function nativeTaskList(blocks: Block[]): NativeTask[] {
  const tasks = new Map<string, NativeTask>();
  blocks.forEach((bl, i) => {
    if (!isTaskCall(bl) || bl.kind !== "tool") return;
    if (bl.name === "TaskCreate") {
      // Live, the block appears BEFORE its result — the id is still unknown then, and a per-position placeholder keeps the task
      // in the list anyway.
      const id = /#(\d+)/.exec(bl.result || "")?.[1] ?? `new-${i}`;
      tasks.set(id, {
        id,
        content: String(bl.input?.subject || ""),
        status: "pending",
        activeForm: bl.input?.activeForm ? String(bl.input.activeForm) : undefined,
      });
    } else {
      const id = String(bl.input?.taskId ?? "");
      const previous = tasks.get(id);
      if (!previous) return; // task from an earlier run — not reconstructible
      const status = String(bl.input?.status || previous.status || "pending");
      if (status === "deleted") tasks.delete(id);
      else tasks.set(id, {
        id,
        content: bl.input?.subject ? String(bl.input.subject) : previous.content,
        status,
        activeForm: bl.input?.activeForm ? String(bl.input.activeForm) : previous.activeForm,
      });
    }
  });
  return [...tasks.values()];
}

// Fixed bar above the composer while the list is RELEVANT — i.e. at least one item is open. When all are done it disappears (as
// in the CLI). The open items are shown; the done ones appear only as a counter, else they would push the actual work out of
// long lists. Rows carry the task id as key — with the index everything flickered on ticking.
const NATIVE_TASKS_SHOWN = 5;
export function NativeTaskBar({ tasks }: { tasks: NativeTask[] }) {
  const t = useT();
  const open = tasks.filter((task) => task.status !== "completed");
  if (!open.length) return null;
  const done = tasks.length - open.length;
  const shown = open.slice(0, NATIVE_TASKS_SHOWN);
  return (
    // The same opaque, flat surface as the strip base below (`.cb-strip-surface` in globals.css) — everything above the
    // composer looks the same.
    <div className="cb-strip-surface mb-1.5 flex flex-col gap-1 px-3 py-2">
      <div className="flex items-center gap-2 cb-cs-10 font-semibold uppercase tracking-wider text-dim">
        {t("Agent's tasks")}
        {done > 0 && (
          <span className="normal-case tracking-normal">
            {t("{done} of {all} done", { done, all: tasks.length })}
          </span>
        )}
      </div>
      {shown.map((task) => {
        const active = task.status === "in_progress";
        return (
          <div key={task.id} className="flex items-start gap-2 cb-cs-12-5">
            <span className={`mt-[3px] grid h-3.5 w-3.5 shrink-0 place-items-center rounded-[4px] border ${active ? "border-accent text-accent" : "border-edge text-dim"}`}>
              {active ? <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent" /> : null}
            </span>
            <span className={`min-w-0 flex-1 truncate ${active ? "font-medium text-fg" : "text-fg"}`}>
              {active ? task.activeForm || task.content : task.content}
            </span>
          </div>
        );
      })}
      {open.length > shown.length && (
        <span className="cb-cs-12 text-dim">{t("+{n} more", { n: open.length - shown.length })}</span>
      )}
    </div>
  );
}

// ── Thinking block — collapsible, CLOSED by default (quiet surface) ──────────────
// Flush and without symbol: "Thought ›" sits at the edge like the paragraph above it. Expanded, the ONE indent for expanded
// content applies: the line at the edge, the text 12 px behind it — the same as for an expanded single call and a subagent's
// children.
const ThinkingBlock = memo(function ThinkingBlock({ text }: { text: string }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  return (
    <div className="py-0.5">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1 cb-cs-12 text-dim hover:text-fg"
        data-thinking-block
      >
        {t("Thought")}
        <Chevron open={open} />
      </button>
      {open && (
        <div className="mt-1 border-l border-edge pl-3 cb-cs-12-5 italic leading-relaxed text-dim">
          <span className="whitespace-pre-wrap break-words">{text}</span>
        </div>
      )}
    </div>
  );
});

// Subagent calls ALWAYS stand on their own. Behind their fold lies the work of a whole run; in a summary row ("3 tool calls")
// it could not be found any more. This holds even while no child event has arrived yet (background agent).
const AGENT_TOOLS = new Set(["Agent", "Task", "mcp__cbase__cbase_agent"]);
export const isAgentCall = (name: string) => AGENT_TOOLS.has(name);

// ── Tool call with result/diff and (for Task) nested child calls ────────────────

// The states of the subagent marks, computed ONCE per agent (the agent list in ChatPane, block id → state). `AssistantBlocks`
// fills the context from its optional prop `agentStates`; a nested `AssistantBlocks` without the prop inherits it. `null`
// means: there is no list (agent dock) — then the mark computes itself, with `inStream: null`. Module-internal: only this file
// reads it.
const AgentStateContext = createContext<ReadonlyMap<string, AgentState | null> | null>(null);

// The state word of a subagent ("RUNNING", "STOPPED", "ERROR", "NO RESULT") — tone and pulse come from the ONE table
// (AGENT_STATES via `agentState`), not from this file.
function AgentWord({ z, className = "" }: { z: AgentState; className?: string }) {
  const t = useT();
  return (
    <span
      data-agent-word
      className={`shrink-0 cb-cs-10-5 font-medium uppercase tracking-wide ${TONE_CLASS[z.tone]} ${z.pulses ? "animate-pulse motion-reduce:animate-none" : ""} ${className}`}
    >
      {t(z.word)}
    </span>
  );
}

// `shimmer`: may this row's sentence shimmer while the call runs? `ToolGroup` switches it off on the expanded SINGLE call —
// otherwise summary row and call below would shimmer and both say the same.
// ── File name as a button (code tabs in the chat) ───────────────────────────────────────────────
// In the Coding chat the stage (chat/ChatStage.tsx) sets the context: the chat's key (id or draft), the root of its target
// (project folder, the workspace without a project — chat/chatTabs.ts `targetRoot`) and the runs' cwd (the workspace: a tool's
// relative path resolves there). Without context (agent bar, dock) and for a path OUTSIDE the root there is no button — never
// one that would look for a foreign file under the chat's target. A copy overlays the project at its original path, so a tool's
// path is relative to the same root in every instance; the tab takes the chat's target.
export type FileTabContextValue = { chatKey: string; root: string | null; cwd: string };
export const FileTabContext = createContext<FileTabContextValue | null>(null);

/** The path of an Edit/MultiEdit/Write call RELATIVE to the chat's target — null without context, without a file or outside the target. */
function useFileTab(block: { name: string; input?: Record<string, unknown> }): string | null {
  const k = useContext(FileTabContext);
  const path = toolFile(block.name, block.input);
  return k?.root && path ? relativeToRoot(path, k.root, k.cwd) : null;
}

/** The button: opens the file as a preview tab in the chat's code area (the click does not expand the row). */
function FileButton({ rel, shimmers, className, children }: { rel: string; shimmers: boolean; className: string; children: React.ReactNode }) {
  const t = useT();
  const k = useContext(FileTabContext);
  return (
    <button
      type="button"
      onClick={(e) => { e.stopPropagation(); if (k) openFileTab(k.chatKey, rel); }}
      title={t("Open in the code area: {path}", { path: rel })}
      data-file-tab={rel}
      className={`min-w-0 truncate text-left underline-offset-2 hover:text-fg hover:underline ${shimmerClass(shimmers)} ${className}`}
      data-shimmer={shimmers ? "" : undefined}
    >
      {children}
    </button>
  );
}

const ToolBlock = memo(function ToolBlock({ block, initiallyOpen = false, live = true, ck = "", onAgentOpen, shimmer = true }: { block: Extract<Block, { kind: "tool" }>; initiallyOpen?: boolean; live?: boolean; ck?: string; onAgentOpen?: (id: string) => void; shimmer?: boolean }) {
  const t = useT();
  const states = useContext(AgentStateContext);
  const isTodo = block.name === "TodoWrite" && Array.isArray(block.input?.todos);
  // `cbase_skill_write`: below the "Skill … created/changed" row, Undo or the request card of a deletion — only with a readable,
  // error-free result.
  const skillResult = isSkillWrite(block.name) && block.done && !block.resultIsError && block.result
    ? readSkillWriteResult(resultToText(block.result), block.input)
    : null;
  const diff = buildDiff(block.name, block.input);
  const resultText = block.result ? resultToText(block.result).slice(0, MAX_RESULT_CHARS) : "";
  const children = block.children ?? [];
  // A subagent call can be expanded ONLY via this row: its child calls and its report are content of the fold, not of the
  // history. Otherwise a subagent's whole work (often dozens of calls) stood permanently in the chat and buried the answer.
  const expandable = !isTodo && (Boolean(diff) || Boolean(resultText) || children.length > 0);
  // Empty text/thinking blocks render nothing and must not inflate the count on the collapsed row — else "7 steps" promises
  // more than the fold shows.
  const childCount = children.filter((c) => !((c.kind === "text" || c.kind === "thinking") && !c.text.trim())).length;
  // Everything this call knows about its subagent — from the SAME source as the agent bar (lib/agents.ts), so mark and bar never
  // name different tasks. `null` for every other tool.
  const agentData = isAgentCall(block.name) ? agentsList<Block>([], [block as AgentBlock<Block>])[0] : null;
  // Which model works here? The report names the RESOLVED model (even in the "running" state), the call only the main agent's
  // wish — which can be "codex::" without a model. The badge shows only in the FALLBACK fold (agent dock); on the mark it is
  // absent on purpose, there the bar names the model.
  const agentModel = agentData
    ? agentData.model || (typeof block.input?.model === "string" ? block.input.model : "")
    : "";
  // ALWAYS start collapsed — even on an error. A failed tool call is recognisable in the history by the red word "Error";
  // expanding its output by itself pushed the text below away and inflated long runs with stack traces nobody mostly reads.
  // Whoever wants to see them expands. Whoever opens a GROUP wants to see the contents — then the calls inside start open
  // (initiallyOpen).
  const [open, setOpen] = useState(initiallyOpen);

  // Does the call run? Only if the turn is RUNNING and the result is missing (lib/history-state.ts). A call without a result in
  // a finished turn (stop, restart, Codex without item.completed) does NOT run — it simply carries no mark; it used to pulse
  // forever under a row that said "Aborted after …".
  const running = toolRunning(block, live);
  const shimmers = running && shimmer;

  const label = t(formatToolName(block.name));
  const file = useFileTab(block);

  // ── A subagent's mark ───────────────────────────────────────────────────────────
  // In the history only ONE row remains of a subagent: the word "Subagent", its task, its state word and an arrow that leads
  // elsewhere. Its steps, its report and its numbers live in the agent bar; in the history they buried the answer the person is
  // waiting for. The arrow therefore expands NOTHING, it calls `onAgentOpen` with the tool-call id — the key by which the bar
  // joins running and finished agents. WITHOUT a callback the fold stays (below): the agent dock renders the same component and
  // has no bar — there the mark would be an arrow into nothing.
  if (agentData && onAgentOpen && block.id) {
    const id = block.id;
    // The state comes from the card if it knows it: then mark and bar say the same, because both read the same once-computed
    // value. If the card does not know the block, it sits in a discarded bubble (the agent list filters `dimmed`) — the list is
    // known and it is not in it: `inStream: false`. Without a card the fallback applies (`null`). A finished subagent carries NO
    // word; `data-agent-state` then says "finished".
    const z = states?.has(id)
      ? (states.get(id) ?? null)
      : agentState({
          error: block.resultIsError === true,
          rawStatus: agentData.rawStatus,
          done: block.done === true,
          inStream: states ? false : null,
          turnRunning: live,
        });
    // sentence: the smaller word sits on the row's BASELINE (`items-baseline` — centered it sat 2.8 px higher), with a fixed gap
    // after the task (8 px) and before the arrow (6 px; with `gap-0.5` it stuck to both). The arrow is no text and sits centered.
    // A fixed space before the dot: the ordinary one dropped at the start of the flex child ("Subagent·"). Guard:
    // history-without-points.test.mjs.
    return (
      <div className="py-0.5">
        <button
          type="button"
          onClick={() => onAgentOpen(id)}
          data-subagent-marker={id}
          data-agent-state={z?.identifier ?? "finished"}
          title={t("Open in the agents panel")}
          className="flex w-full items-baseline text-left text-tool text-dim hover:text-fg"
        >
          <span className="shrink-0 text-fg">{t("Subagent")}</span>
          <span className="min-w-0 truncate">{"\u00a0· "}{agentData.job}</span>
          {z && <AgentWord z={z} className="ml-2" />}
          <span className="ml-1.5 shrink-0 self-center text-dim"><Chevron open={false} /></span>
        </button>
      </div>
    );
  }

  // The fallback without a bar (agent dock): here too a subagent carries its state word — from the same chain, without a list
  // (`inStream: null`), with the bubble's turn. The word "Error" of an ordinary call then does not stand beside it again.
  const agentZ = agentData
    ? agentState({
        error: block.resultIsError === true,
        rawStatus: agentData.rawStatus,
        done: block.done === true,
        inStream: null,
        turnRunning: live,
      })
    : null;

  return (
    <div className="py-0.5">
      <div className="min-w-0 text-tool">
        {file ? (
          // Code tabs in the chat: the path is a button of its own beside the expander — a button in a button would not be valid
          // HTML. The light band then lies on both pieces.
          <div className="flex w-full items-center gap-1.5">
            <button
              type="button"
              disabled={!expandable}
              onClick={() => setOpen((v) => !v)}
              aria-expanded={expandable ? open : undefined}
              className={`shrink-0 text-left ${expandable ? "hover:text-fg" : "cursor-default"}`}
            >
              <span className={shimmerClass(shimmers)} data-shimmer={shimmers ? "" : undefined}>
                {label}
                {block.count > 1 ? ` ×${block.count}` : ""}
                {" ·"}
              </span>
            </button>
            <FileButton rel={file} shimmers={shimmers} className={shimmers ? "" : "text-dim"}>{block.detail}</FileButton>
            {block.resultIsError && <span className="shrink-0 cb-cs-10-5 font-medium uppercase tracking-wide text-danger">{t("Error")}</span>}
            {expandable && (
              <button type="button" tabIndex={-1} aria-hidden onClick={() => setOpen((v) => !v)} className="shrink-0 text-dim hover:text-fg">
                <Chevron open={open} />
              </button>
            )}
          </div>
        ) : (
        <button
          type="button"
          disabled={!expandable}
          onClick={() => setOpen((v) => !v)}
          className={`flex w-full items-center gap-1.5 text-left ${expandable ? "hover:text-fg" : "cursor-default"}`}
        >
          {/* While the call runs, the light band travels over the WHOLE sentence — the gray detail loses its own color for it,
              else it would paint over the band. */}
          <span className={`min-w-0 truncate ${shimmerClass(shimmers)}`} data-shimmer={shimmers ? "" : undefined}>
            {label}
            {block.count > 1 ? ` ×${block.count}` : ""}
            {block.detail && <span className={shimmers ? "" : "text-dim"}> · {block.detail}</span>}
          </span>
          {agentData
            ? agentZ && <AgentWord z={agentZ} />
            : block.resultIsError && <span className="shrink-0 cb-cs-10-5 font-medium uppercase tracking-wide text-danger">{t("Error")}</span>}
          {agentModel && (
            <span className="shrink-0 rounded-md border border-edge px-1.5 py-[1px] cb-cs-11 text-dim" title={t("Subagent model")}>
              {agentModel}
            </span>
          )}
          {childCount > 0 && !open && (
            <span className="shrink-0 cb-cs-11-5 text-dim">
              {childCount === 1 ? t("1 step") : t("{n} steps", { n: childCount })}
            </span>
          )}
          {expandable && <span className="shrink-0 text-dim"><Chevron open={open} /></span>}
        </button>
        )}

        {/* Todos always visible (no hiding behind a fold), at the edge like everything */}
        {isTodo && <div className="mt-1.5"><TodoList todos={block.input!.todos as Todo[]} /></div>}
        {skillResult && <SkillToolCard result={skillResult} />}

        {open && (
          <div className="mt-1.5 flex flex-col gap-1.5">
            {diff && <DiffView lines={diff} />}
            {resultText && <ResultText block={block} />}
          </div>
        )}

        {/* Subagent activity: child calls indented — only when open. The ONE indent for expanded content: line at the edge,
            content 12 px behind it. */}
        {open && children.length > 0 && (
          <div className="mt-1 border-l border-edge pl-3">
            <AssistantBlocks blocks={children} live={live} ck={ck && `${ck}/sub`} onAgentOpen={onAgentOpen} />
          </div>
        )}
      </div>
    </div>
  );
});

type ToolBlockT = Extract<Block, { kind: "tool" }>;

// May a tool call dissolve into a summary row? Not if it carries something permanently visible itself: todo lists stay,
// subagents lead their own fold, a `cbase_skill_write` carries Undo or the request card.
const groupable = (bl: Block): bl is ToolBlockT =>
  bl.kind === "tool" &&
  !isTaskCall(bl) &&
  !isAgentCall(bl.name) &&
  !(bl.children && bl.children.length > 0) &&
  !isSkillWrite(bl.name) &&
  !(bl.name === "TodoWrite" && Array.isArray(bl.input?.todos));

// The summary of the summary row ("15 commands run, one file created  +35 −0", identical to iOS) is built by `toolSummary` in
// lib/tool-summary.ts — there, because the gate checks it.

// A row in the expanded group (from two calls): the title is the call's DESCRIPTION (Claude Code sends it as
// `input.description`), only then the detail — the detail picks the command first, and "git status --short" says less than
// "Working tree state". Every row starts CLOSED and expands on its own; the group used to show all its calls open at once with
// output, and a list of twelve stack traces could not be taken in. The whole row is red if the call failed. While the call
// runs its title shimmers — in the surface of SEVERAL calls the row says WHICH one runs; there is no spinner on the right.
const ToolRow = memo(function ToolRow({ block, live = true }: { block: ToolBlockT; live?: boolean }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const diff = buildDiff(block.name, block.input);
  const resultText = block.result ? resultToText(block.result).slice(0, MAX_RESULT_CHARS) : "";
  const command = block.name === "Bash" && typeof block.input?.command === "string" ? block.input.command : "";
  const title = String(block.input?.description ?? "") || block.detail || t(formatToolName(block.name));
  const running = toolRunning(block, live);
  const expandable = Boolean(diff) || Boolean(resultText) || Boolean(command);
  const file = useFileTab(block);
  return (
    <div data-tool-row data-open={open ? "true" : "false"}>
      {file ? (
        // Code tabs in the chat: the title is the path button, the rest of the row expands.
        <div className="flex w-full items-center cb-cs-13">
          <FileButton rel={file} shimmers={running} className={`py-2 pl-3 ${block.resultIsError ? "text-danger" : "text-fg"}`}>{title}</FileButton>
          <button
            type="button"
            disabled={!expandable}
            onClick={() => setOpen((v) => !v)}
            aria-expanded={expandable ? open : undefined}
            aria-label={title}
            className={`flex min-w-8 flex-1 items-center justify-end self-stretch py-2 pr-3 ${expandable ? "hover:bg-edge/40" : "cursor-default"}`}
          >
            {expandable && <span className="shrink-0 text-dim"><Chevron open={open} /></span>}
          </button>
        </div>
      ) : (
      <button
        type="button"
        disabled={!expandable}
        onClick={() => setOpen((v) => !v)}
        className={`flex w-full items-center gap-2 px-3 py-2 text-left cb-cs-13 ${expandable ? "hover:bg-edge/40" : "cursor-default"}`}
      >
        <span
          className={`min-w-0 truncate ${shimmerClass(running) || (block.resultIsError ? "text-danger" : "text-fg")}`}
          data-shimmer={running ? "" : undefined}
        >
          {title}
        </span>
        {/* Chevron only if the row opens (like ToolBlock): a call without command, diff and output — e.g. without a result after
            a stop — would otherwise promise an expansion that did nothing. Whether it runs, the title itself says. */}
        {expandable && <span className="shrink-0 text-dim"><Chevron open={open} /></span>}
      </button>
      )}
      {open && (
        <div className="flex flex-col gap-1.5 px-3 pb-2">
          {command && <code className="block overflow-x-auto whitespace-pre cb-cs-12 leading-[1.5] text-dim">{command}</code>}
          {diff && <DiffView lines={diff} />}
          {resultText && <ResultText block={block} />}
        </div>
      )}
    </div>
  );
});

// Summary row ("5 commands run, one file created  +35 −0 ›") — for a group as for the SINGLE call. No mark before it: the row
// starts at the edge like the paragraph above, and if something is still running a light band travels over its sentence
// (`shimmerClass`). From two commands the row counts the failed ones in parentheses; for a single one "ERROR" stands beside it.
// The click opens diff and output directly for ONE call, for two or more a framed surface with one collapsed row per call
// (ToolRow). CLOSED by default — even while the turn is still running and even on an error: opening by itself needed a latch
// against flicker and continuously pushed the text away while working.
//
// "Running" means: the turn is LIVE and a call has no result yet (`groupRunning`, lib/history-state.ts). `!done` alone was not
// enough — a call without a result in a finished run (stop, restart, result fell into a card bubble) would spin until reload.
const ToolGroup = memo(function ToolGroup({ blocks, live = true, ck = "" }: { blocks: ToolBlockT[]; live?: boolean; ck?: string }) {
  const t = useT();
  const [userOpen, setUserOpen] = useState<boolean | null>(null);
  const anyError = blocks.some((b) => b.resultIsError);
  const running = groupRunning(blocks, live);
  const open = userOpen ?? false;
  const summary = toolSummary(blocks, t);
  const individual = blocks.length === 1;
  return (
    <div className="py-0.5" data-tool-row={running ? "running" : anyError ? "error" : "done"} data-tool-error={summary.error} aria-busy={running || undefined}>
      <button
        type="button"
        onClick={() => setUserOpen(!open)}
        className="flex w-full items-center gap-1.5 text-left text-tool text-dim hover:text-fg"
      >
        <span className="flex min-w-0 flex-1 items-center gap-1.5">
          {/* The sentence is `summary.text`, in three pieces: only the counter "({k} failed)" turns red — from two calls the word
              "Error" is dropped, and without color a failure in the collapsed row was as gray as a group without one. The red
              counter keeps its color under the light band too: a child with an opaque color paints over the band. */}
          <span className={`min-w-0 truncate ${shimmerClass(running)}`} data-shimmer={running ? "" : undefined}>
            {summary.base}
            {summary.counter && <> <span className="text-danger">{summary.counter}</span></>}
            {summary.postscript}
          </span>
          {summary.files && (
            <span className="shrink-0 tabular-nums">
              <span className="text-ok">+{summary.added}</span> <span className="text-danger">−{summary.removed}</span>
            </span>
          )}
          {anyError && individual && <span className="shrink-0 cb-cs-10-5 font-semibold uppercase tracking-wide text-danger">{t("Error")}</span>}
          <span className="shrink-0"><Chevron open={open} /></span>
        </span>
      </button>
      {open && individual && (
        /* The ONE indent for expanded content: line at the edge, content 12 px behind it. The call below does NOT shimmer along
           — it says the same as the summary row. */
        <div className="mt-1 border-l border-edge pl-3">
          <ToolBlock block={blocks[0]} initiallyOpen live={live} ck={ck && `${ck}/${blocks[0].id ?? 0}`} shimmer={false} />
        </div>
      )}
      {open && !individual && (
        /* ONE surface, rows divided by hairlines, at the edge like the summary row above. Here summary row AND running row
           shimmer: the row says which call runs. */
        <div className="mt-1.5 overflow-hidden rounded-xl border border-edge divide-y divide-edge bg-code/40">
          {blocks.map((b, i) => (
            <ToolRow key={b.id ?? i} block={b} live={live} />
          ))}
        </div>
      )}
    </div>
  );
});

// ── Renderer for an array of blocks (recursive for subagents) ───────────────────
// `live` = the turn is still running. It no longer depends on expansion (summary rows stay closed until someone clicks) — the
// value travels down through the blocks and decides whether a row runs (light effect) and which word a subagent without a
// list carries. Memoized on (blocks, live): while streaming, ChatPane replaces ONLY the blocks array of the currently running
// bubble; all older ones keep their identity. Without this guard every event rebuilt the whole history.
// `ck` = namespace of this block list for the memory brake (chat id + bubble position, for subagents additionally the position
// of the Task call). It must be stable across streaming updates — else a block inherits the remembered height of a foreign one.
// If it is missing, the wrapper has no effect and everything is drawn as before.
// `agentStates` = the subagents' states, computed once per agent (block id → state, `null` = finished). Whoever passes them
// keeps the identity stable as long as no state changes — else every bubble re-renders on every agent tick. If the prop is
// missing, every mark computes itself.
export const AssistantBlocks = memo(function AssistantBlocks({ blocks, live = true, ck = "", onAgentOpen, agentStates }: { blocks: Block[]; live?: boolean; ck?: string; onAgentOpen?: (id: string) => void; agentStates?: ReadonlyMap<string, AgentState | null> }) {
  // Consecutive groupable tool calls (from 2) go into ONE summary row. Empty text/thinking blocks and the invisible Task*
  // calls do not interrupt a group — they render nothing anyway.
  //
  // The key comes from the position in the BLOCK array, not from the position in `items`: `blocks` only grows at the end
  // (ChatPane appends and updates in place), `items` however SHRINKS as soon as two single rows merge into a group. While
  // streaming that always happens at the END of the list, which is why it went unnoticed — but as soon as a block becomes
  // visible LATER (a failed Task* call is no longer an invisible row), everything below gets a new key with the items index and
  // is rebuilt: thinking blocks collapse, Markdown re-renders.
  type Item = { key: string; single: Block } | { key: string; group: ToolBlockT[] };
  const items: Item[] = [];
  let run: Array<{ bl: ToolBlockT; at: number }> = [];
  // A SINGLE groupable call becomes a summary row too (like iOS) — only what carries something permanently visible itself
  // (todo list, subagent) keeps its own row.
  const flush = () => {
    if (run.length >= 1) items.push({ key: `g${run[0].at}`, group: run.map((r) => r.bl) });
    run = [];
  };
  blocks.forEach((bl, i) => {
    if (bl.kind === "tool" && isTaskCall(bl)) return;
    if ((bl.kind === "text" || bl.kind === "thinking") && !bl.text.trim()) return;
    if (groupable(bl)) { run.push({ bl, at: i }); return; }
    flush();
    items.push({ key: `b${i}`, single: bl });
  });
  flush();

  // The guard sits per ITEM, not only per bubble: a single assistant answer measured 59,710 px high (tool lists with 33 and 63
  // children). While it is in view it is drawn entirely — only the per-row guard keeps just the visible part in the renderer
  // even then.
  //
  // Answer text and error text stand WITHOUT a dot before them: the paragraph starts at the edge. An error stays recognisable by
  // its red text.
  const body = items.map((item) => {
    if ("group" in item) return <ToolGroup key={item.key} blocks={item.group} live={live} ck={ck && `${ck}/${item.key}`} />;
    const bl = item.single;
    if (bl.kind === "text") {
      return (
        <div key={item.key} className="min-w-0 py-1" data-text-block>
          <Markdown src={bl.text} />
        </div>
      );
    }
    if (bl.kind === "thinking") {
      return <ThinkingBlock key={item.key} text={bl.text} />;
    }
    if (bl.kind === "tool") {
      return <ToolBlock key={item.key} block={bl} live={live} ck={ck && `${ck}/${item.key}`} onAgentOpen={onAgentOpen} />;
    }
    return (
      <div key={item.key} className="py-1 whitespace-pre-wrap break-words text-danger" data-error-block>
        {bl.text}
      </div>
    );
  });

  const content = !ck ? (
    <>{body}</>
  ) : (
    <>
      {body.map((node, i) => (
        <Contained key={items[i].key} ck={`${ck}/${items[i].key}`}>
          {node}
        </Contained>
      ))}
    </>
  );
  // Only whoever passes the card sets the context — a nested `AssistantBlocks` (a subagent's children) inherits it instead of
  // resetting it to "no list".
  if (agentStates === undefined) return content;
  return <AgentStateContext.Provider value={agentStates}>{content}</AgentStateContext.Provider>;
});
