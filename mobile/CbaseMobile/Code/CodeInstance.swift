import Foundation

// Instance choice of the Code tab — twin of web/src/lib/code-instance.ts, bound in web/test/code-instance-binding.test.mjs
// (both are EXECUTED on the same cases). The rules are in that file's header; in short:
//   - a choice exists only for a converted project with at least one READY copy (`/api/projects`, `instance.copies[]`);
//   - the main carries no parameter, a copy carries `instance=<identifier>` (devtools/routes.js selectedInstance);
//   - a remembered copy that is gone, being removed or failed falls VISIBLY back to the main (hint), as does a 404
//     `UNKNOWN_INSTANCE` in the middle of editing;
//   - a remembered copy that is only NOT READY right now (`transient`: create, start, recreate) stays chosen and remembered
//     (hint `.transient`), no rebuild;
//   - a fallback nobody asked for, with an unsaved file, keeps the displayed copy (`holdFallback`, hint `.held` with its reason;
//     the remembered choice stays while held, so the reason follows the list);
//   - a shown fallback is tracked on every list read (`hintBySituation`): row gone => `.gone`, other state => that state,
//     ready again => superseded (nil); a `.gone` stays;
//   - empty is not unknown: while the list loads, the editor waits on a remembered copy; if it never came, main with
//     "unchecked", the choice stays remembered.
// Foundation only, no L(…): the test compiles this file alone.
enum CodeInstance {
    static let main = "main"
    /// States of a copy that is only TRANSIENTLY not ready — the choice then stays.
    static let transient: [String] = ["create", "start", "recreate"]

    struct CopyRow: Equatable, Sendable {
        var identifier: String?
        var state: String?
        /// The chat that owns the copy (`/api/projects`, `instance.copies[].chatId`) — only the chat bar's instance choice reads it
        /// (Chat/BarInstance.swift `ownSignature`); the Code tab's choice does not.
        var chatId: String? = nil
    }

    struct Field: Equatable, Sendable {
        var identifier: String?
        var converted: Bool?
        var copies: [CopyRow]?
    }

    enum ListSituation: String, Sendable { case loading, error, loaded }

    struct Option: Equatable, Hashable, Sendable {
        let identifier: String
        let kind: String // "main" | "copy"
        let name: String
    }

    enum Hint: Equatable, Sendable {
        case gone(name: String)
        case notReady(name: String, state: String)
        case transient(name: String, state: String)
        case unchecked(name: String)
        /// `reason`: why the displayed copy no longer applies (`.gone`, `.notReady`, `.unchecked`) — nil if the new choice names none
        /// and none was held before.
        indirect case held(name: String, reason: Hint?)
    }

    struct Choice: Equatable, Sendable {
        var options: [Option]
        var identifier: String?
        var param: String?
        var copy: String?
        var hint: Hint?
        var waiting: Bool
        var remember: String?
    }

    static func rememberKey(_ projectId: String) -> String { "cbase-code-instance:\(projectId)" }

    static func identifierParts(_ identifier: String?) -> (projectId: String, instance: String)? {
        let k = identifier ?? ""
        guard let i = k.lastIndex(of: "/") else { return nil }
        let project = String(k[k.startIndex..<i])
        let instance = String(k[k.index(after: i)...])
        guard !project.isEmpty, !instance.isEmpty else { return nil }
        return (project, instance)
    }

    static func copyNameOf(_ identifier: String?) -> String? {
        guard let t = identifierParts(identifier), t.instance.hasPrefix("copy-"), t.instance.count > 5 else { return nil }
        return String(t.instance.dropFirst(5))
    }

    /// `selected`: this copy counts even if it is only transiently not ready — the chosen one stays in the bar.
    static func options(_ field: Field?, selected: String? = nil) -> [Option] {
        guard let field, let hk = field.identifier, let main = identifierParts(hk), main.instance == Self.main, field.converted == true else { return [] }
        var copies: [Option] = []
        var seen = Set<String>()
        for k in field.copies ?? [] {
            let identifier = k.identifier ?? ""
            let counts = k.state == "ready" || (selected != nil && identifier == selected && transient.contains(k.state ?? ""))
            guard let name = copyNameOf(identifier), identifierParts(identifier)?.projectId == main.projectId,
                  counts, !seen.contains(identifier) else { continue }
            seen.insert(identifier)
            copies.append(Option(identifier: identifier, kind: "copy", name: name))
        }
        if copies.isEmpty { return [] }
        return [Option(identifier: hk, kind: "main", name: "")] + copies
    }

    static func select(projectId: String, field: Field?, remembered: String?, situation: ListSituation) -> Choice {
        let g = remembered ?? ""
        let rememberedCopy: String? = (identifierParts(g)?.projectId == projectId) ? copyNameOf(g) : nil
        func main(_ hint: Hint?, remember: String? = nil) -> Choice {
            let opts = situation == .loaded ? options(field) : []
            let hk: String? = (situation == .loaded && field?.converted == true && identifierParts(field?.identifier)?.instance == Self.main) ? field?.identifier : nil
            return Choice(options: opts, identifier: hk, param: nil, copy: nil, hint: hint, waiting: false, remember: remember)
        }
        switch situation {
        case .loading:
            if rememberedCopy != nil { return Choice(options: [], identifier: nil, param: nil, copy: nil, hint: nil, waiting: true, remember: g) }
            return main(nil)
        case .error:
            if let name = rememberedCopy { return main(.unchecked(name: name), remember: g) }
            return main(nil)
        case .loaded:
            break
        }
        let opts = options(field)
        guard let name = rememberedCopy else { return main(nil) }
        if let hits = opts.first(where: { $0.kind == "copy" && $0.identifier == g }) {
            return Choice(options: opts, identifier: hits.identifier, param: hits.identifier, copy: hits.name, hint: nil, waiting: false, remember: hits.identifier)
        }
        if let row = (field?.copies ?? []).first(where: { ($0.identifier ?? "") == g }), field?.converted == true {
            let state = row.state ?? ""
            // Only not ready right now — the choice stays (parameter, label, remembered), no rebuild.
            if transient.contains(state) {
                return Choice(options: options(field, selected: g), identifier: g, param: g, copy: name,
                            hint: .transient(name: name, state: state), waiting: false, remember: g)
            }
            return main(.notReady(name: name, state: state))
        }
        return main(.gone(name: name))
    }

    /// Holds the DISPLAYED copy while the editor has unsaved changes and the choice would switch on its own (fallback) —
    /// hint `.held`, same parameter, no rebuild. A switch the human picks comes without `displayed` or with `unsaved` 0
    /// and is never held.
    static func holdFallback(displayed: Choice?, fresh: Choice, unsaved: Int) -> Choice {
        guard let a = displayed, a.param != nil, let copy = a.copy, unsaved > 0, fresh.param != a.param else { return fresh }
        // The reason: the new choice's, else the last held one.
        let prior: Hint? = { if case .held(_, let g) = a.hint { return g } else { return nil } }()
        let reason: Hint? = {
            switch fresh.hint {
            case .gone, .notReady, .unchecked: return fresh.hint
            default: return prior
            }
        }()
        var h = a
        h.hint = .held(name: copy, reason: reason)
        h.waiting = false
        return h
    }

    /// How a list sees a held fallback of the copy (`fallbackBySituation`): nil means superseded.
    enum Fallback: Equatable, Sendable {
        case gone
        case notReady(state: String)
    }

    /// A fallback of copy `name` (`state` nil: "gone") on a READ list — row gone => `.gone`, other state => that state,
    /// selectable again (ready) => nil; a "gone" stays. Shared with the bar (Chat/BarInstance.swift).
    static func fallbackBySituation(name: String, state: String?, field: Field?) -> Fallback? {
        guard state != nil else { return .gone }
        if options(field).contains(where: { $0.kind == "copy" && $0.name == name }) { return nil }
        guard let row = (field?.copies ?? []).first(where: { copyNameOf($0.identifier) == name }) else { return .gone }
        let z = row.state ?? ""
        if z == "ready" { return nil }
        return .notReady(state: z)
    }

    /// The Code tab's fallback hint tracked against the list — only on a read list and only `.gone`/`.notReady`.
    static func hintBySituation(_ h: Hint?, field: Field?, situation: ListSituation) -> Hint? {
        guard let h else { return nil }
        guard situation == .loaded else { return h }
        let name: String
        let state: String?
        switch h {
        case .gone(let n): name = n; state = nil
        case .notReady(let n, let z): name = n; state = z
        default: return h
        }
        switch fallbackBySituation(name: name, state: state, field: field) {
        case .none: return nil
        case .gone: return .gone(name: name)
        case .notReady(let z): return .notReady(name: name, state: z)
        }
    }

    /// A route error: if the server calls the CHOSEN copy unknown (404 `UNKNOWN_INSTANCE`), that is the visible
    /// fallback to the main; any other error changes nothing (`nil`).
    static func afterError(_ choice: Choice, code: String?, identifier: String?) -> Choice? {
        guard let param = choice.param, let copy = choice.copy, code == "UNKNOWN_INSTANCE" else { return nil }
        if let identifier, identifier != param { return nil }
        let hk = choice.options.first(where: { $0.kind == "main" })?.identifier
        let rest = choice.options.filter { $0.identifier != param }
        return Choice(options: rest.count > 1 ? rest : [], identifier: hk, param: nil, copy: nil, hint: .gone(name: copy), waiting: false, remember: nil)
    }

    /// The query for a route: `instance=<param>` only with a copy, else empty (the main carries no parameter).
    /// No pre-encoding — APIClient.makeURL builds the query itself.
    static func query(_ param: String?) -> [URLQueryItem] {
        guard let param, !param.isEmpty else { return [] }
        return [URLQueryItem(name: "instance", value: param)]
    }
}
