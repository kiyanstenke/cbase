import Foundation

extension ChatViewModel {

    enum SlashResult { // internal, for extensions
        case handled
        case send(actual: String, display: String)
        case notCommand
    }

    /// Longest goal the server stores (`TARGET_MAX` in server.js) — the same number here.
    static let targetMax = 4000

    /// The goal text of a "/goal <text>" with pastes: what was typed, followed by the content
    /// of every pasted text file, cut to the server cap. Same rule as
    /// `targetText` in web/src/lib/slash.ts — the paste stood behind "/goal" in the field before the
    /// composer turned it into a file, and WAS the goal; without it the judge would have to hold "fix the 5
    /// things" against an answer without ever learning which five. An uploaded
    /// FILE (image, PDF) is not folded in — it is material, not goal text.
    static func targetText(_ argument: String, insertions: [String]) -> String {
        let parts = ([argument] + insertions)
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
        return String(parts.joined(separator: "\n\n").prefix(targetMax))
    }

    /// `attachments`: what currently hangs in the composer — /goal folds pastes from it into the goal.
    func runSlash(_ text: String, attachments: [Attachment] = []) async throws -> SlashResult { // internal, for extensions
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.hasPrefix("/") else { return .notCommand }
        let parts = trimmed.dropFirst().split(maxSplits: 1, whereSeparator: \.isWhitespace)
        let command = parts.first?.lowercased() ?? ""
        let argument = parts.count > 1 ? String(parts[1]).trimmingCharacters(in: .whitespacesAndNewlines) : ""

        switch command {
        case "goal":
            // German terms here match German user input on purpose (the UI is bilingual) - an intended exception to the English-only rule.
            if ["clear", "löschen", "erase"].contains(argument.lowercased()) {
                try await setGoal("")
                pushInfo(title: "Goal", body: L("Goal cleared."))
                return .handled
            }
            // Pasted text of a draft still sits in memory (pendingUploads), for
            // an existing chat it is already on the server — the preview carries only 420 characters.
            var insertions: [String] = []
            for attachment in attachments where PastedText.matches(name: attachment.name) {
                if let pending = pendingUploads[attachment.file] {
                    insertions.append(String(decoding: pending.data, as: UTF8.self))
                } else if let data = try? await attachmentData(attachment) {
                    insertions.append(String(decoding: data, as: UTF8.self))
                }
            }
            let target = Self.targetText(argument, insertions: insertions)
            if target.isEmpty {
                // A resting goal says that it rests — otherwise "/goal" would read out a paused goal like a pursued
                // one.
                let goalText = chat.goal.isEmpty
                    ? L("No goal set.")
                    : chat.goalPaused
                        ? chat.goal + "\n\n" + L("Paused — it is not pursued until you resume it from the goal row.")
                        : chat.goal
                pushInfo(title: "Goal", body: goalText)
                return .handled
            }
            try await setGoal(target)
            // The typed text counts as the prompt (the paste travels along as an attachment).
            return .send(actual: argument, display: trimmed)
        case "compact":
            try await compact(instruction: argument)
            return .handled
        case "clear":
            try await clearContext()
            return .handled
        case "cost":
            showCost()
            return .handled
        case "help":
            pushInfo(title: "Commands", body: slashHelp)
            return .handled
        case "effort":
            // The levels of the model this chat RUNS — not the old five-item list. A
            // level the model does not carry ends in a 400 at the provider and costs the
            // whole turn; rejected here it costs one sentence.
            //
            // Both messages therefore name the levels as a PARAMETER and not verbatim: a
            // built-in "low, medium, high, xhigh, max" would be wrong after the next model switch
            // — and in the English version a second time.
            // If the model carries NO levels (Haiku 4.5), there is nothing to choose or
            // set — instead of an empty list the command says so, and nothing goes to the CLI.
            // The same when the provider has `caps.effort` off — the decision lives ONCE in
            // `EffortLevels.withoutSelection`. An old chat without a stored provider computes like the web with the
            // globally active one (`EffortLevels.effectiveProvider`), not with "".
            let provider = EffortLevels.effectiveProvider(chat.provider, active: activeProvider)
            // Short forms: `mid`/`med` ⇒ medium, `x-high` ⇒ xhigh — the same table as `EFFORT_ALIAS` on the web
            // (ChatCatalog.tsx), bound in web/test/list-binding.test.mjs (the anchor looks for the first table under this `case`).
            // Checked afterwards like any word: if the model does not carry the target, it says "Unknown".
            let aliases = [
                "mid": "medium", "med": "medium", "x-high": "xhigh"
            ]
            let value = aliases[argument.lowercased()] ?? argument.lowercased()
            // `/effort ultracode` flips the SWITCH — locally, also with an attachment
            // and also on a model without levels: the branch ends here (`.handled`), the word never reaches the CLI (it knows
            // `--effort ultracode` and would otherwise run its own mode). The level stays — like `chatSlash.ts` on the web.
            if value == EffortLevels.ultracode {
                let enabled = !chat.ultracode
                try await updateSettings(
                    provider: chat.provider, model: chat.model,
                    permissionMode: chat.permissionMode, effort: chat.effort, browserMode: chat.browserMode,
                    preserveContextOnProviderSwitch: false, ultracode: enabled, effortChoice: true
                )
                pushInfo(title: L("Effort"), body: enabled ? L("Ultracode on.") : L("Ultracode off."))
                return .handled
            }
            let without = EffortLevels.withoutSelection(providers, provider: provider, model: chat.model)
            if !without.isEmpty {
                pushInfo(title: L("Effort"), body: EffortLevels.withoutSelectionText(without))
                return .handled
            }
            let levels = EffortLevels.levels(providers, provider: provider, model: chat.model)
            if argument.isEmpty {
                // Named is the level that THINKS — not the stored one. If the model does not carry it,
                // the spawn clamps it, and "Current: **max**" above a list without "max"
                // would be half the truth: the half that is no longer right. The entry from
                // `EffortLevels.selection` carries exactly this sentence ("Max · runs as X-High") — the same
                // as in the picker and on the web, and with the LABEL instead of the raw lowercase word.
                // Without a stored level it names the one that RUNS: the provider's default level,
                // clamped to the model — like server and web.
                let current = chat.effort.isEmpty ? EffortLevels.standard(providers, provider: provider, model: chat.model) : chat.effort
                let entry = EffortLevels
                    .selection(providers, provider: provider, model: chat.model, current: current)
                    .first { $0.id == current }
                // Ultracode is named beside it, each on its own (two axes); the list ends with the switch
                // (like `chatSlash.ts` on the web).
                let now = (entry?.label ?? L("Default")) + (chat.ultracode ? " · Ultracode" : "")
                pushInfo(
                    title: L("Effort"),
                    body: L("Current: **{effort}**\n\nChoose: {list}.",
                            ["effort": now, "list": (levels + [EffortLevels.ultracode]).joined(separator: ", ")])
                )
                return .handled
            }
            // "auto" no longer exists: a word like any other outside the list — "Unknown",
            // locally; the CLI never sees it (`.handled`).
            guard levels.contains(value) else {
                pushInfo(
                    title: L("Effort"),
                    body: L("Unknown: \"{arg}\". Available: {list}.",
                            ["arg": argument, "list": levels.joined(separator: ", ")])
                )
                return .handled
            }
            try await updateSettings(
                provider: chat.provider, model: chat.model,
                permissionMode: chat.permissionMode, effort: value, browserMode: chat.browserMode,
                preserveContextOnProviderSwitch: false, effortChoice: true
            )
            pushInfo(title: L("Effort set"), body: value)
            return .handled
        case "mode":
            let aliases = [
                "voll": "bypassPermissions", "vollzugriff": "bypassPermissions", "full": "bypassPermissions",
                "auto": "acceptEdits", "auto-edit": "acceptEdits", "plan": "plan",
                "fragen": "default", "ask": "default"
            ]
            if argument.isEmpty {
                let labels = [
                    "bypassPermissions": "Full access",
                    "acceptEdits": "Auto-edit",
                    "plan": "Plan",
                    "default": "Ask"
                ]
                pushInfo(
                    title: "Mode",
                    body: L("Current: **{mode}**\n\nChoose: full, auto, plan, ask.", ["mode": labels[chat.permissionMode.isEmpty ? "bypassPermissions" : chat.permissionMode] ?? chat.permissionMode])
                )
                return .handled
            }
            guard let value = aliases[argument.lowercased()] else {
                pushInfo(title: "Mode", body: L("Available: full, auto, plan, ask."))
                return .handled
            }
            try await updateSettings(
                provider: chat.provider, model: chat.model,
                permissionMode: value, effort: chat.effort, browserMode: chat.browserMode,
                preserveContextOnProviderSwitch: false
            )
            pushInfo(title: "Mode set", body: value)
            return .handled
        case "browser":
            // The agents' browser ALWAYS runs headless (toolchain/playwright.js) — the command stays so that
            // "/browser …" does not go to the CLI, and says how things are.
            pushInfo(title: "Browser", body: L("The agents' browser always runs in the background (headless). Under Coding → Browser you can watch it and take over."))
            return .handled
        case "model":
            guard !argument.isEmpty else {
                // OpenRouter brings its whole catalog (hundreds) — the list there names only the
                // count and the way, instead of writing a hundred lines into the history.
                let names = connectedProviders.flatMap { provider -> [String] in
                    if provider.id == UsageContract.openrouterId {
                        return ["\(provider.label) · " + L("{n} models — search in the chat settings or /model <name>", ["n": provider.models.count])]
                    }
                    return provider.models.map { "\(provider.label) · \($0.label)" }
                }
                let label = currentModel?.label ?? chat.model
                pushInfo(
                    title: "Model",
                    body: L("Current: **{model}**\n\nAvailable:\n{list}", ["model": label, "list": names.joined(separator: "\n")])
                )
                return .handled
            }
            let aliases = [
                "opus": "claude-opus-5-5",
                "opus5.5": "claude-opus-5-5",
                "opus5": "claude-opus-5",
                "opus4.8": "claude-opus-4-8",
                // `sonnet`/`haiku` point to the 5.5 models — like the CLI and MODEL_ALIAS on the web
                // (ChatCatalog.tsx, bound in web/test/list-binding.test.mjs).
                "sonnet": "claude-sonnet-5-5",
                "sonnet5.5": "claude-sonnet-5-5",
                "sonnet5": "claude-sonnet-5",
                "haiku": "claude-haiku-5-5",
                "haiku5.5": "claude-haiku-5-5",
                "haiku4.5": "claude-haiku-4-5-20251001",
                "fable": "claude-fable-5-2",
                "fable5.2": "claude-fable-5-2",
                "fable5.1": "claude-fable-5-1",
                "fable5": "claude-fable-5",
                "astra": "gpt-6-astra"
            ]
            let key = argument.lowercased().replacingOccurrences(of: " ", with: "")
            if ["standard", "default"].contains(key),
               let provider = currentProvider,
               let model = provider.models.first(where: { $0.id == provider.defaultModel })
                    ?? provider.models.first {
                try await updateSettings(
                    provider: provider.id, model: model.id,
                    permissionMode: chat.permissionMode, effort: chat.effort, browserMode: chat.browserMode,
                    preserveContextOnProviderSwitch: false
                )
                pushInfo(title: "Model set", body: "\(provider.label) · \(model.label)")
                return .handled
            }
            let needle = aliases[key] ?? argument.lowercased()
            let match = connectedProviders.lazy.compactMap { provider in
                provider.models.first {
                    $0.id.lowercased() == needle || $0.label.lowercased() == needle
                        || $0.label.lowercased().replacingOccurrences(of: " ", with: "") == key
                }.map { (provider, $0) }
            }.first
            guard let (provider, model) = match else {
                pushInfo(title: "Model", body: L("Unknown: \"{arg}\". Use /model for the list.", ["arg": argument]))
                return .handled
            }
            try await updateSettings(
                provider: provider.id, model: model.id,
                permissionMode: chat.permissionMode, effort: chat.effort, browserMode: chat.browserMode,
                preserveContextOnProviderSwitch: true
            )
            pushInfo(title: "Model set", body: "\(provider.label) · \(model.label)")
            return .handled
        default:
            return .notCommand
        }
    }

    private func showCost() {
        let summaries = timeline.compactMap { $0.role == .assistant ? $0.summary : nil }
        let output = summaries.reduce(0) { $0 + $1.outTok }
        let seconds = summaries.reduce(0) { $0 + $1.secs }
        let percent = contextWindow > 0 ? min(100, Int((Double(contextTokens) / Double(contextWindow) * 100).rounded())) : 0
        pushInfo(
            title: "Cost & usage",
            body: L("Replies: {n}\n\nContext now: {used} / {window} ({percent} %)\n\nOutput total: ~{output} tokens\n\nRuntime total: {time}",
                    ["n": summaries.count, "used": Self.formatTokens(contextTokens), "window": Self.formatTokens(contextWindow),
                     "percent": percent, "output": Self.formatTokens(output), "time": Self.formatDuration(seconds)])
                + "\n\n" + usageBillingNote
        )
    }

    private var usageBillingNote: String {
        switch chat.provider {
        case "codex":
            return "_Runs via your ChatGPT/Codex subscription._"
        case "claude":
            return L("_Runs via your Claude subscription._")
        default:
            return "_Runs via this provider's API key._"
        }
    }

    func mentionQuery(in text: String) -> String? { // internal, for extensions
        guard let range = mentionRange(in: text) else { return nil }
        return String(text[range].dropFirst())
    }

    func mentionRange(in text: String) -> Range<String.Index>? { // internal, for extensions
        // `\\s`, NOT `\\\\s`: the doubled form is a LITERAL backslash followed by "s" in
        // ICU. Effect: the mention only triggered at the start of the text, and the search broke off at every "s".
        // The web client has it right (ChatPane.tsx, updateMention).
        guard let regex = try? NSRegularExpression(pattern: "(?:^|\\s)@([^\\s@]*)$"),
              let match = regex.firstMatch(in: text, range: NSRange(text.startIndex..., in: text)),
              let full = Range(match.range(at: 0), in: text) else { return nil }
        var start = full.lowerBound
        if start < text.endIndex, text[start].isWhitespace { start = text.index(after: start) }
        return start..<full.upperBound
    }

    static func formatTokens(_ value: Int) -> String {
        if value >= 999_500 { return millionsShort(value) }
        if value >= 1_000 { return "\(Int((Double(value) / 1_000).rounded()))k" }
        return "\(value)"
    }

    /// "1M", "1,3M" — every token display shows millions from 999,500 instead of "1000k".
    /// Same form as on the web (`fmtTokens`, lib/agents.ts).
    nonisolated static func millionsShort(_ value: Int) -> String { // pure computation, also outside the main actor (`skillTokenShort`)
        var s = String(format: "%.1f", Double(value) / 1_000_000)
        if s.hasSuffix(".0") { s.removeLast(2) }
        return s.replacingOccurrences(of: ".", with: ",") + "M"
    }

    static func formatDuration(_ seconds: Int) -> String {
        seconds >= 60 ? "\(seconds / 60)m \(seconds % 60)s" : "\(seconds)s"
    }

    /// A slash command as the picker shows it and `/help` lists it.
    struct SlashCommand: Identifiable, Hashable, Sendable {
        let name: String
        /// Argument form ("<text>") — purely for display, only the name is written.
        var arg: String = ""
        /// Already translated (see `slashCatalog`).
        let description: String
        var id: String { name }
        /// The line as it stands in `/help`. Name and argument form are the same characters
        /// in every language.
        var helpLine: String { "/\(name)\(arg.isEmpty ? "" : " " + arg) — \(description)" }
    }

    /// The catalog of slash commands: ONE source for the picker AND for `/help`. The
    /// execution stays the `switch` in `runSlash` — that is the execution, not the list.
    /// Whoever adds a command here must handle it there; whoever removes it there must strike it
    /// here, or the picker offers a capability that does not exist.
    ///
    /// COMPUTED, not `static let`, and the descriptions appear as LITERAL translation
    /// calls. Both are needed: `tools/loc-audit.sh` reads only literal calls — a
    /// variable as key would go unnoticed and show German in the English version.
    /// (The audit also reads comments: an example call HERE would itself fail.)
    /// And a `static let` evaluated once
    /// would freeze the language that applied at first access.
    ///
    /// Lives on the CHAT, not the class: the argument form of `/effort` depends on the
    /// model (gpt-5.5 carries no `max`, Sol does), and a help that names levels this
    /// chat cannot run sends the user into the provider's 400.
    var slashCatalog: [SlashCommand] {
        let levels = EffortLevels.levels(providers, provider: chat.provider, model: chat.model)
        return [
            SlashCommand(name: "goal", arg: "<text>", description: L("Set a goal and send it as the task. “/goal clear” removes it.")),
            SlashCommand(name: "compact", description: L("Summarize the context.")),
            SlashCommand(name: "clear", description: L("Clear the previous context; the history stays visible.")),
            SlashCommand(name: "model", arg: "<name>", description: L("Switch the model or provider.")),
            SlashCommand(name: "effort", arg: "<\((levels + [EffortLevels.ultracode]).joined(separator: "|"))>", description: L("Set the reasoning effort.")),
            SlashCommand(name: "mode", arg: "<full|auto|plan|ask>", description: L("Set the permission mode.")),
            SlashCommand(name: "browser", description: L("Shows how the agents' browser runs — always in the background (headless).")),
            SlashCommand(name: "cost", description: L("Show the token usage.")),
            SlashCommand(name: "help", description: L("This overview.")),
        ]
    }

    // The board above is also the list of names the server withholds from the dynamic-workflow library
    // (web/test/list-binding.test.mjs).

    var slashHelp: String { slashCatalog.map(\.helpLine).joined(separator: "\n") }

    // ── Slash picker ──
    /// Detect the leading "/word" (`slashWord`, below) and fetch the skills as soon as the picker
    /// OPENS — not at every character after.
    ///
    /// Unlike on the web the WHOLE text is checked, not the part before the insertion point:
    /// `ChatInputTextView` passes no caret position through to SwiftUI, and every set of
    /// `uiView.text` moves the caret to the end anyway. A picker that pretended to know
    /// the caret would put the command in the wrong place.
    func updateSlash(for text: String) {
        let on = slashQuery != nil
        // While quotes wait, the message is no command (it starts with "> " when sent) — the board stays closed.
        slashQuery = quotes.isEmpty ? slashWord(in: text) : nil
        if slashQuery != nil, !on { Task { await loadSkills(); await loadSlashWorkflows() } }
    }

    /// Insert the chosen name. By construction nothing stands behind it (see
    /// `updateSlash`), so the space simply makes room for the argument.
    func insertSlash(_ name: String) {
        input = "/\(name) "
        slashQuery = nil
    }

    /// What the picker shows: first the commands, then the skills — both filtered by the search.
    /// The order is the statement: commands are nine and always the same, skills can be
    /// many and different per workspace.
    /// Behind them the graph workflows (filled only in the Coding chat), searched via the
    /// inserted name `workflow:<shortname>` (`slashName`) — "/ip" finds `workflow:job-ship` as a hit in the
    /// middle, "/workflow:a" at the start.
    var slashHits: (commands: [SlashCommand], skills: [SkillSummary], workflows: [WorkflowSummary]) {
        guard let q = slashQuery?.lowercased(), !q.isEmpty else {
            return (slashCatalog, slashSkills, slashWorkflows)
        }
        return (slashSorted(slashCatalog, search: q, name: \.name), slashSorted(slashSkills, search: q, name: \.name),
                slashSorted(slashWorkflows, search: q, name: \.slashName))
    }
}

extension WorkflowSummary {
    /// The name the slash picker inserts: `workflow:<shortname>`. Empty without a short name —
    /// such entries are already filtered out by `loadSlashWorkflows`.
    var slashName: String { shortName.map { "workflow:\($0)" } ?? "" }
}

// ── The two rules of the slash picker, free of the class ──
// TWO readers: the composer (`ChatViewModel.updateSlash`/`slashHits`) and the command field of the
// workflow step (`WorkflowNodeSheet` in Workflows/WorkflowCanvasEditor.swift). A character-for-character
// copy of both would let a dot in skill names reach only the composer, with no guard reporting it.
// Whoever changes the character class changes it HERE, and both pickers follow.

/// Detect the leading "/word". Only at the VERY start and only as long as no space has been typed:
/// a slash in the middle of the text belongs to a path, and after the space one types
/// the ARGUMENT of a command, no longer its name. `nil` = no picker.
func slashWord(in text: String) -> String? {
    guard text.hasPrefix("/") else { return nil }
    let rest = text.dropFirst()
    guard rest.allSatisfy({ $0.isLetter || $0.isNumber || $0 == "-" || $0 == "_" || $0 == ":" }) else { return nil }
    return String(rest)
}

/// Hits at the START before hits in the middle: whoever types "co" means "compact" or "cost",
/// not "docs-connector". `q` is already lowercased.
func slashSorted<T>(_ items: [T], search q: String, name: (T) -> String) -> [T] {
    let small = items.map { ($0, name($0).lowercased()) }
    return small.filter { $0.1.hasPrefix(q) }.map(\.0) + small.filter { !$0.1.hasPrefix(q) && $0.1.contains(q) }.map(\.0)
}
