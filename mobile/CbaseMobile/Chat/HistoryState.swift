import Foundation

// The states of the history rows as ONE computation: the iOS counterpart of `web/src/lib/history-state.ts`. Foundation
// only, no SwiftUI: `web/test/history-binding.test.mjs` assembles this WHOLE file with a driver into a program, runs it
// with `xcrun swift` and demands the same answers as the web for the same matrix, row by row. Whoever changes
// something here changes it on the web too, otherwise the gate is red.
//
// The German words are also the keys for `L(…)` (Kit/LocDE*.swift). `loc-audit.sh` sees only literal calls and so NOT an
// `L(z.word)`; `web/test/history-without-points.test.mjs` therefore checks the keys of this table.
enum HistoryState {
    enum Tone: String { case accent, dim, danger }

    struct Agent: Equatable {
        let identifier: String
        let word: String
        let tone: Tone
        let pulses: Bool
    }

    /// The ONE table identifier → word/tone, word for word the same as `AGENT_STATES` (web). Finished has
    /// no entry: a finished subagent carries no word.
    static let agentStates: [String: Agent] = [
        "running": Agent(identifier: "running", word: "running", tone: .accent, pulses: true),
        "stopped": Agent(identifier: "stopped", word: "stopped", tone: .dim, pulses: false),
        "error": Agent(identifier: "error", word: "Error", tone: .danger, pulses: false),
        "without-result": Agent(identifier: "without-result", word: "no result", tone: .dim, pulses: false),
        "waiting": Agent(identifier: "waiting", word: "waiting", tone: .dim, pulses: false),
        "skipped": Agent(identifier: "skipped", word: "skipped", tone: .dim, pulses: false),
    ]

    /// Lookup in the table. A missing identifier is a typo HERE; then the identifier appears as the word
    /// instead of silently returning `nil` (= "finished"); the binding runs every stage and turns red.
    private static func state(_ identifier: String) -> Agent {
        agentStates[identifier] ?? Agent(identifier: identifier, word: identifier, tone: .dim, pulses: false)
    }

    /// Is this tool call running? Only in a running turn and only without a result.
    static func toolRunning(done: Bool, error: Bool, live: Bool) -> Bool {
        live && !done && !error
    }

    /// Is a group row running? Exactly when one of its calls is running. Empty never runs.
    static func groupRunning(_ blocks: [(done: Bool, error: Bool)], live: Bool) -> Bool {
        blocks.contains { toolRunning(done: $0.done, error: $0.error, live: live) }
    }

    /// The state of a subagent, in the SAME order as on the web. `inStream`: `true` = the stream lists it as alive,
    /// `false` = a list is known and it is not in it, `nil` = there is no list (empty is not unknown). A `nil`
    /// result means finished.
    static func agent(error: Bool, rawStatus: String, done: Bool, inStream: Bool?, turnRunning: Bool) -> Agent? {
        if inStream == true { return state("running") }
        if error || rawStatus == "failed" { return state("error") }
        if rawStatus == "stopped" { return state("stopped") }
        if rawStatus == "running" {
            // The background agent: its call is finished, it keeps working itself. Only without a
            // list may the running turn claim that.
            return inStream == nil && turnRunning ? state("running") : state("without-result")
        }
        if done { return nil }
        if turnRunning { return state("running") }
        return state("without-result")
    }

    /// The state of a WORKFLOW agent from the state word the server computes from the journal
    /// (dynworkflows/tree.js `agentState`), bound to `journalAgentState` (web). `nil` means finished; an
    /// unknown state appears under its own name (never "finished").
    static func journalAgent(status: String) -> Agent? {
        status == "finished" ? nil : state(status)
    }

    /// Is the run row shown? It rests in the waiting phase. Unlike the web it stays while text streams (flipping cost a
    /// measured jump of 41 pt, `ChatView.swift`), so there is no `streamingText` parameter here.
    static func runRowVisible(busy: Bool, waiting: Bool) -> Bool {
        busy && !waiting
    }

    /// The running answer, as `ChatTimelineStage.liveItemId` determines it: the newest answer while `busy` holds, but none
    /// if a user row precedes it. The rows come NEWEST FIRST. Deliberately NOT bound to the web: there the last answer
    /// counts even behind a user row.
    static func runningResponseId(newestFirst: [(role: String, id: String)], busy: Bool) -> String? {
        guard busy else { return nil }
        for row in newestFirst {
            if row.role == "user" { return nil }
            if row.role == "assistant" { return row.id }
        }
        return nil
    }
}
