import SwiftUI

// Usage → OpenRouter. OpenRouter is no subscription: money and credit count here. At the top the credit (live from OpenRouter,
// cached for 60 s; unknown ⇒ "—", never $0), below it the windows `30d · total` with the cost as the main number and its
// SOURCE (reported · queried · estimated · unknown; rows without an amount are "unknown", never 0), per model with the price
// range per upstream and the price of the last answer, per chat, background (also outer loop and polling) and the history per
// day.
//
// There are no manual prices: OpenRouter reports the amounts, or the server queries or estimates them from the catalog; the
// page says which.
//
// Identifiers: `usage-or-credit`, `usage-cost`, `usage-cost-origin`, `usage-model-<model>`, `usage-chat-<chatId>`.
struct UsageOpenRouterView: View {
    @EnvironmentObject private var session: SessionStore

    @State private var window = "30d"
    @State private var consumption: [String: UsageConsumption] = [:]
    @State private var error = ""
    @State private var credit: OpenRouterCredit?
    @State private var creditError = false
    @State private var history: UsageHistory?
    /// Prices per upstream, key "provider::model"; `nil` = not there yet (no row).
    @State private var prices: [String: ModelPrices]?

    private let provider = UsageContract.openrouterId

    var body: some View {
        CbList {
            creditGroup

            CbSettingGroup {
                UsageWindowBar(provider: provider, window: $window)
                if let v = consumption[window] { usageSinceRow(v) }
            }

            if let v = consumption[window] {
                if let s = v.sums, !s.empty {
                    costGroup(s)
                    UsageTokenGroup(consumption: v, sums: s)
                    UsageModelGroup(provider: provider, models: v.models, prices: prices)
                    UsageChatGroup(provider: provider, chats: v.chats, additional: v.chatsAdditional)
                    UsageBackgroundGroup(provider: provider, rows: v.background)
                } else {
                    Section {
                        Text(L("Nothing was billed through OpenRouter in this window."))
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

    // ── Credit ──

    @ViewBuilder
    private var creditGroup: some View {
        CbSettingGroup(title: L("Credits"), hint: creditStatus) {
            if let g = credit {
                if g.known {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(usageUsdText(g.restUsd))
                            .cbFont(26, weight: .semibold)
                            .monospacedDigit()
                        Text(L("left")).font(.caption).foregroundStyle(.secondary)
                    }
                    .accessibilityElement(children: .combine)
                    .accessibilityIdentifier("usage-or-credit")
                    LabeledContent(L("Deposited")) { Text(usageUsdText(g.totalUsd)).monospacedDigit() }
                        .font(.caption)
                    LabeledContent(L("Spent")) { Text(usageUsdText(g.consumedUsd)).monospacedDigit() }
                        .font(.caption)
                    // The key's cap only when it has one: a key without a cap is not a key with 0.
                    if g.keyLimitUsd != nil {
                        LabeledContent(L("Key limit")) {
                            Text(L("{rest} of {limit} left", ["rest": usageUsdText(g.keyRestUsd), "limit": usageUsdText(g.keyLimitUsd)]))
                                .monospacedDigit()
                        }
                        .font(.caption)
                    }
                } else {
                    Text(L("Credits are not available right now — no key stored or OpenRouter is not responding."))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .accessibilityIdentifier("usage-or-credit")
                }
            } else if creditError {
                Text("—")
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(.secondary)
                    .accessibilityIdentifier("usage-or-credit")
            } else {
                CbLoading(compact: true)
            }
        }
    }

    private var creditStatus: String? {
        guard let at = credit?.at, credit?.known == true else { return nil }
        return L("As of {time}", ["time": usageClockTime(at)])
    }

    // ── Cost ──

    /// The main number and where it comes from. Rows without an amount show as "unknown", so the sum is a lower bound.
    private func costGroup(_ s: UsageSums) -> some View {
        CbSettingGroup(title: L("Cost")) {
            VStack(alignment: .leading, spacing: 4) {
                Text(usageUsdText(s.costUsd))
                    .cbFont(26, weight: .semibold)
                    .monospacedDigit()
                    .accessibilityIdentifier("usage-cost")
                if let h = s.costOrigin, !h.entries.isEmpty {
                    Text(h.entries.map { L("{origin}: {n}", ["origin": usageOriginWord($0.origin), "n": $0.count]) }.joined(separator: " · "))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .accessibilityIdentifier("usage-cost-origin")
                    if h.unknown > 0 {
                        Text(L("Lower bound — {n} runs without an amount.", ["n": h.unknown]))
                            .font(.caption)
                            .foregroundStyle(.orange)
                    }
                }
            }
            .padding(.vertical, 2)
        }
    }

    // ── Loading ──

    private func loadConsumption() async {
        guard let client = session.client else { return }
        let selected = window
        do {
            consumption[selected] = try await client.loadConsumption(provider: provider, window: selected)
            error = ""
        } catch is CancellationError {
            return
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func loadRest() async {
        guard let client = session.client else { return }
        do {
            credit = try await client.loadOpenRouterCredit()
            creditError = false
        } catch {
            creditError = credit == nil
        }
        if let v = try? await client.loadHistory(provider: provider) { history = v }
        if let p = try? await client.loadOpenRouterPrices() {
            prices = Dictionary(p.models.map { ("\($0.provider)::\($0.model)", $0) }, uniquingKeysWith: { a, _ in a })
        } else if prices == nil {
            prices = [:]
        }
    }
}
