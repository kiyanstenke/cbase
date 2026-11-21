import Foundation

// ── Workflows (node/edge graph the agent works through step by step) ─────────
enum WorkflowNodeType: String, Codable, CaseIterable, Sendable {
    case trigger, start, instruction, condition, loop, parallel, ask, review, end

    var displayLabel: String {
        switch self {
        case .trigger: return "GitLab trigger"
        case .start: return "Start##noun"
        case .instruction: return "Instruction"
        case .condition: return "Condition"
        case .loop: return "Loop"
        case .parallel: return "Parallel"
        case .ask: return "Question##ask"
        case .review: return "Review"
        case .end: return "End"
        }
    }

    var symbol: String {
        switch self {
        case .trigger: return "bolt.circle"
        case .start: return "play.circle"
        case .instruction: return "text.alignleft"
        case .condition: return "arrow.triangle.branch"
        case .loop: return "arrow.triangle.2.circlepath"
        case .parallel: return "arrow.triangle.pull"
        case .ask: return "questionmark.bubble"
        case .review: return "person.crop.circle.badge.checkmark"
        case .end: return "stop.circle"
        }
    }

}

struct WorkflowNode: Codable, Identifiable, Hashable, Sendable {
    var id: String
    var type: WorkflowNodeType
    var title: String
    var text: String
    /// Optional message run before this node's actual work.
    var command: String
    var x: Double
    var y: Double
    var items: [String]
    var maxIterations: Int
    /// Configuration of a trigger node, UNCHANGED as the server delivered it. It is not edited on the iPhone, but sent
    /// along again on save — otherwise a trigger set up on the desktop would be empty after a move on the phone.
    var trigger: JSONValue?
    /// Round cap per step (0 = inherited: the largest in the cycle, otherwise the server default). Without it ONE "Save"
    /// on the phone would silently wipe the caps set on the desktop.
    var maxVisits: Int
    /// Checkbox "notify on reaching" — passed through as well. On a review node it is ON by default (as the server has
    /// it), otherwise off.
    var notify: Bool
    /// Three-valued instead of two checkboxes (`doneCheck`, `capAuto`): "Like workflow" is the default, the node
    /// overrides. The rules are in Workflows/WorkflowRules.swift. `doneMode` = check completion (instruction/parallel),
    /// `doneCapMode` = at the check cap, `loopCapMode` = at the round cap of a cycle.
    var doneMode: WorkflowDoneMode
    var doneCapMode: WorkflowCapMode
    var loopCapMode: WorkflowCapMode
    /// Yardstick of the completion gate: after the turn a model judges whether the step is done; "not done" lets the
    /// SAME step keep working.
    var doneText: String

    init(id: String, type: WorkflowNodeType, title: String, text: String = "", command: String = "", x: Double, y: Double, items: [String] = [], maxIterations: Int = 20, trigger: JSONValue? = nil, maxVisits: Int = 0, notify: Bool = false, doneMode: WorkflowDoneMode = .inherit, doneCapMode: WorkflowCapMode = .inherit, loopCapMode: WorkflowCapMode = .inherit, doneText: String = "") {
        self.id = id
        self.type = type
        self.title = title
        self.text = text
        self.command = command
        self.x = x
        self.y = y
        self.items = items
        self.maxIterations = maxIterations
        self.trigger = trigger
        self.maxVisits = maxVisits
        self.notify = notify
        self.doneMode = doneMode
        self.doneCapMode = doneCapMode
        self.loopCapMode = loopCapMode
        self.doneText = doneText
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = c.str(.id)
        type = WorkflowNodeType(rawValue: c.str(.type)) ?? .instruction
        title = c.str(.title)
        text = c.str(.text)
        command = c.str(.command)
        x = c.dbl(.x)
        y = c.dbl(.y)
        items = c.strings(.items)
        maxIterations = c.int(.maxIterations, 20)
        trigger = c.json(.trigger)
        maxVisits = c.int(.maxVisits, 0)
        // If the field is missing, the same rule as on the server applies: on for review, otherwise off.
        notify = c.boolOpt(.notify) ?? (type == .review)
        // The three modes — with the legacy reading in ONE place (`WorkflowRules.nodeModes`): an older graph still carries
        // `doneCheck`/`capAuto`.
        let modes = WorkflowRules.nodeModes(
            doneMode: c.strOpt(.doneMode), doneCapMode: c.strOpt(.doneCapMode), loopCapMode: c.strOpt(.loopCapMode),
            doneCheck: c.boolOpt(.doneCheck), capAuto: c.boolOpt(.capAuto)
        )
        doneMode = modes.doneMode
        doneCapMode = modes.doneCapMode
        loopCapMode = modes.loopCapMode
        doneText = c.str(.doneText)
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(id, forKey: .id)
        try c.encode(type.rawValue, forKey: .type)
        try c.encode(title, forKey: .title)
        try c.encode(text, forKey: .text)
        if !command.isEmpty { try c.encode(command, forKey: .command) }
        try c.encode(Int(x), forKey: .x)
        try c.encode(Int(y), forKey: .y)
        // items/maxIterations belong to the loop only — otherwise they would be ballast in the graph.
        if type == .loop {
            try c.encode(items, forKey: .items)
            try c.encode(maxIterations, forKey: .maxIterations)
        }
        if type == .trigger, let trigger { try c.encode(trigger, forKey: .trigger) }
        if maxVisits > 0 { try c.encode(maxVisits, forKey: .maxVisits) }
        // Always write: "false" on a review node is an opt-OUT and must not pass as "not set" (there the default is
        // on).
        try c.encode(notify, forKey: .notify)
        // ALWAYS write the three modes — an explicit "off" must not pass as "not set" (if the key is missing, the server
        // reads the legacy state, and that would be "like workflow" = ON for "check all"). The legacy fields
        // `doneCheck`/`capAuto` never go out any more.
        try c.encode(doneMode.rawValue, forKey: .doneMode)
        try c.encode(doneCapMode.rawValue, forKey: .doneCapMode)
        try c.encode(loopCapMode.rawValue, forKey: .loopCapMode)
        if !doneText.isEmpty { try c.encode(doneText, forKey: .doneText) }
    }

    enum CodingKeys: String, CodingKey { case id, type, title, text, command, x, y, items, maxIterations, trigger, maxVisits, capAuto, notify, doneCheck, doneMode, doneCapMode, loopCapMode, doneText }

    /// The node as `WorkflowRules` computes it.
    var ruleNode: WorkflowRules.Node {
        WorkflowRules.Node(id: id, type: type.rawValue, title: title, maxVisits: maxVisits, doneMode: doneMode, doneCapMode: doneCapMode, loopCapMode: loopCapMode)
    }

    /// One-liner for display: "All my projects · 2 events".
    var triggerSummary: String {
        guard let trigger else { return L("(not configured)") }
        let scope = trigger["scope"]?.stringValue ?? "all"
        let where_: String
        switch scope {
        case "project": where_ = trigger["projectPath"]?.stringValue ?? L("project?")
        case "group": where_ = trigger["groupPath"]?.stringValue ?? L("group?")
        default: where_ = L("All my projects")
        }
        let count = trigger["events"]?.arrayValue?.count ?? 0
        return "\(where_) · \(count == 1 ? L("1 event") : L("{n} events", ["n": String(count)]))"
    }
}

/// Edge label: condition (yes/no) or loop (per item/done).
enum WorkflowBranch: String, Codable, Sendable {
    case yes = "true"
    case no = "false"
    case each
    case done
    case ok
    case issues

    var displayLabel: String {
        switch self {
        case .yes: return "Yes"
        case .no: return "No"
        case .each: return "per item"
        case .done: return "done"
        case .ok: return "Approve##noun"
        case .issues: return "Findings"
        }
    }
}

struct WorkflowEdge: Codable, Identifiable, Hashable, Sendable {
    var from: String
    var to: String
    var branch: WorkflowBranch?
    /// Sides of the edge in the desktop editor ("left"/"right", empty = unchosen) — pure presentation, neither shown nor
    /// edited on the iPhone, but PASSED THROUGH on save: otherwise a "Save" on the phone would delete every side chosen
    /// or frozen on the desktop.
    var fromSide: String?
    var toSide: String?

    var id: String { "\(from)>\(to):\(branch?.rawValue ?? "")" }

    init(from: String, to: String, branch: WorkflowBranch? = nil, fromSide: String? = nil, toSide: String? = nil) {
        self.from = from
        self.to = to
        self.branch = branch
        self.fromSide = fromSide
        self.toSide = toSide
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        from = c.str(.from)
        to = c.str(.to)
        branch = c.strOpt(.branch).flatMap { WorkflowBranch(rawValue: $0) }
        fromSide = c.strOpt(.fromSide)
        toSide = c.strOpt(.toSide)
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(from, forKey: .from)
        try c.encode(to, forKey: .to)
        try c.encodeIfPresent(branch?.rawValue, forKey: .branch)
        try c.encodeIfPresent(fromSide, forKey: .fromSide)
        try c.encodeIfPresent(toSide, forKey: .toSide)
    }

    enum CodingKeys: String, CodingKey { case from, to, branch, fromSide, toSide }
}

struct WorkflowGraph: Codable, Hashable, Sendable {
    var nodes: [WorkflowNode] = []
    var edges: [WorkflowEdge] = []
}

struct WorkflowProblem: Codable, Identifiable, Hashable, Sendable {
    var id: String { "\(level)-\(nodeId ?? "")-\(text)" }
    let level: String
    let nodeId: String?
    let text: String

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        level = c.str(.level, "warn")
        nodeId = c.strOpt(.nodeId)
        text = c.str(.text)
    }

    enum CodingKeys: String, CodingKey { case level, nodeId, text }
}

struct WorkflowSteps: Codable, Hashable, Sendable {
    let total: Int
    let approx: Bool

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        total = c.int(.total)
        approx = c.bool(.approx)
    }

    enum CodingKeys: String, CodingKey { case total, approx }
}

// Decodable only: the app READS summaries (lists) but never sends them back. Codable failed from Xcode 26 on at the
// Encodable synthesis (CodingKey "triggers" without a field of that name — `triggerCount` is derived from it); the old
// compiler had let it pass.
/// A skill as the slash picker in the composer needs it.
///
/// Every field except `name` is OPTIONAL, and that is deliberate: a synthesized `Decodable` demands EVERY non-optional
/// key, and the response arrives with differing scope depending on route and server version (`/api/chats/:id/skills`
/// carries `originProject`, older versions and the test fixture do not). A missing field must not make the WHOLE list
/// unreadable here — the picker would then be empty with no error anywhere.
struct SkillSummary: Decodable, Identifiable, Hashable, Sendable {
    var name: String
    var description: String?
    /// Project a skill comes from — set ONLY in the workspace view.
    var originProject: String?

    var id: String { name }
}

/// A saved dynamic workflow in the chat's effective view — the third group of the slash picker. Tolerant like
/// `SkillSummary`: `enabled` is carried only by the project view of a draft (`/api/projects/:id/workspace-dyn-workflows`),
/// not by the chat and workspace routes.
struct DynWorkflowSummary: Decodable, Identifiable, Hashable, Sendable {
    var name: String
    var description: String?
    var enabled: Bool?

    var id: String { name }
}

/// An entry of the dynamic-workflows library — the list of the coding category "Dynamic workflows"
/// (`GET /api/workspaces/:id/dyn-workflows`, in a project `GET /api/projects/:id/workspace-dyn-workflows` with `enabled`),
/// with `script` and `meta` the view (`GET /api/workspaces/:id/dyn-workflows/:id`). Server shape: dynworkflows/routes.js
/// `entryShort`/`entryFull`. TOLERANT: an entry without `whenToUse` or without `phases` (even without the field
/// entirely) must not make the list unreadable — a synthesized `Decodable` would demand every key.
struct DynWorkflowEntry: Decodable, Identifiable, Hashable, Sendable {
    struct Phase: Hashable, Sendable {
        let title: String
        let detail: String
    }

    let id: String
    var name: String
    var description: String
    var title: String?
    var whenToUse: String?
    var phases: [Phase]
    /// Only the project view carries it; `nil` means "not asked", not "off".
    var enabled: Bool?
    /// Only the view carries it — BYTE-EQUAL as saved (interchangeable with Claude Code).
    var script: String?

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = c.str(.id)
        name = c.str(.name)
        description = c.str(.description)
        title = c.strOpt(.title)
        whenToUse = c.strOpt(.whenToUse)
        phases = (c.json(.phases)?.arrayValue ?? []).compactMap { p in
            guard let t = p["title"]?.stringValue else { return nil }
            return Phase(title: t, detail: p["detail"]?.stringValue ?? "")
        }
        enabled = c.boolOpt(.enabled)
        script = c.strOpt(.script)
    }

    enum CodingKeys: String, CodingKey { case id, name, description, title, whenToUse, phases, enabled, script }
}

struct WorkflowSummary: Decodable, Identifiable, Hashable, Sendable {
    let id: String
    var name: String
    var description: String
    var originProject: String?
    /// Project of a project workflow (id) — a channel chat with such a workflow gets this project; workspace workflows
    /// carry nil.
    var projectId: String?
    var nodeCount: Int
    var steps: WorkflowSteps
    var enabled: Bool?
    /// Trigger of this workflow armed (the server polls GitLab). Set up on the desktop — but on the iPhone one should SEE
    /// that a workflow can start by itself.
    var active: Bool
    var triggerCount: Int
    /// The form under which the workflow is named in a message — `/workflow:<shortname>`. The SERVER computes it once over
    /// the chat's effective set (`workflows/shortName.js`); the app never computes it. If it is missing (older server, a
    /// list without picker context), the entry is missing from the slash picker — nothing is guessed.
    var shortName: String?
    /// Name with origin project — as it appears on the channel card and in the picker.
    var displayName: String { originProject.map { "\(name) (\($0))" } ?? name }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = c.str(.id)
        name = c.str(.name, "Workflow")
        description = c.str(.description)
        originProject = c.strOpt(.originProject)
        projectId = c.strOpt(.projectId)
        nodeCount = c.int(.nodeCount)
        steps = (try? c.decode(WorkflowSteps.self, forKey: .steps)) ?? WorkflowSteps.empty
        enabled = c.boolOpt(.enabled)
        active = c.bool(.active)
        triggerCount = c.json(.triggers)?.arrayValue?.count ?? 0
        shortName = c.strOpt(.shortName).flatMap { $0.isEmpty ? nil : $0 }
    }

    enum CodingKeys: String, CodingKey { case id, name, description, originProject, projectId, nodeCount, steps, enabled, active, triggers, shortName }
}

extension WorkflowSteps {
    static let empty: WorkflowSteps = {
        // No decoder at hand — via an empty JSON detour so the init stays uniform.
        (try? JSONDecoder().decode(WorkflowSteps.self, from: Data(#"{"total":0,"approx":false}"#.utf8)))!
    }()

    /// "3 steps", "about 3 steps" — and the singular "1 step".
    func label() -> String {
        if total == 1 { return approx ? L("approx. 1 step") : L("1 step") }
        return approx ? L("approx. {n} steps", ["n": String(total)]) : L("{n} steps", ["n": String(total)])
    }
}

/// Run settings of a workflow (`run`), as the web editor knows them: provider, model, permissions and effort — plus the
/// check model of the completion gate ("Check completion"). Empty fields mean "as usual". The right to create to-dos
/// (`todos`) is gone: a coding chat only reads the task list; an old field in the JSON is ignored.
///
/// Six more fields: compaction (`autocompact`, `autocompactMax` — `nil` = default, 0 = off, otherwise a level),
/// "Check all work steps" (`doneAll`, missing means ON), check rounds (`doneRounds`, 1…10) and the behaviour at the two
/// caps (`doneCapAuto`, `loopCapAuto`). None of them ever lands on the chat.
///
/// The server takes `run` as a PARTIAL PATCH over the stored state (`{...old, ...raw}`): a missing key means
/// "unchanged", an explicit `null` means "back to default". Hence a custom `encode` that WRITES "default" as `null` — a
/// synthesized Encodable would omit the key for `nil`, and a "default" after a level would never reach the server (the
/// same pattern as `setAutocompact` in the chat, Chat/ChatViewModel+Provider.swift).
struct WorkflowRunSettings: Codable, Hashable, Sendable {
    var provider: String = ""
    var model: String = ""
    var permissionMode: String = ""
    var effort: String = ""
    /// Ultracode: the chat's switch for every step — independent of the effort level.
    var ultracode: Bool = false
    var doneProvider: String = ""
    var doneModel: String = ""
    var autocompact: Int? = nil
    var autocompactMax: Int? = nil
    var doneAll: Bool = true
    var doneRounds: Int = 3
    var doneCapAuto: Bool = false
    var loopCapAuto: Bool = false

    init() {}

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        provider = c.str(.provider)
        model = c.str(.model)
        permissionMode = c.str(.permissionMode)
        effort = c.str(.effort)
        // Optional: an older server does not send the field — missing means off.
        ultracode = c.bool(.ultracode)
        doneProvider = c.str(.doneProvider)
        doneModel = c.str(.doneModel)
        autocompact = c.intOpt(.autocompact)
        autocompactMax = c.intOpt(.autocompactMax)
        // Missing means ON — like `r.doneAll !== false` on the server (an older server does not send it).
        doneAll = c.boolOpt(.doneAll) ?? true
        doneRounds = c.int(.doneRounds, 3)
        doneCapAuto = c.bool(.doneCapAuto)
        loopCapAuto = c.bool(.loopCapAuto)
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(provider, forKey: .provider)
        try c.encode(model, forKey: .model)
        try c.encode(permissionMode, forKey: .permissionMode)
        try c.encode(effort, forKey: .effort)
        try c.encode(ultracode, forKey: .ultracode)
        try c.encode(doneProvider, forKey: .doneProvider)
        try c.encode(doneModel, forKey: .doneModel)
        if let autocompact { try c.encode(autocompact, forKey: .autocompact) } else { try c.encodeNil(forKey: .autocompact) }
        if let autocompactMax { try c.encode(autocompactMax, forKey: .autocompactMax) } else { try c.encodeNil(forKey: .autocompactMax) }
        try c.encode(doneAll, forKey: .doneAll)
        try c.encode(doneRounds, forKey: .doneRounds)
        try c.encode(doneCapAuto, forKey: .doneCapAuto)
        try c.encode(loopCapAuto, forKey: .loopCapAuto)
    }

    enum CodingKeys: String, CodingKey {
        case provider, model, permissionMode, effort, ultracode, doneProvider, doneModel
        case autocompact, autocompactMax, doneAll, doneRounds, doneCapAuto, loopCapAuto
    }

    /// The three values nodes inherit — for `WorkflowRules`.
    var rule: WorkflowRules.Rule {
        WorkflowRules.Rule(doneAll: doneAll, doneCapAuto: doneCapAuto, loopCapAuto: loopCapAuto)
    }
}

/// Limits of the machinery as the server sends them with the full view (`limits` in workflows/definitions.js): the
/// editor labels caps and steppers with them instead of maintaining the numbers twice. The defaults are the web editor's
/// for a response without `limits`.
struct WorkflowLimits: Codable, Hashable, Sendable {
    /// Default cap per step in ONE run (the placeholder "5 · Default").
    var maxVisits = 5
    /// Upper bound of the "Rounds per run" stepper.
    var maxVisitsLimit = 99
    /// Upper bound of the "Max. items" stepper of the loop.
    var maxIterations = 50
    /// The SAVED check-round count of this workflow (for old clients) — the editor reads `run.doneRounds`, the editing
    /// state.
    var doneRounds = 3
    /// Upper bound of the check rounds ("Check rounds" stepper).
    var doneRoundsMax = 10

    init() {}

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        maxVisits = c.int(.maxVisits, 5)
        maxVisitsLimit = c.int(.maxVisitsLimit, 99)
        maxIterations = c.int(.maxIterations, 50)
        doneRounds = c.int(.doneRounds, 3)
        doneRoundsMax = c.int(.doneRoundsMax, 10)
    }

    enum CodingKeys: String, CodingKey { case maxVisits, maxVisitsLimit, maxIterations, doneRounds, doneRoundsMax }
}

/// Concurrency of a workflow: which key makes two runs mutually exclusive (`WorkflowRules.lockRanges`) and, for
/// "custom", the template.
struct WorkflowLock: Codable, Hashable, Sendable {
    var scope: String = "project"
    var template: String = ""

    init(scope: String = "project", template: String = "") {
        self.scope = scope
        self.template = template
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let s = c.str(.scope, "project")
        scope = WorkflowRules.lockRanges.contains(s) ? s : "project"
        template = c.str(.template)
    }

    enum CodingKeys: String, CodingKey { case scope, template }
}

/// A lock currently held by this workflow ("Currently locked: …").
struct WorkflowHolding: Codable, Hashable, Sendable {
    var key: String
    var chatId: String
    var at: Double

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        key = c.str(.key)
        chatId = c.str(.chatId)
        at = c.dbl(.at)
    }

    enum CodingKeys: String, CodingKey { case key, chatId, at }
}

/// Operating state of a trigger (`triggerViews` on the server): where it listens, whether it is fully set up (`missing`
/// empty) and when it last fired. Set up on the desktop.
struct WorkflowTriggerView: Codable, Hashable, Sendable, Identifiable {
    var nodeId: String
    var title: String
    var target: String
    var events: [String]
    var missing: String
    var fires: Int
    var lastFireAt: Double
    var lastError: String
    var id: String { nodeId }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        nodeId = c.str(.nodeId)
        title = c.str(.title)
        target = c.str(.target)
        events = c.strings(.events)
        missing = c.str(.missing)
        fires = c.int(.fires)
        lastFireAt = c.dbl(.lastFireAt)
        lastError = c.str(.lastError)
    }

    enum CodingKeys: String, CodingKey { case nodeId, title, target, events, missing, fires, lastFireAt, lastError }
}

struct WorkflowDetail: Codable, Identifiable, Hashable, Sendable {
    let id: String
    var name: String
    var description: String
    /// Project of a project workflow (id), workspace workflows carry nil — like `WorkflowSummary`.
    var projectId: String?
    var graph: WorkflowGraph
    var problems: [WorkflowProblem]
    var run: WorkflowRunSettings
    /// Missing in the response (fixture, older server) → the defaults; a synthesized `Decodable` would demand EVERY key
    /// and make the whole view unreadable.
    var limits: WorkflowLimits
    /// Armed (the server polls the triggers), trigger state, concurrency and the currently held locks — also on mobile
    /// (settings sheet). If missing (older server), the defaults apply.
    var active: Bool
    var triggers: [WorkflowTriggerView]
    var lock: WorkflowLock
    var holding: [WorkflowHolding]

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = c.str(.id)
        name = c.str(.name, "Workflow")
        description = c.str(.description)
        projectId = c.strOpt(.projectId)
        graph = (try? c.decode(WorkflowGraph.self, forKey: .graph)) ?? WorkflowGraph()
        problems = (try? c.decode([WorkflowProblem].self, forKey: .problems)) ?? []
        run = (try? c.decodeIfPresent(WorkflowRunSettings.self, forKey: .run)) ?? WorkflowRunSettings()
        limits = (try? c.decodeIfPresent(WorkflowLimits.self, forKey: .limits)) ?? WorkflowLimits()
        active = c.bool(.active)
        triggers = c.list(.triggers, WorkflowTriggerView.self)
        lock = (try? c.decodeIfPresent(WorkflowLock.self, forKey: .lock)) ?? WorkflowLock()
        holding = c.list(.holding, WorkflowHolding.self)
    }

    enum CodingKeys: String, CodingKey { case id, name, description, projectId, graph, problems, run, limits, active, triggers, lock, holding }
}

/// Running (or last run) workflow of a chat — basis of the progress strip.
struct WorkflowRunState: Decodable, Identifiable, Hashable, Sendable {
    let id: String
    let chatId: String
    let workflowId: String
    let name: String
    let status: String      // running | waiting | done | failed | cancelled
    let step: Int
    let total: Int
    let approx: Bool
    let nodeTitle: String
    let question: String
    let note: String
    /// What a waiting run waits for: "" = question node, "cap" = round cap, "review" = a human is to check the state.
    let pending: String
    let loopIndex: Int?
    let loopTotal: Int?
    let loopItem: String?
    let startedAt: Double
    let updatedAt: Double
    /// 0 = still running. The client computes the total runtime: (endedAt || now) − startedAt.
    let endedAt: Double
    /// The workflow's OWN compaction: `nil` = default (chat, otherwise global), 0 = off, otherwise level or cap in tokens.
    /// Applies while the run is open.
    let compactionPercent: Int?
    let compactionMax: Int?
    /// Does the workflow have its own compaction that currently applies? Then the chat's auto menu shows the hint line,
    /// and the context-trace marker computes with the workflow value.
    var compactionApplies: Bool { isActive && (compactionPercent != nil || compactionMax != nil) }

    var isActive: Bool { status == "running" || status == "waiting" }

    /// Total runtime of this run at time `now`. A workflow consists of many turns — the runtime per answer does not say
    /// how long the run has been going IN TOTAL.
    func runtime(at now: Date) -> TimeInterval? {
        guard startedAt > 0 else { return nil }
        let end = endedAt > 0 ? endedAt / 1000 : now.timeIntervalSince1970
        return max(0, end - startedAt / 1000)
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = c.str(.id)
        chatId = c.str(.chatId)
        workflowId = c.str(.workflowId)
        name = c.str(.name, "Workflow")
        status = c.str(.status, "running")
        step = c.int(.step)
        total = c.int(.total)
        approx = c.bool(.approx)
        nodeTitle = c.str(.nodeTitle)
        question = c.str(.question)
        note = c.str(.note)
        pending = c.str(.pending)
        startedAt = c.dbl(.startedAt)
        updatedAt = c.dbl(.updatedAt)
        endedAt = c.dbl(.endedAt)
        let loop = try? c.decodeIfPresent(LoopState.self, forKey: .loop)
        loopIndex = loop?.index
        loopTotal = loop?.total
        loopItem = loop?.item
        let compaction = (try? c.decodeIfPresent(Compaction.self, forKey: .compaction)) ?? nil
        compactionPercent = compaction?.percent
        compactionMax = compaction?.max
    }

    private struct Compaction: Decodable, Sendable {
        let percent: Int?
        let max: Int?
        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            percent = c.intOpt(.percent)
            max = c.intOpt(.max)
        }
        enum CodingKeys: String, CodingKey { case percent, max }
    }

    private struct LoopState: Decodable, Sendable {
        let index: Int
        let total: Int
        let item: String
    }

    enum CodingKeys: String, CodingKey {
        case id, chatId, workflowId, name, status, step, total, approx, nodeTitle, question, note, pending, loop, startedAt, updatedAt, endedAt, compaction
    }
}

struct WorkflowRunResponse: Decodable, Sendable {
    let run: WorkflowRunState?
}

/// A run stuck at the provider's usage limit and resumed automatically (5-hour/weekly window on Claude, primary/secondary
/// on Codex). Decodable ONLY — the state comes exclusively from the server.
struct LimitWaitState: Decodable, Identifiable, Hashable, Sendable {
    var id: String { chatId }
    let chatId: String
    let kind: String         // run = repeat turn · compact = catch up compaction
    let provider: String
    let group: String        // session | weekly | credits | spend
    let label: String
    let limitText: String    // fully translated by the server
    let reason: String       // reset | probe
    let dueAt: Double
    let resetsAt: Double?
    let attempts: Int
    let maxAttempts: Int
    let evidence: String
    let updatedAt: Double
    /// The credit gate parked it, not a limit that hit: the run WOULD have started, the blocking window only sits above
    /// the mark. Only then may the strip offer "Start anyway" — with a real limit hit the turn would not get through
    /// anyway, and the button would be a trap.
    ///
    /// An explicit mark from the server, no text comparison on `reason == "credit-gate"`: a button's label must not hang on a
    /// string.
    ///
    /// Default `false`: a server that does not carry the field has no gate either.
    let gate: Bool
    /// A RUNNING workflow hangs on the waiting row: if it is discarded, the server ends the workflow as failed — a
    /// "running" workflow without a driver would otherwise only hold its lock. The strip must say that BEFORE cancelling.
    /// Default `false`: without the field nothing hangs on it.
    let workflow: Bool

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        chatId = c.str(.chatId)
        kind = c.str(.kind, "run")
        provider = c.str(.provider)
        group = c.str(.group)
        label = c.str(.label)
        limitText = c.str(.limitText, "Nutzungslimit")
        reason = c.str(.reason, "reset")
        dueAt = c.dbl(.dueAt)
        resetsAt = try? c.decodeIfPresent(Double.self, forKey: .resetsAt)
        attempts = c.int(.attempts)
        maxAttempts = c.int(.maxAttempts)
        evidence = c.str(.evidence)
        updatedAt = c.dbl(.updatedAt)
        gate = c.bool(.gate)
        workflow = c.bool(.workflow)
    }

    enum CodingKeys: String, CodingKey {
        case chatId, kind, provider, group, label, limitText, reason, dueAt, resetsAt, attempts, maxAttempts, evidence, updatedAt, gate, workflow
    }
}

struct LimitWaitResponse: Decodable, Sendable {
    let wait: LimitWaitState?
    let enabled: Bool?
}

struct SkillDetail: Codable, Identifiable, Hashable, Sendable {
    let id: String
    var name: String
    var description: String
    var body: String

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = c.str(.id)
        name = c.str(.name, "Skill")
        description = c.str(.description)
        body = c.str(.body)
    }
}

struct AgentDefinition: Codable, Identifiable, Hashable, Sendable {
    let id: String
    var name: String
    var description: String
    var tools: String
    var model: String
    var body: String
    /// Comma list of skill names loaded COMPLETELY into the subagent's system prompt at start — the same notation as
    /// `tools`.
    var skills: String
    var enabled: Bool?
    /// The tool list as a list: `nil` = not set (inherits all) OR an older server without the field, `[]` = none — `tools`
    /// is empty in BOTH cases (empty is not unknown). Only for displaying the subagents page; saving still goes via
    /// `tools`.
    var toolList: [String]?
    /// The coding MCP servers the type brings along (field `mcp`: serverId → nil = all tools | list) — display only; an
    /// older server does not send the field (nil). It is not saved from iOS, the server keeps it on a PUT without the
    /// field.
    var mcp: [String: [String]?]?
    var mcpServer: Int { mcp?.count ?? 0 }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = c.str(.id)
        name = c.str(.name, "Agent")
        description = c.str(.description)
        tools = c.str(.tools)
        model = c.str(.model)
        body = c.str(.body)
        skills = c.str(.skills)
        enabled = c.boolOpt(.enabled)
        toolList = (try? c.decodeIfPresent([String].self, forKey: .toolList)) ?? nil
        mcp = (try? c.decodeIfPresent([String: [String]?].self, forKey: .mcp)) ?? nil
    }
}

struct ProjectAgentsResponse: Codable, Sendable {
    let projectAgents: [AgentDefinition]
    let workspaceAgents: [AgentDefinition]
    /// The default of the workspace agents in THIS project: "on" — a new project takes over all, including ones created
    /// later, switching off is the exception; "off" — an existing project, each is switched on deliberately. If the field
    /// is missing (older server), "off" applies — the old set.
    let wsAgentsDefault: String?

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        projectAgents = c.list(.projectAgents, AgentDefinition.self)
        workspaceAgents = c.list(.workspaceAgents, AgentDefinition.self)
        wsAgentsDefault = c.strOpt(.wsAgentsDefault)
    }
}

struct WorkspaceOverview: Codable, Sendable {
    let id: String
    var name: String
    var path: String
    var exists: Bool
    var hasClaudeMd: Bool
    var agents: [AgentDefinition]
    var projects: [Project]
    var categories: [ContextCategory]
    var contextCount: Int
    var varsCount: Int
    var mcpCount: Int
    var workflowCount: Int

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = c.str(.id)
        name = c.str(.name, "Workspace")
        path = c.str(.path)
        exists = c.bool(.exists, true)
        hasClaudeMd = c.bool(.hasClaudeMd)
        agents = c.list(.agents, AgentDefinition.self)
        projects = c.list(.projects, Project.self)
        categories = c.list(.categories, ContextCategory.self)
        contextCount = c.int(.contextCount)
        varsCount = c.int(.varsCount)
        mcpCount = c.int(.mcpCount)
        workflowCount = c.int(.workflowCount)
    }
}
