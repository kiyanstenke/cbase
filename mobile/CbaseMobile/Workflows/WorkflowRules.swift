import Foundation

// ── The workflow-settings rules, ONCE on the iPhone ──────────────────────────────────────────────
// Third version of the same calculation — server `workflows.js` (`wantsDoneCheck`, `doneCapAuto`,
// `effectiveCap`, `nodeModes`), web `web/src/lib/workflow-node-form.ts` (`checksEffective`,
// `checkCapContinue`, `effectiveCaps`, `nodeModes`, `rowsFor`). Bound by
// `web/test/wfe-ios-binding.test.mjs`: the test cuts out THIS file as a whole, runs it with
// `xcrun swift` and holds every answer against the TS rules over a matrix of graphs ×
// node modes × workflow rule. Hence a pure sheet: only Foundation, no SwiftUI, no model type,
// no `L(…)` — the conversion from `WorkflowNode` is the caller's job.
//
// Why three values instead of a checkmark: `doneCheck`/`capAuto` stood as `false` on EVERY node
// (the server normalized them so) — "never touched" and "explicitly off" could no longer be
// told apart. "Like workflow" is the default; "on/off" or "ask/continue" override it.

/// "Check completion" on a node: like the workflow, explicitly on, explicitly off.
enum WorkflowDoneMode: String, CaseIterable, Sendable {
    case inherit, on, off
}

/// Behavior at a cap (check cap or round cap) on a node: like the workflow, ask at the
/// cap, continue without asking. `further` carries the server's value "continue" —
/// `continue` is a keyword in Swift.
enum WorkflowCapMode: String, CaseIterable, Sendable {
    case inherit, ask
    case further = "continue"
}

/// The six categories of the settings sheet — keys and order like `WFE_CATEGORIES` in
/// web/src/lib/workflow-settings.ts (bound). Title and symbol are in
/// WorkflowSettings.swift (where `L` exists).
enum WorkflowSettingCategory: String, CaseIterable, Identifiable, Sendable {
    case general, execution, context, check, concurrency, trigger
    var id: String { rawValue }
}

enum WorkflowRules {
    /// The lock ranges of concurrency, from safe to free — like `LOCK_SCOPES`
    /// (server/backend/electron/server/workflows.js) and `LOCK_AREAS` (web/src/lib/workflow-settings.ts).
    static let lockRanges = ["project", "workflow", "event", "custom", "off"]

    /// The three values from the run settings that nodes inherit (`wf`).
    struct Rule: Equatable, Sendable {
        var doneAll = true
        var doneCapAuto = false
        var loopCapAuto = false
    }

    /// A node as the rules need it — structural, so that this file knows no model type.
    struct Node: Equatable, Sendable {
        var id: String
        var type: String
        var title: String = ""
        var maxVisits: Int = 0
        var doneMode: WorkflowDoneMode = .inherit
        var doneCapMode: WorkflowCapMode = .inherit
        var loopCapMode: WorkflowCapMode = .inherit
    }

    struct Edge: Equatable, Sendable {
        var from: String
        var to: String
    }

    /// Effective round cap: number, whether it continues without asking, and the source ("" = own
    /// value or default).
    struct Cap: Equatable, Sendable {
        var cap: Int
        var auto: Bool
        var from: String
    }

    /// Which rows the node sheet carries — the same keys as `rowsFor` on the web.
    struct Rows: Equatable, Sendable {
        var trigger: Bool
        var text: Bool
        var list: Bool
        var command: Bool
        var cap: Bool
        var loopCap: Bool
        var doneMode: Bool
        var doneCap: Bool
        var scale: Bool
        var notification: Bool
    }

    /// Only these two kinds know a "done" (instruction, parallel).
    static let withCompletion: Set<String> = ["instruction", "parallel"]
    /// Entry points and end: no cap, no text.
    static let entryPointsAndEnd: Set<String> = ["start", "end", "trigger"]
    /// Kinds with a turn of their own — the step counter ("{n} steps"), like `countsAsStep` on the server.
    static let stepKinds: Set<String> = ["instruction", "parallel", "ask", "review"]

    static func steps(_ kinds: [String]) -> Int { kinds.filter { stepKinds.contains($0) }.count }

    /// Reading legacy data — ONE place: a valid new value wins; if it is missing (or invalid),
    /// the old checkmark is read. `doneCheck: true` ⇒ "on", otherwise "like workflow";
    /// `capAuto: true` ⇒ BOTH caps "continue" (the old checkmark applied to both), otherwise "like workflow".
    static func nodeModes(
        doneMode: String?, doneCapMode: String?, loopCapMode: String?,
        doneCheck: Bool?, capAuto: Bool?
    ) -> (doneMode: WorkflowDoneMode, doneCapMode: WorkflowCapMode, loopCapMode: WorkflowCapMode) {
        let oldCap: WorkflowCapMode = capAuto == true ? .further : .inherit
        return (
            doneMode.flatMap(WorkflowDoneMode.init(rawValue:)) ?? (doneCheck == true ? .on : .inherit),
            doneCapMode.flatMap(WorkflowCapMode.init(rawValue:)) ?? oldCap,
            loopCapMode.flatMap(WorkflowCapMode.init(rawValue:)) ?? oldCap
        )
    }

    /// Rule 1 — does this node effectively check? Only instruction/parallel; "on" always, "like workflow"
    /// only with "Check all work steps".
    static func checksEffective(_ k: Node, _ wf: Rule) -> Bool {
        withCompletion.contains(k.type) && (k.doneMode == .on || (k.doneMode == .inherit && wf.doneAll))
    }

    /// Rule 2 — does the check cap continue without asking? Only the node's OWN setting counts.
    static func checkCapContinue(_ k: Node, _ wf: Rule) -> Bool {
        k.doneCapMode == .further || (k.doneCapMode == .inherit && wf.doneCapAuto)
    }

    /// Rule 3 — the effective round cap per node. The NUMBER: own value, otherwise the
    /// largest explicitly set one in the own cycle (source = the first in breadth-first order),
    /// otherwise `fallback`. For `auto`: the node's own "ask"/"continue" overrides; otherwise the
    /// group (the sources if explicit caps exist, otherwise all in the cycle): any
    /// "continue" ⇒ continue, otherwise any "ask" ⇒ ask, otherwise the workflow.
    static func capEffective(_ node: [Node], _ edgeList: [Edge], fallback: Int, wf: Rule) -> [String: Cap] {
        var before: [String: [String]] = [:]
        var back: [String: [String]] = [:]
        for e in edgeList {
            before[e.from, default: []].append(e.to)
            back[e.to, default: []].append(e.from)
        }
        // The VISIT ORDER of the breadth-first search, not just the set: with equal caps
        // web (`giver[0]`) and server (`governing[0]`) name the first in this order.
        func reach(_ from: String, _ adj: [String: [String]]) -> [String] {
            var seen: Set<String> = []
            var order: [String] = []
            var queue = [from]
            while !queue.isEmpty {
                let cur = queue.removeFirst()
                for to in adj[cur] ?? [] where !seen.contains(to) {
                    seen.insert(to)
                    order.append(to)
                    queue.append(to)
                }
            }
            return order
        }
        func groupsAuto(_ ms: [Node]) -> Bool {
            if ms.contains(where: { $0.loopCapMode == .further }) { return true }
            if ms.contains(where: { $0.loopCapMode == .ask }) { return false }
            return wf.loopCapAuto
        }
        var byId: [String: Node] = [:]
        for k in node where byId[k.id] == nil { byId[k.id] = k }
        var out: [String: Cap] = [:]
        for n in node {
            let ownAuto: Bool? = n.loopCapMode == .further ? true : n.loopCapMode == .ask ? false : nil
            if n.maxVisits > 0 {
                out[n.id] = Cap(cap: n.maxVisits, auto: ownAuto ?? wf.loopCapAuto, from: "")
                continue
            }
            let her = Set(reach(n.id, back))
            let group = reach(n.id, before).filter { her.contains($0) }.compactMap { byId[$0] }
            if group.isEmpty {
                out[n.id] = Cap(cap: fallback, auto: ownAuto ?? wf.loopCapAuto, from: "")
                continue
            }
            let explicit = group.filter { $0.maxVisits > 0 }
            guard let top = explicit.map(\.maxVisits).max() else {
                out[n.id] = Cap(cap: fallback, auto: ownAuto ?? groupsAuto(group), from: "")
                continue
            }
            let giver = explicit.filter { $0.maxVisits == top }
            out[n.id] = Cap(cap: top, auto: ownAuto ?? groupsAuto(giver), from: giver[0].title.isEmpty ? giver[0].id : giver[0].title)
        }
        return out
    }

    /// Does the round cap show in the sheet? Only on a step on a cycle (not start/end/trigger).
    static func showsCap(_ cycle: Set<String>, _ k: Node) -> Bool {
        cycle.contains(k.id) && !entryPointsAndEnd.contains(k.type)
    }

    /// The composition of the node sheet per type — mirror of `rowsFor(cycle, node, wf)`.
    static func rows(_ cycle: Set<String>, _ k: Node, _ wf: Rule) -> Rows {
        let checks = checksEffective(k, wf)
        return Rows(
            trigger: k.type == "trigger",
            text: !entryPointsAndEnd.contains(k.type),
            list: k.type == "loop",
            command: k.type != "end",
            cap: showsCap(cycle, k),
            loopCap: showsCap(cycle, k),
            doneMode: withCompletion.contains(k.type),
            doneCap: checks,
            scale: checks,
            notification: k.type != "trigger" && k.type != "start"
        )
    }
}
