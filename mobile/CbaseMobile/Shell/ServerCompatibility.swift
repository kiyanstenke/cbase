import SwiftUI

// The two answers of the app to a server whose API range does not match its own (Models/ApiContract.swift):
// - `NeedsNewerAppView`: the server no longer speaks this app's level. Blocking — instead of the sign-in, RootView shows only
//   this (phase `.needsNewerApp`), with the way to the App Store and the way to another server.
// - `OlderServerNotice`: the server is older than the app. A banner at the top of the shell, dismissible, once per server and
//   server build (`SessionStore.olderServerNoticeDue`/`dismissOlderServerNotice`).
// A server without an `api` field counts as level 1 and gets neither.

struct NeedsNewerAppView: View {
    @EnvironmentObject private var session: SessionStore
    @Environment(\.openURL) private var openURL

    var body: some View {
        VStack(spacing: 18) {
            Spacer()
            Image(systemName: "arrow.down.app")
                .font(.symbol(52, weight: .regular))
                .foregroundStyle(.tint)
                .accessibilityHidden(true)
            Text(L("This server needs a newer app"))
                .font(.title2.weight(.semibold))
                .multilineTextAlignment(.center)
                .accessibilityIdentifier("needs-newer-app-title")
            Text(L("The server at {address} no longer supports this version of cbase. Update cbase from the App Store, then connect again."
                   , ["address": session.serverAddress]))
                .font(.body)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .accessibilityIdentifier("needs-newer-app-text")
            Spacer()
            Button {
                if let url = URL(string: ApiContract.storeAddress) { openURL(url) }
            } label: {
                Label(L("Open the App Store"), systemImage: "arrow.up.right")
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.large)
            .accessibilityIdentifier("needs-newer-app-store")
            Button(L("Different server address")) {
                session.prepareServerChange()
            }
            .accessibilityIdentifier("needs-newer-app-other-server")
        }
        .padding(.horizontal, 28)
        .padding(.bottom, 24)
        .frame(maxWidth: 520)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(CbColor.ground)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("needs-newer-app")
    }
}

struct OlderServerNotice: View {
    let onDismiss: () -> Void

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: "info.circle")
                .foregroundStyle(CbColor.textMuted)
                .accessibilityHidden(true)
            Text(L("This server runs an older cbase; some features may be unavailable."))
                .cbFont(14)
                .foregroundStyle(CbColor.text)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityIdentifier("older-server-notice-text")
            Spacer(minLength: 0)
            Button(action: onDismiss) {
                Image(systemName: "xmark")
                    .font(.symbol(13))
                    .foregroundStyle(CbColor.textMuted)
                    .frame(width: 28, height: 28)
                    .contentShape(Rectangle())
            }
            .accessibilityLabel(L("Close"))
            .accessibilityIdentifier("older-server-notice-dismiss")
        }
        .padding(.leading, 14)
        .padding(.trailing, 6)
        .padding(.vertical, 8)
        .background(.cbSurface, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous).strokeBorder(CbColor.edge))
        .shadow(color: .black.opacity(0.18), radius: 12, y: 4)
        .frame(maxWidth: 520)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("older-server-notice")
    }
}
