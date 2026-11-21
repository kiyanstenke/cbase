import SwiftUI

// Instance choice of the Code tab on iOS — counterpart of web/src/components/CodeArea.tsx; the computation lives in
// CodeInstance.swift (twin of web/src/lib/code-instance.ts, bound by a test).
//   - The model lives in AppState (`codeInstance`, per entered project) and remembers the choice per project in UserDefaults
//     (`CodeInstance.rememberKey`). When the effective instance changes, AppState rebuilds the code, git, debug and terminal models
//     (`onSwitch`) — with `instance=<identifier>` on every route; the main carries no parameter.
//   - Source `/api/projects` (`instance.copies[]`), fresh on entering, on every `project/instance` event of this project and after
//     a fallback.
//   - A fallback (copy gone, being removed, failed, 404 `UNKNOWN_INSTANCE` mid-edit) shows as a hint above the editor. If the copy
//     is only NOT READY right now (start after every restart of B, create, recreate), the choice stays (hint, no rebuild).
//   - A switch with an unsaved file asks first. A fallback nobody asked for does not rebuild the models while a file is unsaved
//     (`display` = `CodeInstance.holdFallback`): the copy stays with the "held" hint until the file is no longer changed
//     (CodePane reports it via `apply()`) or the human confirms "Switch to main". While held, the choice stays remembered and
//     the hint names the reason following the list (same as on the web).
//   - A shown fallback follows every read list (`CodeInstance.hintBySituation`); states appear as a word
//     (`AppsStack.operation`), never as an identifier. A category switch tears nothing down here (the models live in AppState).
@MainActor
final class CodeInstanceModel: ObservableObject {
    let projectId: String
    private let client: APIClient
    @Published private(set) var situation: CodeInstance.ListSituation = .loading
    @Published private(set) var field: CodeInstance.Field?
    @Published private(set) var remembered: String?
    @Published var hint: CodeInstance.Hint?
    /// What the models currently show (the reported choice) — the same as `choice`, unless a fallback nobody asked for would hit an
    /// unsaved file. nil: nothing reported yet.
    @Published private(set) var display: CodeInstance.Choice?
    /// The effective choice changed (parameter or waiting) — AppState rebuilds the Code tab models.
    var onSwitch: ((CodeInstance.Choice) -> Void)?
    /// How many files the editor has open with unsaved changes (AppState: the code model) — a fallback then holds.
    var unsaved: () -> Int = { 0 }
    private var reported: (param: String?, waiting: Bool)?

    /// The choice by list and memo (without holding).
    var choice: CodeInstance.Choice { CodeInstance.select(projectId: projectId, field: field, remembered: remembered, situation: situation) }
    /// The choice the bar shows.
    var shown: CodeInstance.Choice { display ?? choice }

    init(client: APIClient, projectId: String) {
        self.client = client
        self.projectId = projectId
        remembered = UserDefaults.standard.string(forKey: CodeInstance.rememberKey(projectId))
    }

    /// The project's row from `/api/projects` — only what the choice needs. A missing field means: no information.
    private struct Row: Decodable {
        let id: String
        let instance: Instance?
        struct Instance: Decodable {
            let identifier: String?
            let converted: Bool?
            let copies: [Copy]?
        }
        struct Copy: Decodable {
            let identifier: String?
            let state: String?
        }
    }

    func load() async {
        do {
            let list: [Row] = try await client.get("/api/projects")
            let z = list.first(where: { $0.id == projectId })?.instance
            field = z.map { i in
                CodeInstance.Field(identifier: i.identifier, converted: i.converted,
                                 copies: i.copies?.map { CodeInstance.CopyRow(identifier: $0.identifier, state: $0.state) })
            }
            situation = .loaded
            // A shown fallback follows the freshly read list — otherwise it froze at the first fallback.
            if hint != nil { hint = CodeInstance.hintBySituation(hint, field: field, situation: .loaded) }
        } catch {
            // A list read once stays what it was; only with no answer at all is the situation `.error`.
            if situation != .loaded { situation = .error }
        }
        apply()
    }

    /// Apply the state of the choice: show the hint, update the remembered choice, report a switch.
    func apply() {
        let w = choice
        // If a copy applies again (the list came after "unchecked" after all), an old fallback hint is superseded.
        if let h = w.hint { hint = h } else if w.param != nil { hint = nil }
        // While the displayed copy is held, the choice stays remembered — the reason then follows the list.
        let holds: Bool = {
            if case .held = CodeInstance.holdFallback(displayed: display, fresh: w, unsaved: unsaved()).hint { return true }
            return false
        }()
        if !w.waiting && w.remember != remembered && !holds { remember(w.remember) }
        let now = CodeInstance.holdFallback(displayed: display, fresh: choice, unsaved: unsaved())
        if display != now { display = now }
        if reported == nil || reported!.param != now.param || reported!.waiting != now.waiting {
            reported = (now.param, now.waiting)
            onSwitch?(now)
        }
    }

    /// The human chooses (after asking when a file is unsaved) — never held.
    func select(_ identifier: String) {
        guard let target = shown.options.first(where: { $0.identifier == identifier }) else { return }
        hint = nil
        display = nil
        remember(target.kind == "copy" ? target.identifier : nil)
        apply()
    }

    /// Release the held copy (the human confirmed, the unsaved file is lost).
    /// Without `display`, `holdFallback` holds nothing.
    func release() {
        display = nil
        apply()
    }

    /// An error of a Code tab route: 404 `UNKNOWN_INSTANCE` of the shown copy => visibly back to the main.
    func error(_ error: Error) {
        guard let e = error as? APIError, let r = CodeInstance.afterError(shown, code: e.code, identifier: e.identifier) else { return }
        hint = r.hint
        remember(nil)
        apply()
        Task { await load() }
    }

    private func remember(_ identifier: String?) {
        remembered = identifier
        let key = CodeInstance.rememberKey(projectId)
        if let identifier { UserDefaults.standard.set(identifier, forKey: key) } else { UserDefaults.standard.removeObject(forKey: key) }
    }
}

/// The bar above the Code tab: "Main | Copy k1 | …" (only with a ready copy), below it a fallback hint.
struct CodeInstanceBar: View {
    @ObservedObject var model: CodeInstanceModel
    /// Does the editor have an unsaved file? Then a switch asks first.
    let unsaved: Bool
    @State private var earmarked: String?

    @State private var releaseAsk = false

    var body: some View {
        let choice = model.shown
        let held: CodeInstance.Hint? = { if case .held = choice.hint { return choice.hint } else { return nil } }()
        let show = held ?? model.hint
        if !choice.options.isEmpty || show != nil {
            VStack(alignment: .leading, spacing: 6) {
                if !choice.options.isEmpty {
                    CbSegments(
                        options: choice.options.map { o in
                            CbSegment(value: o.identifier, label: o.kind == "main" ? L("Main") : L("Copy {name}", ["name": o.name]),
                                       id: "code-instance-\(o.kind == "main" ? "main" : o.name)")
                        },
                        selection: Binding(
                            get: { choice.param ?? choice.options.first?.identifier ?? "" },
                            set: { fresh in
                                guard fresh != (choice.param ?? choice.options.first?.identifier) else { return }
                                if unsaved { earmarked = fresh } else { model.select(fresh) }
                            }
                        ),
                        fills: choice.options.count <= 3
                    )
                    .accessibilityIdentifier("code-instance-choice")
                }
                if let h = show {
                    HStack(alignment: .top, spacing: 8) {
                        Label(text(h), systemImage: "exclamationmark.triangle")
                            .font(.caption)
                            .foregroundStyle(.orange)
                            .frame(maxWidth: .infinity, alignment: .leading)
                        if held != nil {
                            Button(L("Switch to main")) { releaseAsk = true }
                                .font(.caption)
                        } else {
                            Button(L("Dismiss##hide")) { model.hint = nil }
                                .font(.caption)
                        }
                    }
                    .padding(10)
                    .background(Color.orange.opacity(0.1), in: RoundedRectangle(cornerRadius: 11))
                    .accessibilityIdentifier("code-instance-hint")
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .confirmationDialog(
                L("Unsaved changes are lost when you switch the instance."),
                isPresented: Binding(get: { earmarked != nil }, set: { if !$0 { earmarked = nil } }),
                titleVisibility: .visible
            ) {
                Button(L("Switch anyway"), role: .destructive) {
                    if let target = earmarked { model.select(target) }
                    earmarked = nil
                }
                Button(L("Cancel"), role: .cancel) { earmarked = nil }
            }
            .confirmationDialog(
                L("Unsaved changes are lost when you switch the instance."),
                isPresented: $releaseAsk,
                titleVisibility: .visible
            ) {
                Button(L("Switch to main"), role: .destructive) { model.release() }
                Button(L("Cancel"), role: .cancel) {}
            }
        }
    }

    /// A copy's state as a word ("being removed"), never the identifier — the same words as the Apps page (`AppsStack.operation`).
    static func stateWord(_ state: String) -> String {
        if state.isEmpty { return "?" }
        return AppsStack.operation(state)?.word ?? L("unknown")
    }

    private func text(_ h: CodeInstance.Hint) -> String {
        switch h {
        case .gone(let name):
            return L("The copy {name} no longer exists — the editor shows the main instance again.", ["name": name])
        case .notReady(let name, let state):
            return L("The copy {name} is not ready ({state}) — the editor shows the main instance.", ["name": name, "state": Self.stateWord(state)])
        case .transient(let name, let state):
            return L("The copy {name} is not ready right now ({state}) — the editor stays with it and continues once it is ready.", ["name": name, "state": Self.stateWord(state)])
        case .unchecked(let name):
            return L("The project list could not be loaded — whether the copy {name} still exists is unknown. The editor shows the main instance.", ["name": name])
        case .held(let name, let reason):
            // Wording as on the web; the iOS editor has exactly one open file. The reason: from the choice, else the shown
            // fallback of the same copy (a 404 forgets the memo immediately).
            let g: CodeInstance.Hint? = reason ?? {
                switch model.hint {
                case .gone(let n) where n == name, .notReady(let n, _) where n == name, .unchecked(let n) where n == name: return model.hint
                default: return nil
                }
            }()
            switch g {
            case .notReady(_, let state) where state == "clearAway":
                return L("The copy {name} is being removed — {n} file(s) with unsaved changes stay open, but they can no longer be saved. Copy what you need, then switch to the main instance.", ["name": name, "n": "1"])
            case .notReady(_, let state):
                return L("The copy {name} is not ready ({state}) — {n} file(s) with unsaved changes stay open, but they can no longer be saved. Copy what you need, then switch to the main instance.", ["name": name, "state": Self.stateWord(state), "n": "1"])
            case .gone:
                return L("The copy {name} no longer exists — {n} file(s) with unsaved changes stay open, but they can no longer be saved. Copy what you need, then switch to the main instance.", ["name": name, "n": "1"])
            default:
                return L("The copy {name} is gone — {n} file(s) with unsaved changes stay open, but they can no longer be saved. Copy what you need, then switch to the main instance.", ["name": name, "n": "1"])
            }
        }
    }
}
