<!-- cbase's own guide to writing dynamic workflows, written for cbase. Loaded by dynworkflows/reminder.js, it travels
     with the full Ultracode reminder and with the keyword; HTML comments like this one do not go to the model.
     server/backend/test/dynworkflows-reminder.test.js runs every ```javascript example through the sandbox, so each one
     has to stay runnable. Points where cbase behaves differently from the reference version are marked "cbase:". The
     stamp below names the Claude version the guide was last checked against. -->
<!-- Reference-Version: 2.1.322 -->
# Dynamic workflows in cbase

## When a workflow pays off

A workflow is a script that hands work to many agents at once, for coverage (split the job, work every piece in
parallel), confidence (independent views and a hostile check before a result counts) or size (a migration, audit or
broad search that would overflow one context). The script is the plan: what fans out, who checks, where it merges.

Scout by hand first — list the files, look at the diff — until you have the work list, then write the script that runs
over it. The shape has to be known at the orchestration step, not at the start of the task.

Typical one-phase workflows, which you can chain over several turns:
- **Understand:** readers in parallel over the subsystems involved, merged into a structured map.
- **Design:** N approaches worked out independently, then scored by a panel and merged.
- **Review:** split by dimension, find issues, then try to refute each one (the `check-pr` example below).
- **Research:** search along several routes, read the best sources in depth, merge.
- **Migrate:** find every site, change each one in its own worktree, verify.

Bigger jobs are several such workflows in a row: read what one returns before you decide the next. You stay in control,
and each script stays one clearly scoped fan-out.

**Ultracode.** While a cbase reminder says Ultracode is on, the user has opted in: every substantial task gets a
workflow, written and started by you. Aim for the most complete, most correct answer; tokens are not the constraint.
Work with several phases (understand, design, implement, verify) is usually one workflow per phase, run in sequence so
you can steer between them. Take whatever fits from the quality patterns at the end (refuting verifiers, several search
routes, completeness critic, rounds until nothing new). Default to orchestrating and to checking findings
adversarially; skip that only for trivial work or work that is verified already. Work alone only in conversational
turns and for small mechanical edits. Once a reminder says Ultracode is off, the opt-in rule in the description of
`cbase_dynamic_workflow` applies again.

## Running a workflow

cbase: the tool is `cbase_dynamic_workflow`; the script goes straight into its `script` parameter, not into a file.
The call returns at once with `taskId`, `runId` and `scriptPath` and the run goes on in the background — end your turn.
Do not poll: at the end a completion notice brings the return value and the path of an output file with the journal
entry of every `agent()` call and all `log()` lines. Read that file before guessing why a result looks empty.

- **Edit and rerun:** each call saves its script at `scriptPath`. Edit that file and call again with `{scriptPath}`
  instead of `script`, rather than sending the whole script again.
- **Resume:** `{scriptPath, resumeFromRunId}` after an abort or an edit. The longest unchanged opening stretch of
  `agent()` calls is replayed from the journal; from the first changed or added call on, everything runs for real.
  Same script and same `args` means every result comes from the journal.
- **Library:** `cbase_dynamic_workflow_list` shows this chat's saved workflows; start one with `{name, args}` instead
  of `script`. `cbase_dynamic_workflow_save` adds a script, only when the user asks for it.
- **Stop:** `cbase_dynamic_workflow_stop` with the `taskId`. **One agent only** is not a workflow: use `cbase_agent`.

## The shape of a script

A script opens with `export const meta = {...}`, followed by the body:

```javascript
export const meta = {
  name: 'stale-docs',
  description: 'Find README files that no longer match the code',  // a single line; the user sees it before approving
  phases: [                                                          // titles must equal the phase() calls below
    { title: 'Collect', detail: 'list every README in the repo' },
    { title: 'Compare', detail: 'one agent per README' },
  ],
}
const LIST_SCHEMA = {type: 'object', required: ['paths'], properties: {paths: {type: 'array', items: {type: 'string'}}}}
phase('Collect')
const readmes = await agent('List the path of every README.md in the repository.', {schema: LIST_SCHEMA})
phase('Compare')
const notes = await parallel(readmes.paths.map((p, i) => () =>
  agent(`Read ${p} and the code it describes. Report every statement that is no longer true.`, {label: `readme-${i}`, phase: 'Compare'})))
return notes.filter(Boolean)
```

`meta` must be a plain literal, nothing computed: no variables, no calls, no spreads, no template strings. `name` and
`description` (one line, shown on the approval card) are required; `whenToUse` (shown in the workflow list) and
`phases` are optional. A title in `meta.phases` must match the string given to `phase()` exactly; a `phase()` without a
matching entry gets a group of its own.

## What the body can call

- **`agent(prompt, opts?)`** → `Promise<any>` starts one agent. Without `opts.schema` you get its final text as a
  string; with a JSON Schema the agent must answer through the `StructuredOutput` tool and you get the validated object.
  `null` if the agent dies or has no valid object after its retries — hence `.filter(Boolean)`. Options:
  - `label`: the name in the progress view. `phase`: assigns the agent to a phase group; use it inside `pipeline()` and
    `parallel()` stages instead of the global `phase()` state.
  - `model` — cbase: one string; every provider set up in the app is usable. `opus`, `sonnet`, `haiku` are Claude
    aliases; any other model is `provider::model`, e.g. `codex::gpt-5.6-sol`. An unknown name fails at once and lists
    the valid ones; `cbase_agents_list` shows what exists. Omitted, the agent uses this chat's provider and model —
    nearly always right. Set it only for a second model family's independent judgement (refuters, judges) or a cheaper
    model on a mechanical stage.
  - `effort`: `'low' | 'medium' | 'high' | 'xhigh' | 'max'`, clamped to the model; omitted, the chat's effort applies.
    `'low'` for cheap mechanical stages, the top levels only for the hardest verifying and judging.
  - `isolation: 'worktree'`: a Git checkout of the agent's own, deleted if nothing in it changed. Costly — only when
    agents edit files in parallel and would collide. cbase: with several repos in the project, `repo` picks one
    (without it, the error lists them).
  - `agentType` — cbase: one of this workspace's agent definitions instead of the default agent (its role, tools, MCP
    servers, and its model unless `model` is given). Combines with `schema`. `subagent_type` is an alias, the option's
    name on `cbase_agent`.
- **`pipeline(items, ...stages)`** → `Promise<any[]>`: each item goes through all stages on its own, with NO barrier
  between stages — one item can be in stage 3 while another is in stage 1. Stages get `(previous, item, index)`. A
  stage that throws turns its item into `null` and skips the item's later stages. The default for multi-stage work.
- **`parallel(thunks)`** → `Promise<any[]>` runs `() => Promise` functions concurrently and waits for all: a BARRIER.
  A thunk that throws leaves `null` in its slot; `parallel()` itself never throws.
- **`log(message)`** writes a progress line; **`phase(title)`** opens a new phase.
- **`args`**: the run's input as passed (`undefined` if none). Pass lists and objects as JSON values
  (`args: ["a.ts", "b.ts"]`), not as a string holding JSON, or `args.map` fails.
- **`budget`** `{total, spent(), remaining()}`: the token target from a "+500k" in the user's message; `budget.total` is
  `null` without one. `spent()` counts this turn's output tokens of the chat and all workflows together; `remaining()`
  is `max(0, total − spent())`, or `Infinity` without a target. It is enforced: once `spent()` reaches `total`, every
  further `agent()` throws.
- **`workflow(nameOrRef, args?)`** → `Promise<any>` runs a saved workflow (name from `cbase_dynamic_workflow_list`) or
  a script file (`{scriptPath}`) as a step and returns its return value. The child shares this run's caps, agent
  counter, abort and budget. Nesting is limited to one level (a child calling `workflow()` throws); an unknown name
  or a child with a syntax error throws as well.

## What agents get, and what the script may use

Agents know their last message is the return value and answer with bare data; use `schema` for structure. A schema's
root must be `{type: 'object', properties: {...}}`, and every name in `required` must appear in `properties`.

cbase: workflow agents have the chat's tools — files, shell, browser, the workspace's MCP servers — but no subagents
(`cbase_agent*`), no workflows of their own, no questions to a human, no wakeups or monitors. Nobody watches, so an
approval request is refused without a card. They do not see your conversation: each prompt must stand on its own.

Plain JavaScript only; TypeScript syntax does not parse. The body is async, so use `await` directly. Built-ins like
`JSON`, `Math` and `Array` exist, except that `Date.now()`, `Math.random()` and `new Date()` with no argument throw —
they would break resuming. Pass times in via `args`, stamp results after the run, vary prompt or label by index for
variety. No file system, no Node API. Define every constant you use in the script: an undefined name throws only in
the branch that touches it, which then silently becomes `null`.

## Prefer pipelines over barriers

Use `pipeline()`. A barrier (`parallel()` between stages) belongs only where the next stage needs the COMPLETE output
of the previous one: removing duplicates across the whole set before costly work, stopping early when the total is
zero, or a prompt that compares a result with all the others. Not a reason: flattening, mapping or filtering first
(do it inside a stage), stages that feel separate, tidier code. A barrier makes the fast items wait for the slowest.

The reference shape — each dimension's findings go to verification as soon as that dimension is done:

```javascript
export const meta = {
  name: 'check-pr',
  description: 'Inspect a change along several dimensions and confirm each finding',
  phases: [{ title: 'Inspect' }, { title: 'Confirm' }],
}
const DIMENSIONS = [
  {key: 'logic', prompt: 'Read the changed files and list logic errors.'},
  {key: 'security', prompt: 'Read the changed files and list security problems.'},
]
const FINDINGS_SCHEMA = {type: 'object', required: ['findings'], properties: {findings: {type: 'array', items: {
  type: 'object', required: ['title', 'file'], properties: {title: {type: 'string'}, file: {type: 'string'}}}}}}
const VERDICT_SCHEMA = {type: 'object', required: ['isReal'], properties: {isReal: {type: 'boolean'}, why: {type: 'string'}}}
const checked = await pipeline(
  DIMENSIONS,
  dim => agent(dim.prompt, {label: `inspect-${dim.key}`, phase: 'Inspect', schema: FINDINGS_SCHEMA}),
  (report, dim) => parallel(report.findings.map((item, n) => () =>
    agent(`Try to show that this ${dim.key} finding is wrong: ${item.title} (${item.file})`,
      {label: `confirm-${dim.key}-${n}`, phase: 'Confirm', schema: VERDICT_SCHEMA})
      .then(verdict => verdict && {...item, dimension: dim.key, isReal: verdict.isReal}))),
)
return {real: checked.filter(Boolean).flat().filter(x => x && x.isReal)}
// While 'security' is still being inspected, the 'logic' findings are already being confirmed.
```

The next two snippets are body fragments; `DIMENSIONS`, `FINDINGS_SCHEMA` and `VERDICT_SCHEMA` are the constants from
the example above, defined in the same script.

A barrier that earns its place — duplicates only show once every dimension has reported, and an empty set ends the run:

```javascript
const reports = await parallel(DIMENSIONS.map(dim => () => agent(dim.prompt, {schema: FINDINGS_SCHEMA})))
const byPlace = new Map()
for (const report of reports.filter(Boolean)) for (const f of report.findings) byPlace.set(`${f.file}|${f.title}`, f)
const unique = [...byPlace.values()]
if (unique.length === 0) return []
return parallel(unique.map(f => () => agent(`Is this a real problem? ${f.title} in ${f.file}`, {schema: VERDICT_SCHEMA})))
```

A barrier that does not — the middle step looks at one report at a time, so nothing needs the whole set:

```javascript
const reports = await parallel(DIMENSIONS.map(dim => () => agent(dim.prompt, {schema: FINDINGS_SCHEMA})))
const titles = reports.filter(Boolean).flatMap(report => report.findings.map(f => f.title))
const verdicts = await parallel(titles.map(t => () => agent(`Check: ${t}`, {schema: VERDICT_SCHEMA})))
```

Do the reshaping inside a stage instead: `pipeline(DIMENSIONS, dim => agent(...), report => parallel(...))`. When
unsure, choose the pipeline.

## Limits

At most 8 agents run at the same time per run. cbase: plus a limit per user across all running workflows (8 by
default). Extra calls queue and start as slots free up, so 100 items in one `parallel()` are fine. A run makes at most
1000 `agent()` calls in total (a guard against runaway loops); one `parallel()` or `pipeline()` takes at most 4096
items — more is an error, never a silent cut.

## Loops

Collect until there are enough:

```javascript
const IDEAS_SCHEMA = {type: 'object', required: ['cases'], properties: {cases: {type: 'array', items: {type: 'string'}}}}
const cases = []
for (let round = 1; cases.length < 12 && round <= 30; round++) {
  const batch = await agent(`Suggest edge cases for the date parser that the test suite misses (attempt ${round}).`, {schema: IDEAS_SCHEMA})
  if (batch) cases.push(...batch.cases)
  log(`round ${round}: ${cases.length} of 12 edge cases`)
}
return cases.slice(0, 12)
```

Collect while the budget lasts, so that a "+500k" from the user decides how deep the run goes. Test `budget.total`
first: with no target, `remaining()` is `Infinity` and the loop would only end at the cap of 1000 agents.

```javascript
const RISKS_SCHEMA = {type: 'object', required: ['risks'], properties: {risks: {type: 'array', items: {type: 'string'}}}}
const risks = []
let pass = 0
while (budget.total && budget.remaining() > 60_000) {
  pass++
  const out = await agent(`List risks of moving the service to the next major framework version (pass ${pass}).`, {schema: RISKS_SCHEMA})
  if (out) risks.push(...out.risks)
  log(`pass ${pass}: ${risks.length} risks, about ${Math.round(budget.remaining() / 1000)}k tokens left`)
}
return risks
```

Both ideas together — search in rounds, drop what was already seen, let several lenses judge, stop after two rounds
without anything new:

```javascript
const SEARCHERS = [
  'Look for race conditions by following every shared mutable variable.',
  'Look for race conditions by reading the code that runs in timers and callbacks.',
]
const HITS = {type: 'object', required: ['hits'], properties: {hits: {type: 'array', items: {
  type: 'object', required: ['where', 'what'], properties: {where: {type: 'string'}, what: {type: 'string'}}}}}}
const VOTE = {type: 'object', required: ['holds'], properties: {holds: {type: 'boolean'}}}
const LENSES = ['can the two paths really interleave', 'what breaks if they do', 'is there already a guard']
const known = new Set(), accepted = []
let emptyRounds = 0
while (emptyRounds < 2) {
  const reports = await parallel(SEARCHERS.map(s => () => agent(s, {phase: 'Search', schema: HITS})))  // one round, all searchers
  const novel = reports.filter(Boolean).flatMap(r => r.hits).filter(h => !known.has(`${h.where}: ${h.what}`))
  if (novel.length === 0) { emptyRounds++; continue }
  emptyRounds = 0
  for (const h of novel) known.add(`${h.where}: ${h.what}`)
  const rulings = await parallel(novel.map(h => async () => {
    const votes = await parallel(LENSES.map(lens => () =>
      agent(`Race condition at ${h.where}: ${h.what}. Judge only this question: ${lens}. Does it hold?`, {phase: 'Judge', schema: VOTE})))
    return {h, holds: votes.filter(v => v && v.holds).length >= 2}
  }))
  accepted.push(...rulings.filter(r => r && r.holds).map(r => r.h))
}
return accepted
// Compare with `known`, not with `accepted`: otherwise rejected hits return every round and the loop never ends.
```

## Quality patterns

Combine as the task needs:
- **Refuting verifiers:** N independent skeptics per finding, each told to disprove it; drop it when most succeed.
  This filters out claims that sound right but are not.

  ```javascript
  const claim = 'The retry helper can send the same payment twice'
  const REFUTE = {type: 'object', required: ['refuted'], properties: {refuted: {type: 'boolean'}, evidence: {type: 'string'}}}
  const ballots = await parallel([1, 2, 3].map(n => () =>
    agent(`Skeptic ${n}: disprove this claim if you can: "${claim}". If you cannot decide, answer refuted=true.`, {schema: REFUTE})))
  const stands = ballots.filter(b => b && !b.refuted).length >= 2
  ```
- **Separate lenses:** if a finding can be wrong in several ways, each verifier gets one angle (correctness, security,
  performance, does it reproduce) instead of N identical skeptics. cbase: another model family (`model: 'codex::…'`)
  is a lens too.
- **Judge panel:** N independent attempts from different starting points, scored by parallel judges; build on the
  winner and borrow the best ideas of the rest. Beats polishing one attempt when many solutions are possible.
- **Until nothing new:** when the amount is unknown, keep sending finders until K rounds in a row add nothing; a fixed
  count misses the tail.
- **Several search routes:** parallel agents, each searching another way (by location, content, subject, time).
- **Completeness critic:** a last agent asks what is missing — a route not searched, a claim not checked, a source not
  read. Its answer is the next round.
- **Say when you cut:** if the workflow limits coverage (top N, no retries, sampling), report it with `log()`; a
  silent cut reads as full coverage.

Match the effort to the request: "find bugs" → a few finders, one verification; "review thoroughly" or "be complete" →
more finders, 3–5 refuting votes, a merge step. When unsure, thorough for research, review and audit, short for quick
checks. The list is not closed — build other shapes when the task needs them (tournament, self-repair loop, staged
escalation).
