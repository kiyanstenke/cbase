import SwiftUI

// Usage → Claude or Codex. At the top the window bar `session · week · 30d`, the same windows the ring measures (start = reset
// minus window length from the server's last snapshot; without a snapshot it slides, and the label then says "Last 5 hrs" /
// "Last 7 days"). Below it, as the main number, the API equivalent with its breakdown and the hint that the subscription does
// its own accounting; then tokens (cache read and write SEPARATE: the most expensive item used to be invisible inside
// "Cache"), subagent share, per model, background tasks per role, chats (+ "N more") and the history over 30 days. Claude
// additionally: ALL limits of the last snapshot with "measured N min ago" and the credit balance (extra usage).
//
// Only what the server stored is read (`/api/usage/*` reads the database and snapshot, never a fetch from the provider). The
// credit balance comes from `/api/usage`, the same route as the header rings, which the app asks anyway.
//
// Identifiers: `usage-equivalent`, `usage-tokens`, `usage-subagent-share`, `usage-chat-<chatId>`, `usage-limit-<id>`,
// `usage-claude-measured`, `usage-credit`.
struct UsageSubscriptionView: View {
    @EnvironmentObject private var session: SessionStore
    let provider: String

    @State private var window = "session"
    /// The last answer per window; switching back shows the old state at once while the new one loads.
    @State private var consumption: [String: UsageConsumption] = [:]
    @State private var error = ""
    @State private var history: UsageHistory?
    @State private var limits: ClaudeLimits?
    @State private var claudeUsage: ClaudeUsage?

    var body: some View {
        CbList {
            CbSettingGroup {
                UsageWindowBar(provider: provider, window: $window) { consumption[$0]?.windowKnown ?? true }
                if let v = consumption[window] { usageSinceRow(v) }
            }

            if let v = consumption[window] {
                if let s = v.sums, !s.empty {
                    UsageEquivalentGroup(sums: s)
                    UsageTokenGroup(consumption: v, sums: s)
                    UsageModelGroup(provider: provider, models: v.models)
                    UsageBackgroundGroup(provider: provider, rows: v.background)
                    UsageChatGroup(provider: provider, chats: v.chats, additional: v.chatsAdditional)
                } else {
                    Section {
                        Text(L("Nothing was recorded in this time window."))
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .accessibilityIdentifier("usage-empty")
                    }
                }
            } else {
                Section { usageLoadRow(error: error) }
            }

            if let history {
                UsageHistoryGroup(provider: provider, history: history)
            }

            if provider == "claude" {
                limitGroup
            }
        }
        .navigationTitle(usageSubpageWord(provider))
        .navigationBarTitleDisplayMode(.inline)
        .task(id: window) { await loadConsumption() }
        .task { await loadRest() }
        .cbRefreshable {
            consumption = [:]
            await loadConsumption()
            await loadRest()
        }
    }

    // ── Claude: all limits and the credit ──

    @ViewBuilder
    private var limitGroup: some View {
        CbSettingGroup(title: L("Limits"), hint: measuredText) {
            if let limits {
                if limits.window.isEmpty {
                    Text(L("No usage data available."))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                ForEach(limits.window) { f in limitRow(f) }
            } else {
                CbLoading(compact: true)
            }
            creditRow
        }
    }

    /// "measured 4 min ago": the state is a snapshot, and how old it is belongs next to the number.
    private var measuredText: String? {
        guard let limits else { return nil }
        guard let measuredAt = limits.measuredAt else { return L("Never measured.") }
        let minutes = max(0, Int(Date().timeIntervalSince(measuredAt) / 60))
        return minutes < 1 ? L("measured just now") : L("measured {n} min ago", ["n": minutes])
    }

    private func limitRow(_ f: ClaudeLimitWindow) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            HStack {
                Text(f.title).font(.caption).foregroundStyle(.secondary)
                Spacer()
                Text(f.percent.map { L("{p} % used", ["p": Int(max(0, min(100, $0)).rounded())]) } ?? "—")
                    .font(.caption.weight(.semibold))
                    .monospacedDigit()
            }
            if let p = f.percent { CbProgressBar(percent: p, tone: cbToneFor(p)) }
            if let reset = f.resetsAt {
                Text(L("resets {reset}", ["reset": locWeekdayTime(reset)]))
                    .cbFont(10)
                    .foregroundStyle(.secondary)
            }
        }
        .padding(.vertical, 1)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("usage-limit-\(f.id)")
    }

    /// The credit balance ("extra usage"): shown ONLY when the account has a credit pot at all (`active`); an account without a
    /// pot and one with an empty pot are two different things. No bar: credit does not run back.
    @ViewBuilder private var creditRow: some View {
        if let g = claudeUsage?.credit, g.active {
            VStack(alignment: .leading, spacing: 2) {
                HStack {
                    Text(L("Credits")).font(.caption).foregroundStyle(.secondary)
                    Spacer()
                    if let percent = g.percent {
                        Text(L("{p} % used", ["p": Int(max(0, min(100, percent)).rounded())]))
                            .font(.caption.weight(.semibold))
                            .monospacedDigit()
                    }
                }
                if let text = Self.creditText(g) {
                    Text(text)
                        .cbFont(10)
                        .foregroundStyle(.secondary)
                        .monospacedDigit()
                }
                if g.blocked, !g.reason.isEmpty {
                    Text(L("Blocked: {reason}", ["reason": g.reason]))
                        .cbFont(10)
                        .foregroundStyle(.red)
                }
            }
            .padding(.vertical, 3)
            .accessibilityIdentifier("usage-credit")
        }
    }

    /// "USD 2.40 of USD 20.00 spent", for an explicitly unlimited pot without a cap. Nothing is converted: `limit` and the amount
    /// spent arrive finished in the server's currency unit.
    private static func creditText(_ g: CreditStatus) -> String? {
        guard let consumed = g.consumed else { return nil }
        let currency = g.currency.isEmpty ? "USD" : g.currency
        let consumedText = locFormattedMoney(consumed, currency: currency)
        if g.unlimited { return L("{used} spent (no cap)", ["used": consumedText]) }
        guard let cap = g.limit else { return L("{used} spent", ["used": consumedText]) }
        return L("{used} of {limit} spent",
                 ["used": consumedText, "limit": locFormattedMoney(cap, currency: currency)])
    }

    // ── Loading ──

    private func loadConsumption() async {
        guard let client = session.client else { return }
        let selected = window
        do {
            let v = try await client.loadConsumption(provider: provider, window: selected)
            consumption[selected] = v
            error = ""
        } catch is CancellationError {
            return
        } catch {
            // The last shown state stays; only a window with no state at all shows the error.
            self.error = error.localizedDescription
        }
    }

    /// History, limits and credit are independent of the window, each its own attempt: one failure must not take the numbers
    /// above with it.
    private func loadRest() async {
        guard let client = session.client else { return }
        if let v = try? await client.loadHistory(provider: provider) { history = v }
        guard provider == "claude" else { return }
        if let l = try? await client.loadClaudeLimits() { limits = l }
        if let u: ClaudeUsage = try? await client.get("/api/usage") { claudeUsage = u }
    }
}
