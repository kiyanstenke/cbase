import SwiftUI

// Settings → Usage: a push list of the five subpages of the contract (`UsageContract.usageSubpages`: Overview, Claude, Codex,
// OpenRouter, At limit), built like `IntegrationsList`. On the web the list sits left of the subpage (`UsageSettings.tsx`); on
// mobile the HIG applies: the list is the first level, a tap opens the subpage. The workflow settings have their own page
// (`WorkflowsSettings.swift`, "Behavior" group).
//
// Jump from outside: `AppState.settingsJump` = "usage:<subpage>" (the header rings); `SettingsView` pushes this page with
// `start`, and it opens the subpage on first appearance.
//
// This file also holds the blocks the subpages share (window bar, equivalent value, tokens, models, background, chats,
// history) and the ONE calculation of the ring per subscription provider (`subscriptionQuota`), which the provider card reads too.
//
// Identifiers: `usage-page-<subpage>`.
struct UsageSettingsView: View {
    @EnvironmentObject private var session: SessionStore
    @EnvironmentObject private var state: AppState
    /// The subpage opened on first appearance (jump "usage:<subpage>"); `nil` = the list.
    var start: String? = nil

    @State private var open: String?
    @State private var startTaken = false

    var body: some View {
        CbList {
            CbSettingGroup {
                ForEach(UsageContract.usageSubpages, id: \.self) { page in
                    NavigationLink {
                        UsageSubpage(page: page)
                            .environmentObject(session)
                            .environmentObject(state)
                    } label: {
                        row(page)
                    }
                    .accessibilityIdentifier("usage-page-\(page)")
                }
            }
        }
        .navigationTitle(L("Usage"))
        .navigationBarTitleDisplayMode(.inline)
        // Only for the jump: the rows themselves are ordinary links.
        .navigationDestination(item: $open) { page in
            UsageSubpage(page: page)
                .environmentObject(session)
                .environmentObject(state)
        }
        .task {
            guard !startTaken else { return }
            startTaken = true
            if let start, UsageContract.usageSubpages.contains(start) { open = start }
        }
    }

    private func row(_ page: String) -> some View {
        HStack(spacing: 12) {
            usageMarker(page)
                .frame(width: 24)
            VStack(alignment: .leading, spacing: 1) {
                Text(usageSubpageWord(page))
                    .font(.subheadline.weight(.medium))
                Text(Self.hint(page))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            }
            Spacer(minLength: 0)
        }
        .padding(.vertical, 2)
    }

    private static func hint(_ page: String) -> String {
        switch page {
        case "overview": return L("Quotas, API value and costs at a glance")
        case "claude": return L("Subscription: windows, limits, API value, where it goes")
        case "codex": return L("Subscription: windows, API value, where it goes")
        case "openrouter": return L("Credits and costs per model and chat")
        default: return L("Continuing at the limit, credit gate, what is waiting")
        }
    }
}

/// A subpage of "Usage": the switch that list and jump share.
struct UsageSubpage: View {
    let page: String

    var body: some View {
        switch page {
        case "overview": UsageOverviewView()
        case "claude", "codex": UsageSubscriptionView(provider: page)
        case "openrouter": UsageOpenRouterView()
        default: UsageAtLimitView()
        }
    }
}

/// "At limit": the two toggles and the waiting list (tappable: a tap opens the waiting chat). The same section that used to
/// sit at the end of the long usage page (`AutoContinueSection.swift`).
struct UsageAtLimitView: View {
    var body: some View {
        CbList {
            AutoContinueSection()
        }
        .navigationTitle(L("At the limit"))
        .navigationBarTitleDisplayMode(.inline)
    }
}

/// The mark of a subpage. `ProviderMark` only knows Claude and Codex and draws the Claude mark for anything else, so
/// OpenRouter gets a neutral symbol (like the provider card).
@ViewBuilder
func usageMarker(_ page: String) -> some View {
    switch page {
    case "claude", "codex":
        ProviderMark(providerId: page, size: 17)
    case "openrouter":
        Image(systemName: "point.3.connected.trianglepath.dotted").font(.symbol(15)).foregroundStyle(.tint)
    case "overview":
        Image(systemName: "square.grid.2x2").font(.symbol(15)).foregroundStyle(.tint)
    default:
        Image(systemName: "hourglass").font(.symbol(15)).foregroundStyle(.tint)
    }
}

// ── The ring per subscription provider: ONE calculation ──

/// The window the ring of a subscription provider shows: load in percent, reset, name.
struct SubscriptionQuota {
    let utilization: Double
    let resetsAt: String?
    let name: String
}

/// Which window the ring shows: the same source and the same choice as on the web and as the header rings: `ring` is the
/// session window and carries a value even when the legacy fields stay empty (exactly at the limit).
///
/// ONE exception: a CREDIT window never gets the ring. `creditWindow()` in `limits.js` reports `percent: 100, reached: true`
/// as soon as the reason is `out_of_credits`, even when 0 of 42.50 EUR are used. That means "the pot is not open", not "the pot
/// is empty"; without it the ring shows the real time window beneath.
///
/// This calculation lives HERE, once: two copies would drift apart at the next window.
func subscriptionQuota(_ provider: String, claude: ClaudeUsage?, codex: CodexUsage?) -> SubscriptionQuota? {
    if provider == "claude" {
        if let ring = claude?.ring, ring.group != "credits" {
            return SubscriptionQuota(utilization: ring.percent, resetsAt: ring.resetsAt, name: subscriptionWindowName(ring))
        }
        if let value = claude?.fiveHour?.utilization {
            return SubscriptionQuota(utilization: value, resetsAt: claude?.fiveHour?.resetsAt, name: L("5-hour limit"))
        }
        return nil
    }
    if provider == "codex" {
        guard let codex, codex.connected else { return nil }
        if let ring = codex.ring, ring.group != "credits" {
            return SubscriptionQuota(utilization: ring.percent, resetsAt: ring.resetsAt, name: subscriptionWindowName(ring))
        }
        // The fallback when the backend sends no `ring` yet: if the long window is present it wins, word for word the choice of the
        // web client and the header.
        let lang = codex.secondary?.usedPercent != nil
        let window = lang ? codex.secondary : codex.primary
        if let window, let percent = window.usedPercent {
            return SubscriptionQuota(utilization: percent, resetsAt: window.resetsAt, name: lang ? L("Long window") : L("Short window"))
        }
        return nil
    }
    return nil
}

/// Window label: credit and spending cap have no time window at all, a model-specific limit carries its model name.
func subscriptionWindowName(_ ring: UsageRingWindow) -> String {
    if ring.group == "credits" { return L("Credits") }
    if ring.group == "spend" { return L("Spend limit") }
    if !ring.scope.isEmpty { return L("{name} limit", ["name": ring.scope]) }
    return ring.group == "weekly" ? L("7-day limit") : L("5-hour limit")
}

/// The ring shows what is LEFT; the color comes from the LOAD (70/90 like header and kit).
func subscriptionRing(_ k: SubscriptionQuota, size: CGFloat = 46) -> some View {
    let rest = max(0, min(100, 100 - k.utilization))
    let reset = UsageStore.parse(k.resetsAt).map { L("resets {reset}", ["reset": locWeekdayTime($0)]) }
    let label = [k.name, reset].compactMap { $0 }.joined(separator: "\n")
    return CbRing(percent: rest, label: label, tone: cbToneFor(k.utilization), size: size)
        .accessibilityLabel("\(k.name), \(L("{rem} % left", ["rem": Int(rest.rounded())]))")
}

// ── Blocks of the subpages ──

/// The window bar of a provider subpage (`session · week · 30d` or `30d · total`). The label of a subscription window depends
/// on the server's state: without a snapshot it slides, and the label says so (`known`).
struct UsageWindowBar: View {
    let provider: String
    @Binding var window: String
    /// Per window, whether the server knows its start; `nil` (not loaded yet) counts as known.
    var known: (String) -> Bool = { _ in true }

    var body: some View {
        CbSegments(
            options: UsageContract.window(for: provider).map {
                CbSegment(value: $0, label: usageWindowWord($0, known: known($0)), id: "usage-window-\($0)")
            },
            selection: $window
        )
        .listRowInsets(EdgeInsets(top: 8, leading: 16, bottom: 8, trailing: 16))
    }
}

/// "since 14:00" under the bar, only when the server KNOWS the start; a sliding window says exactly that.
@ViewBuilder
func usageSinceRow(_ v: UsageConsumption) -> some View {
    if v.window == "total" {
        EmptyView()
    } else if v.windowKnown, let from = v.from {
        Text(L("since {time}", ["time": v.window == "session" ? usageClockTime(from) : (v.window == "week" ? locWeekdayTime(from) : locShortDate(from))]))
            .font(.caption)
            .foregroundStyle(.secondary)
            .accessibilityIdentifier("usage-window-since")
    } else if !v.windowKnown {
        Text(L("Rolling — no snapshot of the provider's window yet."))
            .font(.caption)
            .foregroundStyle(.secondary)
            .accessibilityIdentifier("usage-window-sliding")
    }
}

/// "14:05" in the notation of the chosen language.
func usageClockTime(_ date: Date) -> String {
    let f = DateFormatter()
    f.locale = Loc.locale
    f.setLocalizedDateFormatFromTemplate("HH:mm")
    return f.string(from: date)
}

/// Tokens short ("12.3k", "1.2M"), the same notation as the chat history.
@MainActor func usageTokens(_ n: Int) -> String { ChatViewModel.formatTokens(n) }

/// The equivalent value (subscription provider): the main number, below it the breakdown and the hint. `nil` ⇒ "—" and why.
struct UsageEquivalentGroup: View {
    let sums: UsageSums

    var body: some View {
        CbSettingGroup(title: L("API equivalent"), hint: L("Estimate at API list price — the subscription counts its quota itself.")) {
            VStack(alignment: .leading, spacing: 4) {
                Text(usageUsdText(sums.equivalentUsd))
                    .cbFont(26, weight: .semibold)
                    .monospacedDigit()
                    .accessibilityIdentifier("usage-equivalent")
                if sums.equivalentUsd == nil {
                    Text(L("No price is known for the models in this window."))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                } else if !sums.equivalentComplete {
                    // Without this sentence the number would look like the whole sum.
                    Text(L("Lower bound — not everything has a known price."))
                        .font(.caption)
                        .foregroundStyle(.orange)
                        .accessibilityIdentifier("usage-equivalent-lower-limit")
                }
            }
            .padding(.vertical, 2)
            if let t = sums.partsUsd {
                UsageTiles(cells: [
                    (L("Input"), usageUsdText(t.input)),
                    (L("Output"), usageUsdText(t.output)),
                    (L("Cache read"), usageUsdText(t.cacheRead)),
                    (L("Cache write"), usageUsdText(t.cacheWrite)),
                ])
                .accessibilityIdentifier("usage-equivalent-parts")
            }
        }
    }
}

/// The tokens of a window: input · output · cache read · cache write (+ unsplit, only > 0), runs, and, when the server names
/// it, the subagents' share of the output.
struct UsageTokenGroup: View {
    let consumption: UsageConsumption
    let sums: UsageSums

    var body: some View {
        CbSettingGroup(title: L("tokens")) {
            UsageTiles(cells: [
                (L("Input"), usageTokens(sums.input)),
                (L("Output"), usageTokens(sums.output)),
                (L("Cache read"), usageTokens(sums.cacheRead)),
                (L("Cache write"), usageTokens(sums.cacheWrite)),
            ])
            .accessibilityIdentifier("usage-tokens")
            if sums.cacheUnsplit > 0 {
                LabeledContent(L("Cache, not split")) {
                    Text(usageTokens(sums.cacheUnsplit)).monospacedDigit()
                }
                .font(.caption)
                .accessibilityIdentifier("usage-cache-unsplit")
            }
            LabeledContent(L("runs")) {
                Text(locFormattedInt(sums.runs)).monospacedDigit()
            }
            .font(.caption)
            if let quote = consumption.subagentsQuote, quote > 0 {
                subagentProgressBar(quote)
            }
        }
    }

    /// Subagents' share of the output.
    private func subagentProgressBar(_ quote: Double) -> some View {
        let pct = Int((quote * 100).rounded())
        return VStack(alignment: .leading, spacing: 5) {
            HStack {
                Text(L("of which subagents")).font(.caption).foregroundStyle(.secondary)
                Spacer()
                Text(L("{pct} % of output", ["pct": pct]))
                    .font(.caption.weight(.semibold))
                    .monospacedDigit()
                    .accessibilityIdentifier("usage-subagent-share")
            }
            GeometryReader { proxy in
                HStack(spacing: 0) {
                    Rectangle().fill(Color.accentColor)
                        .frame(width: proxy.size.width * (1 - quote))
                    Rectangle().fill(Color.orange)
                }
                .clipShape(Capsule())
            }
            .frame(height: 7)
        }
        .padding(.vertical, 3)
    }
}

/// Four key figures, two columns: four tiles do not fit side by side on the phone.
struct UsageTiles: View {
    let cells: [(String, String)]

    var body: some View {
        VStack(spacing: 8) {
            ForEach(Array(stride(from: 0, to: cells.count, by: 2)), id: \.self) { start in
                HStack(spacing: 10) {
                    ForEach(start..<min(start + 2, cells.count), id: \.self) { i in
                        VStack(alignment: .leading, spacing: 1) {
                            Text(cells[i].0)
                                .cbFont(10, weight: .semibold)
                                .textCase(.uppercase)
                                .foregroundStyle(.secondary)
                            Text(cells[i].1).cbFont(15, weight: .semibold).monospacedDigit()
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                    }
                }
            }
        }
        .padding(.vertical, 4)
        .accessibilityElement(children: .combine)
    }
}

/// The amount of a row: for OpenRouter the cost, otherwise the equivalent value; `nil` shows as "—".
private func usageAmount(provider: String, equivalent: Double?, cost: Double?) -> String {
    usageUsdText(provider == UsageContract.openrouterId ? cost : equivalent)
}

/// A row of a breakdown: title, below it runs and tokens, the amount on the right.
struct UsageItem: View {
    let title: String
    var monospaced = false
    let runs: Int
    let input: Int
    let output: Int
    let amount: String
    var addition: String? = nil
    var identifier: String

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .cbFont(13, weight: .medium, design: monospaced ? .monospaced : .default)
                    .lineLimit(1)
                    .truncationMode(.middle)
                    .accessibilityIdentifier(identifier)
                Text(verbatim: "\(L("{runs} runs", ["runs": runs])) · ↑ \(usageTokens(input)) · ↓ \(usageTokens(output))")
                    .cbFont(10.5)
                    .foregroundStyle(.secondary)
                    .monospacedDigit()
                if let addition {
                    Text(addition).cbFont(10.5).foregroundStyle(.secondary)
                }
            }
            Spacer(minLength: 8)
            Text(amount)
                .font(.caption.weight(.semibold))
                .monospacedDigit()
        }
        .padding(.vertical, 2)
    }
}

/// Per model (sorted by the server). `prices` only for OpenRouter: the range per upstream and the price of the last answer.
struct UsageModelGroup: View {
    let provider: String
    let models: [UsageModel]
    var prices: [String: ModelPrices]? = nil

    var body: some View {
        if !models.isEmpty {
            CbSettingGroup(title: L("By model")) {
                ForEach(models) { m in
                    UsageItem(
                        title: m.model.isEmpty ? L("(unknown)") : m.model, monospaced: true,
                        runs: m.runs, input: m.input, output: m.output,
                        amount: usageAmount(provider: provider, equivalent: m.equivalentUsd, cost: m.costUsd),
                        addition: addition(m), identifier: "usage-model-\(m.model)"
                    )
                }
            }
        }
    }

    private func addition(_ m: UsageModel) -> String? {
        var parts: [String] = []
        if !m.priceKnown { parts.append(L("Price unknown")) }
        if let p = prices?["\(provider)::\(m.model)"] {
            if p.known, let s = p.span {
                parts.append(L("per provider {in} in · {out} out (1M)", ["in": usageSpan(s.inMin, s.inMax), "out": usageSpan(s.outMin, s.outMax)]))
                if !p.upstream.isEmpty, let l = p.last {
                    parts.append(L("last {provider}: {in} in · {out} out", ["provider": p.upstream, "in": usageSpan(l.inMin, l.inMax), "out": usageSpan(l.outMin, l.outMax)]))
                }
            } else if !p.known {
                parts.append(L("Prices per provider unavailable"))
            }
        }
        return parts.isEmpty ? nil : parts.joined(separator: "\n")
    }
}

/// "$0.43–0.60", or "$0.50" when all providers charge the same, per 1M tokens, two to four decimals.
func usageSpan(_ min: Double, _ max: Double) -> String {
    let f = NumberFormatter()
    f.locale = Loc.locale
    f.numberStyle = .decimal
    f.minimumFractionDigits = 2
    f.maximumFractionDigits = 4
    let z = { (n: Double) in f.string(from: NSNumber(value: n)) ?? String(n) }
    return min == max ? "$\(z(min))" : "$\(z(min))–\(z(max))"
}

/// The background tasks per role (oneshot calls, contract `ONCE_ROLES`), the 18 % of the output that was booked nowhere.
struct UsageBackgroundGroup: View {
    let provider: String
    let rows: [UsageBackground]

    var body: some View {
        if !rows.isEmpty {
            CbSettingGroup(title: L("Background tasks")) {
                ForEach(rows) { h in
                    UsageItem(
                        title: usageRoleWord(h.role), runs: h.runs, input: h.input, output: h.output,
                        amount: usageAmount(provider: provider, equivalent: h.equivalentUsd, cost: h.costUsd),
                        identifier: "usage-background-\(h.role)"
                    )
                }
            }
        }
    }
}

/// Per chat: at most 25, and the number of the rest stands below; a list that silently truncates cannot be told from a
/// complete one.
struct UsageChatGroup: View {
    let provider: String
    let chats: [UsageChat]
    let additional: Int

    var body: some View {
        if !chats.isEmpty || additional > 0 {
            CbSettingGroup(title: L("Chats")) {
                ForEach(chats) { c in
                    UsageItem(
                        title: title(c), runs: c.runs, input: c.input, output: c.output,
                        amount: usageAmount(provider: provider, equivalent: c.equivalentUsd, cost: c.costUsd),
                        identifier: "usage-chat-\(c.chatId)"
                    )
                }
                if additional > 0 {
                    Text(additional == 1 ? L("and 1 more chat") : L("and {n} more chats", ["n": additional]))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .accessibilityIdentifier("usage-chats-additional")
                }
            }
        }
    }

    private func title(_ c: UsageChat) -> String {
        let t = c.title.isEmpty ? L("(untitled)") : c.title
        return c.deleted ? "\(t) · \(L("deleted"))" : t
    }
}

/// The history per day (30 days, gapless, oldest first) as bars. Subscription: the equivalent value; OpenRouter: the cost, as
/// long as EVERY day with consumption has an amount; otherwise the output, and the hint says on how many days the amount is missing.
///
/// "null ≠ 0": the server sends 0 for a day WITHOUT runs, and `null` for a day WITH runs but without a price or reported cost
/// (account/usage-report.js `history`). If ALL days with runs carry `null` (Codex with a model without a catalog price, Claude
/// without a catalog), the page says "Nothing was recorded in these days."
struct UsageHistoryGroup: View {
    let provider: String
    let history: UsageHistory

    /// The amount of a day: `nil` means unknown, not 0.
    private func amount(_ p: UsagePoint) -> Double? {
        provider == UsageContract.openrouterId ? p.costUsd : p.equivalentUsd
    }

    /// Days with consumption whose amount is unknown.
    private var daysWithoutAmount: Int {
        history.points.filter { amount($0) == nil && $0.input + $0.output + $0.cacheRead + $0.cacheWrite > 0 }.count
    }

    private var inMoney: Bool {
        daysWithoutAmount == 0 && history.points.contains { amount($0) != nil }
    }

    /// `?? 0` only in money: then the amount is missing at most on a day without any consumption, whose equivalent value IS 0.
    private var values: [(day: String, value: Double)] {
        let money = inMoney
        return history.points.map { p in (p.day, money ? (amount(p) ?? 0) : Double(p.output)) }
    }

    private var hint: String? {
        if inMoney { return nil }
        switch daysWithoutAmount {
        case 0: return L("Output tokens per day")
        case 1: return L("Output tokens per day — the amount is missing on one day.")
        default: return L("Output tokens per day — the amount is missing on {n} days.", ["n": daysWithoutAmount])
        }
    }

    var body: some View {
        let queue = values
        let highest = queue.map(\.value).max() ?? 0
        CbSettingGroup(
            title: L("History — {n} days", ["n": history.days > 0 ? history.days : queue.count]),
            hint: hint
        ) {
            if highest <= 0 {
                Text(L("Nothing was recorded on these days."))
                    .font(.caption)
                    .foregroundStyle(.secondary)
            } else {
                HStack(alignment: .bottom, spacing: 2) {
                    ForEach(Array(queue.enumerated()), id: \.offset) { _, point in
                        Capsule()
                            .fill(point.value > 0 ? Color.accentColor : Color.secondary.opacity(0.18))
                            .frame(height: max(2, 64 * point.value / highest))
                            .frame(maxWidth: .infinity)
                    }
                }
                .frame(height: 64, alignment: .bottom)
                .padding(.vertical, 4)
                .accessibilityElement(children: .ignore)
                .accessibilityLabel(summary(queue, highest))
                .accessibilityIdentifier("usage-history")
            }
        }
    }

    private func summary(_ queue: [(day: String, value: Double)], _ highest: Double) -> String {
        guard let tip = queue.first(where: { $0.value == highest }) else { return "" }
        let count = inMoney ? usageUsdText(tip.value) : usageTokens(Int(tip.value))
        return L("Highest day {day}: {value}", ["day": tip.day, "value": count])
    }
}

/// The state of a subpage while nothing is there: loading, error (with the server's wording), or empty.
@ViewBuilder
func usageLoadRow(error: String) -> some View {
    if error.isEmpty {
        CbLoading(compact: true)
    } else {
        Label(error, systemImage: "exclamationmark.circle")
            .font(.caption)
            .foregroundStyle(.red)
            .accessibilityIdentifier("usage-error")
    }
}
