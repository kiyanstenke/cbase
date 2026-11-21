import SwiftUI
import UIKit

// Preview links. A link goes through the user's ngrok account to ONE registered service with a port on ONE instance;
// only a human creates it (no MCP tool).
//
// The file has three parts:
//   1. `PreviewRules` — pure calculation without SwiftUI and without `L(…)`: which instance a link on a service hits, the
//      runtimes, the remaining time, how a service's links fall onto its row (`assignment`), the plan limit. The block is
//      cut out in `web/test/preview-rules-binding.test.mjs` and run with `xcrun swift` against the web calculation
//      (`web/src/lib/preview-links.ts`); it may therefore touch only Foundation and `ProjectServiceRow`/`Project`/`PreviewLink`
//      (the mocks there).
//   2. `PreviewLinksModel` — the `GET /api/preview-links` query, create and revoke. It loads on open and on the SSE event
//      `vorschau/link` (`AppState.previewTick`), never on a timer. **A 404 on the list means: this server does not know
//      preview links** (an older server, or the UI-test fixture) — then nothing is shown, neither an offer nor an error.
//   3. The view pieces: `PreviewShareButton` (the menu with the four runtimes on a service row) and `PreviewLinkRow` (an
//      active or ended link with address, `ShareLink`, copy, revoke, remaining time) — used by the ports popover
//      (`ServicesButton.swift`) and by Settings → Integrations (`Settings/NgrokSettings.swift`).
//
// There are no access values (auth token, API key) here: the responses only say WHETHER one is stored.
//
// Identifiers: `preview-share-<serviceId>` (menu on the service row), `preview-access-<serviceId>` (without access: to the
// settings), `preview-link-<linkId>` (a link's row), `preview-share-share-<linkId>`, `preview-copy-<linkId>`,
// `preview-revoke-<linkId>`, `preview-notice` (result in the popover).

// ── 1. Pure calculation ───────────────────────────────────────────────────────────────────────

enum PreviewRules {
    /// The selectable runtimes in days, `nil` = unlimited. The server accepts the same values (1, 7, 30, null).
    static let runtimes: [Int?] = [1, 7, 30, nil]
    /// 7 days are preselected.
    static let defaultDays = 7

    /// Where a link on a service points. `.b` = at B itself (`instance: null` — the project has not been migrated),
    /// `.instance(name)` = at an instance (`main`, `copy-k1`), `.unknown` = cannot be determined: then the view offers NO
    /// link. A wrong `null` for a migrated project would be a 400, a guessed `main` for a non-migrated one a 404 — and a
    /// project that is not loaded yet is not "not migrated" (empty is not unknown).
    enum Target: Equatable, Sendable {
        case b
        case instance(String)
        case unknown

        /// The value for `instance` in the body (`nil` → JSON `null`); `.unknown` has none.
        var bodyValue: String?? {
            switch self {
            case .b: return .some(nil)
            case .instance(let name): return .some(name)
            case .unknown: return nil
            }
        }
    }

    /// The instance name from an identifier "<project>/<instance>" (`p1/main` → `main`, `p1/copy-k1` → `copy-k1`); `nil`
    /// without a slash or with an empty remainder.
    static func instanceName(identifier: String) -> String? {
        guard let cut = identifier.lastIndex(of: "/") else { return nil }
        let name = String(identifier[identifier.index(after: cut)...])
        return name.isEmpty ? nil : name
    }

    /// The target of a link on `service`:
    ///  · if the service names its instances (from two on), the one it RUNS in — main first, otherwise the first running
    ///    copy; if it runs nowhere, `.unknown` (a link to a stopped service would point nowhere);
    ///  · otherwise the project: unknown (not loaded) ⇒ `.unknown`; no instance ⇒ `.b`; migrated with identifier ⇒ its name;
    ///    an instance that is not (yet) migrated ⇒ `.b`; a server that names neither `converted` nor the identifier ⇒
    ///    `.unknown`.
    static func target(service: ProjectServiceRow, project: Project?) -> Target {
        if let list = service.instances, !list.isEmpty {
            let running = list.filter(\.running)
            let choice = running.first(where: { instanceName(identifier: $0.identifier) == "main" }) ?? running.first
            guard let choice, let name = instanceName(identifier: choice.identifier) else { return .unknown }
            return .instance(name)
        }
        guard let project else { return .unknown }
        guard let instance = project.instance else { return .b }
        switch instance.converted {
        case .some(false): return .b
        case .none: return .unknown
        case .some(true):
            guard let identifier = instance.identifier, let name = instanceName(identifier: identifier) else { return .unknown }
            return .instance(name)
        }
    }

    /// How a service's active links fall onto its row — the same assignment as `linkOfTheRow` on the web
    /// (`web/src/lib/preview-links.ts`, bound in `web/test/preview-rules-binding.test.mjs`):
    ///  · `own` is the NEWEST link on exactly this target (project, instance, service; `.b` hits only `instance: null`) — only
    ///    it hides "Share link". An unknown target has no own link.
    ///  · `additional` are the remaining links of the same project and service (another instance, an older one) in list
    ///    order — they sit under the row so nothing vanishes from the popover, and name their instance (`foreignInstance`)
    ///    when it is not the row's.
    /// Assigning by project and service alone would put a link on `copy-k1` under the main row and hide "Share link" there.
    struct Assignment: Equatable {
        var own: PreviewLink?
        var additional: [PreviewLink]
    }

    static func hits(_ link: PreviewLink, _ target: Target) -> Bool {
        switch target {
        case .b: return link.instance == nil
        case .instance(let name): return link.instance == name
        case .unknown: return false
        }
    }

    static func assignment(projectId: String, serviceId: Int, target: Target, in active: [PreviewLink]) -> Assignment {
        let all = active.filter { $0.projectId == projectId && $0.serviceId == serviceId }
        var own: PreviewLink?
        for link in all where hits(link, target) {
            if own == nil || link.createdAt > own!.createdAt { own = link }
        }
        return Assignment(own: own, additional: all.filter { $0.id != own?.id })
    }

    /// The instance a link under a row must name: `nil` if it hits the row's target; otherwise its instance name, for a link
    /// on B (`instance: null`) under an instance row the empty name (the view then says "not migrated").
    static func foreignInstance(_ link: PreviewLink, target: Target) -> String? {
        if hits(link, target) { return nil }
        return link.instance ?? ""
    }

    /// The plan limit is reached (web: `shareSituation` = "limit"): creating another link would end in 409 LIMIT.
    static func limitReached(active: Int, limit: Int) -> Bool {
        limit > 0 && active >= limit
    }

    /// What is left of a link — "6 d left", "5 h left", "12 min left". The same rule as `remainingTime` on the web
    /// (`web/src/lib/preview-links.ts`, bound in `web/test/preview-rules-binding.test.mjs`): from TWO days on in days, from
    /// one hour on in hours, below that in minutes. Rounded down: a link with 6.9 days says "6 d left", never more than it
    /// has; under one minute it says "1 min left" until the server ends it (`expired` only from zero). `now` and
    /// `runningSinceAt` in milliseconds since 1970.
    enum RemainingTime: Equatable, Sendable {
        case unlimited
        case days(Int)
        case hours(Int)
        case minutes(Int)
        case expired
    }

    static func remainingTime(runningSinceAt: Double?, now: Double) -> RemainingTime {
        guard let runningSinceAt else { return .unlimited }
        let rest = runningSinceAt - now
        guard rest > 0 else { return .expired }
        let minute = 60_000.0, hour = 60 * minute, tag = 24 * hour
        if rest >= 2 * tag { return .days(Int(rest / tag)) }
        if rest >= hour { return .hours(Int(rest / hour)) }
        return .minutes(max(1, Int(rest / minute)))
    }
}

// ── 2. The model ─────────────────────────────────────────────────────────────────────────────

/// The user's links (`GET /api/preview-links`) with create and revoke. One per view (`@StateObject`); the trigger to reload
/// comes from the global event stream (`AppState.previewTick`).
@MainActor
final class PreviewLinksModel: ObservableObject {
    /// `nil` until the list has answered once — until then the view offers NOTHING (empty is not unknown).
    @Published private(set) var snapshot: PreviewLinksStatus?
    /// `false` after a 404: the server does not know the routes. Then there is neither an offer nor an error.
    @Published private(set) var available = true
    /// The sentence for the last action (created, copied, failed) — visible until the next one.
    @Published var notice: String?
    /// An error arrived while nobody was looking (the popover was already closed): the ports button then carries a red dot
    /// until the popover has been opened and closed again. The model lives in the button (`ServicesButton`), not in the
    /// popover, so a 502 after closing does not vanish without a trace.
    @Published var errorUnseen = false
    /// What is being worked on: `dienst-<project>-<id>` when creating, the link id when revoking.
    @Published private(set) var working: Set<String> = []

    var client: APIClient?

    /// May a link be offered on this service? Loaded, available, SDK present, mode known and not `off`, service with a
    /// port and a known target. Without access (`off`) the view offers the way to the settings instead (`accessMissing`).
    func offer(_ service: ProjectServiceRow, target: PreviewRules.Target) -> Bool {
        guard let snapshot, available, snapshot.sdk, service.port != nil, target != .unknown else { return false }
        return snapshot.mode == .dev || snapshot.mode == .names
    }

    /// Loaded and available, but no auth token stored — the entry leads to the settings.
    func accessMissing(_ service: ProjectServiceRow) -> Bool {
        guard let snapshot, available, service.port != nil else { return false }
        return snapshot.mode == .off
    }

    /// The plan limit is reached — instead of the runtimes the menu offers the active links to revoke (they often sit on no
    /// visible row: another workspace, a stopped service).
    var limitReached: Bool {
        guard let snapshot else { return false }
        return PreviewRules.limitReached(active: snapshot.active.count, limit: snapshot.limit)
    }

    static func serviceKey(_ service: ProjectServiceRow) -> String { "service-\(service.projectId)-\(service.id)" }

    private func report(error: Error) {
        notice = (error as? APIError)?.message ?? error.localizedDescription
        errorUnseen = true
    }

    func load() async {
        guard let client else { return }
        do {
            let response: PreviewLinksStatus = try await client.get("/api/preview-links", timeout: 20)
            snapshot = response
            available = true
        } catch let error as APIError where error.status == 404 {
            // The server (or the UI-test fixture) does not know the routes: no links, no access — silently.
            snapshot = PreviewLinksStatus()
            available = false
        } catch {
            // Any other error keeps the last state; if there was none, the view offers nothing.
        }
    }

    /// Creates a link (`POST /api/preview-links`, all four keys). The response is the link; an error carries the server's
    /// sentence (409 LIMIT, 412 WITHOUT_ACCESS, 502 NGROK …) — it is then shown as the notice.
    func create(_ service: ProjectServiceRow, target: PreviewRules.Target, days: Int?) async {
        guard let client, let instance = target.bodyValue else { return }
        let key = Self.serviceKey(service)
        working.insert(key)
        defer { working.remove(key) }
        do {
            let link: PreviewLink = try await client.post(
                "/api/preview-links",
                body: PreviewLinkCreation(projectId: service.projectId, instance: instance, serviceId: service.id, validDays: days),
                timeout: 60
            )
            notice = link.url.isEmpty
                ? L("Link for “{service}” created.", ["service": service.name])
                : L("Link for “{service}” created: {url}", ["service": service.name, "url": link.url])
        } catch {
            report(error: error)
        }
        await load()
    }

    /// Revokes a link (`DELETE /api/preview-links/:id`). A second revoke is no error for the server (200).
    func revoke(_ link: PreviewLink) async {
        guard let client else { return }
        working.insert(link.id)
        defer { working.remove(link.id) }
        do {
            let _: PreviewLink = try await client.delete("/api/preview-links/\(link.id)")
            notice = L("Link for “{service}” revoked.", ["service": link.serviceName])
        } catch {
            report(error: error)
        }
        await load()
    }

    func copy(_ link: PreviewLink) {
        guard !link.url.isEmpty else { return }
        UIPasteboard.general.string = link.url
        notice = L("Address copied.")
    }
}

// ── 3. View pieces ───────────────────────────────────────────────────────────────────

/// The runtime as a word: "1 day", "7 days", "30 days", "unlimited".
func previewRuntimeText(_ days: Int?) -> String {
    switch days {
    case .none: return L("unlimited")
    case .some(1): return L("1 day")
    case .some(let n): return L("{n} days", ["n": n])
    }
}

/// "6 d left", "5 h left", "12 min left", "unlimited", "expired".
func previewRemainingTimeText(_ rest: PreviewRules.RemainingTime) -> String {
    switch rest {
    case .unlimited: return L("unlimited")
    case .days(let n): return L("{n} d left", ["n": n])
    case .hours(let n): return L("{n} h left", ["n": n])
    case .minutes(let n): return L("{n} min left", ["n": n])
    case .expired: return L("expired")
    }
}

/// The sentence above creating: open to everyone who has the link — in `dev` mode plus what the free plan means.
func previewHint(mode: PreviewMode?) -> String {
    let open = L("Anyone with the link sees the app without signing in to cbase.")
    guard mode == .dev else { return open }
    return "\(open) \(L("Free plan: always the same address, one link at a time; visitors first see an ngrok warning page."))"
}

/// The sentence at the plan limit — as on the web (`PreviewShare.tsx`, situation "limit").
func previewLimitText(_ snapshot: PreviewLinksStatus) -> String {
    snapshot.mode == .dev
        ? L("Free plan: one link at a time — revoke the active one first")
        : L("{n} of {g} links active (ngrok Hobbyist)", ["n": snapshot.active.count, "g": snapshot.limit])
}

/// "Project · service · address" — a link outside its row (limit, settings).
func previewLinkDescription(_ link: PreviewLink) -> String {
    let address = link.url.isEmpty ? ":\(link.port)" : link.url.replacingOccurrences(of: "https://", with: "")
    return [link.projectName, link.serviceName, address].filter { !$0.isEmpty }.joined(separator: " · ")
}

/// The line above a link that hits a DIFFERENT instance than its service row: "Instance copy-k1", for B "not migrated".
func previewInstanceText(_ name: String) -> String {
    name.isEmpty ? L("not migrated") : L("Instance {name}", ["name": name])
}

/// The error of a link for display: the sentences the server stores (`preview/links.js`) are English on the wire and translated here
/// (the address sentence may carry ` (ERR_NGROK_334)` behind it); anything else stays as it is.
func previewLinkError(_ error: String) -> String {
    let sentences = [
        "The address is already taken by another ngrok tunnel (e.g. the one of the writing assistant).",
        "Project deleted — the link has ended.",
        "Service deleted — the link has ended.",
        "Instance removed — the link has ended.",
        "The project now runs in a project container — the link (on B) has ended.",
        "No ngrok authtoken stored.",
        "Creation aborted (server restart).",
        "Link without an address — its name is unknown.",
    ]
    for (i, s) in sentences.enumerated() where error == s || (i == 0 && error.hasPrefix(s + " (")) {
        return L(s) + error.dropFirst(s.count)
    }
    return error
}

/// A link's second line: remaining time or state, for an ended one the reason.
func previewStateText(_ link: PreviewLink, now: Double) -> String {
    switch link.state {
    case "start":
        return L("opening …")
    case "error":
        let reason = link.error.isEmpty ? L("Error") : previewLinkError(link.error)
        return L("disrupted, retrying: {reason}", ["reason": reason])
    case "ended":
        switch link.endedReason {
        case "revoke": return L("revoked")
        case "expired": return L("expired")
        case "error": return link.error.isEmpty ? L("Error") : L("Error: {reason}", ["reason": previewLinkError(link.error)])
        default: return link.endedReason ?? link.state
        }
    default:
        return previewRemainingTimeText(PreviewRules.remainingTime(runningSinceAt: link.runningSinceAt, now: now))
    }
}

/// The "Share link" menu on a service row: the four runtimes (7 days preselected — marked "Default", since a menu has no
/// preselection), above them the sentence that the link is open. Without access the entry leads to the settings.
struct PreviewShareButton: View {
    @ObservedObject var model: PreviewLinksModel
    let service: ProjectServiceRow
    let target: PreviewRules.Target
    /// Without access: open the settings (the caller closes its popover for it).
    let toTheSettings: () -> Void

    var body: some View {
        if model.offer(service, target: target) {
            let running = model.working.contains(PreviewLinksModel.serviceKey(service))
            Menu {
                if model.limitReached, let snapshot = model.snapshot {
                    // The plan limit: creating would end in 409 — the way out is to revoke an active link.
                    Section(previewLimitText(snapshot)) {
                        ForEach(snapshot.active) { link in
                            Button(role: .destructive) {
                                Task { await model.revoke(link) }
                            } label: {
                                Text(L("Revoke"))
                                Text(verbatim: previewLinkDescription(link))
                            }
                        }
                    }
                } else {
                    Section(previewHint(mode: model.snapshot?.mode)) {
                        ForEach(PreviewRules.runtimes, id: \.self) { days in
                            Button {
                                Task { await model.create(service, target: target, days: days) }
                            } label: {
                                if days == PreviewRules.defaultDays {
                                    Text(previewRuntimeText(days))
                                    Text(L("Default"))
                                } else {
                                    Text(previewRuntimeText(days))
                                }
                            }
                        }
                    }
                }
            } label: {
                symbol(running ? nil : "link.badge.plus")
            }
            .disabled(running)
            .accessibilityLabel(L("Share link"))
            .accessibilityIdentifier("preview-share-\(service.id)")
        } else if model.accessMissing(service) {
            Menu {
                Section(L("Preview links need ngrok access.")) {
                    Button(L("Settings → Integrations")) { toTheSettings() }
                }
            } label: {
                symbol("link.badge.plus")
                    .opacity(0.55)
            }
            .accessibilityLabel(L("Share link"))
            .accessibilityIdentifier("preview-access-\(service.id)")
        }
    }

    @ViewBuilder
    private func symbol(_ name: String?) -> some View {
        Group {
            if let name {
                Image(systemName: name)
                    .font(.symbol(13))
                    .foregroundStyle(.tint)
            } else {
                ProgressView().controlSize(.small)
            }
        }
        .frame(minWidth: 32, minHeight: 32)
        .contentShape(Rectangle())
    }
}

/// A link: address (or state), below it remaining time or reason; on the right — while it is active — share (`ShareLink`),
/// copy and revoke (with a confirmation: a reserved name is gone afterwards). Buttons are `.borderless` so that they hit
/// individually in a list cell instead of all at once.
struct PreviewLinkRow: View {
    @ObservedObject var model: PreviewLinksModel
    let link: PreviewLink
    /// Name project and service (settings) or not (on the service row the service is already shown).
    var withService = false
    /// Name the instance — on a service row whose target the link does NOT hit (`PreviewRules.foreignInstance`).
    var foreignInstance: String? = nil
    @State private var revocationQuestion = false

    private var active: Bool { link.state != "ended" }

    var body: some View {
        TimelineView(.periodic(from: .now, by: 60)) { context in
            let now = context.date.timeIntervalSince1970 * 1000
            HStack(spacing: 6) {
                VStack(alignment: .leading, spacing: 1) {
                    if withService {
                        Text(verbatim: [link.serviceName, link.projectName].filter { !$0.isEmpty }.joined(separator: " · "))
                            .cbFont(12.5, weight: .medium)
                            .lineLimit(1)
                    }
                    if let foreignInstance {
                        Text(verbatim: previewInstanceText(foreignInstance))
                            .cbFont(10.5, weight: .medium)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }
                    Text(verbatim: link.url.isEmpty ? ":\(link.port)" : link.url)
                        .cbFont(11, design: .monospaced)
                        .foregroundStyle(link.url.isEmpty || !active ? Color.secondary : Color.primary)
                        .lineLimit(1)
                        .truncationMode(.middle)
                        .textSelection(.enabled)
                    Text(verbatim: previewStateText(link, now: now))
                        .cbFont(10.5)
                        .foregroundStyle(link.state == "error" ? Color.red : Color.secondary)
                        .lineLimit(2)
                }
                Spacer(minLength: 4)
                if active {
                    buttons
                }
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("preview-link-\(link.id)")
        .confirmationDialog(
            L("Revoke the link for “{service}”?", ["service": link.serviceName]),
            isPresented: $revocationQuestion,
            titleVisibility: .visible
        ) {
            Button(L("Revoke"), role: .destructive) { Task { await model.revoke(link) } }
            Button(L("Cancel"), role: .cancel) {}
        } message: {
            Text(L("Anyone with the address can no longer reach the app afterwards."))
        }
    }

    @ViewBuilder
    private var buttons: some View {
        let running = model.working.contains(link.id)
        if let url = URL(string: link.url), !link.url.isEmpty {
            ShareLink(item: url) {
                buttonSymbol("square.and.arrow.up")
            }
            .buttonStyle(.borderless)
            .accessibilityLabel(L("Split"))
            .accessibilityIdentifier("preview-share-share-\(link.id)")
            Button { model.copy(link) } label: { buttonSymbol("doc.on.doc") }
                .buttonStyle(.borderless)
                .accessibilityLabel(L("Copy"))
                .accessibilityIdentifier("preview-copy-\(link.id)")
        }
        Button { revocationQuestion = true } label: {
            if running {
                ProgressView().controlSize(.small).frame(minWidth: 30, minHeight: 30)
            } else {
                buttonSymbol("xmark.circle", color: .red)
            }
        }
        .buttonStyle(.borderless)
        .disabled(running)
        .accessibilityLabel(L("Revoke"))
        .accessibilityIdentifier("preview-revoke-\(link.id)")
    }

    private func buttonSymbol(_ name: String, color: Color? = nil) -> some View {
        Image(systemName: name)
            .font(.symbol(13))
            .foregroundStyle(color ?? Color.accentColor)
            .frame(minWidth: 30, minHeight: 30)
            .contentShape(Rectangle())
    }
}
