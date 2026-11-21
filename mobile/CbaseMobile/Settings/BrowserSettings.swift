import SwiftUI

// ── Browser ─────────────────────────────────────────────────────────────────
//
// The page carries TWO browsers because there are two (counterpart to `web/src/components/settings/BrowserSettings.tsx`):
//
//  • the AGENTS' — Playwright in the server environment, which the agent drives for pages and e2e tests. Nothing about
//    it is adjustable any more: it always runs headless.
//  • YOURS — the browser tab of this app. NOTHING about the second is adjustable, and that is not a gap: whether native or
//    streamed is decided by the client; the session profiles arise per area by themselves; the cbase client sets up the
//    port forwarding. That is why it appears here as a STATE — a badge, not a switch. A switch that switches nothing is
//    worse than no display.
//
// ── Why the badges are named differently here than on the web ───────────────
//
// On the web "Native in the client" and "Streamed via the server" are TWO STATES OF THE SAME surface: the same page runs
// natively in the cbase client and streamed in Chrome, and `nativeAvailable` measures at runtime which of them applies.
// Exactly one badge stands there.
//
// On the iPhone there is nothing to measure: `BrowserPane` is a screencast from the server environment, always — an app
// never runs "in the client". Taking the web badge literally would mean either showing information that never applies
// here, or omitting it and leaving the user believing the streamed picture is a deficiency. So TWO badges stand side by
// side here, and the PLACE is in the text of the second ("Native in the cbase client" rather than "Native in the
// client"): filled is what applies to this device, outlined next to it the information about another one. Without the
// place in the wording the outlined badge would read as "you could have had this here too" — but on a phone it is
// unreachable, and a badge that offers an unreachable state is a lie.

/// A state as a capsule — the same statement as the badge on the web: it does not look like a button, so nobody taps it and
/// wonders why nothing happens.
private struct StateMarker: View {
    let text: String
    var active = false

    var body: some View {
        Text(text)
            .cbFont(11, weight: .medium)
            .lineLimit(1)
            .padding(.horizontal, 9)
            .padding(.vertical, 3)
            .background {
                if active {
                    Capsule().fill(Color.accentColor.opacity(0.14))
                } else {
                    Capsule().stroke(Color.secondary.opacity(0.3), lineWidth: 1)
                }
            }
            .foregroundStyle(active ? Color.accentColor : .secondary)
    }
}

struct BrowserSettingsView: View {

    var body: some View {
        CbList {
            CbSettingGroup(
                title: L("The agents' browser"),
                hint: L("Controls the built-in browser (Playwright) the agent uses to open web pages and run end-to-end tests. In the background everything runs invisibly — no window opens.")
            ) {
                // The agents' browser ALWAYS runs headless (toolchain/playwright.js) — the "Browser in the background"
                // switch and the per-chat choice are gone.
                CbSettingRow(
                    title: L("Always in the background (headless)"),
                    hint: L("No window ever opens. If you need to log in somewhere, open the agent's browser under Coding → Browser and take over there — the profile is kept, and the login also applies to later runs.")
                )
            }

            CbSettingGroup(
                title: L("Your browser"),
                hint: L("The browser in the “Browser” tab and in the chat's right-hand sidebar — yours, not the agent's.")
            ) {
                // The two badges stand BELOW the row, not to the right of it (on the web that is the row property `wide`):
                // side by side they would take about half the row at phone width, and the hint — which carries the whole
                // explanation here — would be left as a three-line stub.
                VStack(alignment: .leading, spacing: 7) {
                    CbSettingRow(
                        title: L("How it is drawn"),
                        hint: L("In the cbase client the window draws the page itself, with no picture going over the wire. Otherwise it arrives as a stream from the server environment. The client version decides this, not a setting.")
                    )
                    HStack(spacing: 5) {
                        // Filled: THIS device's drawing path. It used to be outlined like the dead half of a pair — the
                        // only badge on the page that really applies was the quietest.
                        StateMarker(text: L("Streamed via the server"), active: true)
                            .accessibilityIdentifier("browser-draw-path")
                        StateMarker(text: L("Native in the cbase client"))
                            .accessibilityIdentifier("browser-draw-path-client")
                        Spacer(minLength: 0)
                    }
                }

                CbSettingRow(
                    title: L("Session profiles"),
                    hint: L("One profile per project and per workspace: sign-ins, cookies and the open tabs survive a restart and apply only inside their scope. A chat uses the profile of its project or of its workspace.")
                ) {
                    // Two badges side by side fit at phone width only if the text next to them may shrink — hence no fixed
                    // width, only the stack.
                    HStack(spacing: 5) {
                        StateMarker(text: L("Per project"))
                        StateMarker(text: L("Per workspace"))
                    }
                }

                // There is NO list of active forwardings here, and that is measured, not omitted: the forwardings live as a
                // map in the client's main process (`client/main.js`), the web page fetches them via the Electron bridge
                // `window.cbaseClient.ports`. The server does not know them — per connection it sees only a WebSocket on
                // `/api/tunnel` and keeps no directory of them; the four `/api/ports*` routes deliver the SCANNED and
                // running services of the server environment, which is something else. Under this heading they would be a
                // mislabelling. Without a route and without a bridge a phone cannot ask for the list, and an invented route
                // would be worse than the gap.
                //
                // The hint stays word for word the same as the web's, although "on this device" in it means the COMPUTER and
                // not the phone: the place is set by the row on the right, and a 200-character sentence that would appear
                // twice in the dictionary because of one pronoun would drift apart at the next rework.
                CbSettingRow(
                    title: L("Automatic port forwarding"),
                    hint: L("When a page calls a localhost port that only the server environment has, the client binds it on this device — without asking. If another program is already listening on that port here, it asks instead of quietly redirecting it.")
                ) {
                    Text(L("Only in the cbase client."))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.trailing)
                        .accessibilityIdentifier("browser-ports")
                }
            }
        }
        .navigationTitle(L("Browser"))
        .navigationBarTitleDisplayMode(.inline)
    }
}
