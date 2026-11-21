import SwiftUI

// ── The event chain ─────────────────────────────────────────────────────────
//
// The same nine stations and the same wording as in the web client (`web/src/components/settings/AgentHooksSettings.tsx`
// with `Chain`/`ChainPlace` from its SettingsKit). The reason holds here too: a list of pickers does not say that the
// places have an ORDER and that between two occupied ones there is an empty one.
//
// VERTICAL instead of horizontal, and that is not a matter of taste: nine stations at phone width are about 36 points per
// column, the longest label has sixteen characters. Horizontally that leaves a pile of syllables or a cut-off word — a
// picture that no longer names its own stations explains nothing. Vertically the label sits NEXT to the dot and has the
// whole row width; the sequence reads in the same direction as the list below.

/// The places in the run, in CHRONOLOGICAL order — the picker list comes from the server and is sorted by origin
/// (`HOOK_EVENTS` in `toolchain/profiles.js`), which is not a sequence.
///
/// This list is SUBORDINATE to the server list: an event the server offers that is missing here is appended at the end
/// with its raw name. A missing dot would otherwise be indistinguishable from "nothing hangs here" — and the chain
/// would claim a completeness it does not have.
///
/// Computed instead of stored as a constant: a globally evaluated `let` would freeze the language of the first access,
/// and the choice can change at runtime. The wording stands as literals — the wording audit sees only literal calls; a
/// table of bare strings translated later would go unnoticed and show German in English.
private var hookChainsSequence: [(event: String, text: String)] {
    [
        ("SessionStart", L("Session start")),
        ("UserPromptSubmit", L("Input")),
        ("PreToolUse", L("Before the tool")),
        ("Notification", L("Approve##noun")),
        ("PostToolUse", L("After the tool")),
        ("SubagentStop", L("Subagent done")),
        ("PreCompact", L("Before compacting")),
        ("Stop", L("End of the run")),
        ("SessionEnd", L("Session end")),
    ]
}

/// A place in the chain: raw event name, label and the number of hooks hanging there.
private struct HookChainsPlace: Identifiable {
    let event: String
    let text: String
    let count: Int

    var id: String { event }
    var occupied: Bool { count > 0 }
}

/// The places from exactly the state the form below renders from: `events` is the server's choice, `hooks` are the
/// entries in the form. The chain thus follows the UNSAVED state too — a freshly created hook fills its dot as soon as it
/// has a command, and exactly then it also goes out on save (`save()` discards empty commands).
///
/// An event for which the server offers no choice (any more) also gets its place as long as a hook hangs on it —
/// otherwise it would have vanished from the picture and still be in the form. The unknown ones stand sorted at the end:
/// a `Set` has no reliable order, and a picture that sorts differently on every build is none.
private func hookChainsPlaces(events: [String], hooks: [AgentHook]) -> [HookChainsPlace] {
    let existing = Set(events + hooks.map(\.event))
    let known = Set(hookChainsSequence.map(\.event))
    let followUp = hookChainsSequence.filter { existing.contains($0.event) }
        + existing.subtracting(known).sorted().map { (event: $0, text: $0) }
    return followUp.map { place in
        HookChainsPlace(
            event: place.event,
            text: place.text,
            count: hooks.filter {
                $0.event == place.event && !$0.command.trimmingCharacters(in: .whitespaces).isEmpty
            }.count
        )
    }
}

/// The chain itself: one dot per place, filled with the number of hooks hanging there, empty as a ring — joined by a
/// hairline.
private struct HookChain: View {
    let places: [HookChainsPlace]

    /// Diameter of the dot; 18 carries a two-digit number without stretching the row.
    private let point: CGFloat = 18
    /// Width of the dot column — it gives the line its centre.
    private let column: CGFloat = 20

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(Array(places.enumerated()), id: \.element.id) { number, place in
                row(place, first: number == 0, last: number == places.count - 1)
            }
        }
        .padding(.vertical, 2)
        // The identifier sits on the container because the chain has no control that would carry it better.
        // `children: .contain` is mandatory nonetheless: an identifier on a stack REPLACES the identifiers and labels of
        // all children, and some text inside would be found instead of the picture.
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("settings-hooks-chain")
    }

    private func row(_ place: HookChainsPlace, first: Bool, last: Bool) -> some View {
        // Centred alignment so dot and gap in the line sit at the same place: the two halves share the row height, their
        // seam is the centre.
        HStack(spacing: 10) {
            ZStack {
                VStack(spacing: 0) {
                    stroke(bottom: false).opacity(first ? 0 : 1)
                    stroke(bottom: true).opacity(last ? 0 : 1)
                }
                pointView(place)
            }
            .frame(width: column)
            VStack(alignment: .leading, spacing: 1) {
                Text(place.text)
                    .font(.subheadline.weight(place.occupied ? .semibold : .regular))
                    .foregroundStyle(place.occupied ? Color.primary : Color.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                // On the web the raw event name appears only as a title on the dot — the iPhone has no hover, and the
                // picker in the form below shows exactly this name. Without it one would have to guess which row belongs to
                // which dot.
                Text(place.event)
                    .cbFont(11, design: .monospaced)
                    .foregroundStyle(.secondary)
            }
            // The padding sits INSIDE the text column and not on the row: on the row it would cut the line at every seam,
            // and the chain would become nine strokes.
            .padding(.vertical, 5)
            Spacer(minLength: 0)
        }
        // A place is ONE statement; read out separately, number, label and raw name would be three unrelated elements.
        .accessibilityElement(children: .combine)
    }

    /// Half a connector. The distance from the centre leaves the dot OUT instead of covering it with a surface: an opaque
    /// surface would have to know the colour of the list row, and in dark mode that differs from the window background.
    private func stroke(bottom: Bool) -> some View {
        Rectangle()
            .fill(Color.secondary.opacity(0.28))
            .frame(width: 1)
            .frame(maxHeight: .infinity)
            .padding(bottom ? .top : .bottom, point / 2 + 2)
    }

    @ViewBuilder
    private func pointView(_ place: HookChainsPlace) -> some View {
        ZStack {
            if place.occupied {
                Circle().fill(Color.accentColor)
                Text(verbatim: "\(place.count)")
                    .cbFont(11, weight: .semibold)
                    .monospacedDigit()
                    .foregroundStyle(.white)
            } else {
                // Empty is a RING with a small core, not a pale full circle: a grey full circle would look like an occupied
                // one that only lacks the number.
                Circle().strokeBorder(Color.secondary.opacity(0.35), lineWidth: 1)
                Circle().fill(Color.secondary.opacity(0.45)).frame(width: 5, height: 5)
            }
        }
        .frame(width: point, height: point)
    }
}

// ── Hooks ───────────────────────────────────────────────────────────────────
struct HooksSettingsView: View {
    @EnvironmentObject private var session: SessionStore
    @State private var hooks: [AgentHook] = []
    @State private var events: [String] = ["PreToolUse", "PostToolUse", "UserPromptSubmit"]
    @State private var status = ""
    @State private var loaded = false

    var body: some View {
        // `ScrollViewReader`: the approvals input scrolls itself to the middle once the keyboard appears
        // (`HooksApprovalsSection`) — the list's keyboard avoidance pushed it behind the glass header bar on first focus
        // (measured seven times out of twelve).
        ScrollViewReader { role in
        CbList {
            // The chain stands at the TOP and without a heading: it is the overview of everything that follows and needs no
            // label above it. A group carries it nonetheless so it stands on the same surface as every other row of the
            // page.
            CbSettingGroup {
                HookChain(places: hookChainsPlaces(events: events, hooks: hooks))
            }
            // The explanatory sentence is carried by the group it belongs to — same wording, same key, and beyond three
            // lines with (i) instead of silently.
            CbSettingGroup(
                title: L("Hooks"),
                hint: L("Shell commands the built-in harness (third-party providers such as Nebius) runs on agent events — just like Claude Code. The command receives the event as JSON on stdin. Claude/Codex use their own CLI hooks.")
            ) {
                // The group carries a row and not just its header: a section without a row is nothing to rely on in a
                // `List` — and "+ Hook" is the action that belongs to this heading.
                Button(L("+ Hook")) {
                    hooks.append(AgentHook(event: events.first ?? "PreToolUse", matcher: "*", command: ""))
                }
                .accessibilityIdentifier("hook-add")
            }
            // One section per hook: that is a FORM (picker, two fields, delete) and not a setting with a control on the
            // right — the row form did not fit.
            ForEach($hooks) { $hook in
                Section {
                    Picker(L("Event"), selection: $hook.event) {
                        ForEach(events, id: \.self) { event in
                            Text(event).tag(event)
                        }
                    }
                    TextField(L("Tool pattern (regex) or *"), text: $hook.matcher)
                        .font(.system(.body, design: .monospaced))
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                    TextField(L("Shell command"), text: $hook.command, axis: .vertical)
                        .cbFont(12, design: .monospaced)
                        .lineLimit(1...4)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                    Button(L("Remove"), role: .destructive) {
                        hooks.removeAll { $0.id == hook.id }
                    }
                }
            }
            Section {
                if loaded && hooks.isEmpty {
                    Text(L("No hooks configured.")).font(.caption).foregroundStyle(.secondary)
                }
                Button(L("Save")) { Task { await save() } }
                    .disabled(!loaded)
                    .accessibilityIdentifier("hooks-save")
                if !status.isEmpty {
                    Text(status).font(.caption).foregroundStyle(.secondary)
                }
            }

            // The three further blocks of the hooks page — as in the web client, in the same order. Each brings its own
            // state, its own loading and its own status (HooksExtras.swift) so that the failure of one route does not take
            // the other two with it.
            HooksApprovalsSection(role: role)
            HooksWebSearchSection()
            HooksReadAloudSection()
        }
        }
        .navigationTitle(L("Hooks"))
        .navigationBarTitleDisplayMode(.inline)
        .task { await load() }
    }

    private func load() async {
        guard let client = session.client else { return }
        do {
            let response: AgentHooksResponse = try await client.get("/api/agent-hooks")
            hooks = response.hooks
            if !response.events.isEmpty { events = response.events }
            loaded = true
        } catch {
            status = error.localizedDescription
        }
    }

    private func save() async {
        guard let client = session.client else { return }
        struct Body: Encodable { let hooks: [AgentHook] }
        status = L("Saving…")
        do {
            let response: AgentHooksResponse = try await client.put(
                "/api/agent-hooks",
                body: Body(hooks: hooks.filter { !$0.command.trimmingCharacters(in: .whitespaces).isEmpty })
            )
            hooks = response.hooks
            status = L("Saved.")
        } catch {
            status = error.localizedDescription
        }
    }
}
