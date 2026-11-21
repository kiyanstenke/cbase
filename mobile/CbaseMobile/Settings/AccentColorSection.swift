import SwiftUI

// ── Settings → Appearance → Accent colour ───────────────────────────────────────────────────
//
// As on the web (`web/src/components/settings/AccentColorSection.tsx`): eight presets, a custom colour via the system
// ColorPicker, "Reset" and a preview with the same building blocks as the app. Primary buttons and selected rows are
// NEUTRAL (`CbColor.primaryButton`, `CbColor.markiert`) — hint and preview therefore show only what the accent still
// colours: the send face of the composer island (with a white arrow), the run hexagon, a switch, a link and the tinted
// surface of running work. The computation lives in `Kit/AccentColor.swift`; it takes effect immediately, without a Save
// button.
//
// The swatches show the accent that actually applies in the CURRENT theme (in dark mode the derived lighter step) — what
// you tap is what you get.

struct AccentColorSection: View {
    @ObservedObject private var accent = AccentStore.shared
    @Environment(\.colorScheme) private var schema
    /// The switch preview needs a state; it has no effect anywhere.
    @State private var previewOn = true

    private func fieldColor(_ hex: String) -> Color {
        let w = AccentColor.values(hex)
        return Color(uiColor: AccentColor.uiColor(hex: schema == .dark ? w.dark : w.light))
    }

    private var current: String { accent.hex ?? AccentColor.standard }

    /// The ColorPicker works on the CHOSEN base tone, not on the derived step — otherwise the colour would drift a bit
    /// lighter on every opening in dark mode.
    private var ownColor: Binding<Color> {
        Binding(
            get: { Color(uiColor: AccentColor.uiColor(hex: current)) },
            set: { fresh in
                if let hex = AccentColor.hex(from: fresh) { accent.set(hex) }
            }
        )
    }

    var body: some View {
        CbSettingGroup(
            title: L("Accent color"),
            hint: L("Colors the send button, switches, links, progress indicators and highlights — on this device only. Buttons and selected rows stay neutral. The dark theme uses a lighter shade, the light theme a deeper one where needed, so the white glyph on the send button stays readable."),
            // In full, not cut off after three lines (seen on device: "… In the dark theme appl…") — only the sentence
            // about the dark step explains why the swatches here are lighter than the choice.
            hintWhole: true
        ) {
            // The presets: one equal-width column per swatch — one row on every phone width.
            HStack(spacing: 0) {
                ForEach(AccentColor.defaults, id: \.hex) { preset in
                    let on = preset.hex == current
                    Button {
                        accent.set(preset.hex)
                    } label: {
                        Circle()
                            .fill(fieldColor(preset.hex))
                            .frame(width: 28, height: 28)
                            .overlay {
                                if on {
                                    Image(systemName: "checkmark")
                                        .font(.symbol(12, weight: .bold))
                                        .foregroundStyle(.white)
                                }
                            }
                            // Chosen: ring in text colour — an accent edge would be invisible on the accent.
                            .overlay(Circle().stroke(Color.primary, lineWidth: 2).padding(-4).opacity(on ? 1 : 0))
                            .frame(maxWidth: .infinity, minHeight: 40)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(L(preset.label))
                    .accessibilityAddTraits(on ? .isSelected : [])
                    .accessibilityIdentifier("settings-accent-\(preset.hex.dropFirst())")
                }
            }

            ColorPicker(selection: ownColor, supportsOpacity: false) {
                HStack {
                    Text(L("Custom color"))
                        .font(.subheadline.weight(.medium))
                    Spacer(minLength: 8)
                    Text(current)
                        .font(.footnote.monospaced())
                        .foregroundStyle(.secondary)
                }
            }
            .accessibilityIdentifier("settings-accent-own")

            // The SAME shapes as the app, no replica with its own computation — and only those that actually carry the
            // accent (a filled capsule and a tinted selection chip are gone since the colour theme change).
            CbPreview {
                VStack(alignment: .leading, spacing: 10) {
                    HStack(spacing: 14) {
                        // The send face of the composer island at rest (`SendStopFace`): the hexagon flat in the accent,
                        // the arrow white — hence the computation clamps the light accent.
                        ZStack {
                            MorphingHexStop(morph: 0)
                                .fill(Color.accentColor)
                            Image(systemName: "arrow.up")
                                .font(.symbol(15, weight: .bold))
                                .foregroundStyle(.white)
                        }
                        .frame(width: 37, height: 41)
                        // The run indicator in the history: the hexagon in the accent before "Running".
                        HStack(spacing: ChatRowSymbol.gap) {
                            RowsHexagon()
                                .foregroundStyle(Color.accentColor)
                                .frame(width: 15, height: 15)
                            Text(L("Running"))
                                .cbFont(14)
                                .foregroundStyle(CbColor.textMuted)
                        }
                        Spacer(minLength: 0)
                        Toggle(L("Accent color"), isOn: $previewOn)
                            .labelsHidden()
                    }
                    Text(L("A link in the text"))
                        .cbFont(15)
                        .foregroundStyle(Color.accentColor)
                        .underline()
                    // The tinted surface like `CbPane(accent: true)`: accent 9 %, edge accent 35 %.
                    Text(L("A highlighted surface — this is how running work and open proposals appear."))
                        .cbFont(13)
                        .padding(10)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(Color.accentColor.opacity(0.09), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                        .overlay(
                            RoundedRectangle(cornerRadius: 10, style: .continuous)
                                .strokeBorder(Color.accentColor.opacity(0.35))
                        )
                }
                .accessibilityElement(children: .ignore)
                .accessibilityLabel(L("Preview"))
            }

            Button(L("Reset")) {
                accent.set(nil)
            }
            .disabled(accent.hex == nil)
            .accessibilityIdentifier("settings-accent-reset")
        }
    }
}
