import SwiftUI

// The three blocks that stand next to the hook list on the hooks page — exactly as in the web client (there "Permanent
// approvals", "Web search", "Read aloud (ElevenLabs)"): all three control what the OWN harness does, and therefore belong
// under the same heading.
//
// Each block is a view of its own with its own state, its own loading and its own status text. A shared status would let
// "Saved." stand under a block where nothing was saved; a shared loading would let one outage (say, an older server
// without /api/web-search) drag the other two down.
//
// Form language: system list style (Section/Toggle/Picker) like the rest of the settings.
//
// THREE STATES, not two. None of the three routes knows a delta: a PUT replaces the complete stock. Whoever saves without
// having read the stock therefore writes not "my change" but "my initial state" — and that is an empty list or the
// default. Each block therefore distinguishes explicitly between "loading", "could not be loaded" and "loaded, and the
// stock is empty"; only the last case enables the write buttons. It is the same pattern with which the hook list above
// ties its Save button to `loaded`.

// MARK: - Models

/// The complete approval list. The server trims, deduplicates and caps at 500 — therefore ITS response always applies,
/// never the own draft.
struct PermissionRulesDoc: Decodable, Sendable {
    var rules: [String]

    enum CodingKeys: String, CodingKey { case rules }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        rules = c.strings(.rules)
    }
}

/// `hasKey` is all there is to know about the key — the value itself never leaves the server. `providers` is missing in
/// the PUT response; the last read list then stays (otherwise an empty choice would appear after the first save).
struct WebSearchDoc: Decodable, Sendable {
    var provider: String
    var baseUrl: String
    var hasKey: Bool
    var providers: [String]

    enum CodingKeys: String, CodingKey { case provider, baseUrl, hasKey, providers }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        provider = c.str(.provider, "duckduckgo")
        baseUrl = c.str(.baseUrl)
        hasKey = c.bool(.hasKey)
        providers = c.strings(.providers)
    }
}

/// The app reads `modelId` and `baseUrl` along but does not show them — just like the web client. They are never sent; the
/// server fills missing fields from the stock, so they stay untouched.
struct TtsConfigDoc: Decodable, Sendable {
    var hasKey: Bool
    var voiceId: String
    var modelId: String
    var baseUrl: String

    enum CodingKeys: String, CodingKey { case hasKey, voiceId, modelId, baseUrl }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        hasKey = c.bool(.hasKey)
        voiceId = c.str(.voiceId)
        modelId = c.str(.modelId)
        baseUrl = c.str(.baseUrl)
    }
}

/// A voice of the ElevenLabs account. The app deliberately leaves the field `labels` alone: a free object of the provider
/// that no view needs and that it may change at any time.
struct TtsVoice: Decodable, Hashable, Identifiable, Sendable {
    var id: String
    var name: String

    enum CodingKeys: String, CodingKey { case id, name }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = c.str(.id)
        name = c.str(.name)
    }
}

struct TtsVoicesDoc: Decodable, Sendable {
    var voices: [TtsVoice]

    enum CodingKeys: String, CodingKey { case voices }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        // A voice without an id could not be selected in the picker and would be an empty value on saving — the server would
        // then silently set its default voice.
        voices = c.list(.voices, TtsVoice.self).filter { !$0.id.isEmpty }
    }
}

/// Body for the two settings with a secret (`/api/tts/config`, `/api/web-search`). The server reads `apiKey` THREE-VALUED:
/// if the key is missing or empty, the old one stays; a string sets; an EXPLICIT null deletes. A synthesized Encodable
/// would simply omit `nil` — that would mean "keep", and "remove key" would do nothing.
struct SecretBody: Encodable {
    enum KeyChange {
        case keep
        case set(String)
        case erase
    }

    var apiKey: KeyChange = .keep
    var voiceId: String?      // only /api/tts/config
    var provider: String?     // only /api/web-search
    var baseUrl: String?      // only /api/web-search (SearxNG)

    private struct Key: CodingKey {
        var stringValue: String
        var intValue: Int? { nil }
        init?(stringValue: String) { self.stringValue = stringValue }
        init?(intValue: Int) { nil }
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: Key.self)
        switch apiKey {
        case .keep: break                                   // do not send the field at all
        case .set(let value): try c.encode(value, forKey: Key(stringValue: "apiKey")!)
        case .erase: try c.encodeNil(forKey: Key(stringValue: "apiKey")!)
        }
        if let voiceId { try c.encode(voiceId, forKey: Key(stringValue: "voiceId")!) }
        if let provider { try c.encode(provider, forKey: Key(stringValue: "provider")!) }
        if let baseUrl { try c.encode(baseUrl, forKey: Key(stringValue: "baseUrl")!) }
    }
}

/// The approval list always goes out in full — the server knows no delta.
struct PermissionRulesBody: Encodable {
    let rules: [String]
}

// MARK: - Shared state rows

/// The placeholder of a field that already holds a secret. The eight dots stand for the value that never leaves the server;
/// the half-sentence next to it is a SENTENCE and therefore goes through `L(...)` — otherwise the English UI shows a German
/// clause. The key already exists (the provider editor labels its field the same way), so none is added.
private func secretPlaceholder() -> String {
    "•••••••• " + L("stored (leave empty = keep)")
}

/// Loading state and load error look the same in all three blocks — and both must differ from the EMPTY state. "No
/// approval stored" and "I do not know what is stored" are two different statements, and only the first may be
/// overwritten. Both used to appear as the same grey status line, formatted like "Saved." — a load failure was
/// indistinguishable from a success.
///
/// Deliberately a `@ViewBuilder` FUNCTION and not a `View` struct: what it returns is a `TupleView`, which the `List`
/// unfolds into single rows. A struct would be ONE child for the list — the four rows would then lie on top of each other
/// in a single row. On success it returns nothing and therefore occupies no row.
@ViewBuilder
private func blockStateRows(
    identifier: String,
    loading: Bool,
    error: String,
    again: @escaping () -> Void
) -> some View {
    if loading {
        CbLoading(label: L("Loading…"), compact: true)
            .accessibilityIdentifier("\(identifier)-loading")
    }
    if !error.isEmpty {
        Label(error, systemImage: "exclamationmark.circle")
            .font(.caption)
            .foregroundStyle(.red)
            .accessibilityIdentifier("\(identifier)-error")
        Text(L("As long as the server state is missing, this block stays locked — otherwise saving would replace the stored settings with defaults."))
            .font(.caption)
            .foregroundStyle(.secondary)
        Button(L("Try again")) { again() }
            .font(.caption)
            .buttonStyle(.borderless)
            .accessibilityIdentifier("\(identifier)-retry")
    }
}

// MARK: - Permanent approvals

/// The list of tool calls that pass without a question. In daily use it arises via "Always allow" on the approval card; here
/// is the place to read, add and clear. Every change goes out immediately — there is deliberately no Save button of its
/// own, otherwise a struck rule would stay in force although it has vanished from the list.
struct HooksApprovalsSection: View {
    @EnvironmentObject private var session: SessionStore
    /// The role of the list the section sits in (`HooksSettingsView`) — for scrolling the input row after the keyboard.
    var role: ScrollViewProxy? = nil

    /// The input row scrolls itself to the MIDDLE once the keyboard appears. The list's keyboard avoidance pushed it, on the
    /// FIRST focus of a run, measured seven times out of twelve BEHIND the sheet's glass header bar (button y 73–106 against
    /// the safe band 150–575; otherwise y 523–537): "Add" reported itself hittable, the tap hit the bar. Scrolling happens
    /// only when the keyboard STANDS (`didShow`/`didChangeFrame`) — before that the list still computed itself and would
    /// have overwritten the own move. The promise is held by SettingsUITests `testHooksKeyAndPermanentApprovals`
    /// (measured in the band between header bar and keyboard, without scrolling).
    @FocusState private var inputFocus: Bool
    private static let inputRow = "permrule-input-row"

    @State private var rules: [String] = []
    @State private var draft = ""
    @State private var loaded = false
    @State private var loading = true
    @State private var loadError = ""
    @State private var status = ""

    // The explanatory text is carried by the group: same wording, same key, truncated to three lines and with (i) at the
    // title.
    var body: some View {
        CbSettingGroup(
            title: L("Standing permissions"),
            hint: L("Tool calls that go through without asking in the “Ask” and “Auto-edit” modes. They usually come from “Always allow” on the permission card. Same notation as Claude Code: Bash(git status:*) allows everything starting like that, Read(src/**) a path area, WebFetch the whole tool.")
        ) {
            blockStateRows(identifier: "permrule", loading: loading, error: loadError) {
                Task { await load() }
            }

            ForEach(Array(rules.enumerated()), id: \.element) { number, rule in
                HStack(spacing: 8) {
                    // The identifier hangs on the text, not on the HStack: an identifier on a stack moves to every child and
                    // makes the button next to it unfindable.
                    Text(rule)
                        .cbFont(13, design: .monospaced)
                        .lineLimit(1)
                        .truncationMode(.middle)
                        .accessibilityIdentifier("permrule-\(number)")
                    Spacer(minLength: 8)
                    Button(L("Remove"), role: .destructive) {
                        Task { await write(rules.filter { $0 != rule }) }
                    }
                    .font(.caption)
                    .buttonStyle(.borderless)
                    .disabled(!loaded)
                    .accessibilityIdentifier("permrule-remove-\(number)")
                }
            }
            // Additionally the mobile idiom: swipe left deletes. The visible button stays nonetheless — nobody expects a
            // swipe gesture in a settings list, and an approval must be removable without prior knowledge.
            .onDelete { indices in
                let doomed = indices.compactMap { rules.indices.contains($0) ? rules[$0] : nil }
                Task { await write(rules.filter { !doomed.contains($0) }) }
            }

            if loaded && rules.isEmpty {
                Text(L("No standing permissions — every sensitive call asks."))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .accessibilityIdentifier("permrule-empty")
            }

            HStack(spacing: 8) {
                // The placeholder is a code example, not a sentence — it is not translated.
                TextField("Bash(npm run test:*)", text: $draft)
                    .cbFont(13, design: .monospaced)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .submitLabel(.done)
                    .onSubmit { add() }
                    .disabled(!loaded)
                    .focused($inputFocus)
                    .accessibilityIdentifier("permrule-input")
                Button(L("Add")) { add() }
                    .font(.caption)
                    .buttonStyle(.borderless)
                    // Without a read stock `rules` is empty, and the PUT replaces all permanent approvals with the one new
                    // rule. The button therefore hangs on loading, not just on the draft.
                    .disabled(!loaded || draft.trimmingCharacters(in: .whitespaces).isEmpty)
                    .accessibilityIdentifier("permrule-add")
            }
            .id(Self.inputRow)
            .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardDidShowNotification)) { _ in
                inputCentered()
            }
            .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardDidChangeFrameNotification)) { _ in
                inputCentered()
            }
            // Loading hangs on this row and not on the section: a modifier on a section is delicate in a List, a row is
            // unquestionably a row. This row stands in EVERY state — also with an empty list, while loading and after a
            // failure; only for that reason is it the reliable anchor for `.task`. A `.disabled` stops operation, not the
            // lifecycle: the task also runs on a disabled field.
            .task {
                guard !loaded else { return }
                await load()
            }

            if !status.isEmpty {
                Text(status).font(.caption).foregroundStyle(.secondary)
            }
        }
    }

    private func inputCentered() {
        guard inputFocus, let role else { return }
        withAnimation(.easeOut(duration: 0.2)) { role.scrollTo(Self.inputRow, anchor: .center) }
    }

    private func add() {
        let trimmed = draft.trimmingCharacters(in: .whitespaces)
        guard !trimmed.isEmpty else { return }
        draft = ""
        Task { await write(rules + [trimmed]) }
    }

    private func load() async {
        loading = true
        loadError = ""
        guard let client = session.client else {
            loading = false
            loadError = L("No connection to the server.")
            return
        }
        do {
            let doc: PermissionRulesDoc = try await client.get("/api/permission-rules")
            rules = doc.rules
            loaded = true
            status = ""
        } catch {
            loadError = error.localizedDescription
        }
        loading = false
    }

    private func write(_ next: [String]) async {
        // Second guard next to the locked buttons: a swipe gesture knows no `disabled`, and a PUT based on an unread list
        // would delete the whole stock.
        guard loaded, let client = session.client else { return }
        status = L("Saving…")
        do {
            let doc: PermissionRulesDoc = try await client.put(
                "/api/permission-rules", body: PermissionRulesBody(rules: next))
            // The server deduplicates, trims and caps at 500 — its list applies.
            rules = doc.rules
            status = L("Saved.")
        } catch {
            status = error.localizedDescription
        }
    }
}

// MARK: - Web search

/// Source for the own harness's WebSearch tool. Which fields belong is decided by the provider: the address applies ONLY
/// to a self-hosted SearxNG instance, the key only to Brave and Tavily, DuckDuckGo needs neither.
struct HooksWebSearchSection: View {
    @EnvironmentObject private var session: SessionStore

    @State private var provider = "duckduckgo"
    @State private var providerList = ["duckduckgo", "brave", "tavily", "searxng"]
    @State private var base = ""
    @State private var key = ""
    @State private var hasKey = false
    @State private var loaded = false
    @State private var loading = true
    @State private var loadError = ""
    @State private var status = ""

    var body: some View {
        CbSettingGroup(
            title: L("Web search"),
            hint: L("Source for the WebSearch tool of the built-in harness (third-party chats). Without a key it scrapes DuckDuckGo's HTML page, which breaks as soon as that page changes. Claude and Codex use their own search.")
        ) {
            blockStateRows(identifier: "websearch", loading: loading, error: loadError) {
                Task { await load() }
            }

            Picker(L("Providers"), selection: $provider) {
                ForEach(providerList, id: \.self) { value in
                    Text(L(providerName(value))).tag(value)
                }
            }
            // Before loading, only the default "duckduckgo" and an empty address stand here — a value nobody set. Being
            // locked is the more honest statement than a choice that claims a setting.
            .disabled(!loaded)
            .accessibilityIdentifier("websearch-provider")
            // See the comment in the approvals block: loading hangs on a row that stands in every state; `.disabled` does
            // not stop the task.
            .task {
                guard !loaded else { return }
                await load()
            }

            if provider == "searxng" {
                // An address is not translated.
                TextField("https://searx.example.org", text: $base)
                    .keyboardType(.URL)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .cbFont(13, design: .monospaced)
                    .disabled(!loaded)
                    .accessibilityIdentifier("websearch-base")
            }

            if provider != "duckduckgo" && provider != "searxng" {
                SecureField(hasKey ? secretPlaceholder() : L("API key"),
                            text: $key)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .disabled(!loaded)
                    .accessibilityIdentifier("websearch-key")
            }

            Button(L("Save")) { Task { await save() } }
                // The server replaces `provider` and `baseUrl` outright with what is sent. Without a read state the default
                // "duckduckgo" would go out with an empty address — a configured SearxNG instance would be gone without ever
                // having been told that the page did not know the state at all.
                .disabled(!loaded)
                .accessibilityIdentifier("websearch-save")

            if !status.isEmpty {
                Text(status).font(.caption).foregroundStyle(.secondary)
            }
        }
    }

    /// The web client's labels, word for word. An unknown value shows its identifier raw — the server may extend the list
    /// without the app standing empty.
    private func providerName(_ value: String) -> String {
        switch value {
        case "duckduckgo": return "DuckDuckGo (no key, best effort)"
        case "brave": return "Brave Search API"
        case "tavily": return "Tavily"
        case "searxng": return "SearxNG (self-hosted)"
        default: return value
        }
    }

    private func load() async {
        loading = true
        loadError = ""
        guard let client = session.client else {
            loading = false
            loadError = L("No connection to the server.")
            return
        }
        do {
            let doc: WebSearchDoc = try await client.get("/api/web-search")
            provider = doc.provider
            base = doc.baseUrl
            hasKey = doc.hasKey
            if !doc.providers.isEmpty { providerList = doc.providers }
            loaded = true
            status = ""
        } catch {
            loadError = error.localizedDescription
        }
        loading = false
    }

    private func save() async {
        guard loaded, let client = session.client else { return }
        status = L("Saving…")
        let typed = key.trimmingCharacters(in: .whitespaces)
        do {
            // Provider and address always go along; the key only if something was really typed — otherwise an empty field
            // would accidentally mean "delete".
            let doc: WebSearchDoc = try await client.put("/api/web-search", body: SecretBody(
                apiKey: typed.isEmpty ? .keep : .set(typed),
                provider: provider,
                baseUrl: base))
            provider = doc.provider
            base = doc.baseUrl
            hasKey = doc.hasKey
            // The PUT response carries NO `providers` — the choice list therefore stays.
            key = ""
            status = L("Saved.")
        } catch {
            status = error.localizedDescription
        }
    }
}

// MARK: - Read aloud (ElevenLabs)

/// Without a key the system voice reads aloud (`SpeechService`), with a key ElevenLabs. The voice list comes only on a button
/// press: it is queried live from the provider, and without a key the server answers 409 there — a silent call on opening
/// the page would be an error message without cause.
struct HooksReadAloudSection: View {
    @EnvironmentObject private var session: SessionStore

    @State private var key = ""
    @State private var hasKey = false
    @State private var voice = ""
    @State private var voices: [TtsVoice] = []
    @State private var loaded = false
    @State private var loading = true
    @State private var loadError = ""
    @State private var status = ""

    var body: some View {
        CbSettingGroup(
            title: L("Read aloud (ElevenLabs)"),
            hint: L("Without a key the device's system voice reads aloud. An ElevenLabs key sounds more natural; identical messages are cached so they are not paid for twice.")
        ) {
            blockStateRows(identifier: "tts", loading: loading, error: loadError) {
                Task { await load() }
            }

            SecureField(hasKey ? secretPlaceholder() : L("ElevenLabs key"),
                        text: $key)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .disabled(!loaded)
                .accessibilityIdentifier("tts-key")
                // See the comment in the approvals block: loading hangs on a row that stands in every state; `.disabled`
                // does not stop the task.
                .task {
                    guard !loaded else { return }
                    await load()
                }

            if voices.isEmpty {
                // Without a loaded account list only the raw id remains — it stands in the server's configuration too.
                TextField(L("Voice"), text: $voice)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .cbFont(13, design: .monospaced)
                    .disabled(!loaded)
                    .accessibilityIdentifier("tts-voice")
            } else {
                Picker(L("Voice"), selection: $voice) {
                    ForEach(voices) { entry in
                        Text(entry.name).tag(entry.id)
                    }
                }
                // Locked like the text field in the other branch and like everything in this block: without a read state
                // `voice` is not the chosen voice but "". That the list can only arise AFTER loading makes the row
                // inconsequential today — it stays here so the rule remains a rule and need not be re-derived for every
                // control.
                .disabled(!loaded)
                .accessibilityIdentifier("tts-voice")
            }

            // In a List every button belongs in a row of its own: three tappable zones side by side are hard to hit at phone
            // width.
            Button(L("Save")) { Task { await save() } }
                // Unread, `voice` is "" — and an empty `voiceId` makes the server set its default voice. The chosen voice
                // would be reset without anyone having touched it.
                .disabled(!loaded)
                .accessibilityIdentifier("tts-save")

            if hasKey {
                Button(L("Load voices")) { Task { await voicesLoad() } }
                    // The call asks the provider with the stored key — without a read state the page does not know whether
                    // there is one. This too is inconsequential today (the button stands only with `hasKey`, and that
                    // presupposes loading); same rule as next door, see there.
                    .disabled(!loaded)
                    .accessibilityIdentifier("tts-load-voices")
                Button(L("Remove key"), role: .destructive) {
                    Task { await keyRemove() }
                }
                .disabled(!loaded)
                .accessibilityIdentifier("tts-remove-key")
                Text(L("Key stored"))
                    .font(.caption)
                    .foregroundStyle(.green)
                    .accessibilityIdentifier("tts-has-key")
            }

            if !status.isEmpty {
                Text(status).font(.caption).foregroundStyle(.secondary)
            }
        }
    }

    private func load() async {
        loading = true
        loadError = ""
        guard let client = session.client else {
            loading = false
            loadError = L("No connection to the server.")
            return
        }
        do {
            let doc: TtsConfigDoc = try await client.get("/api/tts/config")
            hasKey = doc.hasKey
            voice = doc.voiceId
            loaded = true
            status = ""
        } catch {
            loadError = error.localizedDescription
        }
        loading = false
    }

    private func save() async {
        guard loaded, let client = session.client else { return }
        status = L("Saving…")
        let typed = key.trimmingCharacters(in: .whitespaces)
        do {
            let doc: TtsConfigDoc = try await client.put("/api/tts/config", body: SecretBody(
                apiKey: typed.isEmpty ? .keep : .set(typed),
                voiceId: voice))
            hasKey = doc.hasKey
            voice = doc.voiceId          // sent empty ⇒ the server sets its default
            key = ""
            status = L("Saved.")
        } catch {
            status = error.localizedDescription
        }
    }

    private func voicesLoad() async {
        // Read-only — the stock is not touched by it. The button stands only when a key IS stored, and only a successful
        // load knows that.
        guard let client = session.client else { return }
        status = L("Loading…")
        do {
            let doc: TtsVoicesDoc = try await client.get("/api/tts/voices")
            voices = doc.voices
            // An id missing from the account list shows in the picker as an empty selection and would write an empty string on
            // the next save — so fall back to the first voice instead of silently triggering the server's default.
            if !voices.contains(where: { $0.id == voice }), let first = voices.first {
                voice = first.id
            }
            status = ""                   // the list reports success itself
        } catch {
            // A 409 ("No ElevenLabs key stored") is the right message here and needs no special handling.
            status = error.localizedDescription
        }
    }

    /// Explicit null — only that deletes. An omitted key would mean "keep".
    private func keyRemove() async {
        guard loaded, let client = session.client else { return }
        status = L("Saving…")
        do {
            let doc: TtsConfigDoc = try await client.put(
                "/api/tts/config", body: SecretBody(apiKey: .erase))
            hasKey = doc.hasKey
            voices = []                  // without a key the account list is obsolete
            status = L("Saved.")
        } catch {
            status = error.localizedDescription
        }
    }
}
