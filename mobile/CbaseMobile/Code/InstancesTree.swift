import Foundation

// What the "Instances" tab shows — the Swift TWIN of web/src/lib/instances-tree.ts, bound in web/test/instances-tree-binding.test.mjs:
// both sides are EXECUTED (tsc or `xcrun swiftc`) on the SAME cases and must deliver the same. The rules are in the head of the TS
// file; here only what concerns the translation:
//   - `readTree` takes the answer RAW, as `JSONSerialization` delivers it (`Any?`) — the same allowlist as on the web, field by field.
//     A boolean is only a JSON `true` (`NSNumber` of type CFBoolean), never a 1; a number is never a boolean.
//   - "Empty is not unknown": a part without `loaded: true` is NEVER an empty list (`partSituation` → closed · loading · error).
//   - `openParam` sorts by UTF-16 code units like `Array.prototype.sort` (not by Swift's character comparison).
//   - `actionsOf` delivers per action `ok` and a REASON as a key; translation happens in the view (Code/ProjectInstances.swift).
//   - `actionFrom`: the human's last action on the instance (tree field `action`) — `stacks` nil means "no list", never "no stack".
//   - `rowOf`: the summary of the row — stack, branch, links; `asOf` per part.
//   - `progress` per instance, `copyProgressFrom` and `progressDetail`: twin of web/src/lib/api/copy-progress.ts (the web keeps the
//     type and allowlist there because the "Active runs" pill reads them too) — a broken core is NO progress, single fields beside
//     it fall back to nil.
//   - `chatInstanceOptions` delivers in EVERY converted project at least main — the choice below offers "Create copy …"
//     (Chat/ChatHeader.swift).
// Foundation only, no L(…): the test compiles the file alone.
enum InstancesTree {
    static let main = "main"
    private static let copy = "copy-"
    /// The live states of an instance row a chat may switch into (runs/instance-switch.js LIVE_INSTANCE).
    static let liveInstance: [String] = ["ready", "start", "stopped"]
    /// The state of a copy row (stack_copies) in which a chat may switch into the copy (runs/instance-switch.js instanceChoice).
    static let copyReady = "ready"

    struct Waiting: Equatable, Hashable, Sendable {
        /// "queue" | "storage"
        let reason: String
        let since: Double?
    }

    struct Part<T: Hashable & Sendable>: Equatable, Hashable, Sendable {
        let loaded: Bool
        let open: Bool
        let error: String
        let list: [T]
        /// When the server read the part (ms), nil without (summary).
        var asOf: Double? = nil
    }

    struct Container: Equatable, Hashable, Sendable {
        let name: String
        let service: String
        let running: Bool
        let status: String
    }

    struct Repo: Equatable, Hashable, Sendable {
        let rel: String
        let branch: String
        let detached: Bool
        let open: Double
        let error: String
    }

    struct Link: Equatable, Hashable, Sendable {
        let id: String
        let url: String
        let procedure: Double?
        let state: String
    }

    struct Service: Equatable, Hashable, Identifiable, Sendable {
        let id: String
        let name: String
        let port: Double?
        let running: Bool
        let holdsStart: Bool
        let startable: Bool
        let link: Link?
    }

    struct ChatRow: Equatable, Hashable, Identifiable, Sendable {
        let id: String
        let title: String
        let running: Bool
    }

    /// A stack of the stack restart.
    struct StackRow: Equatable, Hashable, Sendable {
        let project: String
        let ok: Bool
        let error: String
    }

    /// The human's last action on the instance (projectbox/instance-action-status.js): "branch" · "dismiss" · "stack-restart";
    /// `running` until the end, then `ok`/`error`; `stacks` only for the stack restart.
    struct Action: Equatable, Hashable, Sendable {
        let kind: String
        let running: Bool
        let since: Double?
        let end: Double?
        let ok: Bool
        let error: String
        let stacks: [StackRow]?
    }

    /// The progress of a copy that waits or is being created (projectbox/copy-progress.js `copyProgress`). `share`/`restMs` are
    /// an estimate from the project's last finished copy — nil without a predecessor.
    struct CopyProgress: Equatable, Hashable, Sendable {
        /// "waiting" | "create"
        let kind: String
        /// For "waiting": "queue" | "storage"; otherwise "".
        let reason: String
        let step: Int
        let steps: Int
        let phase: String
        let stage: Stage?
        let begin: Double?
        let share: Double?
        let restMs: Double?
        let estimateMs: Double?
        let overrun: Bool
    }

    struct Stage: Equatable, Hashable, Sendable {
        let seq: Int
        let from: Int
    }

    /// What row and page show (without words): `kind` "queue" · "storage" · "step" · "create".
    struct ProgressDetail: Equatable, Hashable, Sendable {
        let kind: String
        let step: Int
        let steps: Int
        let phase: String
        let stage: Stage?
        let share: Double?
        let restMin: Double?
        let overrun: Bool
    }

    /// The phases of the build in their order (store `STACK_COPY_PHASES.build`).
    static let copyPhases = ["clone1", "freeze", "clone2", "creation", "prepare", "start"]

    struct CreatedOf: Equatable, Hashable, Sendable {
        let chatId: String
        let title: String?
    }

    struct Instance: Equatable, Hashable, Identifiable, Sendable {
        var id: String { name }
        let name: String
        let identifier: String
        let state: String
        let phase: String
        let error: String
        let waiting: Waiting?
        let cpu: Double?
        let memBytes: Double?
        let createdOf: CreatedOf?
        let base: String?
        let container: Part<Container>
        let repos: Part<Repo>
        let services: [Service]
        let chats: [ChatRow]
        var action: Action? = nil
        var progress: CopyProgress? = nil
    }

    struct Tree: Equatable, Hashable, Sendable {
        let ops: Bool
        let asOf: Double
        let instances: [Instance]
    }

    /// The situation of an instance in the UI. `waiting` carries the reason in `i.waiting`.
    enum Situation: String, Sendable { case ready, starts, stops, stopped, waiting, build, clearAway, error, unknown }
    enum PartSituation: String, Sendable { case closed, loading, error, empty, list }
    enum Reason: String, Sendable {
        case notReady = "not-ready"
        case notStopped = "not-stopped"
        case startWaiting = "start-waiting"
        case noWaitingStart = "no-waiting-start"
        case main
        case getsClearedAway = "gets-cleared-away"
        case noRepos = "no-repos"
        case reposTo = "repos-closed"
    }

    struct Available: Equatable, Sendable {
        let on: Bool
        let reason: Reason?
    }

    struct Actions: Equatable, Sendable {
        let stop: Available
        let start: Available
        let abortStart: Available
        let erase: Available
        let branch: Available
        let chat: Available
        let code: Available
        let terminal: Available
        let asBase: Available
    }

    enum ServiceAction: String, Sendable { case stop, start, startCommand, no }

    /// The summary of an instance row (`rowOf`): `stack` nil = not read, never 0/0 for unknown.
    struct RowsStack: Equatable, Hashable, Sendable {
        let run: Int
        let total: Int
        let down: [String]
    }
    struct RowsBranch: Equatable, Hashable, Sendable {
        let name: String
        let detached: Bool
        let changed: Bool
        let additional: Int
    }
    struct RowsLink: Equatable, Hashable, Sendable {
        let service: String
        let port: Double?
        let stopped: Bool
    }
    struct Row: Equatable, Hashable, Sendable {
        let stack: RowsStack?
        let branch: RowsBranch?
        let links: [RowsLink]
    }

    struct Option: Equatable, Hashable, Identifiable, Sendable {
        var id: String { name }
        let name: String
        let identifier: String
        let state: String
    }

    /// The field `instance` from /api/projects (projectbox/names.js projectInstanceField): `copies[].identifier` = `<pid>/copy-<name>`.
    /// Any field may be missing (nil); a value that is not text or not `true` is already nil here. The app builds it from
    /// `ProjectInstanceShort.treeField` (Models.swift) — the binding runs its cases through THIS decoder.
    struct Field: Equatable, Sendable {
        var identifier: String?
        var state: String?
        var converted: Bool?
        var copies: [CopyRow]?
    }

    /// `state` = that of the instance row, `copyState` = that of the copy row in stack_copies ("" without live ones, nil from an
    /// older server).
    struct CopyRow: Equatable, Sendable {
        var identifier: String?
        var state: String?
        var copyState: String?
    }

    // ── Values from the raw answer ──────────────────────────────────────────────────────────────

    private static func isBool(_ x: Any?) -> Bool {
        guard let n = x as? NSNumber else { return false }
        return CFGetTypeID(n) == CFBooleanGetTypeID()
    }
    private static func obj(_ x: Any?) -> [String: Any]? { x as? [String: Any] }
    private static func text(_ x: Any?) -> String { x as? String ?? "" }
    private static func countOrNull(_ x: Any?) -> Double? {
        guard let n = x as? NSNumber, !isBool(n) else { return nil }
        let d = n.doubleValue
        return d.isFinite ? d : nil
    }
    private static func truthy(_ x: Any?) -> Bool { isBool(x) && (x as? NSNumber)?.boolValue == true }
    private static func wrong(_ x: Any?) -> Bool { isBool(x) && (x as? NSNumber)?.boolValue == false }
    /// `String(x)` of a number as in JS for the ids (whole numbers without ".0").
    private static func idText(_ x: Any?) -> String {
        if let s = x as? String { return s }
        guard let d = countOrNull(x) else { return "" }
        if d == d.rounded(), abs(d) < 1e18 { return String(Int64(d)) }
        return "\(d)"
    }
    private static func list(_ x: Any?) -> [Any]? { x as? [Any] }
    /// A whole number like `Number.isInteger` in JS (not a boolean, finite, no remainder) — nil otherwise.
    private static func whole(_ x: Any?) -> Int? {
        guard let d = countOrNull(x), d == d.rounded(), abs(d) < 1e15 else { return nil }
        return Int(d)
    }

    // ── The computations (names as on the web) ──────────────────────────────────────────────────

    /// "copy-k1" ⇒ "k1"; main ⇒ nil.
    static func copyName(_ name: String) -> String? {
        name.hasPrefix(copy) && name.utf16.count > copy.utf16.count ? String(name.dropFirst(copy.count)) : nil
    }

    /// The value of `chats.instance` as instance name (nil/""/"main" ⇒ "main").
    static func chatInstanceName(_ value: String?) -> String {
        let w = (value ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        return w.isEmpty ? main : w
    }

    private static func partFrom<T: Hashable & Sendable>(_ raw: Any?, _ row: (Any) -> T?) -> Part<T> {
        guard let r = obj(raw) else { return Part(loaded: false, open: false, error: "", list: [], asOf: nil) }
        let loaded = truthy(r["loaded"])
        let l: [T] = loaded ? (list(r["list"]) ?? []).compactMap(row) : []
        return Part(loaded: loaded, open: loaded || truthy(r["open"]), error: text(r["error"]), list: l, asOf: countOrNull(r["asOf"]))
    }

    private static func waitingFrom(_ raw: Any?) -> Waiting? {
        guard let r = obj(raw), let g = r["reason"] as? String, g == "queue" || g == "storage" else { return nil }
        return Waiting(reason: g, since: countOrNull(r["since"]))
    }

    /// The action from the tree or from the event `project/instance` — nil without `kind`.
    static func actionFrom(_ raw: Any?) -> Action? {
        guard let r = obj(raw), !text(r["kind"]).isEmpty else { return nil }
        let stacks: [StackRow]? = list(r["stacks"]).map { l in
            l.compactMap { s in
                guard let s = obj(s), !text(s["project"]).isEmpty else { return nil }
                return StackRow(project: text(s["project"]), ok: truthy(s["ok"]), error: text(s["error"]))
            }
        }
        return Action(kind: text(r["kind"]), running: truthy(r["running"]), since: countOrNull(r["since"]), end: countOrNull(r["end"]),
                      ok: truthy(r["ok"]), error: text(r["error"]), stacks: stacks)
    }

    /// The allowlist of the progress (web/src/lib/api/copy-progress.ts `copyProgressFrom`): nil if the core is wrong —
    /// `kind` "waiting" with `reason` queue/storage or "create", `steps` whole ≥ 1, `step` whole in 0…steps.
    static func copyProgressFrom(_ raw: Any?) -> CopyProgress? {
        guard let r = obj(raw), let kind = r["kind"] as? String, kind == "waiting" || kind == "create" else { return nil }
        let reason: String?
        if kind == "waiting" {
            let g = r["reason"] as? String
            reason = g == "queue" || g == "storage" ? g : nil
        } else {
            reason = ""
        }
        guard let reason, let steps = whole(r["steps"]), steps >= 1, let step = whole(r["step"]), step >= 0, step <= steps
        else { return nil }
        var stage: Stage?
        if let s = obj(r["stage"]), let seq = whole(s["seq"]), let from = whole(s["from"]), seq >= 1, from >= seq { stage = Stage(seq: seq, from: from) }
        let share = countOrNull(r["share"]).flatMap { $0 >= 0 && $0 <= 1 ? $0 : nil }
        let notNegative: (Any?) -> Double? = { x in countOrNull(x).flatMap { $0 >= 0 ? $0 : nil } }
        return CopyProgress(kind: kind, reason: reason, step: step, steps: steps, phase: text(r["phase"]), stage: stage,
                                begin: countOrNull(r["begin"]), share: share, restMs: notNegative(r["restMs"]),
                                estimateMs: notNegative(r["estimateMs"]), overrun: truthy(r["overrun"]))
    }

    /// What the UI shows — without progress (older server) from the state alone; nil if nothing is created or waiting.
    static func progressDetail(_ f: CopyProgress?, state: String) -> ProgressDetail? {
        let n = copyPhases.count
        guard let f else {
            switch state {
            case "waiting_queue": return ProgressDetail(kind: "queue", step: 0, steps: n, phase: "", stage: nil, share: nil, restMin: nil, overrun: false)
            case "waiting_storage": return ProgressDetail(kind: "storage", step: 0, steps: n, phase: "", stage: nil, share: nil, restMin: nil, overrun: false)
            case "build", "create": return ProgressDetail(kind: "create", step: 0, steps: n, phase: "", stage: nil, share: nil, restMin: nil, overrun: false)
            default: return nil
            }
        }
        if f.kind == "waiting" {
            return ProgressDetail(kind: f.reason == "storage" ? "storage" : "queue", step: 0, steps: f.steps, phase: "", stage: nil,
                                     share: nil, restMin: nil, overrun: false)
        }
        let restMin: Double? = f.overrun ? nil : f.restMs.map { max(1, ($0 / 60000).rounded(.up)) }
        return ProgressDetail(kind: f.step >= 1 ? "step" : "create", step: f.step, steps: f.steps, phase: f.phase,
                                 stage: f.stage, share: f.share, restMin: restMin, overrun: f.overrun)
    }

    private static func instanceFrom(_ raw: Any) -> Instance? {
        guard let r = obj(raw) else { return nil }
        let name = text(r["name"])
        if name.isEmpty || (name != main && copyName(name) == nil) { return nil }
        var from: CreatedOf?
        if let v = obj(r["createdOf"]), !text(v["chatId"]).isEmpty {
            from = CreatedOf(chatId: text(v["chatId"]), title: v["title"] as? String)
        }
        let base = text(r["base"])
        let container: Part<Container> = partFrom(r["container"]) { c in
            guard let c = obj(c), !text(c["name"]).isEmpty else { return nil }
            return Container(name: text(c["name"]), service: text(c["service"]), running: truthy(c["running"]), status: text(c["status"]))
        }
        let repos: Part<Repo> = partFrom(r["repos"]) { x in
            guard let x = obj(x), let rel = x["rel"] as? String else { return nil }
            return Repo(rel: rel, branch: text(x["branch"]), detached: truthy(x["detached"]), open: countOrNull(x["open"]) ?? 0, error: text(x["error"]))
        }
        let services: [Service] = (list(r["services"]) ?? []).compactMap { d in
            guard let d = obj(d), !idText(d["id"]).isEmpty else { return nil }
            var link: Link?
            if let l = obj(d["link"]), !idText(l["id"]).isEmpty {
                link = Link(id: idText(l["id"]), url: text(l["url"]), procedure: countOrNull(l["procedure"]), state: text(l["state"]))
            }
            return Service(id: idText(d["id"]), name: text(d["name"]), port: countOrNull(d["port"]), running: truthy(d["running"]),
                          holdsStart: truthy(d["holdsStart"]), startable: truthy(d["startable"]), link: link)
        }
        let chats: [ChatRow] = (list(r["chats"]) ?? []).compactMap { c in
            guard let c = obj(c), !text(c["id"]).isEmpty else { return nil }
            return ChatRow(id: text(c["id"]), title: text(c["title"]), running: truthy(c["running"]))
        }
        return Instance(name: name, identifier: text(r["identifier"]), state: text(r["state"]), phase: text(r["phase"]), error: text(r["error"]),
                       waiting: waitingFrom(r["waiting"]), cpu: countOrNull(r["cpu"]), memBytes: countOrNull(r["memBytes"]), createdOf: from,
                       base: base.isEmpty ? nil : base, container: container, repos: repos, services: services, chats: chats,
                       action: actionFrom(r["action"]),
                       // Only on a copy — main is not created.
                       progress: name == main ? nil : copyProgressFrom(r["progress"]))
    }

    /// The answer as an allowlist; nil if it is no tree — the page then shows "not loaded", never "no instances".
    static func readTree(_ raw: Any?) -> Tree? {
        guard let r = obj(raw), truthy(r["loaded"]), let raw = list(r["instances"]) else { return nil }
        // main first, otherwise the server's order; a duplicate row counts once.
        var seen = Set<[UInt16]>()
        var unique: [Instance] = []
        for i in raw.compactMap(instanceFrom) where !seen.contains(Array(i.name.utf16)) {
            seen.insert(Array(i.name.utf16))
            unique.append(i)
        }
        let sorted = unique.filter { $0.name == main } + unique.filter { $0.name != main }
        return Tree(ops: !wrong(r["ops"]), asOf: countOrNull(r["asOf"]) ?? 0, instances: sorted)
    }

    /// The value for `?open=` — only names the tree knows, sorted; nil without (no parameter).
    static func openParam(_ open: [String], _ tree: Tree?) -> String? {
        // Equality by UTF-16 like `Set` in JS — Swift's `String ==` would treat "é" and "e + ◌́" as equal.
        let known = tree.map { Set($0.instances.map { Array($0.name.utf16) }) }
        var seen = Set<[UInt16]>()
        var names: [String] = []
        for n in open where !seen.contains(Array(n.utf16)) {
            seen.insert(Array(n.utf16))
            if !n.isEmpty && (known?.contains(Array(n.utf16)) ?? true) { names.append(n) }
        }
        names.sort { a, b in Array(a.utf16).lexicographicallyPrecedes(Array(b.utf16)) }
        return names.isEmpty ? nil : names.joined(separator: ",")
    }

    /// The state of an instance in ONE word of the UI.
    static func situationOf(_ i: Instance) -> Situation {
        if i.waiting != nil { return .waiting }
        switch i.state {
        case "ready": return .ready
        case "start", "recreate", "relocation": return .starts
        case "stop": return .stops
        case "stopped": return .stopped
        case "waiting_queue", "waiting_storage": return .waiting
        case "create", "build": return .build
        case "clearAway": return .clearAway
        case "error": return .error
        default: return .unknown
        }
    }

    /// A part (container, repos): closed · loading · error · empty · list.
    static func partSituation<T: Hashable & Sendable>(_ t: Part<T>) -> PartSituation {
        if !t.loaded { return !t.open ? .closed : !t.error.isEmpty ? .error : .loading }
        if t.list.isEmpty { return !t.error.isEmpty ? .error : .empty }
        return .list
    }

    private static let on = Available(on: true, reason: nil)
    private static func unavailable(_ g: Reason) -> Available { Available(on: false, reason: g) }

    /// Per action { an, reason } — `reason` is a key, not a text.
    static func actionsOf(_ i: Instance) -> Actions {
        let situation = situationOf(i)
        let ready = situation == .ready
        let isMain = i.name == main
        let waitingStart = i.state == "stopped" && i.waiting?.reason == "storage"
        let notReady = unavailable(situation == .clearAway ? .getsClearedAway : .notReady)
        let reposPart = partSituation(i.repos)
        return Actions(
            stop: ready ? on : notReady,
            start: i.state == "stopped" && !waitingStart ? on : unavailable(waitingStart ? .startWaiting : situation == .clearAway ? .getsClearedAway : .notStopped),
            abortStart: waitingStart ? on : unavailable(.noWaitingStart),
            // Delete only a copy; in every situation except during the cleanup itself.
            erase: isMain ? unavailable(.main) : situation == .clearAway ? unavailable(.getsClearedAway) : on,
            branch: !ready ? notReady : reposPart == .list ? on : unavailable(reposPart == .empty ? .noRepos : .reposTo),
            // A chat may enter a stopped instance: its turn starts it.
            chat: ready || i.state == "stopped" ? on : notReady,
            code: ready ? on : notReady,
            terminal: ready ? on : notReady,
            asBase: ready ? on : notReady
        )
    }

    /// What the service row offers: stop · start · start command · none.
    static func serviceAction(_ d: Service, _ i: Instance) -> ServiceAction {
        if d.running || d.holdsStart { return .stop }
        if situationOf(i) != .ready { return .no }
        return d.startable ? .start : .startCommand
    }

    /// The instance does not run — stopped, stopping or starting (also a waiting start) —, its preview link reaches nothing.
    /// By STATE, not by situation.
    static func linkStopped(_ i: Instance) -> Bool {
        i.state == "stopped" || i.state == "stop" || i.state == "start"
    }

    /// The summary of the row: stack running/total with the non-running ones, branch of the project folder (otherwise of the first
    /// repo) with `additional`, the services with an active preview link.
    static func rowOf(_ i: Instance) -> Row {
        let c = i.container
        let stack: RowsStack? = c.loaded
            ? RowsStack(run: c.list.filter(\.running).count, total: c.list.count,
                          down: c.list.filter { !$0.running }.map { $0.service.isEmpty ? $0.name : $0.service })
            : nil
        let r = i.repos
        let first: Repo? = r.loaded ? (r.list.first { $0.rel.isEmpty } ?? r.list.first) : nil
        let branch = first.map { e in
            RowsBranch(name: e.branch, detached: e.detached, changed: e.open > 0, additional: r.list.count - 1)
        }
        let stopped = linkStopped(i)
        let links = i.services.filter { $0.link != nil }.map { d in
            RowsLink(service: d.name.isEmpty ? d.id : d.name, port: d.port, stopped: stopped)
        }
        return Row(stack: stack, branch: branch, links: links)
    }

    /// The chats with a running turn — for the confirmation on stop, branch and delete.
    static func workingChats(_ i: Instance) -> [ChatRow] {
        i.chats.filter(\.running)
    }

    /// The instances a copy can be created from: every ready one, main first.
    static func baseOptions(_ tree: Tree?) -> [Option] {
        guard let tree else { return [] }
        return tree.instances.filter { actionsOf($0).asBase.on }.map { Option(name: $0.name, identifier: $0.identifier, state: $0.state) }
    }

    /// A chat's instance choice: main + every copy that instanceChoice accepts — copy row `ready` AND instance row live;
    /// empty if the project is not converted or the field carries no `state`. Also without a ready copy: then `[main]` — the
    /// choice is followed by "Create copy …".
    static func chatInstanceOptions(_ field: Field?) -> [Option] {
        guard let field, field.converted == true, let identifier = field.identifier, let mainState = field.state else { return [] }
        guard let cut = identifier.lastIndex(of: "/"), cut > identifier.startIndex,
              String(identifier[identifier.index(after: cut)...]) == main else { return [] }
        let pid = String(identifier[..<cut])
        let copies: [Option] = (field.copies ?? []).compactMap { k in
            let kk = k.identifier ?? ""
            let name = kk.hasPrefix("\(pid)/") ? String(kk.dropFirst(pid.count + 1)) : ""
            let state = k.state ?? ""
            return copyName(name) != nil && k.copyState == copyReady && liveInstance.contains(state)
                ? Option(name: name, identifier: kk, state: state) : nil
        }
        return [Option(name: main, identifier: identifier, state: mainState)] + copies
    }
}
