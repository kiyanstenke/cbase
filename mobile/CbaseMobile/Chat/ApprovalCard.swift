import SwiftUI

// ── Approval card ──────────────────────────────────────────────────────────────
// The card sits in the coding chat's timeline (`ChatTimelineRow`); its wording matches the web card.
// An agent wants to run a tool that carries an approval mark.
// The run stands still until it is decided here: approve (also with changed parameters) or
// deny with a reason — the reason goes to the model as a tool error, the turn continues.
// Unlike the transient `PermissionCard`, this card lives in the TIMELINE (role "freigabe"): it
// survives a restart, and the ruling stays readable as a row below it.
// Counterpart: web/src/components/ApprovalCard.tsx.
struct ApprovalCardView: View {
    let card: ApprovalCardState
    /// (requestId, approve, reason, changed parameters). If it is missing, the card stays readable.
    var onDecide: ((String, Bool, String, JSONValue?) -> Void)? = nil

    @State private var reasonShow = false
    @State private var reason = ""
    @State private var edit = false
    @State private var texts: [String: String] = [:]
    @State private var toggle: [String: Bool] = [:]

    private var fields: [(key: String, value: JSONValue)] {
        (card.input.objectValue ?? [:]).sorted { $0.key < $1.key }.map { ($0.key, $0.value) }
    }
    /// After the ruling the card shows what REALLY ran — the changed parameters.
    private var shown: JSONValue { card.ruling?.updatedInput ?? card.input }
    private var changed: Bool {
        guard let u = card.ruling?.updatedInput else { return false }
        return u != card.input
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            // Card shape of the timeline (Chat/StatusForm.swift): no orange, ruling muted.
            CardsHeader(symbol: "hand.raised", title: card.open ? L("Approval needed") : L("Approve##noun"), identifier: "chat-approval-card") {
                Spacer(minLength: 4)
                if card.at > 0 {
                    Text(Date(timeIntervalSince1970: card.at / 1000).formatted(date: .omitted, time: .shortened))
                }
            }
            HStack(spacing: 6) {
                (Text(card.server).foregroundStyle(.secondary) + Text(" · ").foregroundStyle(.secondary) + Text(card.tool).bold())
                    .chatFont(.fixed(13.5), design: .monospaced)
                    .lineLimit(2)
                if card.writing == true { AgentMarker(L("writes")) }
            }
            if !card.description.isEmpty {
                Text(card.description)
                    .chatFont(.fixed(12))
                    .foregroundStyle(.secondary)
                    .lineLimit(3)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if edit { formView } else { values(shown) }
            if card.open, onDecide != nil {
                buttons
            } else if let e = card.ruling {
                result(e)
            } else if !card.open {
                Text(L("No longer open"))
                    .chatFont(.caption)
                    .foregroundStyle(.secondary)
                    .accessibilityIdentifier("chat-approval-result")
            }
        }
        .cbCard()
    }

    // ── Reading values ──
    @ViewBuilder
    private func values(_ json: JSONValue) -> some View {
        let pairs = (json.objectValue ?? [:]).sorted { $0.key < $1.key }
        if pairs.isEmpty {
            Text(L("No parameters"))
                .chatFont(.caption)
                .foregroundStyle(.secondary)
        } else {
            VStack(alignment: .leading, spacing: 5) {
                ForEach(pairs, id: \.key) { key, value in
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Text(key)
                            .chatFont(.fixed(11.5), design: .monospaced)
                            .foregroundStyle(.secondary)
                            .frame(minWidth: 64, alignment: .leading)
                        // A text value carries the text marker: a long press marks it, the menu offers "Adjust" —
                        // bring the agent's message into your own tone without leaving the card. JSON stays
                        // monospace without a marker.
                        if Self.isScalar(value) {
                            ChatHighlightableText(source: Self.short(value), markdown: false, fontSize: 12.5)
                                .fixedSize(horizontal: false, vertical: true)
                        } else {
                            Text(Self.short(value))
                                .chatFont(.fixed(12.5), design: .monospaced)
                                .chatSelectable()
                                .fixedSize(horizontal: false, vertical: true)
                        }
                    }
                }
            }
            .padding(10)
            .background(CbColor.ground.opacity(0.6), in: RoundedRectangle(cornerRadius: 10))
        }
    }

    // ── Changing values: the form comes from the VALUE types, the rest as JSON ──
    private var formView: some View {
        VStack(alignment: .leading, spacing: 8) {
            ForEach(fields, id: \.key) { key, value in
                VStack(alignment: .leading, spacing: 3) {
                    Text(key)
                        .chatFont(.fixed(11.5), design: .monospaced)
                        .foregroundStyle(.secondary)
                    switch value {
                    case .bool:
                        Toggle(isOn: Binding(get: { toggle[key] ?? false }, set: { toggle[key] = $0 })) { EmptyView() }
                            .labelsHidden()
                    case .number:
                        TextField(key, text: textBinding(key))
                            .keyboardType(.decimalPad)
                            .textFieldStyle(.roundedBorder)
                    case .string:
                        TextField(key, text: textBinding(key), axis: .vertical)
                            .lineLimit(1...6)
                            .textFieldStyle(.roundedBorder)
                            .accessibilityIdentifier("chat-approval-field-\(key)")
                    default:
                        TextEditor(text: textBinding(key))
                            .chatFont(.fixed(12), design: .monospaced)
                            .frame(minHeight: 64)
                            .overlay { RoundedRectangle(cornerRadius: 6).stroke(Color.secondary.opacity(0.3)) }
                    }
                }
            }
            Text(L("Nested values stay JSON — invalid JSON keeps the old value."))
                .chatFont(.caption2)
                .foregroundStyle(.secondary)
        }
        .padding(10)
        .background(CbColor.ground.opacity(0.6), in: RoundedRectangle(cornerRadius: 10))
    }

    private func textBinding(_ key: String) -> Binding<String> {
        Binding(get: { texts[key] ?? "" }, set: { texts[key] = $0 })
    }

    private func startEdit() {
        var t: [String: String] = [:]
        var s: [String: Bool] = [:]
        for (key, value) in fields {
            switch value {
            case .string(let v): t[key] = v
            case .number(let v): t[key] = v == v.rounded() && abs(v) < 1e15 ? String(Int(v)) : String(v)
            case .bool(let v): s[key] = v
            default: t[key] = value.prettyPrinted
            }
        }
        texts = t
        toggle = s
        edit = true
    }

    /// Changed parameters as an object: every value keeps its type; what cannot be read
    /// stays the old value (never send off an empty card).
    private func changedInput() -> JSONValue {
        var out = card.input.objectValue ?? [:]
        for (key, value) in out {
            switch value {
            case .string:
                out[key] = .string(texts[key] ?? "")
            case .number(let old):
                out[key] = .number(Double((texts[key] ?? "").replacingOccurrences(of: ",", with: ".")) ?? old)
            case .bool(let old):
                out[key] = .bool(toggle[key] ?? old)
            default:
                if let t = texts[key], let data = t.data(using: .utf8),
                   let v = try? JSONDecoder().decode(JSONValue.self, from: data) {
                    out[key] = v
                }
            }
        }
        return .object(out)
    }

    // ── Action ──
    private var buttons: some View {
        VStack(alignment: .leading, spacing: 8) {
            if reasonShow {
                TextField(L("Why not? (sent to the model)"), text: $reason)
                    .textFieldStyle(.roundedBorder)
                    .submitLabel(.send)
                    .onSubmit { onDecide?(card.requestId, false, reason, nil) }
                    .accessibilityIdentifier("chat-approval-reason")
            }
            HStack(spacing: 8) {
                Button(L("Deny"), role: .destructive) {
                    if reasonShow { onDecide?(card.requestId, false, reason, nil) } else { reasonShow = true }
                }
                .buttonStyle(CardsButtonStyle())
                .accessibilityIdentifier("chat-approval-reject")
                Spacer(minLength: 0)
                if edit {
                    Button(L("Dismiss")) { edit = false }
                        .buttonStyle(CardsButtonStyle())
                    Button(L("Approve with changes")) { onDecide?(card.requestId, true, "", changedInput()) }
                        .buttonStyle(CardsButtonStyle(main: true))
                        .accessibilityIdentifier("chat-approval-approve-changed")
                } else {
                    if !fields.isEmpty {
                        Button(L("Update")) { startEdit() }
                            .buttonStyle(CardsButtonStyle())
                            .accessibilityIdentifier("chat-approval-change")
                    }
                    Button(L("Approve")) { onDecide?(card.requestId, true, "", nil) }
                        .buttonStyle(CardsButtonStyle(main: true))
                        .accessibilityIdentifier("chat-approval-approve")
                }
            }
            if reasonShow {
                Text(L("Tap Deny again to send the reason."))
                    .chatFont(.caption2)
                    .foregroundStyle(.secondary)
            }
        }
    }

    // ── Result: who decided how ──
    private func result(_ e: ApprovalRuling) -> some View {
        // Without colour: a cancelled card stays distinguishable from the human's "no" by word and symbol.
        let (text, symbol): (String, String) = {
            if e.behavior == "allow" {
                if !e.remember.isEmpty { return (L("Approved — rule remembered: {rule}", ["rule": e.remember]), "checkmark.circle") }
                return (changed ? L("Approved — with changes") : L("Approved"), "checkmark.circle")
            }
            switch e.origin {
            case "stop": return (L("Not executed — the run was stopped"), "minus.circle")
            case "running": return (L("No longer open — the run has ended"), "minus.circle")
            default: return (e.reason.isEmpty ? L("Rejected") : L("Declined: “{reason}”", ["reason": e.reason]), "xmark.circle")
            }
        }()
        return HStack(alignment: .firstTextBaseline, spacing: 6) {
            Image(systemName: symbol).foregroundStyle(CbColor.textMuted)
            Text(text)
                .chatFont(.fixed(12.5))
                .foregroundStyle(CbColor.textSecondary)
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 4)
            if e.at > 0 {
                Text(Date(timeIntervalSince1970: e.at / 1000).formatted(date: .omitted, time: .shortened))
                    .chatFont(.fixed(11))
                    .foregroundStyle(.secondary)
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("chat-approval-result")
    }

    // ── Helpers ──
    private static func isScalar(_ v: JSONValue) -> Bool {
        switch v {
        case .string, .number, .bool, .null: return true
        default: return false
        }
    }
    private static func short(_ v: JSONValue) -> String {
        switch v {
        case .string(let s): return s.isEmpty ? "„“" : s
        case .number(let n): return n == n.rounded() && abs(n) < 1e15 ? String(Int(n)) : String(n)
        case .bool(let b): return b ? L("yes") : L("no")
        case .null: return "–"
        default: return v.prettyPrinted
        }
    }
}
