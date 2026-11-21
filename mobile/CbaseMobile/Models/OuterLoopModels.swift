import Foundation

// ── Outer loop ────────────────────────────────────────────────────────────────────────────────────────────────────
// Web counterpart: web/src/lib/api/outerloop.ts.
//
// Every shape decodes with its own `init(from:)` via `DecodeHelpers`, EVERY field with a default: a missing key must not make
// the view unreadable (a synthesized `Decodable` requires every key). The request bodies encode their fields EXPLICITLY
// (`encode(to:)`): a synthesized `Encodable` would omit a `nil` key, and what MUST be absent for a chat origin (`defaultNew`,
// otherwise 400) is absent here on purpose and by name, not by accident. The server no longer sends an area and ignores it
// in the body.

// ── Tool choice ─────────────────────────────────────────────────────────────────────────────────────────────────
// Catalog groups and areas, external MCP servers with their tools: the shapes of `Code/ToolChoiceSections.swift`. The outer
// loop editor is their only user. Web counterpart: the four types in web/src/lib/api/outerloop.ts.
struct ToolGroup: Decodable, Identifiable, Hashable, Sendable {
    let key: String
    /// Area of the catalog (knowledge · acting); the editor's sort order.
    let area: String
    let label: String
    let tools: [String]
    /// The reading subset of a MIXED group; the editor then offers Off · Read · Maintain instead of a toggle. Empty for purely
    /// reading or purely acting groups.
    let read: [String]
    let description: String
    var id: String { key }
    var hasStages: Bool { !read.isEmpty && read.count < tools.count }
    var maintain: [String] { tools.filter { !read.contains($0) } }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        key = c.str(.key)
        area = c.str(.area)
        label = c.str(.label)
        tools = c.strings(.tools)
        read = c.strings(.read)
        description = c.str(.description)
    }
    enum CodingKeys: String, CodingKey { case key, area, label, tools, read, description }
}

struct ToolArea: Decodable, Identifiable, Hashable, Sendable {
    let key: String
    let label: String
    let description: String
    var id: String { key }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        key = c.str(.key)
        label = c.str(.label)
        description = c.str(.description)
    }
    enum CodingKeys: String, CodingKey { case key, label, description }
}

/// A tool of an external MCP server, as tools/list last reported it.
struct McpTool: Decodable, Identifiable, Hashable, Sendable {
    let name: String
    let description: String
    /// true = changes something in the foreign system, false = reads, nil = not classified by the server
    /// ("unresolved"; "Read-only" leaves it out).
    let writing: Bool?
    var id: String { name }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        name = c.str(.name)
        description = c.str(.description)
        writing = (try? c.decodeIfPresent(Bool.self, forKey: .writing)) ?? nil
    }
    enum CodingKeys: String, CodingKey { case name, description, writing }
}

/// An MCP server of the workspace, as the outer loop editor chooses it: streamable HTTP with a bearer token. The token never
/// comes back, only `tokenSet`.
struct ManagerMcpServer: Decodable, Identifiable, Hashable, Sendable {
    let id: String
    /// The MCP name: calls are named mcp__<key>__<tool>.
    let key: String
    let name: String
    let url: String
    let tokenSet: Bool
    let tools: [McpTool]
    let toolsAt: Double
    let error: String
    /// Approval marks: the tools of this server that an agent may only run after the user's approval; per server in the
    /// inventory, not per agent.
    let approval: [String]
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = c.str(.id)
        key = c.str(.key)
        name = c.str(.name)
        url = c.str(.url)
        tokenSet = c.bool(.tokenSet)
        tools = c.list(.tools, McpTool.self)
        toolsAt = c.dbl(.toolsAt)
        error = c.str(.error)
        approval = c.strings(.approval)
    }
    enum CodingKeys: String, CodingKey { case id, key, name, url, tokenSet, tools, toolsAt, error, approval }
}

/// A trigger: `quiet` and `interval` with minutes, `run_end` without a value, `clockTime` with a list of `HH:MM`.
struct OuterLoopTrigger: Codable, Hashable, Sendable {
    var kind: String
    var minutes: Int
    var clockTimes: [String]

    static let kinds = ["quiet", "interval", "run_end", "clockTime"]

    init(kind: String, minutes: Int = 0, clockTimes: [String] = []) {
        self.kind = kind
        self.minutes = minutes
        self.clockTimes = clockTimes
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        kind = c.str(.kind)
        minutes = c.int(.minutes, kind == "quiet" ? 5 : 60)
        clockTimes = c.strings(.clockTimes)
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(kind, forKey: .kind)
        switch kind {
        case "quiet", "interval": try c.encode(minutes, forKey: .minutes)
        case "clockTime": try c.encode(clockTimes, forKey: .clockTimes)
        default: break
        }
    }

    // The server calls the field `times` (outerloop/catalog.js); the Swift name stays descriptive.
    enum CodingKeys: String, CodingKey { case kind, minutes, clockTimes = "times" }
}

extension KeyedDecodingContainer {
    /// The trigger list, as a list or as JSON text (how it is stored in the database); unknown entries are dropped.
    func outerLoopTrigger(_ key: Key) -> [OuterLoopTrigger] {
        let list: [OuterLoopTrigger]
        if let l = (try? decodeIfPresent([OuterLoopTrigger].self, forKey: key)) ?? nil {
            list = l
        } else if let s = strOpt(key), let l = try? JSONDecoder().decode([OuterLoopTrigger].self, from: Data(s.utf8)) {
            list = l
        } else {
            list = []
        }
        return list.filter { OuterLoopTrigger.kinds.contains($0.kind) }
    }

    /// The kind of an observed chat: "normal" stays "normal", every other kind becomes "special"; missing or empty
    /// stays `nil`. The server (`outerloop/publiclyVisible.js:chatKindOf`) now only sends "normal" or `null` (chat gone, or a
    /// legacy read-only conversation, no longer a target). Web counterpart: `chatKindOf` in lib/api/outerloop.ts.
    func outerLoopChatKind(_ key: Key) -> String? {
        guard let k = strOpt(key), !k.isEmpty else { return nil }
        return k == "normal" ? "normal" : "special"
    }

    /// An MCP choice { serverId: [tool, …] }; missing or broken is empty.
    func mcpChoice(_ key: Key) -> [String: [String]] {
        ((try? decodeIfPresent([String: [String]].self, forKey: key)) ?? nil) ?? [:]
    }
}

/// An outer loop agent, as `publicAgent` writes it (agent shape plus the routes' additions).
struct OuterLoopAgent: Decodable, Identifiable, Hashable, Sendable {
    let id: String
    let workspaceId: String
    let projectId: String?
    let chatId: String?
    /// "workspace" | "project" | "chat".
    let origin: String
    let name: String
    let job: String
    let trigger: [OuterLoopTrigger]
    // There is no `area` any more: the server sends it in no response. Web counterpart: lib/api/outerloop.ts.
    let provider: String
    let model: String
    let effort: String
    let defaultNew: Bool
    let defaultNewSince: Double?
    let tools: [String]
    let builtin: [String]
    let mcp: [String: [String]]
    let summarizer: Bool
    /// The workspace's agenda keeper, the second built-in agent.
    let agendaKeeper: Bool
    /// The workspace's timeline agent, the third built-in agent, only on chats of a project.
    let timeline: Bool
    /// Built-in (summarizer, agenda keeper or timeline): cannot be deleted, "Reset to template", hint "new template".
    /// If the field is missing (older server) the server's rule applies: `fixed = summarizer || agendaKeeper || timeline`.
    let fixed: Bool
    /// Toggle "Mark changes": only on the keeper, otherwise always off; if missing on the keeper the server's default applies
    /// (on, column `upkeep_mark DEFAULT 1`), as on the web (`normOuterLoopAgent`).
    let markUpkeep: Bool
    /// "Abort on new message": any agent; if the field is missing (older server), off.
    let abortingTurn: Bool
    /// Tally of its changes: only on the keeper, otherwise `nil`; if missing (older server) it is unknown, never "0".
    let upkeepTally: OuterLoopUpkeepTally?
    let templateRevision: Int?
    let on: Bool
    let createdAt: Double
    let updatedAt: Double
    let chatTitle: String
    /// Chat origin: the kind of its chat ("normal" | legacy value); "To chat" exists only for "normal", since a legacy
    /// conversation appears in no chat list any more. `nil` without a chat, for a chat that is gone, and on an older server.
    let chatKind: String?
    let projectName: String
    let effective: Bool
    /// "off" | "without-model" | "without-provider"; empty if the agent is effective.
    let ineffectiveReason: String
    let templateNew: Bool
    let notTakenOverIn: [String]
    let running: Int

    var toolCount: Int { tools.count + builtin.count + mcp.values.reduce(0) { $0 + $1.count } }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = c.str(.id)
        workspaceId = c.str(.workspaceId)
        projectId = c.strOpt(.projectId).flatMap { $0.isEmpty ? nil : $0 }
        chatId = c.strOpt(.chatId).flatMap { $0.isEmpty ? nil : $0 }
        let h = c.str(.origin)
        origin = ["workspace", "project", "chat"].contains(h) ? h : (chatId != nil ? "chat" : projectId != nil ? "project" : "workspace")
        name = c.str(.name)
        job = c.str(.job)
        trigger = c.outerLoopTrigger(.trigger)
        provider = c.str(.provider)
        model = c.str(.model)
        effort = c.str(.effort)
        defaultNew = c.bool(.defaultNew)
        defaultNewSince = c.dblOpt(.defaultNewSince)
        tools = c.strings(.tools)
        builtin = c.strings(.builtin)
        mcp = c.mcpChoice(.mcp)
        summarizer = c.bool(.summarizer)
        agendaKeeper = c.bool(.agendaKeeper)
        timeline = c.bool(.timeline)
        fixed = c.boolOpt(.fixed) ?? (summarizer || agendaKeeper || timeline)
        // As on the web (lib/api/outerloop.ts normOuterLoopAgent), bound in web/test/outerloop-set-binding.test.mjs: both only
        // on the keeper; the server sends `markUpkeep: false` and `upkeepTally: null` on every other agent, and whatever
        // another agent carries anyway means nothing.
        markUpkeep = agendaKeeper && (c.boolOpt(.markUpkeep) ?? true)
        abortingTurn = c.bool(.abortingTurn)
        upkeepTally = agendaKeeper ? ((try? c.decodeIfPresent(OuterLoopUpkeepTally.self, forKey: .upkeepTally)) ?? nil) : nil
        templateRevision = c.intOpt(.templateRevision)
        on = c.bool(.on, true)
        createdAt = c.dbl(.createdAt)
        updatedAt = c.dbl(.updatedAt)
        chatTitle = c.str(.chatTitle)
        chatKind = c.outerLoopChatKind(.chatKind)
        projectName = c.str(.projectName)
        // If `effective` is missing, the server's rule applies; never "running" out of ignorance.
        let w = c.boolOpt(.effective) ?? (on && !provider.isEmpty && !model.isEmpty)
        effective = w
        let g = c.str(.ineffectiveReason)
        ineffectiveReason = ["managing", "off", "without-model", "without-provider"].contains(g) ? g : (w ? "" : !on ? "off" : provider.isEmpty ? "without-provider" : "without-model")
        templateNew = c.bool(.templateNew)
        notTakenOverIn = c.strings(.notTakenOverIn)
        if let b = c.boolOpt(.running) { running = b ? 1 : 0 } else { running = c.int(.running) }
    }

    enum CodingKeys: String, CodingKey {
        case id, workspaceId, projectId, chatId, origin, name, job, trigger, provider, model, effort
        case defaultNew, defaultNewSince, tools, builtin, mcp, summarizer, templateRevision, on = "enabled", createdAt, updatedAt
        case chatTitle, chatKind, projectName, effective, ineffectiveReason, templateNew, notTakenOverIn, running
        case agendaKeeper, timeline, fixed, markUpkeep, upkeepTally, abortingTurn
    }
}

/// The agenda keeper's tally (`publicAgent.upkeepTally`): every change from the `agenda_upkeep` log and its later outcome.
/// "Standing" means open + confirmed: the main agent did not take it back. Every field defaults to 0, `changes` without a
/// field is the sum of the three outcomes (as on the web, `normUpkeepTally`).
struct OuterLoopUpkeepTally: Decodable, Hashable, Sendable {
    let changes: Int
    let open: Int
    let confirmed: Int
    let corrected: Int
    var standing: Int { open + confirmed }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        open = c.int(.open)
        confirmed = c.int(.confirmed)
        corrected = c.int(.corrected)
        changes = c.intOpt(.changes) ?? (open + confirmed + corrected)
    }
    enum CodingKeys: String, CodingKey { case changes, open, confirmed, corrected }
}

/// What ONE run of the agenda keeper changed (`publicRun.upkeep`); `nil` for runs of other agents.
struct OuterLoopRunUpkeep: Decodable, Hashable, Sendable {
    let changes: Int
    let corrected: Int

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        changes = c.int(.changes)
        corrected = c.int(.corrected)
    }
    enum CodingKeys: String, CodingKey { case changes, corrected }
}

/// A workspace agent in the project, with its takeover (`GET /api/projects/:pid/workspace-outer-loop`).
struct OuterLoopProjectAgent: Decodable, Identifiable, Hashable, Sendable {
    let agent: OuterLoopAgent
    /// No row = taken over; if the field is missing, the same applies here.
    let takenOver: Bool
    var id: String { agent.id }

    init(from decoder: Decoder) throws {
        agent = try OuterLoopAgent(from: decoder)
        let c = try decoder.container(keyedBy: CodingKeys.self)
        takenOver = c.bool(.takenOver, true)
    }

    enum CodingKeys: String, CodingKey { case takenOver }
}

struct OuterLoopProjectResponse: Decodable, Sendable {
    let items: [OuterLoopProjectAgent]
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        items = c.list(.items, OuterLoopProjectAgent.self)
    }
    enum CodingKeys: String, CodingKey { case items }
}

/// A built-in tool of the CLI. The server may send names OR objects.
struct OuterLoopBuiltin: Decodable, Identifiable, Hashable, Sendable {
    let name: String
    let description: String
    var id: String { name }

    init(from decoder: Decoder) throws {
        if let s = try? decoder.singleValueContainer().decode(String.self) {
            name = s
            description = ""
            return
        }
        let c = try decoder.container(keyedBy: CodingKeys.self)
        name = c.str(.name)
        description = c.str(.description)
    }

    enum CodingKeys: String, CodingKey { case name, description }
}

/// A span (min, max), as an object or as a pair.
struct OuterLoopSpan: Decodable, Hashable, Sendable {
    let min: Int
    let max: Int

    init(min: Int, max: Int) {
        self.min = min
        self.max = max
    }

    init(from decoder: Decoder) throws {
        if var u = try? decoder.unkeyedContainer(), let a = try? u.decode(Int.self), let b = try? u.decode(Int.self) {
            min = a
            max = b
            return
        }
        let c = try decoder.container(keyedBy: CodingKeys.self)
        min = c.int(.min)
        max = c.int(.max)
    }

    enum CodingKeys: String, CodingKey { case min, max }
}

/// The trigger limits; defaults if the server does not send them.
struct OuterLoopLimits: Hashable, Sendable {
    var quiet = OuterLoopSpan(min: 1, max: 1440)
    var interval = OuterLoopSpan(min: 5, max: 10080)
    var clockTimes = OuterLoopSpan(min: 1, max: 24)
}

struct OuterLoopCatalog: Hashable, Sendable {
    var groups: [ToolGroup] = []
    var toolAreas: [ToolArea] = []
    var builtin: [OuterLoopBuiltin] = []
    var mcpServer: [ManagerMcpServer] = []
    var cbaseApproval: [String] = []
    /// Groups whose tools ALL fall to the fence in project chats; the editor marks them.
    var fenceDropped: [String] = []
}

/// `GET /api/workspaces/:wid/outer-loop`.
struct OuterLoopInventory: Decodable, Sendable {
    let items: [OuterLoopAgent]
    let catalog: OuterLoopCatalog
    let limits: OuterLoopLimits
    let templateRevision: Int

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        items = c.list(.items, OuterLoopAgent.self)
        var k = OuterLoopCatalog()
        if let kc = try? c.nestedContainer(keyedBy: CatalogKeys.self, forKey: .catalog) {
            k.groups = kc.list(.groups, ToolGroup.self)
            k.toolAreas = kc.list(.toolAreas, ToolArea.self)
            k.builtin = kc.list(.builtin, OuterLoopBuiltin.self).filter { !$0.name.isEmpty }
            k.mcpServer = kc.list(.mcpServer, ManagerMcpServer.self)
            k.cbaseApproval = kc.strings(.cbaseApproval)
            k.fenceDropped = kc.strings(.fenceDropped)
        }
        catalog = k
        var g = OuterLoopLimits()
        if let ac = try? c.nestedContainer(keyedBy: TriggerKeys.self, forKey: .trigger),
           let gc = try? ac.nestedContainer(keyedBy: LimitsKeys.self, forKey: .limits) {
            if let s = (try? gc.decodeIfPresent(OuterLoopSpan.self, forKey: .quiet)) ?? nil { g.quiet = s }
            if let s = (try? gc.decodeIfPresent(OuterLoopSpan.self, forKey: .interval)) ?? nil { g.interval = s }
            if let s = (try? gc.decodeIfPresent(OuterLoopSpan.self, forKey: .clockTimes)) ?? nil { g.clockTimes = s }
        }
        limits = g
        templateRevision = (try? c.nestedContainer(keyedBy: TemplateKeys.self, forKey: .template))?.int(.revision, 1) ?? 1
    }

    enum CodingKeys: String, CodingKey { case items, catalog, trigger, template }
    enum CatalogKeys: String, CodingKey { case groups, toolAreas, builtin, mcpServer, cbaseApproval, fenceDropped }
    enum TriggerKeys: String, CodingKey { case kinds, limits }
    // The server keys the limits by KIND (`clockTime: {field: "times", min, max}`, outerloop/catalog.js TRIGGER_LIMITS).
    enum LimitsKeys: String, CodingKey { case quiet, interval, clockTimes = "clockTime" }
    enum TemplateKeys: String, CodingKey { case revision }
}

/// What a run REALLY had, after the fence cut.
struct OuterLoopSet: Hashable, Sendable {
    var cbase: [String] = []
    var builtin: [String] = []
    var extern: [String] = []
    var droppedFence: [String] = []
    var droppedApproval: [String] = []
    /// Chosen tools of a coding MCP server that are deselected on the server for coding chats (Coding → MCP); the run does
    /// not have them (server outerloop/set.js `dropped.locked`).
    var droppedLocked: [String] = []
    /// `dropped.genus`: the server now writes it empty; it is still read, as on the web, so an old run row reads the same
    /// (outerloop-set-binding).
    var droppedGenus: [String] = []
}

/// An entry from `set.extern`: a name OR an object `{key, name, tools}`.
private struct OuterLoopExternEntry: Decodable {
    let rows: [String]
    init(from decoder: Decoder) throws {
        if let s = try? decoder.singleValueContainer().decode(String.self) {
            rows = s.isEmpty ? [] : [s]
            return
        }
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let srv = c.str(.name).isEmpty ? c.str(.key) : c.str(.name)
        let tools = c.strings(.tools)
        if tools.isEmpty {
            rows = srv.isEmpty ? [] : [srv]
        } else {
            rows = tools.map { srv.isEmpty ? $0 : "\(srv): \($0)" }
        }
    }
    enum CodingKeys: String, CodingKey { case key, name, tools }
}

private struct OuterLoopSetRaw: Decodable {
    let set: OuterLoopSet
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        var s = OuterLoopSet()
        s.cbase = c.strings(.cbase)
        s.builtin = c.strings(.builtin)
        // `extern` is a list `{key, name, tools}` in the run row (server outerloop/set.js:setRow) and becomes
        // "<server>: <tool>" per tool; fallbacks as on the web (lib/api/outerloop.ts:normSet): a list of plain names or a map
        // server → tools. Trying only `[String]` and the map would silently fail on the object list and leave `extern`
        // empty for EVERY run.
        if let l = (try? c.decodeIfPresent([OuterLoopExternEntry].self, forKey: .extern)) ?? nil {
            s.extern = l.flatMap(\.rows)
        } else {
            s.extern = c.mcpChoice(.extern).sorted { $0.key < $1.key }.flatMap { srv, l in l.map { "\(srv): \($0)" } }
        }
        if let e = try? c.nestedContainer(keyedBy: DroppedKeys.self, forKey: .dropped) {
            s.droppedFence = e.strings(.fence)
            s.droppedApproval = e.strings(.approval)
            s.droppedLocked = e.strings(.locked)
            s.droppedGenus = e.strings(.genus)
        }
        set = s
    }
    enum CodingKeys: String, CodingKey { case cbase, builtin, extern, dropped }
    enum DroppedKeys: String, CodingKey { case fence, approval, locked, genus }
}

/// A run (the run shape plus `chatTitle`).
struct OuterLoopRun: Decodable, Identifiable, Hashable, Sendable {
    let id: String
    let agentId: String
    let chatId: String
    let chatTitle: String
    /// The kind of the observed chat; `nil` if it is gone.
    let chatKind: String?
    let trigger: String
    /// "running" | "finished" | "parked" | "aborted" | "error".
    let state: String
    let startedAt: Double
    let endedAt: Double?
    let parkedUntil: Double?
    let attempts: Int
    let set: OuterLoopSet
    let error: String
    let provider: String
    let model: String
    let input: Int
    let output: Int
    let cached: Int
    /// `nil` = subscription or no price; never 0.
    let cost: Double?
    /// Only on runs of the agenda keeper: how many changes, and how many of them the main agent took back.
    let upkeep: OuterLoopRunUpkeep?

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = c.str(.id)
        agentId = c.str(.agentId)
        chatId = c.str(.chatId)
        chatTitle = c.str(.chatTitle)
        chatKind = c.outerLoopChatKind(.chatKind)
        trigger = c.str(.trigger)
        state = c.str(.state)
        startedAt = c.dbl(.startedAt)
        endedAt = c.dblOpt(.endedAt)
        parkedUntil = c.dblOpt(.parkedUntil)
        attempts = c.int(.attempts, 1)
        if let raw = (try? c.decodeIfPresent(OuterLoopSetRaw.self, forKey: .set)) ?? nil {
            set = raw.set
        } else if let s = c.strOpt(.set), let raw = try? JSONDecoder().decode(OuterLoopSetRaw.self, from: Data(s.utf8)) {
            set = raw.set
        } else {
            set = OuterLoopSet()
        }
        error = c.str(.error)
        provider = c.str(.provider)
        model = c.str(.model)
        input = c.int(.input)
        output = c.int(.output)
        cached = c.int(.cached)
        cost = c.dblOpt(.cost)
        upkeep = (try? c.decodeIfPresent(OuterLoopRunUpkeep.self, forKey: .upkeep)) ?? nil
    }

    enum CodingKeys: String, CodingKey {
        case id, agentId, chatId, chatTitle, chatKind, trigger, state, startedAt, endedAt, parkedUntil, attempts, set, error
        case provider, model, input, output, cached, cost, upkeep
    }
}

struct OuterLoopSum: Decodable, Hashable, Sendable {
    let runs: Int
    let input: Int
    let output: Int
    let cost: Double?

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        runs = c.int(.runs)
        input = c.int(.input)
        output = c.int(.output)
        cost = c.dblOpt(.cost)
    }
    enum CodingKeys: String, CodingKey { case runs, input, output, cost }
}

/// `GET /api/workspaces/:wid/outer-loop/:aid/runs`.
struct OuterLoopRunsPage: Decodable, Sendable {
    let items: [OuterLoopRun]
    let additional: Bool
    let sum: OuterLoopSum?

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        items = c.list(.items, OuterLoopRun.self)
        additional = c.bool(.additional)
        sum = (try? c.decodeIfPresent(OuterLoopSum.self, forKey: .sum)) ?? nil
    }
    enum CodingKeys: String, CodingKey { case items, additional, sum }
}

/// A note on (agent, chat); immutable.
struct OuterLoopNote: Decodable, Identifiable, Hashable, Sendable {
    let id: Int
    let agentId: String
    let agentName: String
    let chatId: String
    let text: String
    let at: Double

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = c.int(.id)
        agentId = c.str(.agentId)
        agentName = c.str(.agentName)
        chatId = c.str(.chatId)
        text = c.str(.text)
        at = c.dbl(.at)
    }
    enum CodingKeys: String, CodingKey { case id, agentId, agentName, chatId, text, at }
}

struct OuterLoopNotesPage: Decodable, Sendable {
    let items: [OuterLoopNote]
    let additional: Bool
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        items = c.list(.items, OuterLoopNote.self)
        additional = c.bool(.additional)
    }
    enum CodingKeys: String, CodingKey { case items, additional }
}

/// An agent in the chat info: the agent in short form and its activation on THIS chat.
struct OuterLoopChatAgent: Decodable, Identifiable, Hashable, Sendable {
    let agent: OuterLoopAgent
    let active: Bool
    /// Why (`outerloop/activation.js`): no-target-chat · archived · not-available · ineffective · row-on · row-off ·
    /// chat · standard · timeline · no-default.
    let source: String
    let since: Double?
    /// A toggle the server does not explicitly release stays locked.
    let toggleable: Bool
    let running: Bool
    let lastRun: OuterLoopRun?
    var id: String { agent.id }

    init(from decoder: Decoder) throws {
        agent = try OuterLoopAgent(from: decoder)
        let c = try decoder.container(keyedBy: CodingKeys.self)
        active = c.bool(.active)
        source = c.str(.source)
        since = c.dblOpt(.since)
        toggleable = c.bool(.toggleable)
        if let b = c.boolOpt(.running) { running = b } else { running = c.int(.running) > 0 }
        lastRun = (try? c.decodeIfPresent(OuterLoopRun.self, forKey: .lastRun)) ?? nil
    }
    enum CodingKeys: String, CodingKey { case active, source, since, toggleable, running, lastRun }
}

/// `GET /api/chats/:id/outer-loop`.
struct OuterLoopChatState: Decodable, Sendable {
    let targetChat: Bool
    let reason: String
    let agents: [OuterLoopChatAgent]
    let notes: [OuterLoopNote]

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        targetChat = c.bool(.targetChat)
        reason = c.str(.reason)
        agents = c.list(.agents, OuterLoopChatAgent.self)
        notes = c.list(.notes, OuterLoopNote.self)
    }
    enum CodingKeys: String, CodingKey { case targetChat, reason, agents, notes }
}

/// The body of create and change. For a chat origin `defaultNew` and `projectId` stay `nil` and are then EXPLICITLY absent from
/// the body (the server answers 400 otherwise); all other fields are always sent. `markUpkeep` is sent ONLY for the agenda
/// keeper; on any other agent the server answers 400.
struct OuterLoopBody: Encodable, Sendable {
    var name: String
    var job: String
    var trigger: [OuterLoopTrigger]
    var provider: String
    var model: String
    var effort: String
    var defaultNew: Bool?
    var tools: [String]
    var builtin: [String]
    var mcp: [String: [String]]
    var on: Bool
    var projectId: String?
    var markUpkeep: Bool? = nil
    /// "Abort on new message": always sent, for every agent.
    var abortingTurn: Bool = false

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(name, forKey: .name)
        try c.encode(job, forKey: .job)
        try c.encode(trigger, forKey: .trigger)
        try c.encode(provider, forKey: .provider)
        try c.encode(model, forKey: .model)
        try c.encode(effort, forKey: .effort)
        if let defaultNew { try c.encode(defaultNew, forKey: .defaultNew) }
        try c.encode(tools, forKey: .tools)
        try c.encode(builtin, forKey: .builtin)
        try c.encode(mcp, forKey: .mcp)
        try c.encode(on, forKey: .on)
        if let projectId { try c.encode(projectId, forKey: .projectId) }
        if let markUpkeep { try c.encode(markUpkeep, forKey: .markUpkeep) }
        try c.encode(abortingTurn, forKey: .abortingTurn)
    }

    enum CodingKeys: String, CodingKey {
        case name, job, trigger, provider, model, effort, defaultNew, tools, builtin, mcp, on = "enabled", projectId, markUpkeep, abortingTurn
    }
}

/// `PATCH …/outer-loop/:aid` with only `an` (wire key `enabled`); the field is required (a missing field is not a statement).
struct OuterLoopToggleBody: Encodable, Sendable {
    let on: Bool
    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(on, forKey: .on)
    }
    enum CodingKeys: String, CodingKey { case on = "enabled" }
}

/// `PATCH /api/projects/:pid/workspace-outer-loop/:aid`.
struct OuterLoopTakeoverBody: Encodable, Sendable {
    let takenOver: Bool
    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(takenOver, forKey: .takenOver)
    }
    enum CodingKeys: String, CodingKey { case takenOver }
}

/// The paths to the server: ONE place for list, editor, runs and chat info. Paths unencoded: `APIClient.makeURL` encodes
/// itself (do not encode before it).
enum OuterLoopAPI {
    static func inventory(_ client: APIClient, workspaceId: String) async throws -> OuterLoopInventory {
        try await client.get("/api/workspaces/\(workspaceId)/outer-loop", timeout: 20)
    }
    static func create(_ client: APIClient, workspaceId: String, body: OuterLoopBody) async throws -> OuterLoopAgent {
        try await client.post("/api/workspaces/\(workspaceId)/outer-loop", body: body)
    }
    static func change(_ client: APIClient, workspaceId: String, agentId: String, body: OuterLoopBody) async throws -> OuterLoopAgent {
        try await client.patch("/api/workspaces/\(workspaceId)/outer-loop/\(agentId)", body: body)
    }
    static func toggle(_ client: APIClient, workspaceId: String, agentId: String, on: Bool) async throws -> OuterLoopAgent {
        try await client.patch("/api/workspaces/\(workspaceId)/outer-loop/\(agentId)", body: OuterLoopToggleBody(on: on))
    }
    static func erase(_ client: APIClient, workspaceId: String, agentId: String) async throws {
        let _: OKResponse = try await client.delete("/api/workspaces/\(workspaceId)/outer-loop/\(agentId)")
    }
    static func reset(_ client: APIClient, workspaceId: String, agentId: String) async throws -> OuterLoopAgent {
        try await client.post("/api/workspaces/\(workspaceId)/outer-loop/\(agentId)/reset")
    }
    /// Paging uses `after` = id of the LAST run of the previous page; the server resolves it to (startedAt, rowid). A cursor
    /// on `startedAt` alone lost runs started at the same time at the page boundary.
    static func runs(_ client: APIClient, workspaceId: String, agentId: String, after: String? = nil) async throws -> OuterLoopRunsPage {
        var q = [URLQueryItem(name: "limit", value: "50")]
        if let after, !after.isEmpty { q.append(URLQueryItem(name: "after", value: after)) }
        return try await client.get("/api/workspaces/\(workspaceId)/outer-loop/\(agentId)/runs", query: q, timeout: 20)
    }
    static func project(_ client: APIClient, projectId: String) async throws -> [OuterLoopProjectAgent] {
        let r: OuterLoopProjectResponse = try await client.get("/api/projects/\(projectId)/workspace-outer-loop", timeout: 20)
        return r.items
    }
    static func takeover(_ client: APIClient, projectId: String, agentId: String, takenOver: Bool) async throws {
        try await client.send("/api/projects/\(projectId)/workspace-outer-loop/\(agentId)", method: .patch, body: OuterLoopTakeoverBody(takenOver: takenOver))
    }
    static func chat(_ client: APIClient, chatId: String) async throws -> OuterLoopChatState {
        try await client.get("/api/chats/\(chatId)/outer-loop", timeout: 20)
    }
    static func chatActive(_ client: APIClient, chatId: String, agentId: String, on: Bool) async throws {
        try await client.send("/api/chats/\(chatId)/outer-loop/\(agentId)/active", method: .put, body: OuterLoopToggleBody(on: on))
    }
    static func chatCreate(_ client: APIClient, chatId: String, body: OuterLoopBody) async throws -> OuterLoopAgent {
        try await client.post("/api/chats/\(chatId)/outer-loop", body: body)
    }
    static func chatNotes(_ client: APIClient, chatId: String, agentId: String?, before: Int? = nil) async throws -> OuterLoopNotesPage {
        var q = [URLQueryItem(name: "limit", value: "20")]
        if let agentId, !agentId.isEmpty { q.append(URLQueryItem(name: "agentId", value: agentId)) }
        if let before { q.append(URLQueryItem(name: "before", value: String(before))) }
        return try await client.get("/api/chats/\(chatId)/outer-loop/notes", query: q, timeout: 20)
    }
}
