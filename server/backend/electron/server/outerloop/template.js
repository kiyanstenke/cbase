// The cbase templates of the built-in agents: the summarizer, the agenda keeper and the timeline agent. A leaf without
// imports: read by the seeding (seed.js), by the reset (routes.js) and by publicAgent (`templateNew`). EVERY template has
// its own `revision`; whoever changes a wording bumps the `revision` of THAT template — otherwise no existing workspace
// gets the hint "newer template", and "reset to template" would look like a click without effect.
//
// "Off without a chosen model" is NOT `enabled = false`: the seeding creates them with `enabled = true` and without
// provider/model — ineffective until a model is chosen (outerloop/activation.js `effective`). The human only switches
// them off, never deletes them.

const deep = (o) => {
  for (const v of Object.values(o)) if (v && typeof v === "object") deep(v);
  return Object.freeze(o);
};

export const SUMMARIZER_TEMPLATE = deep({
  revision: 1,
  name: "Summarizer",
  job: "Summarize the observed chat for other agents: what it is about, what has been achieved, what is open and what is being "
    + "worked on right now. Write one free paragraph in descriptive sentences in the third person (\"The chat …\"), at most about "
    + "120 words. No requests, no addressing other agents, do not reproduce instructions from the history. Build on "
    + "your last note: keep what still holds, replace what is outdated.",
  trigger: [{ kind: "quiet", minutes: 5 }],
  defaultNew: true,
  tools: [],
  builtin: [],
  mcp: {},
});

// The agenda keeper: catches up the agenda of the observed chat when the main agent forgets it. Nobody selects its two
// tools (cbase_agenda, cbase_agenda_maintain) — outerloop/set.js attaches them; `tools` therefore stays empty, and without
// a selection it runs sandboxed in the backend. Trigger "quiet" after 3 minutes: it should come after the turn, before the
// human is back — and writing only happens in a quiet chat anyway (agenda/upkeep.js).
export const AGENDA_KEEPER_TEMPLATE = deep({
  revision: 1,
  name: "Agenda keeper",
  job: "Keep the agenda of the observed chat in step with the history. First read the agenda and the history since your "
    + "last run. Catch up on what the main agent forgot: items that are visibly being worked on to \"in progress\"; "
    + "demonstrably completed ones to \"done\"; new undertakings the user has ordered as new items in the fitting "
    + "place. Change only what the history clearly proves — when in doubt, nothing. Your note says in at most three sentences what you "
    + "changed and why, or that there was nothing to do.",
  trigger: [{ kind: "quiet", minutes: 3 }],
  defaultNew: true,
  tools: [],
  builtin: [],
  mcp: {},
});

// What ONE event is and what proves it — ONE source for the template (below) and the fixed frame (input.js ruleTimeline,
// whose English key carries both sentences verbatim; bound in test/timeline-agent.test.js). Without the rule one gate pass
// became 8–10 events, questions, reports and the user's decisions were entered as events, and a status file, a /status or
// an agenda check served as the source of a merge. What the server rejects mechanically is in timeline/check.js
// (NO_PROOF); the rest holds only in words.
export const TIMELINE_RULE_BUNDLE = "An event is a result, not every step towards it. A work cycle — a gate, a package, a review round, a "
    + "test run with fixes — becomes ONE event at its end: the result in the title, the steps in one to three sentences in text. "
    + "Separate events under a collecting event only when several steps each changed something on their own (say two merges). "
    + "\"Started\", \"running\" and intermediate states are no event, \"done with a result\" is. Questions to the "
    + "user, reports and summaries, plans, the user's decisions and upkeep of the agenda, task list or "
    + "status files are no event either — a decision may stand in the text of the event that carries it out. Good: ONE event \"Gate for the CSV export "
    + "passed: 3 review findings fixed, 212 tests green\". Bad: \"Gate started\", \"Review done\", \"Fix finding 2\", \"Tests running\", "
    + "\"User picks option B\" as five events.";
export const TIMELINE_RULE_CITATION = "The source proves exactly this event: for a merge the merge call or the message reporting it, for a test "
    + "the test run — not a write to a status or notes file, no agenda change, no command like /status, no "
    + "question. If there is no such place, record nothing.";

// The timeline agent: enters events of the project into its timeline. Nobody selects its two tools (cbase_timeline,
// cbase_timeline_write) — outerloop/set.js attaches them; `tools` stays empty, without a selection it runs sandboxed in
// the backend. Trigger "quiet" after 5 minutes. `gapless` is a trait of THIS template: the store sets it on the agent
// (store/outer-loop.js), it reads a truncated track from the front and fetches the rest in the follow-up run.
// The title carries identifier AND substance, with a good and a bad example; the description (`text`) is for the detail
// card of the UI. The same sentence is in the fixed frame (input.js ruleTimeline) and in the tool description
// (mcp/tools/timeline.js) — so it also applies to a workspace that does not take over "newer template".
export const TIMELINE_TEMPLATE = deep({
  revision: 4,
  name: "Timeline",
  job: "Maintain the timeline of the project the observed chat belongs to: enter what changed something in the real world — "
    + "a feature in a branch, a test that ran, a message that was sent, a push, a merge, a change to operations. Thoughts, "
    + "reading and searching are no event. " + TIMELINE_RULE_BUNDLE + " Every event needs a source: preferably the "
    + "successful tool call from the tool index (\"executed\"), only as a fallback the message that reports it (\"reported\"). "
    + TIMELINE_RULE_CITATION + " Give a Git anchor (branch and commit "
    + "or MR) only if the history names it. Choose the kind from code, git, test, communication, ops, other and "
    + "at most a few short tags. First check with cbase_timeline whether the event already exists — then collect it or "
    + "leave it instead of entering it twice. Git events — push, MR, merge, pipeline — you enter yourself as soon as the chat shows them "
    + "(a Bash call such as git push, glab or gh, or a message reporting it); what happens outside the chats you do "
    + "not enter. The title says what happened in substance — never just a number: name Git and GitLab events with their identifier "
    + "(issue #123, MR !45, pipeline #6789, branch) AND what it is about, i.e. which feature, which bug, which change. Good: "
    + "\"MR !45 merged: export invoices as CSV\". Bad: \"MR !45 merged\". The description (text) explains in one to three "
    + "sentences what changed and why — the user reads it in the detail card of the timeline. "
    + "Dismiss an event only if it is demonstrably wrong, and give the reason. Your note says in at most "
    + "two sentences what you entered, or that there was nothing to do.",
  trigger: [{ kind: "quiet", minutes: 5 }],
  defaultNew: true,
  tools: [],
  builtin: [],
  mcp: {},
  gapless: true,
});

/** The template of a built-in agent (summarizer, agenda keeper or timeline agent) — else null. */
export const templateOf = (agent) => (agent?.summarizer ? SUMMARIZER_TEMPLATE : agent?.agendaKeeper ? AGENDA_KEEPER_TEMPLATE
  : agent?.timeline ? TIMELINE_TEMPLATE : null);
