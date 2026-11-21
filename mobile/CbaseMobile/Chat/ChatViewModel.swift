import Foundation
import UIKit

@MainActor
final class ChatViewModel: ObservableObject {
    @Published var chat: Chat
    @Published var isDraft: Bool // internal, for extensions
    @Published var timeline: [TimelineItem] = []
    /// The composer text is a draft per chat (see `draftKey`): every tab or
    /// chat switch rebuilds this model, and without storage the text would be gone.
    @Published var input = "" {
        didSet { if draftReady, input != oldValue { planeDraft() } }
    }
    @Published var attachments: [Attachment] = []
    /// Quotes from the history ("Reply" on the text marker): a separate list beside the text, as a card and marker in the island
    /// (`Chat/ChatQuotes.swift`), sent as "> …" BEFORE the message (`ChatViewModel+Quotes.swift`). Every tab or
    /// chat switch rebuilds this model — so `quoteDeposit` keeps them per draft key, in the app's MEMORY,
    /// not in UserDefaults: a restart clears them, and no UI test inherits them from the previous one.
    @Published var quotes: [String] = [] {
        didSet { if quotes != oldValue { Self.quoteDeposit[draftKey] = quotes.isEmpty ? nil : quotes } }
    }
    static var quoteDeposit: [String: [String]] = [:] // internal, for extensions
    /// Preview texts of pasted attachments (`file` → excerpt, see `PastedText`). On pasting
    /// the text is known; in the history the card loads it once.
    @Published var pastedPreviews: [String: String] = [:]
    @Published var artifacts: [ChatArtifact] = []
    @Published var artifactUploading = false
    @Published var queued: [QueuedMessage] = []
    @Published var controlRunning = false // "Steer" in flight — the button blocks a second abort

    @Published var permissionRequests: [PermissionRequest] = []
    @Published var providers: [Provider] = []
    /// The GLOBALLY active provider (`active` from `/api/providers`): an old chat without a stored
    /// provider computes its effort levels with it — like the web (`activeChat.provider || globalProvider`).
    @Published var activeProvider = ""
    @Published var busy = false
    @Published var waiting = false
    /// The running monitors of this chat (cbase_monitor) — they belong to the CHAT, not the turn
    /// (Chat/ChatMonitors.swift). `waitMonitors` is their short form.
    @Published var monitors: [MonitorView] = []
    /// Running subagents of this chat as the event stream reports them. ONE source for
    /// two forms: the wait-phase row (`waitAgents`) and the list in the subagents sheet
    /// (`subagents`). It used to be `[String]` — task and model in ONE text, the id
    /// thrown away; that made neither a stop nor a mapping to the history possible.
    @Published var waitAgentsLive: [SubagentLive] = []
    /// "Task · provider::model" per running subagent — for the run display in the history.
    /// Without a description (foreground subtask) the model stands alone instead of losing
    /// the row entirely.
    var waitAgents: [String] {
        waitAgentsLive.compactMap { agent in
            let model = agent.modelText
            if agent.description.isEmpty, model.isEmpty { return nil }
            if model.isEmpty { return agent.description }
            return agent.description.isEmpty ? model : "\(agent.description) · \(model)"
        }
    }
    /// Pace per running subagent in tokens per minute — empty as long as too few sample points
    /// exist (see `measureTempo`). An invented number would be worse than none.
    @Published var agentTempo: [String: Int] = [:]
    /// Running background commands (Bash with run_in_background) — third reason for the wait phase.
    @Published var waitTasks: [String] = []
    /// Continuation planned by the agent (ScheduleWakeup); nil = none.
    @Published var waitWakeupAt: Date?
    /// Reason and follow-up prompt of the wakeup — only for the info card of the status line.
    @Published var waitWakeupReason = ""
    @Published var waitWakeupPrompt = ""
    var lastClearAt: Double = 0 // internal, for extensions

    /// Current state of the CLI's own task list, derived from the sequence of Task* calls in the
    /// WHOLE history. Subagent blocks stay out — they keep their own lists.
    var nativeTasks: [NativeTask] { nativeTaskList(timeline.filter { !$0.dimmed }.flatMap(\.blocks)) }
    @Published var stopping = false
    @Published var compacting = false
    /// Autocompact: the global level, so the menu can say "Default · 60 %"
    /// and the context bar draws the threshold.
    @Published var autocompactGlobal: AutocompactDoc?
    @Published var uploading = false
    @Published var streamingText = false
    @Published var contextTokens = 0
    @Published var inputTokens = 0
    @Published var outputTokens = 0
    @Published var runStartedAt: Date?
    @Published var error = ""
    @Published var mentionResults: [String] = []
    /// Slash picker: the search behind the leading "/" (nil = closed) and the skills of this chat.
    /// The commands stand as a catalog in the model (`SlashCatalog`), the skills come from the server —
    /// which set applies is decided by the scope of the chat, not the device.
    @Published var slashQuery: String?
    @Published var slashSkills: [SkillSummary] = []
    /// The third group: the graph workflows of this chat as
    /// `/workflow:<shortname>` — only in the Coding chat (`withDynWorkflows`; agent chats do not start them), fetched on EVERY
    /// open like the skills. A typed "/name" no longer starts a stored DYNAMIC workflow.
    @Published var slashWorkflows: [WorkflowSummary] = []
    /// Coding chat only: the graph workflows in the slash picker AND the progress tree of the dynamic workflows
    /// in the subagents sheet. Agent chats build their model without.
    let withDynWorkflows: Bool
    // This model builds Coding chats only.
    /// The progress tree of the dynamic workflows of this chat (Chat/DynTree.swift) — "not loaded"
    /// until the route has answered; advanced from the `dynwf_tree` event (`ChatViewModel+DynTree.swift`).
    @Published var dynTree = DynTree.Snapshot()
    /// The transcripts of the workflow agents that the sheet has opened — key `<runId>#<n>`.
    @Published var dynTranscripts: [String: DynTranscript.Snapshot] = [:]
    /// The graph workflow starts of this chat (Chat/GraphRuns.swift) — "not loaded" until
    /// the route has answered; advanced from the `graph_run` event (`ChatViewModel+GraphRuns.swift`).
    /// From it the row "starts when the turn ends" or "waiting" in the composer strip.
    @Published var graphRuns = GraphRuns.Snapshot()
    /// The agenda of this Coding chat (Chat/Agenda.swift) — "not loaded" until the route has answered;
    /// advanced from the `agenda` event (`ChatViewModel+Agenda.swift`). Read only: the chat's agent leads it.
    @Published var agendaState = Agenda.Snapshot()
    /// The worktree rows the human has hidden — memory only, per `startId`.
    @Published var graphHidden: Set<String> = []
    /// A "Cancel" is in flight — the button blocks a second tap.
    @Published var graphStopRunning = false
    // The running workflow of this chat. Workflows are started via `/workflow:<shortname>` in the message,
    // the model starts them; there is no choice in the composer.
    @Published var workflowRun: WorkflowRunState?
    /// Run of this chat parked at the usage limit (auto-continue) — strip below the chat name.
    @Published var limitWait: LimitWaitState?
    @Published var limitBusy = false
    @Published var workflowBusy = false
    /// While the history is loaded from the server the view shows a loading animation
    /// instead of an empty screen.
    @Published var loadingLog: Bool

    let client: APIClient
    let workspace: Workspace
    let onChanged: () -> Void
    let onCreated: (Chat) -> Void
    /// Called as soon as the draft is created (in `ensureServerChat`), and after the first message of a chat created that way.
    /// The VIEW sets both (it knows `AppState` and the list) — the chat stays open in it, the list leads it only from the
    /// first message and reloads afterwards.
    var atCreation: ((Chat) -> Void)?
    var afterFirstMessage: ((Chat) -> Void)?
    /// Created, but the first message has not gone through yet — if it fails, the next successful one reports (`send`).
    var firstMessagePending = false // internal, for extensions
    /// The running creation of the draft: `isDraft` only becomes `false` with the response, and a second send during
    /// the `POST` created a SECOND chat. Every further caller of `ensureServerChat` waits for THIS job; afterwards it is `nil` again — a
    /// failure frees the way. The creation (`createChatNow`) runs only through here.
    var creationJob: Task<Void, Error>? // internal, for extensions
    // The Coding draft sends every value in the `POST`.

    var streamTask: Task<Void, Never>? // internal, for extensions
    var mentionTask: Task<Void, Never>? // internal, for extensions
    /// Draft of the composer in UserDefaults — only the text, not the attachments.
    /// Written throttled (300 ms), immediately on send, on moving to
    /// the background and via `flushDraft()`.
    var draftKey: String // internal, for extensions
    var draftTask: Task<Void, Never>? // internal, for extensions
    /// Only after loading in init may `didSet` write — otherwise loading would write the
    /// text just read straight back.
    private var draftReady = false
    private var draftObserver: (any NSObjectProtocol)?
    var pendingUploads: [String: (name: String, data: Data)] = [:] // internal, for extensions
    var eventStreamConnected = false // internal, for extensions
    /// Has this chat view been at the event stream before? Then every further
    /// "connected" message is a re-entry — with a gap before it (see `connected`).
    var hadStreamConnection = false // internal, for extensions
    var streamOpen = false // internal, for extensions
    var streamGotText = false // internal, for extensions
    var joinedMidRun = false // internal, for extensions
    /// The raw history rows `timeline` was last built from — the "own state" every `connected`
    /// reconciles against (`lastId`/`total`). Always a gapless section of the server history (with the window its END): rows that arrived live
    /// (`row`, `user_message` …) are NOT in it — otherwise `since` of the delta would be wrong (`ChatViewModel+Reconcile.swift`).
    var logRows: [LogEntry] = [] // internal, for extensions
    /// `logRows` comes from a SUCCESSFUL fetch. Not the same as "empty" (empty is not unknown): a failed first
    /// fetch means "state unknown", and the first `connected` fetches the whole history.
    var logLoaded = false // internal, for extensions
    /// The WINDOW (`ChatViewModel+Window.swift`): `logRows` is the end of the history from a bubble boundary, no
    /// longer its start. `logBeforeWindow` counts the server rows before it (reconciliation computes `logRows.count + logBeforeWindow`
    /// against `total`), `logOlder` says whether they exist, `loadingOlder` blocks a second reload.
    var logBeforeWindow = 0 // internal, for extensions
    var logOlder = false // internal, for extensions
    var loadingOlder = false // internal, for extensions
    /// The running fetch of the history (`loadHistory`) — `connected` waits for it instead of reconciling against a half state.
    var logJob: Task<Void, Never>? // internal, for extensions
    /// The highest row id appended as a `row` event — a row below it is already there.
    var streamRowsId = 0 // internal, for extensions
    /// The text of an error that the next successful reconciliation takes back: the stream broke off (`listen`) or the history did
    /// not arrive (`loadHistory`). Otherwise the red row stayed after a successful reconnect until
    /// the chat was left. The text, not a flag: an error that came afterwards (send, upload …) stays.
    var reconcileError = "" // internal, for extensions
    /// Return from the background: the stream is reconnected — for the Coding chat and the agent overlay
    /// alike, because both use this model.
    private var foregroundObserver: (any NSObjectProtocol)?
    /// An instance switch came mid-turn: fetch the history at the run end so its separator is there (`historyAfterInstanceSwitch`).
    var historyAfterRun = false // internal, for extensions
    var messageOutputBaseline = 0 // internal, for extensions
    /// Own messages that sit optimistically in the history and still wait for their echo from the
    /// event stream (see `echoUserMessage`). The server mirrors EVERY user row
    /// back to all clients — without this list the own one would appear twice.
    var pendingEchoes: [PendingEcho] = [] // internal, for extensions

    struct PendingEcho { // internal, for extensions
        let id: String
        let text: String
    }

    init(
        client: APIClient,
        workspace: Workspace,
        chat: Chat?,
        /// The values of a draft (`chat == nil`): project, folder, model, level, instance — what the "New
        /// chat" entry chose. They accompany it until the first message
        /// actually creates the chat.
        preset: NewChatDraft = NewChatDraft(),
        /// Only the Coding chat (`ChatView`) offers stored dynamic workflows in the slash picker and
        /// shows the progress tree.
        withDynWorkflows: Bool = false,
        onChanged: @escaping () -> Void,
        onCreated: @escaping (Chat) -> Void
    ) {
        self.client = client
        self.workspace = workspace
        self.withDynWorkflows = withDynWorkflows
        self.onChanged = onChanged
        self.onCreated = onCreated
        if let chat {
            self.chat = chat
            isDraft = false
            contextTokens = chat.contextTokens
            loadingLog = true
            draftKey = Self.draftKey(chatId: chat.id)
        } else {
            let project = preset.projectId.isEmpty ? nil : preset.projectId
            let folder = preset.folderId.isEmpty ? nil : preset.folderId
            var draft = Chat(
                id: "draft-\(UUID().uuidString)",
                workspaceId: workspace.id,
                projectId: project,
                folderId: folder,
                model: preset.model,
                permissionMode: preset.permissionMode,
                effort: preset.effort,
                ultracode: preset.ultracode,
                provider: preset.provider,
                browserMode: preset.browserMode,
                kind: "normal"
            )
            // The instance belongs to the project — without a project none.
            draft.instance = project != nil ? ChatInstanceRules.binding(preset.instance) : nil
            self.chat = draft
            isDraft = true
            contextTokens = 0
            loadingLog = false
            draftKey = Self.draftKey(newIn: workspace, projectId: project, folderId: folder)
        }
        input = UserDefaults.standard.string(forKey: draftKey) ?? ""
        quotes = Self.quoteDeposit[draftKey] ?? []
        draftReady = true
        // On moving to the background write immediately — the throttle must not lose the text
        // to a swipe up. The observer is removed again in deinit.
        draftObserver = NotificationCenter.default.addObserver(
            forName: UIApplication.willResignActiveNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            MainActor.assumeIsolated { self?.flushDraft() }
        }
        // Back from the background: RECONNECT the stream. `ChatView` alone used to call `reloadChatAndLog()` + `start()` on the switch
        // to `.active` — the reload replaced the open bubble mid-turn, and `start()`
        // did nothing because the old (often dead) stream still stood.
        foregroundObserver = NotificationCenter.default.addObserver(
            forName: UIApplication.willEnterForegroundNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            MainActor.assumeIsolated { self?.reconnect() }
        }
    }

    deinit {
        streamTask?.cancel()
        mentionTask?.cancel()
        logJob?.cancel()
        if let draftObserver { NotificationCenter.default.removeObserver(draftObserver) }
        if let foregroundObserver { NotificationCenter.default.removeObserver(foregroundObserver) }
    }

    /// Sample points per subagent for the pace: (time, token count). Sliding window, see
    /// `measureTempo`.
    var tempoLane: [String: [(time: Date, tokens: Int)]] = [:] // internal, for extensions
    /// Last reported token kind per subagent — survives the agent (see `applyWaitState`).
    var tokenKindSeen: [String: String] = [:] // internal, for extensions
    /// Status from the report per subagent call, remembered with the length of the result it
    /// was read from. `agentStates` is asked on every stage update (every token),
    /// and `agentReport` decodes the whole JSON of the result — without this memory every
    /// token would re-read every report of the history.
    var reportStatusRemembered: [String: (length: Int, status: String)] = [:] // internal, for extensions

}

// ── Subagents: the two forms of an agent ─────────────────────────────────────────
//
// RUNNING it comes from the event stream (`SubagentLive`, payload contract), FINISHED from
// the history of this chat. Both are merged into ONE list in `ChatViewModel.subagents`
// — `SubagentEntry` is what the display sees of it.

/// A running subagent as the server reports it. The fields are the payload, 1:1.
struct SubagentLive: Identifiable, Hashable, Sendable {
    /// The only kind WITHOUT "at least": the provider counts input AND output (Claude). Every other — only output
    /// (Codex, loop engine) or unknown — carries the marker (`ChatViewModel.tokenLowerLimit`): an
    /// understated number cannot otherwise be told from a complete one.
    static let tokenKindFull = "full"

    let taskId: String
    let agentId: String
    let description: String
    let name: String
    let provider: String
    let model: String
    let status: String
    let startedAt: Date?
    let tokens: Int
    let tokenKind: String
    let toolUses: Int
    /// Parked at the usage limit: when it resumes — only with status "parked", else `nil`.
    let parkedUntil: Date?
    /// A call waits for it — only then does the "Move to background" button show. The server sets the field
    /// only on foreground agents; if it is missing, it is a background agent.
    let foreground: Bool
    /// "CPU saver": a Bash command waits for CPU before starting. If the field is missing, it does not wait.
    let waitingForCpu: Bool

    /// `agentId` is the identifier `POST /agent/stop` works with; without it the
    /// task id stays (background agents of the Claude CLI report through it).
    var id: String { agentId.isEmpty ? taskId : agentId }

    /// Notation as everywhere in the app ("provider::model"); without a model the
    /// provider stands alone. A placeholder from the server ("(provider default)") is
    /// no model name and counts here as "no model".
    var modelText: String {
        if !model.isEmpty, !model.hasPrefix("(") {
            return provider.isEmpty ? model : "\(provider)::\(model)"
        }
        return provider
    }

    init(json: JSONValue) {
        taskId = json["taskId"]?.stringValue ?? ""
        agentId = json["agentId"]?.stringValue ?? ""
        description = json["description"]?.stringValue ?? ""
        name = json["name"]?.stringValue ?? ""
        provider = json["provider"]?.stringValue ?? ""
        model = json["model"]?.stringValue ?? ""
        status = json["status"]?.stringValue ?? ""
        let start = json["startedAt"]?.doubleValue ?? 0
        startedAt = start > 0 ? Date(timeIntervalSince1970: start / 1000) : nil
        tokens = json["tokens"]?.intValue ?? 0
        tokenKind = json["tokenKind"]?.stringValue ?? ""
        toolUses = json["toolUses"]?.intValue ?? 0
        let until = json["parkedUntil"]?.doubleValue ?? 0
        parkedUntil = status == "parked" && until > 0 ? Date(timeIntervalSince1970: until / 1000) : nil
        foreground = json["foreground"]?.boolValue ?? false
        waitingForCpu = json["waitingForCpu"]?.boolValue ?? false
    }
}

/// A subagent as the display needs it — running or finished, from one source or from
/// both. `nil` for a number means "not known" and is shown as a gap, not as 0.
struct SubagentEntry: Identifiable, Hashable {
    let id: String
    /// The call in the history it belongs to — by it the sheet recognizes which entry a
    /// tapped marker means.
    let blockId: String?
    /// Identifier for `POST /agent/stop`; empty ⇒ no stop possible.
    let agentId: String
    let job: String
    let model: String
    /// "running" · "completed" · "failed" · "stopped" — empty if no source names it.
    let status: String
    let running: Bool
    /// Start time of a running agent; the display computes the runtime from it every second.
    let startedAt: Date?
    /// Runtime of a FINISHED agent in seconds (from its report).
    let runtime: Int?
    let tokens: Int?
    let onlyOutput: Bool
    /// Tokens per minute — only for running ones, and only with enough sample points (see `measureTempo`).
    let tempo: Int?
    let tools: Int
    /// What the MAIN AGENT read. Empty while the agent works.
    let report: String
    /// The child calls — the reasoning below the report.
    let steps: [ChatBlock]
    let error: Bool
    /// The state, computed ONCE per agent (`HistoryState.agent`) — the same answer the marker in the history
    /// reads via `chatAgentStates`. `nil` = finished (no word). `running` follows from it.
    let state: HistoryState.Agent?
    /// Parked at the usage limit: when it resumes. `nil` while it works or is finished.
    var parkedUntil: Date? = nil
    /// A running foreground agent a call waits for — button "Move to background".
    var foreground: Bool = false
    /// "CPU saver": a command waits for CPU before starting — adds "waiting for CPU" to the card.
    var waitingForCpu: Bool = false

    /// Stopped by hand (server status "stopped"). The marker in the history carries this state.
    var stopped: Bool { status == "stopped" }

    /// "waiting until 14:05" — the same computation as on the web (`waitingUntilText` in web/src/lib/agents.ts): local time of the
    /// device, 24 hours, two digits.
    static func waitingUntilText(_ until: Date) -> String {
        let parts = Calendar.current.dateComponents([.hour, .minute], from: until)
        let time = String(format: "%02d:%02d", parts.hour ?? 0, parts.minute ?? 0)
        return L("waiting until {time}", ["time": time])
    }
}

/// `SubagentEntry` is `Hashable` (the sheet's list compares entries), so its state must be too.
/// Equality is synthesized by `HistoryState.swift` itself; the hash value
/// lives here because Swift can only synthesize it in the file of the type — and that file belongs
/// to the bound computation (it is run as a whole with `xcrun swift` against the web).
extension HistoryState.Agent: Hashable {
    func hash(into hasher: inout Hasher) {
        hasher.combine(identifier)
        hasher.combine(word)
        hasher.combine(tone)
        hasher.combine(pulses)
    }
}
