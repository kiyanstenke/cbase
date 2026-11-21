// An airlock for a fetch that runs on a beat AND on causes (first user: the "Instances" tab, components/projects/InstancesPage.tsx).
//
// THE BUG IT CLOSES: the page started a new fetch every 5 s and on every event and adopted only the answer of the LAST started one. If the
// route permanently took longer than the beat (in B a stack is building, the container answers sluggishly; the tree may take up to 15 s
// exec plus 4 s resources per instance), every answer was invalidated by the next fetch: the page stayed on "loading…" or an old state
// forever, errors vanished silently, and the fetches piled up against the user container.
//
// THE RULE:
//   - At most ONE fetch runs. Every answer that arrives counts (there is no younger one that could overtake it).
//   - `nudge(true)` (a cause: event, action, expanding) during a running fetch sets a mark: exactly ONE follow-up afterwards, no matter how
//     many causes came; the running fetch may not know the cause yet.
//   - `nudge(false)` (the beat) during a running fetch does nothing; otherwise a slow route would run fetch after fetch.
//   - An error is reported like an answer, even if no state ever arrived ("empty is not unknown": the caller then shows the error, not
//     "loading…").
//   - `end()` (unmounting, another project): an answer afterwards is discarded, a follow-up no longer happens.
//
// A leaf without imports and without a clock: web/test/retrieval-airlock.test.mjs compiles it with tsc and runs it with gates instead of durations.

export type Airlock = {
  /** `afterRun` (default true): if a fetch is already running, exactly one follows it. The beat calls `nudge(false)`. */
  nudge: (afterRun?: boolean) => void;
  /** Afterwards the airlock reports nothing and starts nothing. */
  end: () => void;
  /** Is a fetch running? (for tests and displays) */
  running: () => boolean;
};

export function retrievalAirlock<T>(fetch: () => Promise<T>, report: { ok: (value: T) => void; error: (e: unknown) => void }): Airlock {
  let running = false;
  let again = false;
  let alive = true;
  const round = async () => {
    running = true; // synchronously before the first await, so a nudge in the same tick sees the running fetch
    try {
      do {
        again = false;
        try {
          const value = await fetch();
          if (!alive) return;
          report.ok(value);
        } catch (e) {
          if (!alive) return;
          report.error(e);
        }
      } while (again && alive);
    } finally {
      running = false;
    }
  };
  return {
    nudge(afterRun = true) {
      if (!alive) return;
      if (running) { if (afterRun) again = true; return; }
      void round();
    },
    end() { alive = false; again = false; },
    running: () => running,
  };
}
