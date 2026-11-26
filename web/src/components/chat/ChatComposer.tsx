"use client";

import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { api, type Attachment, type WorkflowMeta, type WorkflowRun } from "@/lib/api";
import type { UploadSource } from "@/lib/drop-files";
import { CbSendButton } from "@/components/CbSendButton";
import { SlashPalette } from "@/components/SlashPalette";
import { filterPalette, graphEntries, type PaletteEntry, placeSlash, slashMarkerLength, slashQuery, slashKey } from "@/lib/slash";
import { PastedTextCard, isLargePaste, isPastedText } from "@/components/chat/ChatBubbleRow";
import { CaretDown, CheckIcon, FileIcon, GaugeIcon, PlusIcon, ShieldIcon, XIcon } from "@/components/chat/ChatIcons";
import { PERM_MODES, SLASH_COMMANDS } from "@/components/chat/ChatCatalog";
import { EffortSlider } from "@/components/chat/EffortSlider";
import { type EffortCatalog, effortEntries, effortFallback, effortSupported, effortHint, effortLabel, effortMarker, effortWithoutSelection, effortWithoutSelectionText, effortPicker } from "@/lib/effort";
import { attUrl, fmtSize } from "@/lib/chat-format";
import { QuoteAnnotations } from "@/components/chat/ChatQuotes";
import { ModelSearchList, type ModelGroup } from "@/components/ModelChoice";
import { Toggle, menuRow } from "@/components/CbKit";

// The composer of the Coding chat: it SHOWS and EDITS: text field with glow overlay, slash palette, @ mentions, waiting
// attachments and the button row with attachment (plus), permission/model/effort pickers and send. What it does NOT do: send,
// create, upload, persist model/permissions/effort: `send`, `stop`, `addFiles`, `addPastedText` and the `pick*` handlers with
// their `current*` derivations stay in ChatPane and arrive as props (`runSlash`, the context bar, the agents bar and the
// provider-switch modal read them too). State that ONLY the composer sets and reads lives here; state that the stage or `send`
// touch (input, attachments, drop state, the pop flags for the global closer, the text field for focus from outside) stays in
// ChatPane and arrives with its setter. No context, no store: one prop list, one line per value. The PICKER GROUP (permission
// and effort pickers) is optional with defaults; ChatPane passes all of them (the gate test composer-contract.test.mjs counts
// them). A graph workflow starts via `/workflow:<shortName>` from the slash picker; the model starts it.
//
// The FORM: ONE large, round, opaque surface (`.cb-composer` in globals.css: one step above the ground, fine edge, no shadow,
// no glass, no accent border except while dragging files), the placeholder at the top (16 px, 24 px from the edge), the
// button row at the bottom INSIDE the field: on the left the bare plus (attachment, still a <label> with the input inside)
// and the permission mode as a ghost button with shield + dimmed word; on the right model + effort level as ONE trigger
// "<model> <level> ⌄" (two adjacent buttons, two menus, `data-pop` unchanged) and at the far right the round send button in
// the accent colour (`CbSendButton round`, during a run the same shape as stop). The bar under the field (context, compact,
// auto) belongs to ChatStage. Guards: web/test/composer-form.test.mjs (source), a DOM probe in a real browser (menus
// above the glass, images).
//
// What ChatPane triggers from outside on the composer: `clear()` from `send` (clear the field AND close the palette).
export type ChatComposerHandle = {
  clear(): void;
};

export type ChatComposerProps = {
  t: (key: string, params?: Record<string, string | number>) => string;
  hero: boolean; // the chat has no message yet (`empty` in ChatPane): autofocus, placeholder
  activeId: string | null;
  wsId: string; // workspace: file search of the mentions, workflow and skill list of the chat not yet created
  focusProjectId: string | null;
  input: string;
  setInput: React.Dispatch<React.SetStateAction<string>>;
  files: Attachment[];
  setFiles: React.Dispatch<React.SetStateAction<Attachment[]>>;
  quotes: string[]; // quotes from the history ("reply" on selected text): mark in the field, card above it (chat/ChatQuotes.tsx); they go out with `send` (lib/quotes.ts)
  setQuotes: React.Dispatch<React.SetStateAction<string[]>>;
  uploading: boolean;
  dragOver: boolean; // set by the stage's drop handlers
  busy: boolean;
  stopping: boolean;
  send: (preset?: string) => void | Promise<void>;
  stop: () => void | Promise<void>;
  addFiles: (source: UploadSource) => void | Promise<void>;
  addPastedText: (text: string) => void | Promise<void>; // a large paste becomes an attachment (isLargePaste)
  wfRun: WorkflowRun | null; // the chat's running workflow (placeholder): comes from the server, not from the picker
  taRef: React.RefObject<HTMLTextAreaElement | null>; // focused from outside (askAboutSelection, hero ideas)
  currentProvider: string;
  effectiveModel: string; // the EFFECTIVE model (an empty chat choice already resolved to the provider default): check marks and effort levels hang on it
  currentModelLabel: string;
  pickerProviders: { id: string; label: string; models: { id: string; label: string }[] }[]; // only CONNECTED providers; the effort levels come from `effortCatalog`, not from here
  providerDefault: (prov: string) => string;
  pickModel: (providerId: string, id: string) => Promise<unknown>; // the composer does not read the answer; ChatPane returns "applied"/"deferred" (for /model)
  modelPickerOpen: boolean;
  setModelPickerOpen: React.Dispatch<React.SetStateAction<boolean>>;
  // ── Picker group: permission and effort pickers. ChatPane passes all of them; the defaults say "nothing chosen". ──
  currentPerm?: string;
  currentPermLabel?: string;
  pickPerm?: (id: string) => Promise<void>;
  permPickerOpen?: boolean;
  setPermPickerOpen?: React.Dispatch<React.SetStateAction<boolean>>;
  currentEffort?: string;
  currentEffortLabel?: string;
  ultracode?: boolean; // ultracode: a toggle next to the level (independent of it), in the effort sheet below the slider
  setUltracode?: (on: boolean) => Promise<void>;
  effortCatalog?: EffortCatalog; // ALL providers (connected or not) with their `efforts`; the type lives in lib/effort.ts so the value is not lost silently
  pickEffort?: (id: string) => Promise<void>;
  effortPickerOpen?: boolean;
  setEffortPickerOpen?: React.Dispatch<React.SetStateAction<boolean>>;
};

// Defaults of the optional props, at module level so their identity is stable across renders.
const noSetter = () => {}; // setter of the picker group if a caller does not pass it (ChatPane passes all)
const noPick = async () => {};
const noUltracode = async () => {};
const noCatalog: EffortCatalog = []; // without a catalog the five default levels apply (lib/effort.ts)

export const ChatComposer = forwardRef<ChatComposerHandle, ChatComposerProps>(function ChatComposer(props, ref) {
  const {
    t, hero, activeId, wsId, focusProjectId, input, setInput, files, setFiles, quotes, setQuotes, uploading, dragOver,
    busy, stopping, send, stop, addFiles, addPastedText, wfRun, taRef,
    currentProvider, effectiveModel, currentModelLabel, pickerProviders, providerDefault, pickModel, modelPickerOpen, setModelPickerOpen,
    // Picker group: without a value, "none chosen, none open" applies.
    currentPerm = "", currentPermLabel = "", pickPerm = noPick, permPickerOpen = false, setPermPickerOpen = noSetter,
    currentEffort = "", currentEffortLabel = "", ultracode = false, setUltracode = noUltracode, effortCatalog = noCatalog, pickEffort = noPick, effortPickerOpen = false, setEffortPickerOpen = noSetter,
  } = props;
  // As in ChatPane: the loaders read the chat id from a ref so their identity depends only on the workspace and focus project.
  const activeIdRef = useRef<string | null>(null);
  activeIdRef.current = activeId;
  // Highlight overlay behind the (transparent) textarea: renders the same text but highlights the leading "/command", skill or
  // workflow (`slashMarker`, everything from the picker's stock, not only the commands). Scroll is synced with the textarea.
  const highlightRef = useRef<HTMLDivElement>(null);
  // @ file mentions: recognised @token before the cursor + hit list (files in the workspace).
  const [mention, setMention] = useState<{ query: string; start: number } | null>(null);
  const [mentionItems, setMentionItems] = useState<string[]>([]);
  const [mentionIdx, setMentionIdx] = useState(0);
  const mentionTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // Slash picker: the search after the leading "/" (null = closed), the highlighted entry and this chat's skills. The commands
  // live in the module (SLASH_COMMANDS), the skills come from the server; which set applies is decided by the chat's scope,
  // not by the client.
  const [slashQ, setSlashQ] = useState<string | null>(null);
  const [slashIdx, setSlashIdx] = useState(0);
  const [skillList, setSkillList] = useState<{ name: string; description: string; originProject?: string }[]>([]);
  // This chat's graph workflows for the slash picker's workflow group, each entry with the `shortName` the server computes over
  // the effective set; the client never computes it itself.
  const [graphList, setGraphList] = useState<WorkflowMeta[]>([]);
  // Search and accordion of the model picker live in the shared component (`ModelSearchList`); it is rebuilt on every open, so
  // the search is empty and the chat's provider is open (`startGroup`).
  const pickerContentRef = useRef<HTMLDivElement>(null); // measures the content height for the smooth size animation
  const [pickerAnimH, setPickerAnimH] = useState<number | null>(null);
  // Width of the composer's control row → how much label the pickers carry. MEASURED, because the row grows and shrinks with the
  // window, chat list and right sidebar; a media query on the window width would simply be wrong with the sidebar open.
  // Why no container query (@container): it would bring `container-type: inline-size` and with it layout containment; the
  // pickers' `fixed inset-0` click catchers would then attach to the container instead of the window, and the pickers could no
  // longer be closed by clicking elsewhere.
  const barRef = useRef<HTMLDivElement | null>(null);
  const [barW, setBarW] = useState(9999); // until the first measurement: show everything
  useEffect(() => {
    const el = barRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const w = Math.round(entries[0]?.contentRect.width ?? 0);
      if (w > 0) setBarW((cur) => (Math.abs(cur - w) > 1 ? w : cur));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  // Breakpoints (measured on the full row). No "Effort:" prefix: the level sits right behind the model, the position says it.
  const barValues = barW >= 600; // the values (the level, "Auto", "Visible", …); below that only the icons
  const barPerm = barW >= 520;   // the permission level as a word next to the shield

  // @ mention: with an active @token, load the matching workspace files (debounced).
  useEffect(() => {
    if (!mention) { setMentionItems([]); return; }
    clearTimeout(mentionTimer.current);
    mentionTimer.current = setTimeout(() => {
      api<{ results: string[] }>(`/api/workspaces/${wsId}/file-search?q=${encodeURIComponent(mention.query)}`).then((r) => r.results || [])
        .then((items) => { setMentionItems(items); setMentionIdx(0); })
        .catch(() => setMentionItems([]));
    }, 160);
    return () => clearTimeout(mentionTimer.current);
  }, [mention, wsId]);

  // The graph workflows selectable in the chat, for the slash picker's workflow group (scope of the chat or, while it does not
  // exist yet, of the workspace/project). Called on EVERY opening of the palette (`updateSlash`), never on chat switch: otherwise
  // a newly created one would be missing, and a deleted or renamed one would be rejected by the server as an unknown name.
  const loadGraphList = useCallback(async () => {
    const id = activeIdRef.current;
    try {
      setGraphList(id
        ? await api<WorkflowMeta[]>(`/api/chats/${id}/workflows`)
        : await api<WorkflowMeta[]>(`/api/workspaces/${wsId}/effective-workflows?projectId=${focusProjectId ?? ""}`));
    } catch { setGraphList([]); }
  }, [wsId, focusProjectId]);
  // This chat's skills for the picker. As with the workflows: an existing chat is asked via the chat route, one not yet created
  // via the workspace route with the focus project; the picker is already available in the empty chat, which is only created on
  // send.
  const loadSkillList = useCallback(async () => {
    const id = activeIdRef.current;
    try {
      setSkillList(id
        ? await api<{ name: string; description: string; originProject?: string }[]>(`/api/chats/${id}/skills`)
        : await api<{ name: string; description: string; originProject?: string }[]>(`/api/workspaces/${wsId}/effective-skills?projectId=${focusProjectId ?? ""}`));
    } catch { setSkillList([]); }
  }, [wsId, focusProjectId]);
  useEffect(() => { loadSkillList(); }, [activeId, loadSkillList]);
  // @ mention: detect the @token directly before the cursor (up to whitespace).
  function updateMention(value: string, caret: number) {
    const before = value.slice(0, caret);
    const mm = before.match(/(?:^|\s)@([^\s@]*)$/);
    if (mm) setMention({ query: mm[1], start: caret - mm[1].length - 1 });
    else { setMention(null); setMentionItems([]); }
  }
  // Insert the chosen file as @path into the text and place the cursor behind it.
  function insertMention(p: string) {
    if (!mention) return;
    const caretAfter = mention.start + 1 + mention.query.length;
    const next = input.slice(0, mention.start) + "@" + p + " " + input.slice(caretAfter);
    setInput(next);
    setMention(null);
    setMentionItems([]);
    const pos = mention.start + 1 + p.length + 1;
    requestAnimationFrame(() => { const ta = taRef.current; if (ta) { ta.focus(); ta.setSelectionRange(pos, pos); } });
  }

  // The slash picker's stock: first the commands, then the skills, then the graph workflows as `workflow:<shortName>`. The order
  // is the point: commands are always the same few, skills can be many and differ per workspace; if they came first, the
  // commands would move around in every workspace.
  const slashStock = useMemo<PaletteEntry[]>(() => [
    ...SLASH_COMMANDS.map((b) => ({ name: b.name, arg: b.arg, description: t(b.description), group: "command" as const })),
    ...skillList.map((sk) => ({
      name: sk.name,
      // A skill WITHOUT a description is possible (the field may be empty): then the text says what is true, instead of an
      // empty surface that looks like a load error.
      description: sk.description || t("This skill has no description."),
      group: "skill" as const,
      origin: sk.originProject || undefined,
    })),
    // `/workflow:<shortName> ` is inserted; the row shows the real name and the origin (lib/slash.ts:graphEntries).
    ...graphEntries(graphList, t("This workflow has no description.")),
  ], [skillList, graphList, t]);
  const slashItems = useMemo(
    () => (slashQ === null ? [] : filterPalette(slashStock, slashQ)),
    [slashQ, slashStock],
  );
  // The mark in the overlay: the same names as the picker; while the name is being typed (palette open), a prefix is enough.
  // While quotes wait, the message is no command (see `slashOpen`), so no mark.
  const slashNames = useMemo(() => slashStock.map((e) => e.name), [slashStock]);
  const slashMarker = quotes.length > 0 ? 0 : slashMarkerLength(input, slashNames, slashQ !== null);
  // While quotes wait, the message is no command: on send it starts with "> " (lib/quotes.ts), and a "/goal" behind it would go
  // out as text. The palette then offers nothing, and Enter sends.
  const slashOpen = slashQ !== null && quotes.length === 0;
  const mentionOpen = mention !== null && mentionItems.length > 0;
  // Empty means nothing to send: no text, no attachment, no quote (a quote alone goes out as a message).
  const nothingToSend = !input.trim() && files.length === 0 && quotes.length === 0;

  // The effort choice of this chat: the levels ITS model supports according to the catalog (`efforts` from /api/providers), plus,
  // marked, the set level if the model does not list it. The "Auto" row ('' = no default, the CLI decides) is no level and
  // therefore sits before the list. Without catalog data the five default levels remain (see lib/effort.ts). Entries, label and
  // mark come from the ONE building block `effortEntries`, the same list as in the workflow settings; only the word of the empty
  // entry is given by each place itself.
  //
  // The EFFECTIVE model is used, not the raw chat setting: a new chat and every old chat without its own choice carry '' there,
  // and '' is in no catalog, so the choice would fall back to the five default levels in exactly the most common case (e.g.
  // default model gpt-5.5: the pill shows "GPT-5.5", the picker offers "Max", the chat is created with effort=max, and every turn
  // silently thinks with the CLI default). If the model carries NO levels according to the catalog (Haiku 4.5) or the provider
  // has `caps.effort` off, there is no picker: a level there fizzles silently on the wire, and the server does not even send it.
  // A MISSING `efforts` is "unknown" and keeps showing the default levels. The decision lives ONCE in the building block
  // (`effortPicker`, lib/effort.ts).
  const effortNone = !effortPicker(currentProvider, effectiveModel, effortCatalog);
  // The slider carries ONLY the levels. Ultracode is a separate toggle below it (kit `Toggle`), independent of the level, so
  // the button ALWAYS shows: even a model without levels (Haiku 4.5) can carry ultracode; there the sheet shows the sentence
  // saying why there is nothing to choose instead of the slider.
  const effortChoice = useMemo(
    () => (effortNone ? [] : effortEntries(currentProvider, effectiveModel, effortCatalog, currentEffort, null, t)),
    [effortNone, currentProvider, effectiveModel, effortCatalog, currentEffort, t],
  );
  const effortWithoutReason = effortWithoutSelection(currentProvider, effectiveModel, effortCatalog);
  // Does the model support the SET level? The answer belongs on the collapsed button, not only in the opened picker: otherwise
  // only someone who is about to change something sees the mark. Without levels there is nothing to support; the button only
  // stands for the ultracode toggle there.
  const effortOk = effortNone || effortSupported(currentProvider, effectiveModel, effortCatalog, currentEffort);
  // The word on the button: the level and, when on, "Ultracode" behind it: two axes, both visible.
  const effortButtonText = [effortNone ? "" : currentEffortLabel.replace("Effort: ", ""), ultracode ? "Ultracode" : ""].filter(Boolean).join(" · ") || t("Effort");
  // … and the button also says WHAT thinks instead. The clamp at spawn no longer drops an unsupported level but raises it to the
  // highest the model supports (`codexEffortFallback`/`mapClaudeEffort`). A description side that says something different from
  // what the execution side does is worse than none. Wording and mark come from `effortHint`/`effortMarker`: with Claude the CLI
  // rejects the level, otherwise the model, and the sentence names the right one (see lib/effort.ts).
  const effortFallbackLabel = effortLabel(effortFallback(currentProvider, effectiveModel, effortCatalog, currentEffort));
  // Detect the leading "/word" (see slashQuery) and open or close the picker.
  //
  // On OPENING the skill list is fetched fresh, and that is not cosmetic: measured, the Claude CLI answers an unknown "/name"
  // with "Unknown command: /name" and swallows the WHOLE rest of the message (num_turns 0). A picker offering a skill that has
  // since been deleted would not just be inaccurate; it would let a fully typed message run into nothing.
  function updateSlash(value: string, caret: number) {
    const q = slashQuery(value, caret);
    if (q !== null && slashQ === null) {
      loadSkillList();
      // Same for the graph workflows.
      loadGraphList();
    }
    setSlashQ(q);
    if (q !== null) setSlashIdx(0);
  }
  // Insert the chosen entry. Commands with an argument get a trailing space (something follows), argument-less commands and
  // skills too: only that way can a task still be added behind a skill without touching the name again.
  function insertSlash(e: PaletteEntry) {
    const { text, caret } = placeSlash(input, slashQ, e.name);
    setInput(text);
    setSlashQ(null);
    requestAnimationFrame(() => { const ta = taRef.current; if (ta) { ta.focus(); ta.setSelectionRange(caret, caret); } });
  }
  // Clear the field AND close the palette. Closing only on keyup is not enough (onSelect then sees mark 0 on empty text): while
  // the key is held, or if no keyup reaches the field, the palette would stay open above the empty field.
  function composerClear() {
    setInput("");
    setSlashQ(null);
    setSlashIdx(0);
  }

  // Upward-opening composer pickers (permission/model/effort): compute the maximum height on open from the space available above
  // the button. The upper bound is the STRICTER of the header's lower edge and the nearest overflow ancestor, which CLIPS absolute
  // children (otherwise the topmost pixels of the card are cut off instead of merely limited).
  const [pickerMaxH, setPickerMaxH] = useState(320);
  const openUpPicker = (e: React.MouseEvent, setOpen: React.Dispatch<React.SetStateAction<boolean>>) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    let bound = document.querySelector("header")?.getBoundingClientRect().bottom ?? 0;
    for (let el = (e.currentTarget as HTMLElement).parentElement; el; el = el.parentElement) {
      const o = getComputedStyle(el).overflowY;
      if (o === "auto" || o === "scroll" || o === "hidden") { bound = Math.max(bound, el.getBoundingClientRect().top); break; }
    }
    setPickerMaxH(Math.max(80, Math.min(360, r.top - bound - 16)));
    setOpen((v) => !v);
  };
  // Model picker: measure the content height and animate the scroll area smoothly to it (accordion/search change the height).
  // ResizeObserver catches every content change; capped at maxScroll.
  useEffect(() => {
    if (!modelPickerOpen) { setPickerAnimH(null); return; }
    const el = pickerContentRef.current;
    if (!el) return;
    const maxScroll = Math.max(80, pickerMaxH - 48); // minus the search bar
    const measure = () => setPickerAnimH(Math.min(el.scrollHeight, maxScroll));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [modelPickerOpen, pickerMaxH]);

  useImperativeHandle(ref, () => ({
    clear() { composerClear(); },
  }));

  // Box and font of the text field AND its glow layer: ONE value for both, otherwise the glyphs do not line up (composer-form.test.mjs
  // holds that). The text starts 24 px from the edge (form 10 + field 14). Same font as the history, 15.5 px like `.cb-chat-text`
  // in globals.css, and flat: ONE line high in a running chat, three in the hero. The text size from Settings → Appearance is
  // injected into EVERY size, this one too, by the plugin web/postcss-text-scale.cjs.
  const fieldBox = `max-h-[34vh] ${hero ? "min-h-[72px]" : "min-h-[40px]"} px-3.5 pb-1 pt-2 text-[15.5px] leading-[1.5]`;
  // Model and level are ONE trigger "<model> <level> ⌄": two adjacent buttons, each with its own menu (`data-pop="model"` /
  // `"effort"`, the click catcher in ChatPane knows both). The level button carries the one chevron; it always shows (the
  // ultracode toggle lives in its sheet, even on a model without levels).

  // The input field. It ALWAYS sits at the bottom, even in the empty chat (`hero` only means the chat has no message yet), so it
  // does not jump from the page centre to the bottom on the first send; that movement means nothing. No monospace, no "›".
  //
  // The form: ONE large, round, opaque surface (`.cb-composer` in globals.css: one step above the ground, fine edge, no shadow,
  // no glass), the placeholder at the top, the button row at the bottom INSIDE the field. On the left the bare plus (attachment)
  // and the permission mode as a ghost button with icon + dimmed word; on the right model + level as ONE trigger and at the far
  // right the round send button in the accent colour (during a run the same shape as stop). The bar under the field (context,
  // compact, auto) belongs to ChatStage.
  return (
    <form
      // z-[1]: the field sits OVER the docked strips; they are deliberately pushed a bit below it and vanish there (under an
      // opaque surface, not glass).
      // `@container/composer`: the slash picker puts its description next to the list or below it, depending on the width of the
      // COMPOSER. A window query would be wrong here: the same view is 1,400 px wide alone and 940 next to the chat list, in the
      // same window.
      // `data-drag`: files over the field; the only state with an accent edge (globals.css).
      data-drag={dragOver ? "1" : undefined}
      className="cb-composer @container/composer relative z-[1] mb-1.5 flex w-full flex-col rounded-[24px] px-2.5 pb-2 pt-1.5 transition-colors"
      onSubmit={(e) => {
        e.preventDefault();
        send();
      }}
    >
      {/* Slash picker: commands, skills and (in the Coding chat) graph workflows of this chat, above the composer. It and the
          @ mention list cannot get in each other's way: one needs a "/" at the very start, the other an "@" after whitespace. */}
      {slashOpen && (
        <SlashPalette
          entries={slashItems}
          idx={slashIdx}
          onIdx={setSlashIdx}
          onChoice={insertSlash}
          titleCommands={t("Commands")}
          titleSkills={t("Skills")}
          titleWorkflows={t("Workflows")}
          emptyText={t("No command and no skill matches.")}
          identifier="chat"
        />
      )}
      {/* @ mention suggestions (workspace files), above the composer */}
      {mention && mentionItems.length > 0 && (
        <div className="cb-pop-in-fast cb-pop absolute bottom-full left-0 right-0 z-40 mb-1.5 max-h-[240px] origin-bottom overflow-y-auto rounded-2xl p-1.5">
          {mentionItems.map((it, i) => (
            <button
              key={it}
              type="button"
              onMouseDown={(e) => { e.preventDefault(); insertMention(it); }}
              className={`${menuRow} font-mono text-[12px] ${i === mentionIdx ? "bg-accent text-white" : ""}`}
            >
              <span className="min-w-0 flex-1 truncate">{it}</span>
            </button>
          ))}
        </div>
      )}
      {/* Quotes from the history ("reply"): the mark "1 comment" here in the field, the card above it (anchored to the <form>
          like the @ list). */}
      {quotes.length > 0 && <QuoteAnnotations t={t} quotes={quotes} setQuotes={setQuotes} obscured={slashOpen || mentionOpen} />}
      {/* Waiting attachments (removable before sending) */}
      {files.length > 0 && activeId && (
        <div className="flex flex-wrap gap-2 px-2 pt-1.5">
          {files.map((f, i) => (
            <span key={f.file} className="group relative">
              {f.mime.startsWith("image/") ? (
                <img src={attUrl(activeId, f.file)} alt={f.name} title={f.name} className="h-14 w-14 rounded-lg object-cover" />
              ) : isPastedText(f) ? (
                <PastedTextCard chatId={activeId} att={f} onDark={false} />
              ) : (
                <span className="flex h-14 max-w-[200px] items-center gap-1.5 rounded-lg bg-bg px-2.5 text-xs" title={f.name}>
                  <FileIcon />
                  <span className="min-w-0">
                    <span className="block max-w-[150px] truncate font-medium">{f.name}</span>
                    <span className="text-dim">{fmtSize(f.size)}</span>
                  </span>
                </span>
              )}
              <button
                type="button"
                title={t("Remove")}
                onClick={() => setFiles((prev) => prev.filter((_, j) => j !== i))}
                className="absolute -right-1.5 -top-1.5 hidden h-4.5 w-4.5 place-items-center rounded-full bg-dark text-white group-hover:grid"
              >
                <XIcon />
              </button>
            </span>
          ))}
        </div>
      )}
      {/* Text field, below it the button row, both INSIDE the one surface. */}
      <div className="relative min-w-0">
      {/* Glow overlay: identical box and typography as the text field (`fieldBox`), so the glyphs line up. The field itself is
          text-transparent. Any change to size, line height, padding or font family applies to BOTH via `fieldBox`. */}
      <div
        ref={highlightRef}
        aria-hidden
        className={`pointer-events-none absolute inset-0 overflow-hidden whitespace-pre-wrap break-words ${fieldBox} text-fg`}
      >
        {slashMarker > 0 ? (
          <>
            <span className="cb-slash-marker" data-slash-marker>{input.slice(0, slashMarker)}</span>
            {input.slice(slashMarker)}
          </>
        ) : input}
        {/* Trailing breakpoint: render an empty last line (text ends in \n) at the correct height. */}
        {"​"}
      </div>
      <textarea
        ref={taRef}
        value={input}
        autoFocus={hero}
        style={{ caretColor: "var(--color-fg)" }}
        onScroll={(e) => { const el = highlightRef.current; if (el) { el.scrollTop = e.currentTarget.scrollTop; el.scrollLeft = e.currentTarget.scrollLeft; } }}
        onChange={(e) => {
          const caret = e.target.selectionStart ?? e.target.value.length;
          setInput(e.target.value);
          updateMention(e.target.value, caret);
          updateSlash(e.target.value, caret);
        }}
        // Clicking and arrow keys also move the caret: if it leaves (or re-enters) the "/word", the picker must notice, otherwise it
        // would stay open over text that is no longer a command.
        onSelect={(e) => updateSlash(e.currentTarget.value, e.currentTarget.selectionStart ?? 0)}
        onKeyDown={(e) => {
          // With the slash picker open, it intercepts the navigation and selection keys. It comes before the mention list because it
          // is only open with a "/" at the VERY start, where no mention can run; the order must still be fixed.
          if (slashOpen) {
            // The rule itself lives in lib/slash.ts (slashKey), checked in the gate and the same for both composers. Here only what
            // the actions do.
            const action = slashKey({ key: e.key, shiftKey: e.shiftKey, hits: slashItems.length });
            if (action) {
              e.preventDefault();
              const hits = slashItems[Math.min(slashIdx, slashItems.length - 1)];
              if (action === "close") setSlashQ(null);
              else if (action === "down") setSlashIdx((i) => (i + 1) % slashItems.length);
              else if (action === "up") setSlashIdx((i) => (i - 1 + slashItems.length) % slashItems.length);
              else if (action === "place") insertSlash(hits);
              else {
                // Enter: insert and send in the same step. The completed text goes along as an argument because `input` only
                // catches up after this handler; it still goes into the field, so if sending is aborted the full name is there,
                // not "/rel".
                const { text } = placeSlash(input, slashQ, hits.name);
                setInput(text);
                setSlashQ(null);
                send(text);
              }
              return;
            }
          }
          // With the @ mention list open, it intercepts the navigation/selection keys.
          if (mention && mentionItems.length > 0) {
            if (e.key === "ArrowDown") { e.preventDefault(); setMentionIdx((i) => Math.min(i + 1, mentionItems.length - 1)); return; }
            if (e.key === "ArrowUp") { e.preventDefault(); setMentionIdx((i) => Math.max(i - 1, 0)); return; }
            if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); insertMention(mentionItems[mentionIdx]); return; }
            if (e.key === "Escape") { e.preventDefault(); setMention(null); setMentionItems([]); return; }
          }
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            send();
          }
        }}
        onBlur={() => { setTimeout(() => { setMention(null); setMentionItems([]); setSlashQ(null); }, 120); }}
        onPaste={(e) => {
          if (e.clipboardData?.files?.length) {
            e.preventDefault();
            addFiles(e.clipboardData.files);
            return;
          }
          // Large text blocks become an attachment instead of a prompt wall (see isLargePaste).
          const pasted = e.clipboardData?.getData("text/plain") ?? "";
          if (isLargePaste(pasted)) {
            e.preventDefault();
            addPastedText(pasted);
          }
        }}
        placeholder={
          wfRun?.status === "waiting"
            ? wfRun.pending === "review"
              ? t("Your verdict: “looks good” — or the findings to fix…")
              : t("Answer to the workflow's question…")
            : hero ? t("How can I help you today?") : t("Message…")
        }
        className={`relative w-full field-sizing-content resize-none bg-transparent ${fieldBox} text-transparent outline-none placeholder:text-dim disabled:opacity-60`}
      />
      </div>
      {/* The button row INSIDE the field (attachment, permissions | model + level, send).
          ONE line: it used to be flex-wrap, and already at ~650 px row width the whole right group slid below the icons. Instead of
          wrapping, the buttons give up their labels in steps (barValues/barPerm) and stay as icons. Only below 430 px, narrower than
          any sensible window, may it still wrap so that nothing sticks out of the window. All buttons are ghost buttons (no border,
          no surface, a faint one on hover) except the round send button. */}
      <div ref={barRef} data-composer-row className={`flex items-center gap-x-1 pt-0.5 ${barW < 430 ? "flex-wrap gap-y-1" : ""}`}>
        {/* Left group (attachment, permissions) and right group (model + level, send). The left one does not shrink. */}
        <div className="flex shrink-0 items-center gap-0.5">
        {/* Attachment as a bare plus: <label> with the field INSIDE, no button with input.click(); same reason as the artifact
            upload (the programmatic click did not open a dialog). */}
        <label
          data-composer-attachment
          title={t("Attach files (all types: images, PDFs, code, …)")}
          aria-label={t("Attach files (all types: images, PDFs, code, …)")}
          className={`relative grid h-9 w-9 shrink-0 place-items-center rounded-full text-fg transition-colors ${uploading ? "pointer-events-none opacity-35" : "cursor-pointer hover:bg-hover"}`}
        >
          <PlusIcon />
          <input
            type="file"
            multiple
            disabled={uploading}
            className="absolute h-px w-px overflow-hidden opacity-0"
            onChange={(e) => {
              if (e.target.files?.length) addFiles(e.target.files);
              e.target.value = "";
            }}
          />
        </label>
        {/* Permission mode (opens upward). Also with Codex, where it maps to the sandbox instead of interactive questions (see the
            Codex connector). On the left as a ghost button with shield + dimmed word; below 520 px only the shield. */}
        <div className="relative" data-pop="permissions">
          <button
            type="button"
            onClick={(e) => openUpPicker(e, setPermPickerOpen)}
            title={t("Permission mode for this chat")}
            aria-label={t(currentPermLabel)}
            className={`flex h-9 shrink-0 items-center gap-1.5 rounded-full text-[13px] text-dim transition-colors hover:bg-hover hover:text-fg ${barPerm ? "pl-2.5 pr-3" : "w-9 justify-center"}`}
          >
            <ShieldIcon />
            {barPerm && t(currentPermLabel)}
          </button>
          {permPickerOpen && (
            <>
              <div style={{ maxHeight: pickerMaxH }} className="cb-pop-in-fast cb-pop absolute bottom-full left-0 z-40 mb-1.5 w-[260px] origin-bottom-left overflow-y-auto rounded-2xl p-1.5">
                {PERM_MODES.map((mo) => {
                  const hint = currentProvider === "codex" && mo.codexHint ? mo.codexHint : mo.hint;
                  return (
                  <button
                    key={mo.id}
                    type="button"
                    title={t(hint)}
                    onClick={() => pickPerm(mo.id)}
                    className={`${menuRow} ${
                      currentPerm === mo.id ? "font-medium" : ""
                    }`}
                  >
                    <span className="block min-w-0 flex-1">
                      <span className="flex w-full items-center text-[13px]">
                        {t(mo.label)}
                        {currentPerm === mo.id && <span className="ml-auto text-dim"><CheckIcon /></span>}
                      </span>
                      <span className="block text-[11px] font-normal text-dim">{t(hint)}</span>
                    </span>
                  </button>
                  );
                })}
              </div>
            </>
          )}
        </div>
        </div>
        <div className="ml-auto flex min-w-0 items-center justify-end gap-x-1">
        {/* Model + level: ONE trigger "<model> <level> ⌄" made of two adjacent buttons. */}
        {/* Model + level share ONE hover surface (on the wrapper, not per button), so the padding left and right of the pill is
            even: 12 px left (model) and 10 px + chevron right (level); the menus stay per button. */}
        <div className="flex min-w-0 items-center rounded-full transition-colors hover:bg-hover" data-composer-model-level>
        {/* Model choice (opens upward) */}
        <div className="relative min-w-0" data-pop="model">
          <button
            type="button"
            onClick={(e) => openUpPicker(e, setModelPickerOpen)}
            title={t("Model for this chat")}
            className={"flex h-9 min-w-0 items-center gap-1 rounded-full pl-3 pr-1 text-[13px] font-medium text-fg"}
          >
            {/* The model is the ONLY picker that always keeps its label: it is the chat's identity. Long names (e.g.
                "claude-sonnet-5") are truncated, not wrapped. */}
            <span className="min-w-0 max-w-[9rem] truncate">{t(currentModelLabel)}</span>
          </button>
          {modelPickerOpen && (() => {
            // Many models per provider → search + accordion (only the chat's provider open), via the shared component
            // (components/ModelChoice.tsx), because OpenRouter carries the whole catalog with tools. The set value is appended at the
            // end of its group when the list does not carry it (same move as on mobile, Chat/ChatSheets.swift): `/api/providers`
            // omits the models the signed-in account cannot run (gpt-5.4 and gpt-5.4-mini need an API key); a chat on one of them
            // would otherwise show a check mark on NO model, as if it were on nothing. The client does not know why it is missing, so
            // the marker only says THAT it is missing (`missing`); the server gives the reason on saving. Same RULE as in
            // `DefaultModelRow` (settings/ProviderSettings.tsx), where the value sits above the list; shared are the sentence "a value
            // without an option appears in the list itself" and the component. If the provider itself is not in the list (not
            // connected, or the list is not loaded yet), there is nothing to report: an unloaded list does not mean "does not
            // exist" (`pickerProviders` carries the constant fallback before the first answer).
            const models = (pv: { id: string; models: { id: string; label: string }[] }) =>
              pv.id === currentProvider && effectiveModel && !pv.models.some((mo) => mo.id === effectiveModel)
                ? [...pv.models, { id: effectiveModel, label: currentModelLabel, missing: true }]
                : pv.models;
            // The value of a row is `provider::model`: the same model id can exist at two providers, and the check mark belongs only
            // to the chat's row.
            const groups: ModelGroup[] = pickerProviders.map((pv) => ({
              key: pv.id,
              label: pv.label,
              options: models(pv).map((mo) => {
                const missing = "missing" in mo && mo.missing;
                return {
                  value: `${pv.id}::${mo.id}`,
                  label: mo.label,
                  warn: missing,
                  markers: [...(missing ? [t("unavailable")] : []), ...(mo.id === providerDefault(pv.id) ? [t("Default")] : [])],
                  title: missing ? t("This chat is set to a model the provider no longer offers — the server names the reason when you save.") : undefined,
                };
              }),
            }));
            return (
              // overflow-hidden on the rounded frame clips the scrollbar at the corners (otherwise square on the right).
              // cb-pop-in-fast: fast fade-in from the trigger corner; height is animated smoothly.
              <div className="cb-pop-in-fast cb-pop absolute bottom-full right-0 z-40 mb-1.5 flex w-[272px] origin-bottom-right flex-col overflow-hidden rounded-2xl">
                <ModelSearchList
                  groups={groups}
                  value={`${currentProvider}::${effectiveModel}`}
                  startGroup={currentProvider}
                  onChoice={(o, g) => { if (g) pickModel(g.key, o.value.slice(g.key.length + 2)); }}
                  onEscape={() => setModelPickerOpen(false)}
                  scrollClass="cb-anim-height transition-[height] duration-200 ease-[cubic-bezier(0.22,1,0.36,1)]"
                  scrollStyle={{ height: pickerAnimH ?? undefined, maxHeight: Math.max(80, pickerMaxH - 48) }}
                  contentRef={pickerContentRef}
                  large
                />
              </div>
            );
          })()}
        </div>
        {/* Effort choice (the second half of the trigger "<model> <level> ⌄", opens upward). The level word sits dimmed behind the
            model, without an "Effort:" prefix; the position says it; below 600 px the gauge icon remains. If the model does NOT
            support the set level, the collapsed button already says so: warning colour instead of grey and a "!" behind the value
            (the button is narrow; at the tightest breakpoint only the icon's colour remains). The full sentence is in the tooltip
            and the aria-label. */}
        <div className="relative" data-pop="effort">
          <button
            type="button"
            onClick={(e) => openUpPicker(e, setEffortPickerOpen)}
            title={effortOk
              ? `${t("Reasoning effort for this chat")} — ${currentEffortLabel}`
              : t(effortHint(currentProvider), { effort: effortLabel(currentEffort), fallback: effortFallbackLabel })}
            aria-label={effortOk ? currentEffortLabel : `${currentEffortLabel} — ${t(effortMarker(currentProvider))}`}
            className={`flex h-9 shrink-0 items-center gap-1 rounded-full pl-1 pr-2.5 text-[13px] transition-colors ${effortOk ? "text-dim hover:text-fg" : "text-warn hover:text-warn"}`}
          >
            {barValues
              ? <span>{effortButtonText}{effortOk ? "" : " !"}</span>
              : <GaugeIcon />}
            <CaretDown />
          </button>
          {effortPickerOpen && (
            // A SLIDER instead of the list (chat/EffortSlider.tsx). The steps are the same entries as in the list (`effortEntries`),
            // the unsupported one names its replacement in the word above ("Max · runs as X-High"), WHO rejects it in the tooltip.
            // Unlike the list, the sheet stays OPEN after the choice: `pickEffort` closes it, the slider reopens it in the same
            // step; it is closed by a click elsewhere, Escape or the button.
            <div className="cb-pop-in-fast cb-pop absolute bottom-full right-0 z-40 mb-1.5 w-[min(296px,calc(100vw-2rem))] origin-bottom-right rounded-2xl px-4 pb-3 pt-3.5">
              {effortChoice.length > 0
                ? <EffortSlider entries={effortChoice} active={currentEffort} ultra={ultracode} t={t}
                    onChoice={(id) => { void pickEffort(id); setEffortPickerOpen(true); }} />
                : <p className="text-[12.5px] leading-relaxed text-dim">{effortWithoutReason ? t(effortWithoutSelectionText(effortWithoutReason)) : ""}</p>}
              {/* Ultracode: a toggle next to the level; switching it on or off leaves the level alone. */}
              <div className="mt-3 flex items-center gap-3 border-t border-edge pt-3" data-effort-ultracode>
                <div className="min-w-0 flex-1">
                  <div className={`text-[13px] font-medium ${ultracode ? "cb-ultra-text" : "text-fg"}`}>Ultracode</div>
                  <div className="text-[11.5px] leading-snug text-dim">{t("Multi-agent orchestration without asking — independent of the effort level.")}</div>
                </div>
                <Toggle on={ultracode} onClick={() => { void setUltracode(!ultracode); }} title="Ultracode" />
              </div>
            </div>
          )}
        </div>
        </div>
        {/* The agents' browser always runs headless (toolchain/playwright.js); watching and intervening goes through the browser
            of the right bar. */}
        {/* Send at the far right: the round, filled accent button (CbSendButton `round`); during a run the same shape as stop
            (square), dimmed when disabled, never gone. */}
        <CbSendButton
          round
          className="ml-1 h-9 w-9"
          iconSize={20}
          // Empty + running = abort. As soon as the user types or picks an attachment, the same button morphs into send/queue.
          stop={busy && nothingToSend}
          stopping={stopping}
          // While a turn runs and the composer has content, the message is queued.
          queue={busy}
          onStop={stop}
          disabled={uploading || nothingToSend}
          title={
            busy && nothingToSend
              ? (stopping ? t("Stopping…") : t("Stop generation"))
              : uploading
                ? t("Uploading…")
                : busy
                  ? t("Queue message (Enter)")
                  : t("Send (Enter)")
          }
        />
        </div>
      </div>
    </form>
  );
});
