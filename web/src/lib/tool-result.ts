// Assign a result (tool_result) to the matching tool block — without React, so the gate (web/test/tool-result.test.mjs) can
// compile the helper with tsc and check it. The history (ChatPane) gets it via AssistantBlocks.tsx.
//
// Recursive, because it may also hit a subagent's child call; the search is by tool_use_id across all levels. BACKWARD through
// all bubbles, not only the last: if a row of its own slips in between call and result (question card, approval card, monitor row),
// the result would otherwise land nowhere and the call would stay "running" forever. One helper for all chat views.
// The normal case hits the last bubble; without a hit the array stays the same object (no re-render).

// The least the helper must know about a block — `Block` in AssistantBlocks.tsx satisfies this structurally (text and
// thinking blocks carry none of the optional fields).
export type ResultBlock = {
  kind: string;
  id?: string;
  result?: string;
  resultIsError?: boolean;
  done?: boolean;
  children?: ResultBlock[];
};

export function applyToolResult<B extends { role: string; blocks: ResultBlock[] }>(prev: B[], id: string, result: string, isError: boolean): B[] {
  const walk = (blocks: ResultBlock[]): [ResultBlock[], boolean] => {
    let found = false;
    const out = blocks.map((bl) => {
      if (bl.kind !== "tool") return bl;
      if (bl.id === id) { found = true; return { ...bl, result, resultIsError: isError, done: true }; }
      if (bl.children?.length) {
        const [ch, f] = walk(bl.children);
        if (f) { found = true; return { ...bl, children: ch }; }
      }
      return bl;
    });
    return [out, found];
  };
  for (let i = prev.length - 1; i >= 0; i--) {
    if (prev[i].role !== "assistant") continue;
    const [blocks, found] = walk(prev[i].blocks);
    if (!found) continue;
    const copy = [...prev];
    copy[i] = { ...prev[i], blocks };
    return copy;
  }
  return prev;
}

/**
 * Write the input of a tool call (the `assistant` event) into ITS block, which already stands.
 *
 * The block is created at the start of the call (`content_block_start`, also from the loop engine), its input comes with the
 * finished call — in between, while the model streams the arguments, often half a minute passes. If a bubble of its own attaches
 * in that time (monitor row, workflow marker, channel card — or, because the engine in approval mode announces call by call, the
 * approval card of the PREVIOUS call of the same round), the search in the LAST bubble did not find it: a second row appeared, and the
 * first kept "running" without input and result.
 * Hence the same search as `applyToolResult`: backward through all assistant bubbles and all levels — like iOS
 * (`ChatViewModel+Blocks.swift:upsertTool`). `detail` replaces the old one only if it says something.
 * Without a hit the array stays the SAME object — then the caller creates the block where it created it before.
 */
export function applyToolInput<B extends { role: string; blocks: InputBlock[] }>(prev: B[], id: string, input: Record<string, unknown>, detail: string): B[] {
  const walk = (blocks: InputBlock[]): [InputBlock[], boolean] => {
    let found = false;
    const out = blocks.map((bl) => {
      if (found || bl.kind !== "tool") return bl;
      // Only an OPEN block (without input, without result) — that is how only content_block_start creates it. Codex counts its
      // item ids anew per process (item_0, item_1, … in every turn and every subagent): a finished block with the same
      // id is a DIFFERENT call, and overwriting it left the new one without a row.
      if (bl.id === id && bl.input === undefined && bl.result === undefined && !bl.done) { found = true; return { ...bl, input, detail: detail || bl.detail }; }
      if (bl.children?.length) {
        const [ch, f] = walk(bl.children);
        if (f) { found = true; return { ...bl, children: ch }; }
      }
      return bl;
    });
    return [out, found];
  };
  for (let i = prev.length - 1; i >= 0; i--) {
    if (prev[i].role !== "assistant") continue;
    const [blocks, found] = walk(prev[i].blocks);
    if (!found) continue;
    const copy = [...prev];
    copy[i] = { ...prev[i], blocks };
    return copy;
  }
  return prev;
}
// What `applyToolInput` must know about a block (plus what `applyToolResult` needs).
export type InputBlock = ResultBlock & { input?: Record<string, unknown>; detail?: string; children?: InputBlock[] };

/**
 * Sort the content of ONE subagent into its call block.
 *
 * The same search as above, for the same reason — and the same bug one function further: the histories had a `mutateBlocks` for this
 * that looked only in the LAST bubble and on failure **put the content into the main bubble** instead of dropping it. From the time
 * when subagents still stood in the chat, that was the right choice ("better up there than lost"). Since they have a place of their
 * own, the calculation turns around.
 *
 * Measured in a running chat: the `cbase_agent` call stood one bubble further up, the subagent delivered a 12 KB report — and EVERY one
 * of its deltas landed in the bubble the main agent was writing into. Two streams, one text block, interleaved character by
 * character. Plus torn Markdown (a `**` that opens in one fragment and closes in the next never becomes bold) and the child calls
 * as "ran 1 command" between the fragments.
 *
 * Without a hit the array stays the SAME object: no re-render, and the content is gone. That is intentional, but not free: what is
 * dropped here are the subagent's "steps" in the agent bar (they are exactly `bl.children`). Its REPORT survives — it comes from the
 * call's result, not from here. The trade is still worth it because it is almost never due now: the search runs over ALL bubbles and
 * ALL levels, so "orphaned" means the call block really is not in the history (compacted, emptied). Then there is no right place
 * left — and the main bubble is the most wrong of all.
 */
export function mutateUnderParent<
  Bl extends { kind: string; id?: string; children?: Bl[] },
  B extends { role: string; blocks: Bl[] },
>(
  prev: B[],
  parentId: string,
  fn: (blocks: Bl[]) => Bl[],
): B[] {
  const walk = (blocks: Bl[]): [Bl[], boolean] => {
    let found = false;
    const out = blocks.map((bl) => {
      if (found || bl.kind !== "tool") return bl;
      if (bl.id === parentId) { found = true; return { ...bl, children: fn(bl.children ?? []) }; }
      if (bl.children?.length) {
        const [ch, f] = walk(bl.children);
        if (f) { found = true; return { ...bl, children: ch }; }
      }
      return bl;
    });
    return [out, found];
  };
  // Backward: the NEWEST call with this id wins. Ids are unique, but a resumed run (--resume) can carry the same
  // history twice.
  for (let i = prev.length - 1; i >= 0; i--) {
    if (prev[i].role !== "assistant") continue;
    const [blocks, found] = walk(prev[i].blocks);
    if (!found) continue;
    const copy = [...prev];
    copy[i] = { ...prev[i], blocks };
    return copy;
  }
  return prev;
}
