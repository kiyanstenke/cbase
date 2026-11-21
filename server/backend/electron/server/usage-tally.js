// Consumption count of a run from the CLI's event stream.
//
// Why at all: the context display (ctxIn/lastOut in runs/do-run.js) deliberately describes only the LAST API call — that is the
// context size, not the consumption. For "what did this run cost" the sum over all calls is needed, including those of the
// subagents, which drop out of the context count via parent_tool_use_id but consume real tokens.
//
// The two traps this is built against:
//   1. The same numbers arrive several times. The CLI sends one assistant event per content block — all with the same
//      message.id and the same usage. In addition message_start/message_delta deliver the same call once more. Naive adding
//      multiplies the input by the number of blocks. Deduplication is therefore by message.id.
//   2. The output of a call in message_delta is CUMULATIVE, not incremental. If every delta is added, the sum grows
//      quadratically. Per call the maximum counts, and only its increase goes into the sum.
//
// The counter is deliberately tolerant: missing fields, unknown events and streams without partial messages (no
// stream_event) must not throw it off — a consumption count must never disturb a run.
//
// Codex: the connector does not know the individual model calls of a turn, only the turn (`turn.completed`) and the LAST call
// (rollout). For the context display it reports the last call as message_start/message_delta with the marker `onlyContext` —
// that does NOT count here —, the consumption of the whole turn as its own event `consumption` (stream_event, usage in the
// Claude shape).
//
// `cached` is read + write (the shape of the usage_events row); `cacheRead`/`cacheWrite` keep both apart for the breakdown of
// the display (providers/connectors/consumption.js tokenParts).

export function createUsageTally() {
  const main = { input: 0, output: 0, cached: 0, cacheRead: 0, cacheWrite: 0 };
  const sub = { input: 0, output: 0, cached: 0, cacheRead: 0, cacheWrite: 0 };
  const seenIn = new Set();   // message.id whose input side is already booked
  const openOut = new Map();  // stream → { id, out }: the call whose output is still growing

  const input = (u, bucket) => {
    const read = Number(u.cache_read_input_tokens) || 0, write = Number(u.cache_creation_input_tokens) || 0;
    bucket.input += Number(u.input_tokens) || 0;
    bucket.cached += read + write;
    bucket.cacheRead += read;
    bucket.cacheWrite += write;
  };
  const addInput = (id, u, bucket) => {
    if (!u || !id || seenIn.has(id)) return;
    seenIn.add(id);
    input(u, bucket);
  };
  // id === null for message_delta (they carry no message.id) → applies to the stream's open call.
  const addOutput = (key, id, out, bucket) => {
    const n = Number(out) || 0;
    if (n <= 0) return;
    const open = openOut.get(key);
    if (open && (!id || open.id === id)) {
      if (n > open.out) { bucket.output += n - open.out; open.out = n; }
      return;
    }
    // Another call: the previous one is already fully booked and is merely displaced.
    openOut.set(key, { id: id || "", out: n });
    bucket.output += n;
  };

  return {
    main,
    sub,
    // Pass every event of the run through here — the counter picks out what is relevant.
    observe(evt) {
      if (!evt) return;
      const parentId = evt.parent_tool_use_id ?? null;
      const bucket = parentId ? sub : main;
      const key = parentId || "main";
      if (evt.type === "stream_event" && evt.event?.onlyContext) return; // Codex: only the last call, for the context display
      if (evt.type === "stream_event" && evt.event?.type === "consumption") {
        // A whole turn, reported exactly once — not a partial message, hence without dedup and without an open call.
        const u = evt.event.usage;
        if (!u) return;
        input(u, bucket);
        bucket.output += Number(u.output_tokens) || 0;
        return;
      }
      if (evt.type === "assistant") {
        // Carries the final sum of the call and is the only path that gets by without a partial-message stream. The dedup
        // by message.id prevents the multiple count per content block.
        const u = evt.message?.usage;
        if (!u) return;
        addInput(evt.message?.id, u, bucket);
        addOutput(key, evt.message?.id, u.output_tokens, bucket);
      } else if (evt.type === "stream_event" && evt.event?.type === "message_start") {
        const u = evt.event.message?.usage;
        if (!u) return;
        addInput(evt.event.message?.id, u, bucket);
        openOut.set(key, { id: evt.event.message?.id || "", out: 0 });
      } else if (evt.type === "stream_event" && evt.event?.type === "message_delta") {
        addOutput(key, null, evt.event.usage?.output_tokens, bucket);
      }
    },
    // Sum of both buckets — for displays that do not separate by kind.
    totals() {
      return {
        input: main.input + sub.input,
        output: main.output + sub.output,
        cached: main.cached + sub.cached,
        cacheRead: main.cacheRead + sub.cacheRead,
        cacheWrite: main.cacheWrite + sub.cacheWrite,
      };
    },
  };
}
