import Foundation

extension ChatViewModel {

    var connectedProviders: [Provider] { providers.filter(\.connected) }

    var currentProvider: Provider? {
        providers.first(where: { $0.id == chat.provider })
    }

    var currentModel: ProviderModel? {
        currentProvider?.models.first(where: { $0.id == chat.model })
    }

    /// The catalog figure of the model the chat RUNS — cbase computes with it (transcript budget, compaction). As on the web
    /// (`contextWindowFor(currentModel || providerDefault(currentProvider), …)`): an empty `chat.model` is the choice
    /// "provider default" and is resolved through `defaultModel`, an empty `chat.provider` through the active
    /// provider — otherwise such a chat silently fell back to 1,000,000.
    var contextWindow: Int {
        let providerId = EffortLevels.effectiveProvider(chat.provider, active: activeProvider)
        let provider = providers.first(where: { $0.id == providerId })
        let model = chat.model.isEmpty ? (provider?.defaultModel ?? "") : chat.model
        return provider?.models.first(where: { $0.id == model })?.context ?? (providerId == "codex" ? 272_000 : 1_000_000)
    }

    /// The bar below the composer (`ContextDisplay`): denominator = the window of the provider of the last reply,
    /// if known, else `contextWindow`; the name sits beside it. Computation still uses `contextWindow`.
    var contextDisplay: ContextDisplay.Snapshot {
        ContextDisplay.compute(tokens: contextTokens, catalogWindow: contextWindow, provider: chat.upstreamProvider, providerWindow: chat.upstreamWindow)
    }

    /// The bar's fill share — on the DISPLAYED denominator (`contextDisplay`).
    var contextFraction: Double { contextDisplay.share }

    /// Where the autocompact mark sits on the bar: its threshold stays on the catalog (`autocompactShare`),
    /// it is positioned on the displayed denominator.
    var autocompactMarker: Double {
        ContextDisplay.markerOnDenominator(autocompactShare, catalogWindow: contextWindow, denominator: contextDisplay.denominator)
    }

    /// The level that applies to THIS chat: its own choice, else the global one. 0 = off.
    var autocompactEffective: Int {
        chat.autocompact ?? autocompactGlobal?.percent ?? 0
    }

    /// The cap in tokens that applies to this chat: its own choice, else the global one.
    var autocompactCap: Int {
        chat.autocompactMax ?? autocompactGlobal?.maxTokens ?? 0
    }

    /// The compaction that applies RIGHT NOW: while a workflow run is open and the workflow carries
    /// its own choice, that value — else the chat's, else the global one. Only for the mark and the hint line of the menu;
    /// the choice OF THE CHAT (`autocompactEffective`/`autocompactCap`) stays as it is and applies after the run.
    var autocompactRunPercent: Int {
        if let run = workflowRun, run.isActive, let p = run.compactionPercent { return p }
        return autocompactEffective
    }
    var autocompactRunCap: Int {
        if let run = workflowRun, run.isActive, let m = run.compactionMax { return m }
        return autocompactCap
    }

    /// The hint line in the autocompact menu during a workflow with its own compaction — nil otherwise.
    var autocompactWorkflowHint: String? {
        guard workflowRun?.compactionApplies == true else { return nil }
        return L("During the workflow: {value}", ["value": autocompactText(autocompactRunPercent, cap: autocompactRunCap)])
    }

    /// Where the threshold REALLY lies, as a share of the window (0 = no mark). TWO
    /// equal triggers — share and cap in tokens —, the earlier one applies; same computation
    /// as `threshold()` in autocompact.js. Without it the mark would sit on a number at which nothing
    /// is compacted. During a workflow with its own compaction, that one's value.
    var autocompactShare: Double {
        let p = autocompactRunPercent
        let fromShare = p > 0 ? Double(p) / 100 : 0
        let cap = autocompactRunCap
        let fromCap = cap > 0 && contextWindow > 0 ? Double(cap) / Double(contextWindow) : 0
        if fromShare > 0 && fromCap > 0 { return min(fromShare, fromCap) }
        return fromShare > 0 ? fromShare : fromCap
    }

    /// Menu label: the EFFECTIVE setting. "60 %" next to a mark at 35 % would be a
    /// number that contradicts the picture — and "off" with a cap set once left a
    /// 652k chat uncompacted.
    func autocompactText(_ p: Int, cap: Int) -> String {
        if p <= 0 && cap <= 0 { return L("off") }
        if cap > 0 {
            let previous = contextWindow > 0 && p > 0
                ? Double(cap) / Double(contextWindow) < Double(p) / 100 - 0.005
                : p <= 0
            if previous { return ChatViewModel.formatTokens(cap) }
        }
        return "\(p) %"
    }

    func loadAutocompact() async {
        autocompactGlobal = try? await client.get("/api/autocompact")
    }

    /// Which of the two sliders is written. A call writes exactly ONE — the other
    /// key must not be in the body at all, or it would overwrite the choice beside it.
    enum AutocompactField: String { case share = "autocompact", cap = "autocompactMax" }

    /// nil = back to default. The body writes nil EXPLICITLY as null — a
    /// synthesized Encodable would omit the key, and the server would then change nothing.
    func setAutocompact(_ field: AutocompactField, _ value: Int?) async throws {
        guard !isDraft else { return }
        struct Body: Encodable {
            let key: String
            let value: Int?
            struct Key: CodingKey {
                var stringValue: String
                var intValue: Int? { nil }
                init?(stringValue: String) { self.stringValue = stringValue }
                init?(intValue: Int) { nil }
            }
            func encode(to encoder: Encoder) throws {
                var c = encoder.container(keyedBy: Key.self)
                guard let k = Key(stringValue: key) else { return }
                if let value { try c.encode(value, forKey: k) } else { try c.encodeNil(forKey: k) }
            }
        }
        let updated: Chat = try await client.patch("/api/chats/\(chat.id)", body: Body(key: field.rawValue, value: value))
        chat = updated
        onChanged()
    }
}
