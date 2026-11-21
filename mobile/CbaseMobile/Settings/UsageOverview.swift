import SwiftUI

// Usage → Overview: per subscription provider the ring (window + reset, the same calculation as header and provider card,
// `subscriptionQuota`) and the equivalent value of the last 30 days; OpenRouter with the cost of the last 30 days and the credit;
// the number of waiting items with the way to "At limit". Every row leads to its subpage.
//
// Every number loads on its own (`try?` per route): one route failing must not take the other rows with it, and a number that
// did not arrive shows as "—", never as 0.
//
// Identifiers: `usage-overview-<subpage>`.
struct UsageOverviewView: View {
    @EnvironmentObject private var session: SessionStore
    @EnvironmentObject private var state: AppState

    @State private var claudeUsage: ClaudeUsage?
    @State private var codexUsage: CodexUsage?
    @State private var thirty: [String: UsageConsumption] = [:]
    @State private var credit: OpenRouterCredit?
    @State private var waiting: Int?
    @State private var loaded = false

    var body: some View {
        CbList {
            CbSettingGroup(title: L("Plan quotas")) {
                ForEach(UsageContract.subscriptionProvider, id: \.self) { id in
                    link(id) { subscriptionRow(id) }
                }
            }
            CbSettingGroup(title: "OpenRouter") {
                link(UsageContract.openrouterId) { openRouterRow }
            }
            CbSettingGroup(title: L("At the limit")) {
                link("limit") { limitRow }
            }
        }
        .navigationTitle(L("Overview"))
        .navigationBarTitleDisplayMode(.inline)
        .task { await load() }
        .cbRefreshable { await load() }
    }

    private func link<Content: View>(_ page: String, @ViewBuilder content: () -> Content) -> some View {
        NavigationLink {
            UsageSubpage(page: page)
                .environmentObject(session)
                .environmentObject(state)
        } label: {
            content()
        }
        .accessibilityIdentifier("usage-overview-\(page)")
    }

    private func subscriptionRow(_ id: String) -> some View {
        let equivalent = thirty[id]?.sums?.equivalentUsd
        return HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 6) {
                    usageMarker(id)
                    Text(usageSubpageWord(id)).font(.subheadline.weight(.medium))
                }
                Text(loaded ? L("{amount} API value in 30 days", ["amount": usageUsdText(equivalent)]) : L("Loading…"))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .monospacedDigit()
            }
            Spacer(minLength: 8)
            if let k = subscriptionQuota(id, claude: claudeUsage, codex: codexUsage) {
                subscriptionRing(k, size: 40)
            } else if loaded {
                Text(id == "codex" && codexUsage?.connected == false ? L("Not connected.") : "—")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .padding(.vertical, 2)
    }

    private var openRouterRow: some View {
        let cost = thirty[UsageContract.openrouterId]?.sums?.costUsd
        return HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 6) {
                    usageMarker(UsageContract.openrouterId)
                    Text(verbatim: "OpenRouter").font(.subheadline.weight(.medium))
                }
                Text(loaded ? L("{amount} costs in 30 days", ["amount": usageUsdText(cost)]) : L("Loading…"))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .monospacedDigit()
            }
            Spacer(minLength: 8)
            VStack(alignment: .trailing, spacing: 2) {
                CbOverline(L("Credits"))
                Text(credit?.known == true ? usageUsdText(credit?.restUsd) : "—")
                    .cbFont(14, weight: .semibold)
                    .monospacedDigit()
            }
        }
        .padding(.vertical, 2)
    }

    private var limitRow: some View {
        HStack(spacing: 12) {
            usageMarker("limit")
            Text(limitText)
                .font(.subheadline)
            Spacer(minLength: 0)
        }
        .padding(.vertical, 2)
    }

    private var limitText: String {
        guard let waiting else { return loaded ? "—" : L("Loading…") }
        if waiting == 0 { return L("Nothing is waiting for a reset") }
        return waiting == 1 ? L("1 run is waiting for a reset") : L("{n} runs are waiting for a reset", ["n": waiting])
    }

    private func load() async {
        guard let client = session.client else { return }
        async let claude: ClaudeUsage? = try? client.get("/api/usage")
        async let codex: CodexUsage? = try? client.get("/api/usage/codex")
        async let c30 = try? client.loadConsumption(provider: "claude", window: "30d")
        async let x30 = try? client.loadConsumption(provider: "codex", window: "30d")
        async let o30 = try? client.loadConsumption(provider: UsageContract.openrouterId, window: "30d")
        async let g = try? client.loadOpenRouterCredit()
        async let wait: AutoContinueDoc? = try? client.get("/api/auto-continue")
        let (cu, xu, cv, xv, ov, gu, wd) = await (claude, codex, c30, x30, o30, g, wait)
        if let cu { claudeUsage = cu }
        if let xu { codexUsage = xu }
        var fresh = thirty
        if let cv { fresh["claude"] = cv }
        if let xv { fresh["codex"] = xv }
        if let ov { fresh[UsageContract.openrouterId] = ov }
        thirty = fresh
        if let gu { credit = gu }
        if let wd { waiting = wd.waiting.count }
        loaded = true
    }
}
