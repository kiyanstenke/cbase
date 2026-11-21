import Foundation

// The instance choice of a chat's git view (twin of web/src/lib/bar-instance.ts, bound in web/test/bar-instance-binding.test.mjs;
// both are RUN on the same cases). The rules are at the top there; in short:
//   - The target carries EXACTLY ONE: the chat (`chat=<id>`, default) or the choice — a copy as `instance=<identifier>`, the main
//     without any parameter. Never both (devtools/routes.js withSelectedInstance: 400; with the chat's own copy blocked the main
//     would be blocked too).
//   - A choice that equals the own instance is chat mode (silently).
//   - Only the chat-bound tree knows the own instance (`GitModel.copy`); the choice remembers it (`own`) together with the
//     signature of this chat's copy rows from the project list. If the signature changes (move in or out), the choice drops (hint
//     `.own`); likewise if the remembered own copy has no row any more (child chat of a graph run).
//     `copies[].chatId` only means "created by"; the binding lives in `chats.instance`: the signature includes it (`binding`),
//     otherwise a choice would linger after an instance change.
//   - The chosen copy gone, removed, failed ⇒ back to the CHAT (not to the main), visibly; only temporarily not ready
//     (`CodeInstance.transient`) ⇒ the choice stays. A 404 `UNKNOWN_INSTANCE` / 400 `INSTANCE_INVALID` likewise (`afterError`).
//   - The own copy is ALWAYS among the options (from `own`, never from the list — child chats of a graph run do not see it).
//   - Empty is not unknown: without a read own instance or on a loading list no choice; a made one stays while loading and only
//     drops on a READ list.
//   - The hint of a dropped choice is tracked on every read list (`hintBySituation`) — same computation as in the code tab
//     (`CodeInstance.fallbackBySituation`).
// Foundation only, no L(…), only CodeInstance.swift as a neighbour: the test translates both files alone.
enum BarInstance {
    /// A chat's remembered choice (Chat/ChatGitBar.swift, per chat in memory — not in UserDefaults: after a restart the own
    /// instance is unknown, and a forgotten choice would make a commit in the wrong container more likely).
    struct Choice: Equatable, Sendable {
        /// `<projectId>/main` or `<projectId>/copy-<name>`.
        var identifier: String
        var projectId: String
        /// The chat's own instance at the time of the choice: the name of its copy ("k1") or nil (the main).
        var own: String?
        /// `ownSignature` of the list at the time of the choice.
        var signature: String
    }

    /// What the chat-bound tree says about the own instance: nothing yet, the main, or a copy.
    enum Own: Equatable, Sendable {
        case unknown
        case main
        case copy(String)
    }

    struct Option: Equatable, Hashable, Sendable {
        let identifier: String
        let kind: String // "main" | "copy"
        let name: String
        let own: Bool
    }

    enum Hint: Equatable, Sendable {
        case gone(name: String)
        case notReady(name: String, state: String)
        case transient(name: String, state: String)
        case own
    }

    /// Where git goes: EXACTLY the chat OR the choice (`chatId` nil; `instance` only for a copy).
    struct Target: Equatable, Hashable, Sendable {
        var chatId: String?
        var instance: String?
    }

    struct Snapshot: Equatable, Sendable {
        /// The menu's entries — empty means: no choice.
        var options: [Option]
        var target: Target
        /// The shown instance — nil while it is unknown or the project is not converted.
        var shown: String?
        /// The name of the shown copy, nil for the main.
        var shownName: String?
        /// What is shown is NOT this chat's instance.
        var foreign: Bool
        var hint: Hint?
        /// What stays remembered: the choice, or nil (chat mode).
        var remember: Choice?
    }

    private static func copyIdentifier(_ projectId: String, _ name: String) -> String { "\(projectId)/copy-\(name)" }

    /// A chat's binding (`chats.instance`) for the signature: `copy-<name>` or nil (main — nil, empty or "main").
    private static func bindingOf(_ binding: String?) -> String? {
        let b = (binding ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        return b.isEmpty || b == CodeInstance.main ? nil : b
    }

    /// This chat's copy rows in the list — only their identifiers, sorted — and its binding (`chats.instance`) if it works in a
    /// copy (`#copy-<name>` appended). A move in or out and an instance change alter it, a `start` does not.
    static func ownSignature(_ field: CodeInstance.Field?, chatId: String?, binding: String?) -> String {
        guard let chatId, !chatId.isEmpty else { return "" }
        let rows = (field?.copies ?? [])
            .filter { ($0.chatId ?? "") == chatId }
            .map { $0.identifier ?? "" }
            .filter { !$0.isEmpty }
            .sorted()
            .joined(separator: "|")
        guard let b = bindingOf(binding) else { return rows }
        return "\(rows)#\(b)"
    }

    /// The choice of a chat's git view. `ownFromServer`: what the chat-bound tree names — only passed in chat mode.
    /// `binding`: the value of `chat.instance` (signature, see top).
    static func snapshot(projectId: String?, field: CodeInstance.Field?, situation: CodeInstance.ListSituation, chatId: String?, binding: String?,
                      ownFromServer: Own, choice remembered: Choice?) -> Snapshot {
        let pid = projectId ?? ""
        let chat: String? = (chatId?.isEmpty == false) ? chatId : nil
        let choice: Choice? = { // a choice of another project does not apply
            guard let g = remembered, !pid.isEmpty, chat != nil, g.projectId == pid else { return nil }
            return g
        }()
        let mainIdentifier: String? = {
            guard !pid.isEmpty, field?.converted == true, let t = CodeInstance.identifierParts(field?.identifier),
                  t.instance == CodeInstance.main, t.projectId == pid else { return nil }
            return field?.identifier
        }()
        let own: Own = choice.map { w in w.own.map { Own.copy($0) } ?? .main } ?? ownFromServer
        let ownName: String? = { if case .copy(let n) = own { return n } else { return nil } }()
        let ownIdentifier: String? = {
            guard !pid.isEmpty else { return nil }
            switch own {
            case .unknown: return nil
            case .main: return mainIdentifier
            case .copy(let n): return copyIdentifier(pid, n)
            }
        }()

        func options(selected: String?) -> [Option] {
            guard chat != nil, let hk = mainIdentifier, own != .unknown, situation == .loaded else { return [] }
            var list = [Option(identifier: hk, kind: "main", name: "", own: own == .main)]
            var seen: Set<String> = [hk]
            if let n = ownName {
                let k = copyIdentifier(pid, n)
                list.append(Option(identifier: k, kind: "copy", name: n, own: true))
                seen.insert(k)
            }
            for z in field?.copies ?? [] {
                let k = z.identifier ?? ""
                let state = z.state ?? ""
                let counts = state == "ready" || (k == selected && CodeInstance.transient.contains(state))
                guard let name = CodeInstance.copyNameOf(k), CodeInstance.identifierParts(k)?.projectId == pid,
                      counts, !seen.contains(k) else { continue }
                seen.insert(k)
                list.append(Option(identifier: k, kind: "copy", name: name, own: false))
            }
            return list.count > 1 ? list : []
        }
        func chatState(_ hint: Hint?) -> Snapshot {
            Snapshot(options: options(selected: nil), target: Target(chatId: chat, instance: nil), shown: ownIdentifier,
                  shownName: ownName, foreign: false, hint: hint, remember: nil)
        }

        guard let choice else { return chatState(nil) }
        if choice.identifier == ownIdentifier { return chatState(nil) } // normalised: the own instance is chat mode
        let gName = CodeInstance.copyNameOf(choice.identifier)
        func selectedStatus(_ hint: Hint?, _ options: [Option]) -> Snapshot {
            Snapshot(options: options, target: Target(chatId: nil, instance: gName != nil ? choice.identifier : nil), shown: choice.identifier,
                  shownName: gName, foreign: true, hint: hint, remember: choice)
        }
        // Empty is not unknown: on a list not (or not yet) read, the choice is not decided.
        if situation != .loaded { return selectedStatus(nil, []) }
        if ownSignature(field, chatId: chat, binding: binding) != choice.signature { return chatState(.own) }
        // The own copy has no row any more ⇒ the chat no longer works in it (child chat of a graph run: no signature).
        if let e = choice.own, !(field?.copies ?? []).contains(where: { ($0.identifier ?? "") == copyIdentifier(pid, e) }) {
            return chatState(.own)
        }
        guard let name = gName else {
            return choice.identifier == mainIdentifier ? selectedStatus(nil, options(selected: nil)) : chatState(.gone(name: ""))
        }
        guard let row = (field?.copies ?? []).first(where: { ($0.identifier ?? "") == choice.identifier }), mainIdentifier != nil else {
            return chatState(.gone(name: name))
        }
        let state = row.state ?? ""
        if state == "ready" { return selectedStatus(nil, options(selected: choice.identifier)) }
        if CodeInstance.transient.contains(state) {
            return selectedStatus(.transient(name: name, state: state), options(selected: choice.identifier))
        }
        return chatState(.notReady(name: name, state: state))
    }

    /// The choice a tap on `identifier` remembers — nil for the own instance (chat mode) or an unknown option.
    static func select(_ snapshot: Snapshot, identifier: String, projectId: String, field: CodeInstance.Field?, chatId: String, binding: String?) -> Choice? {
        guard let o = snapshot.options.first(where: { $0.identifier == identifier }), let own = snapshot.options.first(where: { $0.own }),
              !o.own else { return nil }
        return Choice(identifier: o.identifier, projectId: projectId, own: own.kind == "main" ? nil : own.name,
                    signature: ownSignature(field, chatId: chatId, binding: binding))
    }

    /// A server error during a choice: if it calls the CHOSEN instance unknown (404 `UNKNOWN_INSTANCE`) or invalid
    /// (400 `INSTANCE_INVALID`), the choice drops — back to the chat, with a hint. Any other error: nil.
    static func afterError(_ choice: Choice?, code: String?, identifier: String?) -> Hint? {
        guard let choice, code == "UNKNOWN_INSTANCE" || code == "INSTANCE_INVALID" else { return nil }
        if let identifier, !identifier.isEmpty, identifier != choice.identifier { return nil }
        return .gone(name: CodeInstance.copyNameOf(choice.identifier) ?? "")
    }

    /// The hint of a dropped choice, tracked on a READ list — `.notReady` becomes `.gone` as soon as the row is missing, carries a
    /// new state, or drops (nil) when the copy is ready again; `.gone`, `.own`, `.transient` stay.
    static func hintBySituation(_ h: Hint?, field: CodeInstance.Field?, situation: CodeInstance.ListSituation) -> Hint? {
        guard let h else { return nil }
        guard situation == .loaded else { return h }
        let name: String
        let state: String?
        switch h {
        case .gone(let n): name = n; state = nil
        case .notReady(let n, let z): name = n; state = z
        default: return h
        }
        switch CodeInstance.fallbackBySituation(name: name, state: state, field: field) {
        case .none: return nil
        case .gone: return .gone(name: name)
        case .notReady(let z): return .notReady(name: name, state: z)
        }
    }

    /// The target's query: `chat=<id>` OR `instance=<identifier>` (the main of a choice: none). No pre-encoding — APIClient.makeURL
    /// sets the query itself.
    static func query(_ target: Target) -> [URLQueryItem] {
        (target.chatId.map { [URLQueryItem(name: "chat", value: $0)] } ?? []) + CodeInstance.query(target.instance)
    }
}
