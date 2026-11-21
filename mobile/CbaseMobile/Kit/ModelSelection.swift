import SwiftUI

// The ONE model choice with search: OpenRouter brings its whole catalog (every model with tools, hundreds) — a menu picker with three
// hundred rows is no choice any more. Every model choice of the app that can show OpenRouter models therefore goes through this block:
// when OpenRouter is in it, the menu becomes a row that opens a searchable sheet (`ModelSelectionSheet`); otherwise the caller's menu
// stays as it was (Claude, Codex — the same entries, the same XCUITests). Deliberately NOT by length: Claude and Codex together are a
// dozen models, and a choice that silently changes form at model 13 would be a second rule. Counterpart on the web: the shared model
// choice component with search.
//
// The caller keeps its menu (`menu`) and adds the GROUPS (per provider its models), the binding and the value per entry (`value` —
// most places store the model id, the app agents "provider|model", the subagent "provider::model"). Entries outside the groups
// (default, "· not available") stand as `front`/`rear` — the same ones the menu carries.

/// The models of ONE provider in the choice.
struct ModelGroup: Identifiable {
    let id: String
    let title: String
    let models: [ProviderModel]

    init(id: String, title: String, models: [ProviderModel]) {
        self.id = id
        self.title = title
        self.models = models
    }

    init(_ provider: Provider) {
        self.init(id: provider.id, title: provider.label, models: provider.models)
    }

    init(_ provider: ProviderInfo) {
        self.init(id: provider.id, title: provider.label, models: provider.models)
    }
}

/// An entry outside the groups: "Default" (value "") or a set model that the list no longer carries.
struct ModelExtra: Identifiable {
    let title: String
    let value: String
    var id: String { "\(value)\u{1F}\(title)" }
}

enum ModelSelection {
    /// Does this choice need the search? Yes as soon as OpenRouter is in it — its catalog grows on its own.
    static func withSearch(_ groups: [ModelGroup]) -> Bool {
        groups.contains { $0.id == UsageContract.openrouterId }
    }

    /// Does the search hit this model? Every word must be in the name or id (case-insensitive) — "glm flash" finds
    /// "z-ai/glm-5.3-flash".
    static func matches(_ model: ProviderModel, _ search: String) -> Bool {
        let words = search.lowercased().split(whereSeparator: { $0.isWhitespace })
        guard !words.isEmpty else { return true }
        let haystack = (model.label + " " + model.id).lowercased()
        return words.allSatisfy { haystack.contains($0) }
    }
}

/// The choice: the caller's menu, or — with OpenRouter — a row that opens the searchable sheet. Modifiers of the caller
/// (`.labelsHidden()`, `.frame`, `.accessibilityIdentifier`) apply to both forms.
struct ModelChoice<Menu: View>: View {
    let title: String
    let groups: [ModelGroup]
    @Binding var selection: String
    var value: (ModelGroup, ProviderModel) -> String = { _, m in m.id }
    var front: [ModelExtra] = []
    var rear: [ModelExtra] = []
    @ViewBuilder var menu: () -> Menu

    @State private var open = false

    var body: some View {
        if ModelSelection.withSearch(groups) {
            Button {
                open = true
            } label: {
                LabeledContent {
                    HStack(spacing: 4) {
                        Text(currentTitle)
                            .lineLimit(1)
                            .truncationMode(.middle)
                        Image(systemName: "chevron.up.chevron.down")
                            .font(.caption2.weight(.semibold))
                    }
                    .foregroundStyle(.tint)
                } label: {
                    Text(title).foregroundStyle(.primary)
                }
            }
            .accessibilityValue(currentTitle)
            .sheet(isPresented: $open) {
                ModelSelectionSheet(title: title, groups: groups, selection: selection, value: value, front: front, rear: rear) { fresh in
                    selection = fresh
                }
                .cbSheet(.whole)
            }
        } else {
            menu()
        }
    }

    /// What the row shows: the name of the chosen entry, otherwise the raw id (never empty — an empty row would look like "nothing
    /// chosen" while a value is set).
    private var currentTitle: String {
        if let extra = (front + rear).first(where: { $0.value == selection }) { return extra.title }
        for g in groups {
            if let m = g.models.first(where: { value(g, $0) == selection }) {
                return groups.count > 1 ? "\(g.title) · \(m.label)" : m.label
            }
        }
        return selection.isEmpty ? "—" : selection
    }
}

/// The searchable sheet: a section per provider, the search over name and id, a checkmark on the chosen entry. Tapping chooses and
/// closes. Identifier per row `model-choice-<value>`; the search field is the system's.
struct ModelSelectionSheet: View {
    let title: String
    let groups: [ModelGroup]
    let selection: String
    let value: (ModelGroup, ProviderModel) -> String
    var front: [ModelExtra] = []
    var rear: [ModelExtra] = []
    let select: (String) -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var search = ""

    private var filtered: [ModelGroup] {
        groups.map { g in ModelGroup(id: g.id, title: g.title, models: g.models.filter { ModelSelection.matches($0, search) }) }
            .filter { !$0.models.isEmpty }
    }

    var body: some View {
        NavigationStack {
            CbList {
                // The entries outside the groups only without a search — "Default" is no model one searches for.
                if search.isEmpty, !front.isEmpty {
                    Section {
                        ForEach(front) { e in row(title: e.title, identifier: nil, value: e.value) }
                    }
                }
                ForEach(filtered) { g in
                    Section {
                        ForEach(g.models) { m in row(title: m.label, identifier: m.id == m.label ? nil : m.id, value: value(g, m)) }
                    } header: {
                        if groups.count > 1 { Text(verbatim: g.title) }
                    }
                }
                if search.isEmpty, !rear.isEmpty {
                    Section {
                        ForEach(rear) { e in row(title: e.title, identifier: nil, value: e.value) }
                    }
                }
                if !search.isEmpty, filtered.isEmpty {
                    Text(L("No model matches “{search}”.", ["search": search]))
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .accessibilityIdentifier("model-choice-empty")
                }
            }
            .searchable(text: $search, placement: .navigationBarDrawer(displayMode: .always), prompt: L("Search models"))
            .navigationTitle(title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { SheetClose(label: L("Cancel")) { dismiss() } }
        }
    }

    private func row(title: String, identifier: String?, value: String) -> some View {
        Button {
            select(value)
            dismiss()
        } label: {
            HStack(spacing: 10) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(title)
                        .font(.subheadline)
                        .foregroundStyle(.primary)
                    if let identifier {
                        Text(verbatim: identifier)
                            .cbFont(11, design: .monospaced)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                            .truncationMode(.middle)
                    }
                }
                Spacer(minLength: 8)
                if value == selection {
                    Image(systemName: "checkmark")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(.tint)
                }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("model-choice-\(value)")
        .accessibilityAddTraits(value == selection ? .isSelected : [])
    }
}
