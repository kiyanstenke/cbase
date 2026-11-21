// When does a service's "Starting"/"Stopping" transition end?
//
// A LEAF: no imports, no DOM, no React. `web/test/service-stoppable.test.mjs` compiles the file with tsc and recomputes it without a browser;
// the Swift twin `ServiceTransitionRule` (mobile/CbaseMobile/Shell/AppsPage.swift) is bound there by text to the same numbers and conditions.
//
// Without a deadline, "Starting" ended in ALL four service views (web Apps page and project services, iOS Apps and Projects) only at
// `running`. Two cases then hung on "Starting" forever, with neither a stop nor a start button, until one left the page:
//   · the start guard holds the run (`holdsStart`: the group lives but does not listen on the registered port; a wrong port in the start
//     command, a slow boot): the right state is "running, unreachable" with "Stop";
//   · a simple start whose process dies at once (`running` and `holdsStart` both false): the right state is "stopped" with "Start".
//
// The rule (`transitionStep`), in this order:
//   1. State unknown (service gone, copy gone or its state missing) ⇒ end "unknown".
//   2. Stop: nothing stoppable any more ⇒ "reached"; otherwise after the deadline ⇒ "deadline" (the row then shows its real state again with
//      "Stop" instead of saying "Stopping" forever, e.g. when a foreign process holds the port).
//   3. Start: `running` ⇒ "reached".
//   4. Simple start: if the state shows nothing stoppable, and an earlier state that ARRIVED at least `TRANSITION_LINGER_MS` before the start of
//      this query already showed that (`deadSince`) ⇒ "ended": the start command did not keep running. The view then says the reason is in
//      the log.
//   5. Otherwise after the deadline ⇒ "deadline": if the start guard still holds the run, "running, unreachable" with "Stop" appears. An
//      agent start knows only this deadline (the agent brings the service up itself, a run without a process group says nothing about it),
//      with a longer one: it sets up environment and dependencies.
// In addition the views offer the stop already DURING "Starting" as soon as the state is stoppable (`running || holdsStart`).
//
// What the linger time hangs on: the server measures ITS 8 s from the END of the start command (services.js `startSimple`, `afterTheEnd`: a
// start command that ends with 0, e.g. `docker compose up -d`, must be reachable 8 s afterwards, otherwise it reports the failed start), but
// the start route answers at once with 202. Counting the 8 s from the ANSWER would show a command that ran 3 s and whose service listened
// after 10 s as "did not keep running" at 8.3 s (with "Start", where a second click would run the command again) although the server
// reported no failed start and the service ran shortly afterwards. The client sees the end of the command only through one thing: the
// state shows nothing stoppable any more (the group is dead or the wrapper wrote its exit file, so `holdsStart` drops). Hence `deadSince`:
// when the FIRST such state ARRIVED (its response, not the start of its query, since the server computed it sometime in between; so
// `deadSince` never lies before the end of the command). "ended" only when a query that BEGAN at least 8 s later again shows nothing
// stoppable; then the server's probe has begun, and a service it is still probing does not count as dead.
//   · Only states whose query began after the answer to the start are counted (the run is registered then; the route registers it before
//     the 202); a state from before says nothing.
//   · If a state whose query began AFTER `deadSince` shows something stoppable again, the "dead" was no end of the command: `deadSince`
//     drops. An older stoppable one (an overtaken query that arrived later) changes nothing; a dead one can only move `deadSince` to an
//     earlier ARRIVAL, since the views' queries overlap (800 ms beat) and every arrival lies after the end of the command.
//   · Agent start and stop carry no `deadSince`; their transition stays the same object.

/** A running transition of a service in ONE instance. */
export type ServiceTransition = {
  kind: "starting" | "stopping";
  /** When the transition began (ms since epoch); the deadline counts from here. */
  since: number;
  /** Start only: "simple" (start command directly) or "agent". */
  mode?: "simple" | "agent";
  /** When the server's answer to the start arrived (ms); `null`/missing: none yet. */
  response?: number | null;
  /** Simple start only: when the first state without anything stoppable ARRIVED (ms), whose query began after the answer; the linger
   *  time counts from here. `null`/missing: none yet (or a later state was stoppable again). */
  deadSince?: number | null;
};

/** The state of the service in the transition's instance; `null`: unknown. `holdsStart`: the start guard holds the run. */
export type TransitionStatus = { running: boolean; holdsStart?: boolean } | null | undefined;

/** Why a transition ends. */
export type TransitionEnd = "unknown" | "reached" | "ended" | "deadline";

/** The result of a step: the end (`null`: it continues) and the transition afterwards: the SAME object if nothing changed (the view
 *  replaces it only then, and only if the old one still stands under its key). */
export type TransitionStep = { end: TransitionEnd | null; next: ServiceTransition };

/** After this time every transition ends (start without answer or with a held run, stop that does not take). */
export const TRANSITION_DEADLINE_MS = 45_000;
/** The deadline of an agent start. */
export const TRANSITION_DEADLINE_AGENT_MS = 180_000;
/** For this long after the first state without anything stoppable a "nothing runs" does not yet count for a simple start (the server's
 *  probe 8 s after the end of the start command, services.js `afterTheEnd`). */
export const TRANSITION_LINGER_MS = 8_000;

/**
 * One step of the transition `u` at the state `status`. `time.now`: when this state arrived (the evaluation's clock); `time.queried`: when its
 * query BEGAN. Pure; the transition afterwards is in `next`.
 */
export function transitionStep(u: ServiceTransition, status: TransitionStatus, time: { now: number; queried: number }): TransitionStep {
  if (!status || typeof status.running !== "boolean") return { end: "unknown", next: u };
  const stoppable = status.running || status.holdsStart === true;
  const age = time.now - u.since;
  if (u.kind === "stopping") return { end: !stoppable ? "reached" : age >= TRANSITION_DEADLINE_MS ? "deadline" : null, next: u };
  if (status.running) return { end: "reached", next: u };
  const deadSince = deadSinceAfter(u, stoppable, time);
  const next = deadSince === (typeof u.deadSince === "number" ? u.deadSince : null) ? u : { ...u, deadSince };
  if (u.mode === "simple" && !stoppable && deadSince !== null && time.queried - deadSince >= TRANSITION_LINGER_MS) return { end: "ended", next };
  return { end: age >= (u.mode === "agent" ? TRANSITION_DEADLINE_AGENT_MS : TRANSITION_DEADLINE_MS) ? "deadline" : null, next };
}

/** `deadSince` after a state: only for a simple start and only for queries that began after the answer. */
function deadSinceAfter(u: ServiceTransition, stoppable: boolean, time: { now: number; queried: number }): number | null {
  const soFar = typeof u.deadSince === "number" ? u.deadSince : null;
  if (u.mode !== "simple" || typeof u.response !== "number" || time.queried < u.response) return soFar;
  if (!stoppable) return soFar === null ? time.now : Math.min(soFar, time.now);
  if (soFar !== null && time.queried >= soFar) return null;
  return soFar;
}

/** The answer to the start is here: the same transition with a timestamp (a new object; the view compares entries by identity). */
export function withResponse(u: ServiceTransition, now: number): ServiceTransition {
  return { ...u, response: now };
}
