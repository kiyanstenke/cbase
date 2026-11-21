import SwiftUI
import UIKit

// ── The header of a conversation — ONE form for the coding chat ─────────────
//
// One bar sits ABOVE the history — the history runs under it, the stage insets it by the
// measured height of the bar (`topInset` of the `ChatTimelineStage`). Opaque in the card's
// background, no glass. It forms ONE header zone with the app header:
//  – the same background as the TopBar and NO line in between (the shell drops the TopBar's edge
//    while a conversation stands below — `chatHeaderBelow` in `AppShell`); ONE calm edge
//    is drawn by `ChatHeaderGlass` under the whole zone, hints included;
//  – symbols NEUTRAL in the language of the TopBar (weight medium like its symbols, 13 pt like the
//    provider mark on its rings): on the left the way back in primary text like the workspace name above, on the right the
//    handles muted like the status symbols above (`HeaderTone`). Color is carried only by a STATE —
//    the notifier dot, the count on git/channels, an active goal;
//  – the title calm: primary text, medium weight, one line, truncated at the end.
//
// With glass (iOS 26, Kit/CbGlass.swift): the buttons stand per side in ONE glass capsule (left the way,
// right the handles), the title free in between, and under the whole header zone the history runs under a slightly
// translucent, softly blurred background (`CbHeaderVeil`) instead of an opaque surface — TopBar and status bar
// above belong to it (`headerOverhang`). Without glass everything stays as above.

enum ChatHeaderMass {
    /// Height of the bar — the same as the app header (`Metrics.topBarHeight`).
    static let height: CGFloat = 42
    /// Tap area of a button and size of its symbol — equal in all conversations. The symbol 13 pt like
    /// the provider mark on the TopBar's rings (`ProviderMark(size: 13)`), weight medium like its
    /// symbols: ONE glyph size in the whole header zone. The rings themselves are drawn circles, not
    /// glyphs — measured against them (15 pt) the header's symbols stood visibly one step larger than
    /// those of the TopBar (services, pulse 11.5 pt). The tap area stays 32 pt.
    static let button: CGFloat = 32
    static let symbol: CGFloat = 13
    static let weight: Font.Weight = .medium
}

/// Tone of the header symbols: left the way (primary text), right the handles (muted) — as in
/// the TopBar above workspace name and status symbols. `ChatHeader` sets it per side, the buttons
/// read it; outside the header primary text applies.
enum HeaderTone {
    case way, manualAction

    /// On glass the handles stand one step brighter (`textSecondary`): muted on a translucent background they blurred
    /// with the history behind.
    var color: Color { self == .way ? CbColor.text : CbGlass.on ? CbColor.textSecondary : CbColor.textMuted }
}

private struct HeaderToneKey: EnvironmentKey {
    static let defaultValue: HeaderTone = .way
}

extension EnvironmentValues {
    var headerTone: HeaderTone {
        get { self[HeaderToneKey.self] }
        set { self[HeaderToneKey.self] = newValue }
    }
}

struct ChatHeader<Leading: View, Trailing: View>: View {
    let title: String
    var titleIdentifier = "chat-title"
    @ViewBuilder let leading: () -> Leading
    @ViewBuilder let trailing: () -> Trailing

    var body: some View {
        CbGlassGroup {
            HStack(spacing: 2) {
                HStack(spacing: 0) { leading() }
                    .environment(\.headerTone, .way)
                    .modifier(HeaderGlassCapsule())
                Text(title)
                    .cbFont(15, weight: .medium)
                    .foregroundStyle(CbColor.text)
                    .lineLimit(1)
                    .truncationMode(.tail)
                    .padding(.leading, 6)
                    .accessibilityIdentifier(titleIdentifier)
                Spacer(minLength: 4)
                HStack(spacing: 0) { trailing() }
                    .environment(\.headerTone, .manualAction)
                    .modifier(HeaderGlassCapsule())
            }
            // With glass the capsules line up with those of the TopBar above (12 pt from the edge).
            .padding(.horizontal, CbGlass.on ? 12 : 6)
            .frame(height: ChatHeaderMass.height)
        }
    }
}

/// One side of the header as a glass capsule (iOS 26) — unchanged without glass. The capsule is 36 pt high (buttons 32 + 2 × 2) and
/// fits into the 42 pt of the bar; a glass of its own per button would have been up to seven circles on the right.
private struct HeaderGlassCapsule: ViewModifier {
    func body(content: Content) -> some View {
        if CbGlass.on {
            content
                .padding(.horizontal, 3)
                .padding(.vertical, 2)
                .cbGlass(Capsule())
        } else {
            content
        }
    }
}

/// The symbol of a header button — also as the label of a `Menu` (without its own button).
/// With `punkt` it carries a notifier at the top right ("something is running behind it"): a filled
/// circle with a ring in the background color, so it stands out on the symbol too.
///
/// The color is a FIXED one (`HeaderTone.color`), never the hierarchical `.primary`: in a `Menu`
/// `.primary` derives from its tint — so the ⋯ stood in the accent while the agent button
/// next to it (`.plain`) stood in primary text.
struct HeaderSymbol: View {
    let systemImage: String
    /// A STATE in the accent (active goal) — otherwise neutral in the tone of the side.
    var accent = false
    var point = false
    /// Round button with hairline edge — the menu button, in the form of the
    /// workspace capsule above: only the edge, no surface of its own.
    var round = false
    @Environment(\.headerTone) private var tone

    var body: some View {
        Image(systemName: systemImage)
            .font(.symbol(ChatHeaderMass.symbol, weight: ChatHeaderMass.weight))
            .foregroundStyle(accent ? Color.accentColor : tone.color)
            .frame(width: ChatHeaderMass.button, height: ChatHeaderMass.button)
            .overlay {
                // On glass the capsule carries the shape — a ring inside would be a second edge.
                if round && !CbGlass.on { Circle().strokeBorder(CbColor.edge).padding(2) }
            }
            .overlay(alignment: .topTrailing) {
                if point {
                    Circle()
                        .fill(Color.accentColor)
                        .frame(width: 7, height: 7)
                        .overlay(Circle().strokeBorder(CbColor.ground, lineWidth: 1.5))
                        .padding(.top, 5)
                        .padding(.trailing, 4)
                }
            }
            .contentShape(Rectangle())
    }
}

/// The count at the top right of a header symbol (open changes on git, unread
/// channel messages) — a state, hence in the accent; ONE form for both buttons. `foreign`: the count does NOT belong to the
/// instance of this chat (git sheet with a chosen foreign instance, Chat/ChatGitBar.swift) — then in the warning color of the choice.
struct HeaderCount: View {
    let n: Int
    var foreign = false

    var body: some View {
        Text(verbatim: n > 9 ? "9+" : "\(n)")
            .cbFont(8, weight: .bold)
            .foregroundStyle(CbColor.ground)
            .padding(.horizontal, 3)
            .frame(minWidth: 12, minHeight: 12)
            .background(foreign ? Color.orange : Color.accentColor, in: Capsule())
            .offset(x: 1, y: -1)
    }
}

/// A header button: 13 pt symbol (`ChatHeaderMass.symbol`) in a 32 pt tap area.
struct HeaderButton: View {
    let systemImage: String
    let label: String
    var identifier: String? = nil
    var accent = false
    /// Notifier at the top right of the symbol — "something is running behind it" (see `HeaderSymbol`).
    var point = false
    /// Round button (see `HeaderSymbol.round`).
    var round = false
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HeaderSymbol(systemImage: systemImage, accent: accent, point: point, round: round)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label)
        // The notifier is a shape INSIDE the button and thus no element of its own — without this line
        // "the dot stands" would be a promise no test can keep.
        .accessibilityValue(point ? "running" : "")
        .accessibilityIdentifier(identifier ?? "")
    }
}

/// The background of the header: opaque in the card's background, and
/// ONE calm edge at the bottom. On the CONTAINER of the bar (header plus hints below), not on the
/// bar alone — the hints (limit, workflow, tasks) lie with it above the history, need
/// the same background, and the edge belongs under the WHOLE zone. Above it there is none: the TopBar drops
/// its own while a conversation stands below (`AppShell`).
///
/// With glass (iOS 26) a slightly translucent one (`CbHeaderVeil`) instead of the opaque background: it reaches from the
/// top screen edge (the container then begins below status bar and TopBar, `headerOverhang`) to below the hints
/// and fades out softly there, without an edge — the history shimmers through evenly instead of fading out over the zone.
struct ChatHeaderGlass: ViewModifier {
    func body(content: Content) -> some View {
        if CbGlass.on {
            content
                .background(alignment: .top) { CbHeaderVeil() }
        } else {
            content
                .background(CbColor.ground)
                .overlay(alignment: .bottom) {
                    Rectangle().fill(CbColor.edge).frame(height: 0.5)
                }
        }
    }
}

// The ☰ button `ChatListButton` (chat list in the left drawer) is gone; the chat list opens with the swipe to the right.
// Guard (e) in `web/test/ios-drawer.test.mjs`.

// ── The instance of the chat ────────────────────────────────────────────────
//
// A chat works in the main or in a copy of its project (`chats.instance`). The choice stands twice: in the empty chat next to
// the project choice (`ChatComposer.projectRow`, the draft takes it into creation) and here in the header — as a symbol, in the accent,
// while the chat works in a copy (a state, color allowed). In EVERY converted project whose field is read
// (`InstancesTree.chatInstanceOptions` returns at least main there; without a ready copy main stands alone and chosen) — and under a separator "Create copy …"
// (`ChatInstanceRules.copyCreate`): the way into the project's "Instances" tab, where "Create copy" opens with the chat's
// instance as base (`AppState.instancesShow`, Code/ProjectInstances.swift). Without options no button (not converted, field not
// read), except with a binding to a dead copy. The switch is `PATCH /api/chats/:id {instance}`; the
// server writes the separator (`hint`) into the history and rejects an unknown instance with 409. A running turn stays pinned to
// its instance — the switch applies from the next one.
// The LIVE project list (`projects(in:)`) is read, not `ChatViewModel.workspace`: that is a snapshot from opening the
// chat, and a newly created or cleaned-up copy would appear in the choice only after reopening.
// The pure rules live in Chat/ChatInstanceRules.swift (executed in the test):
//   - the header follows every switch the server reports (`harness`/`chat_settings {instance}` → `ChatViewModel+Strom`), and
//     the separator "now working in …" is reloaded — immediately without a running turn, otherwise at run end (`historyAfterInstanceSwitch`).
//   - a draft holds its copy only while it is an option (`holdDraftInstance`, from `ChatComposer.projectRow`), and a
//     chat bound to a copy that is no longer an option still sees the choice — with main as the way back.
//   - the state stands as a word of the "Instances" tab (`ProjectInstancesPage.situationText`), never raw.

extension ChatViewModel {
    /// The projects of this chat's workspace — LIVE from `AppState.workspaces` (the events `project/copy` and `project/instance`
    /// reload them, `AppState.projectListSoon`), not from `workspace`, the snapshot from opening the chat. If the list does not know the
    /// workspace (yet), the snapshot applies — a list not yet loaded does not mean "no projects".
    func projects(in state: AppState) -> [Project] {
        state.workspaces.first(where: { $0.id == workspace.id })?.projects ?? workspace.projects
    }

    /// The instance choice of the chat: the options of its project from the live list (empty = no choice). Never for the child chat of a
    /// graph run (`parentChatId`): it does not switch (409 INSTANCE_PINNED).
    func instanceOptions(in state: AppState) -> [InstancesTree.Option] {
        guard chat.parentChatId == nil else { return [] }
        guard let pid = chat.projectId, let p = projects(in: state).first(where: { $0.id == pid }) else { return [] }
        return InstancesTree.chatInstanceOptions(p.instance?.treeField)
    }

    /// Choose the instance: in a draft only remember (goes out with creation), otherwise `PATCH /api/chats/:id {instance}`.
    /// `main` goes out as "main" — a missing field would be no statement.
    func selectInstance(_ name: String) async throws {
        if isDraft {
            chat.instance = ChatInstanceRules.binding(name)
            return
        }
        struct Body: Encodable { let instance: String }
        let updated: Chat = try await client.patch("/api/chats/\(chat.id)", body: Body(instance: name))
        chat = updated
        onChanged()
        // Show the separator the server writes in the process immediately — not only after the next opening.
        historyAfterInstanceSwitch()
    }

    /// After an instance switch fetch the history so that the separator "now working in …" (role `hint`) is there:
    /// immediately without a running turn, otherwise at run end (`historyAfterRun`, `ChatViewModel+Strom` `run_done`) — in the middle of the turn
    /// the reload would wipe the not yet saved answer text (same rule as on re-entry in `handleHarness`).
    func historyAfterInstanceSwitch() {
        guard !isDraft else { return }
        if busy { historyAfterRun = true } else { Task { await reloadChatAndLog() } }
    }

    /// The copy remembered in the draft only counts while the live list offers it as an option — otherwise it falls
    /// back to main (called on every change of the options, `ChatComposer.projectRow`). A created chat stays untouched:
    /// its binding belongs to the server.
    func holdDraftInstance(_ live: [String]) {
        guard isDraft else { return }
        let fresh = ChatInstanceRules.draftChoice(chat.instance, live: live)
        if fresh != chat.instance { chat.instance = fresh }
    }
}

/// The instance choice as a menu — in the chat header (symbol only) and in the empty chat (`inHeader == false`: with the name).
struct ChatInstanceChoice: View {
    /// The live project list (`ChatViewModel.projects(in:)`) — observed so that a new or cleaned-up copy appears without reopening.
    @EnvironmentObject private var state: AppState
    @ObservedObject var model: ChatViewModel
    var inHeader = true

    /// The row of an entry: the name, behind it the state as a WORD of the "Instances" tab — "ready"
    /// is not shown (the normal case); a binding without an option is called "no longer available".
    static func title(_ e: ChatInstanceRules.Entry) -> String {
        if !e.selectable { return L("{name} · no longer available", ["name": e.name]) }
        guard !e.state.isEmpty, e.state != "ready", let row = ChatInstanceRules.row(name: e.name, state: e.state) else { return e.name }
        return "\(e.name) · \(ProjectInstancesPage.situationText(row))"
    }

    var body: some View {
        let entries = ChatInstanceRules.entries(model.instanceOptions(in: state), selected: model.chat.instance)
        let selected = InstancesTree.chatInstanceName(model.chat.instance)
        let create = ChatInstanceRules.copyCreate(model.instanceOptions(in: state))
        if !entries.isEmpty {
            Menu {
                ForEach(entries) { o in
                    Button {
                        Task {
                            do { try await model.selectInstance(o.name) } catch { model.error = InstancesPageModel.errorText(error) }
                        }
                    } label: {
                        let title = Self.title(o)
                        if o.name == selected { Label(title, systemImage: "checkmark") } else { Text(verbatim: title) }
                    }
                    .disabled(!o.selectable)
                }
                // "Create copy …": into the project's "Instances" tab, "Create copy" with the chat's instance as base.
                if create, let pid = model.chat.projectId {
                    Divider()
                    Button {
                        hideKeyboard()
                        state.instancesShow(projectId: pid, createFrom: selected)
                    } label: {
                        Label(L("Create copy …"), systemImage: "plus.square.on.square")
                    }
                    .accessibilityIdentifier(inHeader ? "chat-instance-create" : "chat-empty-instance-create")
                }
            } label: {
                if inHeader {
                    HeaderSymbol(systemImage: "square.on.square", accent: selected != InstancesTree.main)
                } else {
                    HStack(spacing: 6) {
                        Image(systemName: "square.on.square")
                        Text(verbatim: selected).lineLimit(1)
                        Image(systemName: "chevron.down").font(.symbol(10, weight: .semibold))
                    }
                    // In the empty chat the choice stands in the project row of the strip stack — the same font as every stack row.
                    .font(CbStripMass.font)
                    .foregroundStyle(.secondary)
                    .contentShape(Rectangle())
                }
            }
            .tint(.secondary)
            .accessibilityLabel(L("Instance"))
            .accessibilityValue(selected)
            .accessibilityIdentifier(inHeader ? "chat-instance" : "chat-empty-instance")
        }
    }
}
