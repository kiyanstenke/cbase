import { memo, useEffect, useState } from "react";
import { api, type Attachment } from "@/lib/api";
import { Markdown, MarkdownReferenceContext } from "@/components/Markdown";
import { useOutputsReferences } from "@/components/chat/outputsStore";
import { AssistantBlocks } from "@/components/AssistantBlocks";
import { LimitRow } from "@/components/LimitStrip";
import { type AskAnswer, AskCard } from "@/components/AskCard";
import { CaptureCard } from "@/components/CaptureCard";
import { ChannelCard } from "@/components/ChannelCard";
import { AgentMessageCard } from "@/components/chat/AgentMessageCard";
import { ApprovalCard } from "@/components/ApprovalCard";
import { WorkflowApprovalCard } from "@/components/chat/WorkflowApprovalCard";
import { ImageLightbox } from "@/components/ImageLightbox";
import { MessageActions } from "@/components/MessageActions";
import { isInsertion } from "@/lib/slash";
import { useT } from "@/lib/i18n";
import { bubblesKey } from "@/lib/agents";
import type { AgentState } from "@/lib/history-state";
import type { Bubble } from "@/components/chat/chatBubbles";
import { CompressIcon, FileIcon } from "@/components/chat/ChatIcons";
import { SeparatorRow } from "@/components/chat/SeparatorRow";
import { CARD, StatusLine } from "@/components/chat/StatusLine";
import { ic } from "@/components/CbKit";
import { withSlashGlow } from "@/components/chat/ChatCatalog";
import { MetricRow } from "@/components/chat/RunDisplay";
import { attUrl, fmtSize } from "@/lib/chat-format";
import { imageFrame } from "@/lib/image-frame";

// Icons of the status lines and separators (StatusLine.tsx): 13 px, stroke 2, dimmed like the line — ONE set for all kinds.
const SYM = {
  checkMark: ic(<path d="M20 6 9 17l-5-5" />, 13),
  circle: ic(<circle cx="12" cy="12" r="8" />, 13),
  arrow: ic(<><path d="M5 12h14" /><path d="M13 6l6 6-6 6" /></>, 13),
  blitz: ic(<path d="M13 2 3 14h9l-1 8 10-12h-9l1-8" />, 13),
  branch: ic(<><path d="M6 3v6a3 3 0 0 0 3 3h9" /><path d="M6 21v-6" /><path d="M15 9l3 3-3 3" /></>, 13),
  loop: ic(<><path d="M17 2l4 4-4 4" /><path d="M3 11v-1a4 4 0 0 1 4-4h14" /><path d="M7 22l-4-4 4-4" /><path d="M21 13v1a4 4 0 0 1-4 4H3" /></>, 13),
  cap: ic(<><path d="M17 2l4 4-4 4" /><path d="M3 11v-1a4 4 0 0 1 4-4h14" /><path d="M7 22l-4-4 4-4" /><path d="M21 13v1a4 4 0 0 1-4 4H3" /><path d="M12 9v6" /></>, 13),
  question: ic(<><path d="M9.1 9a3 3 0 1 1 4.5 2.6c-.9.5-1.6 1.2-1.6 2.4" /><path d="M12 18h.01" /></>, 13),
  person: ic(<><path d="M15 20v-1.5a3.5 3.5 0 0 0-3.5-3.5h-4A3.5 3.5 0 0 0 4 18.5V20" /><circle cx="9.5" cy="7.5" r="3.5" /><path d="m15.5 11 2.2 2.2L22 8.9" /></>, 13),
  jump: ic(<><path d="M5 4l10 8-10 8z" /><path d="M19 5v14" /></>, 13),
  command: ic(<><path d="M4 17l6-6-6-6" /><path d="M12 19h8" /></>, 13),
  monitor: ic(<><circle cx="12" cy="12" r="8" /><circle cx="12" cy="12" r="2.4" fill="currentColor" stroke="none" /></>, 13),
  eraser: ic(<><path d="m3 15 8.5-8.5a2.1 2.1 0 0 1 3 0l3 3a2.1 2.1 0 0 1 0 3L12 18H6z" /><path d="m9 9 6 6" /><path d="M12 18h9" /></>, 13),
};

// ── Pasted text as an attachment ─────────────────────────────────────────────
// Large pastes do NOT go into the composer but become an attachment (as with Claude): the prompt stays readable, and
// the agent reads the text from the file with the Read tool. Such an attachment is recognised by its file name — the
// only field that travels with the attachment through server, database and all three clients (mobile/…/Models.swift
// knows the same spelling).
const PASTE_MIN_CHARS = 1200;
const PASTE_MIN_LINES = 25;
const PASTE_PREVIEW_CHARS = 420;
const PASTE_FETCH_MAX = 512_000; // larger attachments get no preview, only the badge
const isLargePaste = (text: string) => text.length >= PASTE_MIN_CHARS || text.split("\n").length >= PASTE_MIN_LINES;
const isPastedText = isInsertion; // detection lives in lib/slash.ts — tested there in the gate
const pastedFileName = () => `pasted-text-${Date.now().toString(36)}.txt`;
// Preview texts per attachment (`chatId:file`). Module-global and NOT in state: ChatPane re-renders on every token, a
// state cache would reload the preview on every run.
const pastedPreviews = new Map<string, string>();

// Card for pasted text: text excerpt + "Pasted" badge. Sits both in the composer (before sending, with a remove button
// around it) and in the user bubble in the history.
function PastedTextCard({ chatId, att, onDark = false }: { chatId: string; att: Attachment; onDark?: boolean }) {
  const t = useT();
  const key = `${chatId}:${att.file}`;
  const [preview, setPreview] = useState(() => pastedPreviews.get(key) ?? "");
  useEffect(() => {
    const cached = pastedPreviews.get(key);
    if (cached !== undefined) { setPreview(cached); return; }
    if (att.size > PASTE_FETCH_MAX) return;
    let alive = true;
    (async () => {
      try {
        const text = String(await api<string>(`/api/chats/${chatId}/attachments/${encodeURIComponent(att.file)}`)).slice(0, PASTE_PREVIEW_CHARS);
        pastedPreviews.set(key, text);
        if (alive) setPreview(text);
      } catch {
        /* The preview is an extra — the card stands without it. */
      }
    })();
    return () => { alive = false; };
  }, [key, chatId, att.file, att.size]);
  return (
    <span
      title={t("Pasted text ({size})", { size: fmtSize(att.size) })}
      className={`flex w-[186px] flex-col justify-between gap-2 rounded-xl border p-2.5 ${onDark ? "border-white/15 bg-white/5" : "border-edge bg-bg"}`}
    >
      <span className="line-clamp-5 min-h-[58px] whitespace-pre-wrap break-words text-[11px] leading-[1.35] opacity-70">
        {preview || t("Pasted text")}
      </span>
      <span className="flex items-center gap-1.5">
        <span className={`rounded-md border px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-[0.14em] ${onDark ? "border-white/25" : "border-edge text-dim"}`}>
          {t("Pasted")}
        </span>
        <span className="text-[10px] opacity-50">{fmtSize(att.size)}</span>
      </span>
    </span>
  );
}

// One row of the history is MEMOIZED (below) and deliberately outside ChatPane: while streaming, state replaces only
// the LAST bubble; without this guard every SSE event (every token, every tool call) would rebuild all rows — visible
// as flicker and height jumps in long chats. All props are stable or primitive: `b` changes only when this row changes,
// `onCopy`/`onAnswerAsk` are function declarations with unchanged identity, `t` is bound to the language via useT().
// Loading animation of the history — the SHAPE of a chat (user block, then answer lines) as calmly pulsing surfaces, in
// the same reading column with the same spacing. Deliberately no centred spinner: something already stands where text
// will appear, and the layout does not jump when the history arrives. Only visible on the FIRST open of a chat — after
// that the history is in the cache and switching needs no loading state.
function ChatSkeleton() {
  const t = useT();
  // Two hinted turns with lines of different length: uniform bars would look like a table, not a conversation.
  const turns = [["78%", "94%", "61%"], ["86%", "68%"]];
  return (
    <div className="flex flex-col gap-4" role="status" aria-label={t("Loading conversation")}>
      {turns.map((widths, turn) => (
        <div key={turn} className="flex flex-col gap-3">
          <div className="flex justify-end"><div className="h-9 w-2/5 animate-pulse rounded-[20px] bg-hover" /></div>
          <div className="flex flex-col gap-2">
            {widths.map((w, i) => (
              <div
                key={i}
                className="h-3 animate-pulse rounded bg-hover"
                // Staggered rhythm: the lines pulse as a wave instead of in lockstep.
                style={{ width: w, animationDelay: `${(turn * 3 + i) * 110}ms` }}
              />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

type RowsProps = {
  b: Bubble;
  index: number;
  chatId: string | null;
  /** Key of the bubble in the height memory (lib/bubbles-key.ts, by content): the blocks in it derive their keys from
      it instead of from `${chatId}:${index}` — otherwise the finished answer would inherit the height of the half-streamed one. */
  ck: string;
  copied: boolean;
  onCopy: (i: number, text: string) => void;
  onAnswerAsk: (requestId: string, answers: AskAnswer[]) => void;
  onDecideApproval: (requestId: string, behavior: "allow" | "deny", extras?: { updatedInput?: Record<string, unknown>; message?: string }) => void;
  /** The open approval of this row currently stands as a transient card above the input field. */
  liveApproval: boolean;
  /** The run is busy and this is the last assistant bubble — so its calls without a result are still RUNNING (without
      the flag that could not be known after a reload). */
  liveRun: boolean;
  /** Click on the subagent marker — opens the agent bar and selects this call. */
  onAgentOpen: (id: string) => void;
  /** Block id → state of the subagents, computed ONCE in the agent list. The marker in the history reads it from
      here instead of deriving it itself — otherwise marker and bar would say different things about the same agent. */
  agentStates: ReadonlyMap<string, AgentState | null>;
  t: (key: string, params?: Record<string, string | number>) => string;
};

// The memoization comparison: all props by identity like `memo` itself — except the state map. It is ONE map for the
// whole history and changes as soon as ANY agent changes its state; compared by identity that would redraw every row.
// A row reads only the states of its OWN calls (`bubblesKey`) — it redraws only when those change.
function sameRow(a: RowsProps, b: RowsProps): boolean {
  for (const k of Object.keys(a) as (keyof RowsProps)[]) {
    if (k === "agentStates") continue;
    if (!Object.is(a[k], b[k])) return false;
  }
  return bubblesKey(a.b.blocks, a.agentStates) === bubblesKey(b.b.blocks, b.agentStates);
}

const BubbleRow = memo(function BubbleRow({
  b, index, chatId, ck, copied, onCopy, onAnswerAsk, onDecideApproval, liveApproval, liveRun, onAgentOpen, agentStates, t,
}: RowsProps) {
  // Full-screen viewer for clicked images of this bubble (user attachments).
  const [lightbox, setLightbox] = useState<{ src: string; alt: string } | null>(null);
  // Plain text of this bubble (visible text blocks only) for copying and reading aloud.
  const text = b.blocks.map((bl) => (bl.kind === "text" ? bl.text : "")).filter(Boolean).join("\n\n");
  // Outputs visible: paths into this chat's output location become clickable in the text (components/chat/outputsStore.ts).
  const references = useOutputsReferences(chatId, text, t("Open in Outputs"));
  // Action bar under the message: copy + read aloud, permanently visible (not a copy button hidden in the corner that appears on hover).
  const actions = (dark: boolean) => (
    <MessageActions
      messageKey={`${chatId ?? ""}:${index}`}
      text={text}
      dark={dark}
      copied={copied}
      onCopy={() => onCopy(index, text)}
    />
  );

  return (
            <div className={`transition-opacity duration-200 ${b.dimmed ? "opacity-45" : ""}`}>
            {b.role === "clear" ? (
              // A boundary in the history like the compaction — the same building block.
              <SeparatorRow b={{ label: b.label ?? "Chat cleared up to here" }} icon={SYM.eraser} />
            ) : b.role === "divider" ? (
              // Three kinds (compaction with symbol, completion notice, hint) — ONE building block with the dock.
              <SeparatorRow b={b} icon={<CompressIcon />} />
            ) : b.role === "info" ? (
              <div className={CARD}>
                {b.label && <div className="mb-1.5 text-[12px] text-dim">{t(b.label)}</div>}
                <div className="min-w-0 text-fg">
                  <MarkdownReferenceContext.Provider value={references}><Markdown src={b.blocks.map((bl) => (bl.kind === "text" ? bl.text : "")).join("")} /></MarkdownReferenceContext.Provider>
                </div>
              </div>
            ) : b.role === "goal" ? (
              /* Verdict of the goal gate — like "Goal achieved" in the Claude Code CLI; a status line like any other (StatusLine.tsx). */
              <StatusLine data-event="target" icon={b.achieved ? SYM.checkMark : SYM.circle}
                header={b.achieved
                  ? t("Goal achieved") + ((b.turns ?? 0) > 0 ? ` (${b.turns} ${t((b.turns ?? 0) === 1 ? "Run" : "runs")})` : "")
                  : t("Goal still open") + (b.continuing ? ` · ${t("harness continuing")} (${b.continuing})` : "")}
                rest={b.label} />
            ) : b.role === "workflow" ? (
              /* Workflow driver: step header, branch verdict, question, end — status lines, so the flow stays readable in
                 the history. The state is in the word and the symbol, not in a colour. */
              (() => {
                const w = b.wf!;
                // `wrap` = the trailing text IS the content and must be fully readable (question, failure reason).
                // Otherwise the line deliberately stays single-line with "…" so the step sequence stays skimmable in the history.
                const line = (icon: React.ReactNode, head: string, tail?: string, wrap = false) => (
                  <StatusLine data-event="workflow" icon={icon} header={head} rest={tail} wrap={wrap} />
                );
                if (w.kind === "trigger") {
                  const head = w.source === "gitlab" ? t("Triggered by GitLab") : t("Triggered externally");
                  return (
                    <StatusLine data-event="trigger" icon={SYM.blitz} header={head}
                      rest={w.event?.summary && (w.event.url
                        ? <a href={w.event.url} target="_blank" rel="noreferrer" className="underline decoration-dotted hover:text-fg">{w.event.summary}</a>
                        : w.event.summary)} />
                  );
                }
                if (w.kind === "start") return line(SYM.arrow, t("Workflow “{name}” started", { name: w.name ?? "" }), w.total ? t("{n} steps", { n: w.total }) : undefined);
                if (w.kind === "step") {
                  const pos = w.total ? `${w.step}/${w.approx ? "ca. " : ""}${w.total}` : `${w.step}`;
                  const head = t("Step {pos}", { pos }) + (w.title ? `: ${w.title}` : "");
                  return line(SYM.arrow, head, w.loop ? t("Item {i}/{n}: {item}", { i: w.loop.index, n: w.loop.total, item: w.loop.item }) : undefined);
                }
                if (w.kind === "decision") return line(SYM.branch, (w.title ? `${w.title}: ` : "") + (w.yes ? t("Yes") : t("No")), w.note);
                if (w.kind === "loop") return line(SYM.loop, t("Loop {title}", { title: w.title ?? "" }), w.count ? t("{n} items", { n: w.count }) : t("nothing to do"));
                if (w.kind === "ask") return line(SYM.question, t("Question##ask"), w.text, true);
                // Review by the human: first the request, then a short line with the verdict.
                if (w.kind === "review") {
                  if (w.verdict === "ok") return line(SYM.person, t("Review approved"), w.note || w.title);
                  if (w.verdict === "issues") return line(SYM.person, t("Findings reported — back into fixing"), w.note || w.title);
                  const head = (w.round ?? 1) > 1
                    ? t("Review requested (round {n})", { n: w.round ?? 1 })
                    : t("Review requested");
                  // Do NOT repeat the instructions themselves: they stand as the agent's message right above — even
                  // formatted there. Here only what is to be done now.
                  return line(SYM.person, head, t("Your answer decides: “looks good” moves on, findings go back into the fix."));
                }
                if (w.kind === "skip") return line(SYM.jump, t("Step skipped"), w.title);
                // Round cap: first the question (the text IS the content → wrap), after "continue" the short
                // confirmation of how many rounds were added.
                if (w.kind === "cap") {
                  if (w.auto) return line(SYM.cap, t("Round cap: {title}", { title: w.title || "" }), w.note, true);
                  return w.granted
                    ? line(SYM.cap, t("{n} more rounds granted", { n: w.granted }), w.title)
                    : line(SYM.cap, t("Round cap: {title}", { title: w.title || "" }), w.text, true);
                }
                // Completion gate ("check completion"): done is a calm line, not done shows that the same step keeps
                // working — and with an open question the question text stands below as content.
                if (w.kind === "gate") {
                  if (w.done) return line(SYM.checkMark, t("Finished: {title}", { title: w.title || "" }), w.note);
                  if (w.text) return line(SYM.circle, t("Not finished yet: {title}", { title: w.title || "" }), w.text, true);
                  return line(SYM.circle, t("Not finished yet: {title} (round {r}/{n})", { title: w.title || "", r: w.round ?? 1, n: w.max ?? 0 }), w.note);
                }
                // A command BEFORE a node (/clear, /compact …) — not a step but preparation. Without a branch of its own
                // it would fall into the completion branch below and appear as "Workflow failed", although nothing is wrong.
                if (w.kind === "command") return line(SYM.command, t("Command {cmd} before \"{title}\"", { cmd: w.command ?? "", title: w.title ?? "" }), w.note);
                // Completion. Judge ONLY with a set status: an unknown block kind must not claim a failure (that is
                // how a `/clear` once looked like a crash).
                if (!w.status) return null;
                const done = w.status === "done";
                return line(done ? SYM.checkMark : SYM.circle,
                  done ? t("Workflow completed") : w.status === "cancelled" ? t("Workflow cancelled") : t("Workflow failed"),
                  w.note, !done);
              })()
            ) : b.role === "limit" ? (
              /* Usage limit: parked / resumed / discarded / gate — one status line (LimitStrip.tsx). */
              <LimitRow line={b.limit!} />
            ) : b.role === "monitor" ? (
              /* Monitor lifecycle — one status line like the goal gate. */
              <StatusLine data-event="monitor" icon={b.event === "done" ? SYM.checkMark : b.event === "fired" ? SYM.blitz : SYM.monitor}
                header={b.event === "done"
                  ? (b.status && b.status !== "completed" ? t("Monitor finished ({status})", { status: b.status }) : t("Monitor finished"))
                  : b.event === "fired" ? t("Monitor fired") : t("Monitor started")}
                rest={b.label} />
            ) : b.role === "ask" ? (
              /* Question from the agent: clickable answer options (cbase_ask). */
              b.ask ? (
                <AskCard
                  questions={b.ask.questions}
                  answers={b.ask.answers ?? null}
                  answerable={b.ask.answerable}
                  onSubmit={(answers) => onAnswerAsk(b.ask!.requestId, answers)}
                  answeredVia={b.ask.overChannel ? t("via channel “{name}” from {sender}", { name: b.ask.overChannel.name, sender: b.ask.overChannel.sender }) : null}
                />
              ) : null
            ) : b.role === "channel" ? (
              /* Message from a channel between chats. */
              b.channel ? <ChannelCard card={b.channel} /> : null
            ) : b.role === "message" ? (
              /* Message from an agent: a card instead of a user bubble. */
              b.message ? <AgentMessageCard message={b.message} /> : null
            ) : b.role === "approval" ? (
              /* Tool approval with its decision. An OPEN card that currently stands as the transient approval card
                 above the input field is not shown a second time here; after a reload (permReqs empty) the
                 history card is the only place where it can still be decided. */
              b.approval && !liveApproval
                ? <ApprovalCard card={b.approval} onDecide={(behavior, extras) => onDecideApproval(b.approval!.requestId, behavior, extras)} />
                : null
            ) : b.role === "workflow_approval" ? (
              /* Approval card of a dynamic workflow: Accept starts it, Reject tells the agent. */
              b.wfApproval ? <WorkflowApprovalCard card={b.wfApproval} chatId={chatId} /> : null
            ) : b.role === "capture" ? (
              /* Recording by an agent: screenshot/screen video, shown at the end of the turn. */
              b.capture && chatId ? <CaptureCard chatId={chatId} capture={b.capture} /> : null
            ) : b.role === "user" ? (
              /* The user message as a bubble on the RIGHT — the side carries the role, no dark box across the full
                 width and no "›". In the coding chat flat without an edge like ChatGPT (`cb-bubble`, globals.css).
                 Copy and read-aloud sit UNDER the bubble, not inside it. */
              <div className="flex flex-col items-end">
                <div className="cb-kit-pane cb-bubble max-w-[85%] min-w-0 rounded-[20px] px-4 py-2.5">
                  {chatId && (b.attachments?.length ?? 0) > 0 && (
                    <div className="mb-1.5 flex flex-wrap gap-1.5">
                      {b.attachments!.map((a, k) =>
                        a.mime.startsWith("image/") ? (
                          <img
                            key={k}
                            src={attUrl(chatId, a.file)}
                            alt={a.name}
                            title={a.name}
                            className="max-h-44 max-w-[220px] cursor-zoom-in rounded-xl object-cover"
                            // With `w`/`h` from the file header (server) the space is reserved BEFORE loading — the same fit
                            // as the classes (176 × 220 px, never enlarged); without dimensions the classes alone apply.
                            style={imageFrame(a.w, a.h, 176, "220px") ?? undefined}
                            onClick={() => setLightbox({ src: attUrl(chatId, a.file), alt: a.name })}
                          />
                        ) : isPastedText(a) ? (
                          <PastedTextCard key={k} chatId={chatId} att={a} />
                        ) : (
                          <span key={k} title={a.name} className="flex items-center gap-1.5 rounded-xl border border-edge bg-panel px-2.5 py-1.5 text-xs">
                            <FileIcon />
                            <span className="max-w-[180px] truncate">{a.name}</span>
                            <span className="opacity-60">{fmtSize(a.size)}</span>
                          </span>
                        ),
                      )}
                    </div>
                  )}
                  <div className="whitespace-pre-wrap break-words">{withSlashGlow(b.blocks.map((bl) => (bl.kind === "text" ? bl.text : "")).join(""))}</div>
                </div>
                {actions(false)}
              </div>
            ) : (
              /* Assistant flat: every line (answer, tool, error) starts at the SAME edge as the text — no dot, no
                 icon column in front. Below it the metrics line, then the actions. */
              <div className="group relative">
                <MarkdownReferenceContext.Provider value={references}>
                  <AssistantBlocks blocks={b.blocks} live={b.streaming === true || liveRun} ck={chatId ? ck : ""} onAgentOpen={onAgentOpen} agentStates={agentStates} />
                </MarkdownReferenceContext.Provider>
                {b.summary && <MetricRow summary={b.summary} />}
                {/* While the answer is still streaming in, the bar would be a moving target. */}
                {!b.streaming && actions(false)}
              </div>
            )}
            {lightbox && <ImageLightbox src={lightbox.src} alt={lightbox.alt} onClose={() => setLightbox(null)} />}
            </div>
  );
}, sameRow);
export { BubbleRow, ChatSkeleton, PASTE_PREVIEW_CHARS, PastedTextCard, isLargePaste, isPastedText, pastedFileName, pastedPreviews };
