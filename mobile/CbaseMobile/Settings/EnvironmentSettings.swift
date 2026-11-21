import SwiftUI

// ── Server environment ──────────────────────────────────────────────────────
//
// Deliberately NO bigger memory picture: the bar stays a bar. It comes only from `SettingsKit` (`CbProgressBar`) instead
// of own capsules — the same number thus carries the same thresholds as the header's usage ring.
//
// The introductory sentence says WHOSE memory is shown here, and therefore belongs on the first group rather than a single
// row — same wording, same key.
//
// Additionally the container's own limits, READ-ONLY: RAM limit with consumption, CPU priority, CPU upper limit — the same
// fields from `GET /gw/env` as on the web (`ENV_ADDITION_FIELDS`, `AdministrationOwn`). Only an admin can change them under
// Settings → Administration; a button here would be a path that ends in 403.
struct EnvironmentSettingsView: View {
    @EnvironmentObject private var session: SessionStore
    @State private var env: GatewayEnvInfo?
    @State private var own: AdministrationOwn?
    @State private var storage: GatewayStorageInfo?
    @State private var loading = true
    @State private var error = ""

    var body: some View {
        CbList {
            if loading && storage == nil {
                Section { CbLoading(label: L("Measuring storage…"), compact: true) }
            }
            if !error.isEmpty {
                Section { Label(error, systemImage: "exclamationmark.circle").foregroundStyle(.red) }
            }
            if let storage {
                CbSettingGroup(
                    title: L("Storage"),
                    hint: L("Your personal, isolated environment on the server — home to your workspaces, chats, and provider logins.")
                ) {
                    let total = storage.quotaBytes ?? storage.hostFreeBytes.map { storage.usedBytes + $0 }
                    let available = storage.quotaBytes.map { max(0, $0 - storage.usedBytes) } ?? storage.hostFreeBytes
                    let percent = total.map { min(100, storage.usedBytes / $0 * 100) } ?? 0
                    HStack(spacing: 12) {
                        CbProgressBar(percent: percent, height: 8)
                        Button(loading ? "…" : L("Refresh")) { Task { await load() } }
                            .font(.caption)
                            .buttonStyle(.borderless)
                            .disabled(loading)
                    }
                    row(L("Used"), formatBytes(storage.usedBytes))
                    row(
                        storage.quotaBytes != nil ? L("Available (of quota)") : L("Available (free on the server)"),
                        formatBytes(available)
                    )
                    if let quota = storage.quotaBytes {
                        row(L("Quota"), formatBytes(quota))
                    }
                }
            }
            if let r = own?.resources {
                resourcesGroup(r)
            }
            if let env {
                CbSettingGroup {
                    CbSettingRow(
                        title: env.state == "running" ? L("Environment running") : L("Environment stopped"),
                        symbol: env.state == "running" ? "circle.fill" : "circle"
                    ) {
                        if env.state == "running", let started = env.startedAt, let date = UsageStore.parse(started) {
                            Text(L("since {time}", ["time": locDateTime(date)]))
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                    }
                    // The dot carries the colour, not the text: a green sentence would read like a success message, but a
                    // state is meant. `.tint` instead of `.foregroundStyle`, because the row's symbol lies on the tint and a
                    // foreground colour would colour the title too.
                    .tint(env.state == "running" ? Color.green : Color.secondary.opacity(0.5))
                }
            }
        }
        .navigationTitle(L("Environment"))
        .navigationBarTitleDisplayMode(.inline)
        .task { await load() }
    }

    /// Label on the left, number on the right — monospaced so the three line up.
    private func row(_ label: String, _ value: String) -> some View {
        CbSettingRow(title: label) {
            Text(value)
                .cbFont(12, weight: .medium, design: .monospaced)
        }
    }

    /// The own limits. If `resources` is missing (a gateway from before the administration), the group is missing — never "no limit".
    @ViewBuilder
    private func resourcesGroup(_ r: AdministrationResources) -> some View {
        CbSettingGroup(
            title: L("Resources"),
            hint: L("The limits of your container. An admin can change them under Settings → Admin.")
        ) {
            VStack(alignment: .leading, spacing: 6) {
                HStack {
                    Text(L("RAM limit")).font(.subheadline.weight(.medium))
                    Spacer()
                    Text(verbatim: "\(r.ramGiB) GiB").cbFont(12, weight: .medium, design: .monospaced)
                }
                if let ram = own?.consumption?.ramBytes {
                    CbProgressBar(percent: ram / (Double(r.ramGiB) * administrationGiB) * 100, height: 8)
                    Text(L("{v} in use", ["v": administrationGiBText(ram)]))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            .padding(.vertical, 2)
            row(L("CPU priority"), administrationPrioWord(r.cpuPrio))
            row(L("CPU limit"), r.cpuMax.map { L("{n} threads", ["n": $0]) } ?? L("none"))
        }
    }

    private func load() async {
        guard let client = session.client else { return }
        loading = true
        defer { loading = false }
        // ONE call, two readings: state/start (`GatewayEnvInfo`) and the own limits (`AdministrationOwn`).
        if let data = try? await client.data("/gw/env") {
            env = try? JSONDecoder().decode(GatewayEnvInfo.self, from: data)
            own = try? JSONDecoder().decode(AdministrationOwn.self, from: data)
        } else {
            env = nil
            own = nil
        }
        do {
            storage = try await client.get("/gw/env/storage")
            error = ""
        } catch {
            self.error = error.localizedDescription
        }
    }
}
