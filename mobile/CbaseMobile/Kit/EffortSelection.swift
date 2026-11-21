import SwiftUI

// The app's effort selection — ONE building block for all pickers: chat settings (`Chat/ChatSheets.swift`), new chat
// (`Chat/WorkspaceViews.swift`) — both WITHOUT an empty entry (`empty: nil`) —, workflow settings (`Workflows/WorkflowSettings.swift`)
// and the app agents (`Settings/AgentModelSettings.swift`), the last two with "Default · <level>" (`EffortLevels.standardLabel`).
// Ultracode is its own toggle below (`UltracodeToggle`), not the top level. No selection without levels (`shows`); without this
// block every change would have to be made at every place separately.
//
// The levels, their labels and the marker of a level the model does not carry ("Max · runs as X-High") are still computed by
// `EffortLevels` (Models/Models.swift) — here only the selection is built from it, in ONE place. The word of the empty entry is
// given by the caller (`empty`, already translated, `nil` = none): "Default · <level>" on the inheriting fields, none at the two
// chat places.
//
// Counterpart on the web: `effortEntries` in web/src/lib/effort.ts. Bound: `web/test/effort-ios.test.mjs` runs `entries` with
// `xcrun swift` and holds it against the web block, and also holds that no picker of the app iterates `EffortLevels.selection`
// itself.

/// The effort picker — the same at all places. It carries no identifier: the tests find it by its label "Effort", its entries by
/// their label (menu items carry none).
struct EffortSelection: View {
    @Binding var effort: String
    /// The word of the empty entry ('' = no default) — differs per place, already translated. `nil` = NO empty entry: the two chat
    /// places — a chat always carries a level, the server rejects empty.
    let empty: String?
    /// The UNFILTERED provider list: which levels a model carries depends on the model, not on the login.
    let providers: [Provider]
    let provider: String
    let model: String
    /// The GLOBALLY active provider (`active` from `/api/providers`): an empty `provider` ("Default (global)", old chat) computes
    /// with it, not with "". Empty while unknown.
    var active: String = ""
    /// Whether there is a selection at all is decided by the block ITSELF: no picker for a model without levels and for a provider
    /// with `caps.effort` off — at no place.
    var body: some View {
        if Self.shows(providers, provider: provider, model: model, active: active) {
            Picker(L("Effort"), selection: $effort) {
                ForEach(Self.entries(providers, provider: provider, model: model, current: effort, empty: empty, active: active)) {
                    Text($0.label).tag($0.id)
                }
            }
        }
    }
}

extension EffortSelection {
    /// Is there a selection for (provider, model)? The short form of `EffortLevels.withoutSelection` — the same question as
    /// `effortPicker` on the web.
    static func shows(_ providers: [Provider], provider: String, model: String, active: String = "") -> Bool {
        EffortLevels.withoutSelection(providers, provider: provider, model: model, active: active).isEmpty
    }

    /// The entries of ONE effort selection in order: first the empty entry ('', only with `empty`), then the model's levels, then —
    /// if the model does not carry it — the set level with its substitute in the label. An empty provider computes with the globally
    /// active one (`EffortLevels.effectiveProvider`).
    static func entries(_ providers: [Provider], provider: String, model: String, current: String, empty: String?, active: String = "") -> [EffortLevels.Entry] {
        let provider = EffortLevels.effectiveProvider(provider, active: active)
        return (empty.map { [EffortLevels.Entry(id: "", label: $0)] } ?? [])
            + EffortLevels.selection(providers, provider: provider, model: model, current: current)
    }
}

/// The Ultracode toggle (counterpart of the toggle in the web's effort sheet): its own toggle beside the effort selection,
/// independent of the level — switching on and off leaves the level alone, and it also stands on a model without levels. At the
/// chat places (chat sheet, new chat, scheduled); a workflow's run settings carry their own.
struct UltracodeToggle: View {
    @Binding var on: Bool

    var body: some View {
        Toggle(isOn: $on) {
            VStack(alignment: .leading, spacing: 2) {
                Text(verbatim: "Ultracode")
                Text(L("Multi-agent orchestration without asking — independent of the effort level."))
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .accessibilityIdentifier("ultracode-toggle")
    }
}
