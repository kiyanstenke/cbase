// Which call block belongs to a subagent start?
//
// Claude and the loop engine say it explicitly: the MCP request `tools/call` carries the tool_use id in `_meta`
// (`claudecode/toolUseId`; the engine sets `cbase/toolUseId`), and the core takes it literally.
// Codex 0.153.1 and 0.162.1 do not — its `_meta` carries `callId`/`itemId` of the model response, the stream (`exec --json`) the
// `item.id` (`item_N`), and the two share no number. For Codex therefore:
//
//   · an open, still FREE cbase_agent block of the calling STREAM is assigned (per core and stream, never global);
//   · stage 1: if several are free, the arguments decide (compared canonically, not as a string);
//   · stage 2: same arguments in several blocks ⇒ PROVISIONALLY in arrival order; the block's result carries the agentId of the
//     started agent and confirms or swaps on closing;
//   · if no free block fits, the start ends with an error naming the reason — never guess, never LIFO.
//
// Measured on 0.153.1, re-measured on 0.162.1 (real MCP calls on the wire): Codex runs MCP calls ONE AFTER ANOTHER,
// also two in one response and `Promise.all` in code mode; every call is its own `mcp_tool_call` item with `arguments` at the
// start and the result text at the end. In the normal case exactly one block is open, so stages 1/2 are the safeguard.
//
// A leaf without imports: the core (runs/agents.js) holds one instance per chat, do-run reports opening and closing.

// Canonical form of arguments: keys sorted, recursively; `callId` is dropped (only the path to the server carries it).
export function canonical(value) {
  const arrange = (v) => {
    if (Array.isArray(v)) return v.map(arrange);
    if (v && typeof v === "object") {
      const out = {};
      for (const k of Object.keys(v).sort()) if (v[k] !== undefined) out[k] = arrange(v[k]);
      return out;
    }
    return v;
  };
  const o = value && typeof value === "object" && !Array.isArray(value) ? { ...value } : value;
  if (o && typeof o === "object" && !Array.isArray(o)) delete o.callId;
  return JSON.stringify(arrange(o ?? {}));
}

// The agentId from the result of a cbase_agent block (the start response or the report, as JSON text; for Codex as MCP
// content `[{type:"text",text}]`). Empty if none is in it (error result).
export function agentIdFromResult(content) {
  const text = Array.isArray(content)
    ? content.map((b) => (typeof b === "string" ? b : b?.text || "")).join("")
    : typeof content === "string" ? content : "";
  try {
    const o = JSON.parse(text);
    if (o && typeof o.agentId === "string") return o.agentId;
  } catch { /* not JSON — by pattern below */ }
  const m = /"agentId"\s*:\s*"([^"]+)"/.exec(text);
  return m ? m[1] : "";
}

export function createCallBlocks() {
  const open = new Map();     // stream → Map(blockId → { id, canon, agentId })   (insertion order = arrival order)
  const assignment = new Map(); // agentId → { block, stream, provisional }
  const waiters = new Map();    // stream → Set(resolve)
  const key = (stream) => stream ?? "";
  const streamOf = (stream) => {
    const k = key(stream);
    if (!open.has(k)) open.set(k, new Map());
    return open.get(k);
  };

  return {
    // A cbase_agent call appears in the stream (Codex: `item.started` with `arguments`).
    // Codex restarts its item ids per PROCESS (`item_0`, `item_1`, …). If a block under the id is already bound or carries
    // other arguments, it stems from an earlier process of the same stream (agent stopped or continued, its block never
    // closed) — then the NEW call counts; an unbound one with the same arguments is the same call, announced again.
    // Keeping the old one would make the start find no free block, wait 5 s and end with an error.
    on(id, input, stream = null) {
      if (!id) return;
      const s = streamOf(stream);
      const canon = canonical(input);
      const old = s.get(id);
      if (old && (old.agentId || old.canon !== canon)) s.delete(id);
      if (!s.has(id)) s.set(id, { id, canon, agentId: null });
      const w = waiters.get(key(stream));
      if (w) { waiters.delete(key(stream)); for (const r of w) r(); }
    },

    // The block closes with its result. Returns the corrections: [{ agentId, block, confirmed }].
    close(id, content, stream = null) {
      const s = open.get(key(stream));
      const b = s?.get(id);
      if (!b) return [];
      s.delete(id);
      const x = agentIdFromResult(content);
      const zx = x ? assignment.get(x) : null;
      if (!zx) return []; // no agent in the result (error) or none this core has assigned
      const changes = [];
      if (zx.block !== id) {
        // Swapped: the agent that stood HERE provisionally gets x's old block (stays provisional).
        const prior = zx.block;
        for (const [agentId, z] of assignment) {
          if (agentId !== x && z.block === id && key(z.stream) === key(stream)) {
            z.block = prior;
            const old = s.get(prior);
            if (old) old.agentId = agentId;
            changes.push({ agentId, block: prior, confirmed: false });
          }
        }
        zx.block = id;
      }
      const wasProvisional = zx.provisional;
      zx.provisional = false;
      if (wasProvisional || changes.length) changes.push({ agentId: x, block: id, confirmed: true });
      return changes;
    },

    // Which open block belongs to this start? { block, provisional } | { wait: true } | { error }
    assign(args, stream = null) {
      const s = [...(open.get(key(stream))?.values() || [])];
      const free = s.filter((b) => !b.agentId);
      if (!free.length) return { wait: true };
      const canon = canonical(args);
      let choice;
      if (free.length === 1) choice = free[0];
      else {
        const matching = free.filter((b) => b.canon === canon);
        if (!matching.length) {
          return { error: `${free.length} cbase_agent calls are open at the same time, and none carries exactly these arguments — the start cannot be assigned to a call.` };
        }
        choice = matching[0];
      }
      // Provisional as long as ANOTHER open block carries the same arguments — then only the result decides.
      const provisional = s.some((b) => b !== choice && b.canon === choice.canon);
      return { block: choice.id, provisional };
    },

    bind(block, agentId, { stream = null, provisional = false } = {}) {
      const b = open.get(key(stream))?.get(block);
      if (b) b.agentId = agentId;
      assignment.set(agentId, { block, stream, provisional });
    },

    provisional: (agentId) => Boolean(assignment.get(agentId)?.provisional),
    blockOf: (agentId) => assignment.get(agentId)?.block || null,

    // Wait for the next block of this stream (the CLI's stream and the MCP request reach the server by two paths; the
    // request can arrive BEFORE the `item.started`). The caller sets the deadline.
    nextBlock(stream = null) {
      return new Promise((resolve) => {
        const k = key(stream);
        if (!waiters.has(k)) waiters.set(k, new Set());
        waiters.get(k).add(resolve);
      });
    },
  };
}
