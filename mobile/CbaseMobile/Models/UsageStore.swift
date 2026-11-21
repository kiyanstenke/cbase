import Foundation
import SwiftUI

// Usage rings in the header: one ring per connected provider (Claude 5-hour limit, Codex narrowest available window).
// A briefly failed query does NOT clear the display — as in the desktop client, the last valid value stays.
@MainActor
final class UsageStore: ObservableObject {
    struct Ring: Identifiable, Equatable {
        let id: String
        let name: String
        let windowLabel: String
        let percent: Double
        let resetsAt: Date?
        let active: Bool
        var reached = false // limit reached → full, red ring instead of "gone"
        var blockedBy: String? // a DIFFERENT window at its limit (e.g. "Fable") — a hint only
    }

    @Published private(set) var rings: [Ring] = []
    @Published private(set) var claude: ClaudeUsage?
    @Published private(set) var codex: CodexUsage?
    @Published private(set) var activeProvider = ""
    @Published private(set) var claudeConnected = false
    @Published private(set) var codexConnected = false

    private let client: APIClient
    private var task: Task<Void, Never>?

    init(client: APIClient) {
        self.client = client
    }

    deinit { task?.cancel() }

    func start() {
        guard task == nil else { return }
        task = Task { [weak self] in
            while !Task.isCancelled {
                await self?.refresh()
                // Until a ring exists, ask faster (as in the desktop client): the server fetches the usage itself only on
                // the first call and caches it.
                let waiting = self?.rings.isEmpty ?? true
                try? await Task.sleep(nanoseconds: waiting ? 15_000_000_000 : 45_000_000_000)
            }
        }
    }

    func stop() {
        task?.cancel()
        task = nil
    }

    func refresh() async {
        if let providers: ProviderInfoResponse = try? await client.get("/api/providers") {
            activeProvider = providers.active
            claudeConnected = providers.providers.first(where: { $0.id == "claude" })?.connected ?? false
            codexConnected = providers.providers.first(where: { $0.id == "codex" })?.connected ?? false
        }
        // Every response with ANY usage value is adopted: `ring` also covers the cases where fiveHour stays empty
        // (model-specific limit, credits, spend limit).
        if let usage: ClaudeUsage = try? await client.get("/api/usage"),
           usage.ring != nil || usage.fiveHour?.utilization != nil {
            claude = usage
        }
        if let usage: CodexUsage = try? await client.get("/api/usage/codex") {
            codex = usage
        }
        rebuild()
    }

    // WHICH window belongs in the ring is decided uniformly by the server: `ring` is the SESSION WINDOW (Claude 5 h across
    // ALL models). An exhausted other window (e.g. a model-specific weekly limit) is in `blocking` and thus only in the
    // accessibility text — not in the ring value. The branches without `ring` stay for older backends (rolling
    // deployment: new app, old backend).
    private func rebuild() {
        var next: [Ring] = []
        if claudeConnected {
            if let ring = claude?.ring {
                next.append(Ring(
                    id: "claude", name: "Claude", windowLabel: Self.label(for: ring),
                    percent: ring.percent, resetsAt: Self.parse(ring.resetsAt),
                    active: activeProvider == "claude", reached: ring.reached,
                    blockedBy: Self.blockedLabel(ring: ring, blocking: claude?.blocking)
                ))
            } else if let value = claude?.fiveHour?.utilization {
                next.append(Ring(
                    id: "claude", name: "Claude", windowLabel: "5h", percent: value,
                    resetsAt: Self.parse(claude?.fiveHour?.resetsAt), active: activeProvider == "claude"
                ))
            }
        }
        if codexConnected, let codex, codex.connected {
            if let ring = codex.ring {
                next.append(Ring(
                    id: "codex", name: "Codex", windowLabel: Self.label(for: ring),
                    percent: ring.percent, resetsAt: Self.parse(ring.resetsAt),
                    active: activeProvider == "codex", reached: ring.reached,
                    blockedBy: Self.blockedLabel(ring: ring, blocking: codex.blocking)
                ))
            } else {
                let window = codex.secondary?.usedPercent != nil ? codex.secondary : codex.primary
                if let window, let percent = window.usedPercent {
                    next.append(Ring(
                        id: "codex", name: "Codex", windowLabel: Self.label(forMinutes: window.windowMinutes),
                        percent: percent, resetsAt: Self.parse(window.resetsAt), active: activeProvider == "codex"
                    ))
                }
            }
        }
        rings = next
    }

    /// Window label: model-specific limits carry their model name ("Fable"), credits and spend limit have no time
    /// window at all.
    private static func label(for ring: UsageRingWindow) -> String {
        if ring.group == "credits" { return L("Credits") }
        if ring.group == "spend" { return L("Spend") }
        if !ring.scope.isEmpty { return ring.scope }
        if let minutes = ring.windowMinutes { return label(forMinutes: minutes) }
        return ring.group == "weekly" ? L("7-day") : "5h"
    }

    /// Names the exhausted window — but only if it is a DIFFERENT one than the ring window (otherwise "Limit reached"
    /// would appear twice in the same accessibility text).
    private static func blockedLabel(ring: UsageRingWindow, blocking: UsageRingWindow?) -> String? {
        guard let blocking else { return nil }
        if ring.reached, ring.group == blocking.group, ring.scope == blocking.scope { return nil }
        return label(for: blocking)
    }

    private static func label(forMinutes minutes: Int?) -> String {
        guard let minutes else { return "" }
        if minutes == 300 { return "5h" }
        if minutes == 10080 { return L("7-day") }
        return "\(Int((Double(minutes) / 60).rounded()))h"
    }

    /// Pure (no property of the store) and therefore `nonisolated`: the usage decoder (`Models/UsageModels.swift`, outside
    /// the MainActor) reads its timestamps with it too.
    nonisolated static func parse(_ iso: String?) -> Date? {
        guard let iso, !iso.isEmpty else { return nil }
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = formatter.date(from: iso) { return date }
        let plain = ISO8601DateFormatter()
        return plain.date(from: iso)
    }
}

/// Neutral provider marks instead of a wordmark (no company logos, see TRADEMARKS.md): a speech bubble for Claude, code brackets
/// for Codex, both as templates so they follow the text colour in light and dark. The same path data as in the web client
/// (ProviderMarks.tsx).
struct ProviderMark: View {
    let providerId: String
    var size: CGFloat = 14

    private var isOpenAI: Bool { providerId == "codex" || providerId == "openai" }

    var body: some View {
        Image(isOpenAI ? "ProviderCodex" : "ProviderClaude")
            .renderingMode(.template)
            .resizable()
            .scaledToFit()
            .frame(width: size, height: size)
    }
}

struct UsageRingView: View {
    let ring: UsageStore.Ring
    /// The ring is a button: a tap opens the provider's subpage under Settings → Usage. `nil` = display only. Identifier
    /// and accessibility label then sit on the BUTTON — a button is a single accessibility element, a label inside it
    /// would no longer be findable.
    var open: (() -> Void)? = nil

    private var color: Color {
        ring.reached || ring.percent >= 90 ? .red : ring.percent >= 70 ? .orange : .accentColor
    }

    var body: some View {
        if let open {
            Button(action: open) { content }
                .buttonStyle(.plain)
                .modifier(Accessibility(ring: ring))
                .accessibilityHint(L("Opens the usage of {name}", ["name": ring.name]))
        } else {
            content
                .accessibilityElement(children: .combine)
                .modifier(Accessibility(ring: ring))
        }
    }

    private var content: some View {
        HStack(spacing: 4) {
            ProviderMark(providerId: ring.id, size: 13)
                // The active provider stays fully opaque, the other steps back.
                .opacity(ring.active ? 1 : 0.5)
            ZStack {
                Circle()
                    .stroke(Color.secondary.opacity(0.22), lineWidth: 2.4)
                Circle()
                    .trim(from: 0, to: min(1, ring.percent / 100))
                    .stroke(color, style: StrokeStyle(lineWidth: 2.4, lineCap: .round))
                    .rotationEffect(.degrees(-90))
                    .animation(.easeOut(duration: 0.6), value: ring.percent)
            }
            .frame(width: 15, height: 15)
            // Fixed: the ring sits in the TopBar (42 pt), whose status line does not grow with the text size
            // (guard exception in ios-font.test.mjs).
            Text(verbatim: "\(Int(ring.percent.rounded())) %")
                .font(.system(size: 10.5, weight: .medium))
                .monospacedDigit()
                .foregroundStyle(.secondary)
        }
        .contentShape(Rectangle())
    }

    /// Identifier and label — ONE element: otherwise name, ring and percentage appear separately in the accessibility
    /// tree and the identifier cannot be found from outside.
    private struct Accessibility: ViewModifier {
        let ring: UsageStore.Ring

        func body(content: Content) -> some View {
            content
                .accessibilityIdentifier("usage-ring-\(ring.id)")
                .accessibilityLabel(L("{name} · {window} limit: {pct}% used", [
                    "name": ring.name, "window": ring.windowLabel, "pct": Int(ring.percent.rounded())
                ])
                + (ring.reached ? " · " + L("Limit reached") : "")
                + (ring.blockedBy.map { " · " + L("{window} limit reached", ["window": $0]) } ?? ""))
        }
    }
}
