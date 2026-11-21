import SwiftUI

// Settings → Integrations: the list of services; a tap opens the service's page (`GitlabSettingsView` in
// IntegrationsSettings.swift, `NgrokSettingsView` below). On the web the list stands to the left of the chosen service
// (`web/src/components/settings/IntegrationsSettings.tsx`); on mobile the HIG applies — the same list is the first level.
//
// The logos are vector assets from Simple Icons (CC0, see web/src/lib/thirdParty.ts): `IntegrationGitLab` (the Tanuki in GitLab's
// orange) and `IntegrationNgrok` (the wordmark, rendered as a template — black in light, white in dark mode).
//
// The list loads the state itself: on every appearance (also after returning from a service page) and on every preview
// event. `nil` means "not loaded yet" — never "not connected".
//
// Identifiers: `integration-gitlab`, `integration-ngrok`.
struct IntegrationsSettingsView: View {
    @EnvironmentObject private var session: SessionStore
    @EnvironmentObject private var state: AppState

    @State private var accounts: [GitlabAccount]?
    @State private var access: NgrokAccess?
    /// `false` after a 404: the server does not know the ngrok routes — the row is omitted.
    @State private var ngrokAvailable = true

    private enum Tone { case ok, off, error, open }

    var body: some View {
        CbList {
            CbSettingGroup(title: L("Services")) {
                NavigationLink {
                    GitlabSettingsView()
                        .environmentObject(session)
                        .environmentObject(state)
                } label: {
                    serviceRow(name: "GitLab", situation: gitlabSituation) {
                        Image("IntegrationGitLab")
                            .resizable()
                            .scaledToFit()
                            .frame(width: 22, height: 22)
                    }
                }
                .accessibilityIdentifier("integration-gitlab")
                if ngrokAvailable {
                    NavigationLink {
                        NgrokSettingsView()
                            .environmentObject(session)
                            .environmentObject(state)
                    } label: {
                        serviceRow(name: "ngrok", situation: ngrokSituation) {
                            Image("IntegrationNgrok")
                                .renderingMode(.template)
                                .resizable()
                                .scaledToFit()
                                .frame(width: 27)
                                .foregroundStyle(.primary)
                        }
                    }
                    .accessibilityIdentifier("integration-ngrok")
                }
            }
        }
        .navigationTitle(L("Integrations"))
        .navigationBarTitleDisplayMode(.inline)
        .task { await load() }
        .onChange(of: state.previewTick) {
            Task { await load() }
        }
    }

    private func serviceRow<Logo: View>(name: String, situation: (text: String, tone: Tone), @ViewBuilder logo: () -> Logo) -> some View {
        HStack(spacing: 12) {
            logo()
                .frame(width: 38, height: 38)
                .background(Color(.systemBackground), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).strokeBorder(Color(.separator), lineWidth: 0.5))
            VStack(alignment: .leading, spacing: 2) {
                Text(verbatim: name)
                    .font(.subheadline.weight(.medium))
                HStack(spacing: 5) {
                    point(situation.tone)
                    Text(situation.text)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
            }
            Spacer(minLength: 0)
        }
        .padding(.vertical, 2)
    }

    @ViewBuilder
    private func point(_ tone: Tone) -> some View {
        switch tone {
        case .ok: Circle().fill(Color.green).frame(width: 6, height: 6)
        case .error: Circle().fill(Color.red).frame(width: 6, height: 6)
        case .off, .open: Circle().strokeBorder(Color.secondary.opacity(0.6), lineWidth: 1).frame(width: 6, height: 6)
        }
    }

    private var gitlabSituation: (text: String, tone: Tone) {
        guard let accounts else { return (L("Loading…"), .open) }
        if accounts.contains(where: { !$0.status.isEmpty }) { return (L("Error on an account"), .error) }
        if accounts.isEmpty { return (L("not connected"), .off) }
        return (accounts.count == 1 ? L("1 account connected") : L("{n} accounts connected", ["n": accounts.count]), .ok)
    }

    private var ngrokSituation: (text: String, tone: Tone) {
        guard let access else { return (L("Loading…"), .open) }
        if !access.error.isEmpty { return (L("Access error"), .error) }
        if !access.authtoken { return (L("not connected"), .off) }
        return (access.mode == .names ? L("own name per link") : L("dev address only"), .ok)
    }

    private func load() async {
        guard let client = session.client else { return }
        if let response: GitlabAccountsResponse = try? await client.get("/api/gitlab/accounts", timeout: 20) {
            accounts = response.accounts
        }
        do {
            let response: NgrokAccess = try await client.get("/api/integrations/ngrok", timeout: 20)
            access = response
            ngrokAvailable = true
        } catch let e as APIError where e.status == 404 {
            ngrokAvailable = false
        } catch {
            // Any other error leaves the row; its page shows the error itself on opening.
        }
    }
}

/// The "ngrok" page: the access and the preview links (`NgrokSettings` in NgrokSettings.swift).
struct NgrokSettingsView: View {
    var body: some View {
        CbList {
            NgrokSettings()
        }
        .navigationTitle(L("ngrok"))
        .navigationBarTitleDisplayMode(.inline)
    }
}
