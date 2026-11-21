import SwiftUI

/// The slash picker above the input field.
///
/// When someone types a slash at the start of the input, a list of two kinds slides up over the field: the slash
/// commands of this chat and the skills that are effective for it (in the coding chat the graph workflows too, as
/// `/workflow:<short name>`). Every row carries its description RIGHT WITH IT, unlike the web where it sits in a second
/// column. On the phone there is no width for a second column, and a floating tooltip has no trigger on a touch
/// device: there is no pointer that rests over a row without tapping it.
///
/// The panel deliberately has the same build as the composer's action panel (`composerActions`): the same surface,
/// rounded on top, sliding out through an `AnimatedHeightMask`. A `.overlay` or `.popover` outside the composer tree
/// would be wrong: the composer is a `UIHostingController` with `sizingOptions = .intrinsicContentSize`, and whatever
/// lies outside is clipped by the hosting frame.
struct SlashPicker: View {
    let commands: [ChatViewModel.SlashCommand]
    let skills: [SkillSummary]
    /// The third group: the graph workflows as `/workflow:<short name>`; only the coding chat supplies any; the graph node's
    /// command field leaves the default in place.
    var workflows: [WorkflowSummary] = []
    /// Prefix of the accessibility identifiers (in the coding chat "chat").
    let prefix: String
    let onChoice: (String) -> Void

    /// Height of the scroll area. Just under three rows: more would hide the history, less would make the list look like a
    /// remnant. It scrolls anyway.
    private static let maxHeight: CGFloat = 216

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 0) {
                if commands.isEmpty && skills.isEmpty && workflows.isEmpty {
                    // An empty box would look like a load error. After a typo it should say that a search
                    // happened and found nothing.
                    Text(L("No command and no skill matches."))
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .padding(.horizontal, 14)
                        .padding(.vertical, 12)
                }
                if !commands.isEmpty {
                    group(L("Commands"))
                    ForEach(commands) { b in
                        row(name: b.name, arg: b.arg, description: b.description, origin: nil)
                        if b.id != commands.last?.id { separator }
                    }
                }
                if !skills.isEmpty {
                    if !commands.isEmpty { separator }
                    group(L("Skills"))
                    ForEach(skills) { s in
                        row(
                            name: s.name,
                            arg: "",
                            // A skill WITHOUT a description is possible (the field may be empty);
                            // then the row says what is true instead of an empty line.
                            description: (s.description?.isEmpty == false ? s.description! : L("This skill has no description.")),
                            origin: s.originProject
                        )
                        if s.id != skills.last?.id { separator }
                    }
                }
                if !workflows.isEmpty {
                    if !commands.isEmpty || !skills.isEmpty { separator }
                    group(L("Workflows"))
                    ForEach(workflows) { w in
                        // `workflow:<short name>` is inserted; on the right is the REAL name (with project): the
                        // short name alone does not say which of two same-named ones is meant ("job-ship-2").
                        row(
                            name: w.slashName,
                            arg: "",
                            description: w.description.isEmpty ? L("This workflow has no description.") : w.description,
                            origin: w.originProject.map { "\(w.name) · \($0)" } ?? w.name,
                            identifier: w.slashName.replacingOccurrences(of: ":", with: "-")
                        )
                        if w.id != workflows.last?.id { separator }
                    }
                }
            }
        }
        .frame(maxHeight: Self.maxHeight)
        // One step above the island (`CbColor.elevated` on its `surface`): the input field itself carries no background of its
        // own anymore, the picker still stands out from the island.
        // Translucent on glass (`CbGlass.inside`): an opaque panel would sit as a blot in the island.
        // Rounded all around like the action panel below.
        .background(
            CbGlass.inside,
            in: RoundedRectangle(cornerRadius: 18, style: .continuous)
        )
        .padding(.horizontal, 10)
        // `children: .contain` is mandatory: an identifier on the container otherwise REPLACES those of the
        // rows inside; all would be called "…-slash-picker".
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("\(prefix)-slash-picker")
    }

    private var separator: some View { Divider().padding(.leading, 14) }

    private func group(_ title: String) -> some View {
        Text(title)
            .font(.caption2.weight(.semibold))
            .textCase(.uppercase)
            .foregroundStyle(.secondary)
            .padding(.horizontal, 14)
            .padding(.top, 10)
            .padding(.bottom, 4)
            .frame(maxWidth: .infinity, alignment: .leading)
    }

    /// `identifier`: the part of the accessibility identifier after "…-slash-"; by default the name; a workflow carries
    /// "workflow-<short name>" so a same-named skill does not hide it.
    private func row(name: String, arg: String, description: String, origin: String?, identifier: String? = nil) -> some View {
        Button {
            onChoice(name)
        } label: {
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    Text("/\(name)")
                        .cbFont(15, design: .monospaced)
                        .foregroundStyle(Color.primary)
                    if !arg.isEmpty {
                        Text(arg)
                            .cbFont(13, design: .monospaced)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }
                    Spacer(minLength: 0)
                    if let origin, !origin.isEmpty {
                        Text(origin)
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }
                }
                // Clamped: a skill's description has no length limit anywhere. A frontmatter paragraph
                // of 900 characters would otherwise push every further row out of the panel; the picker
                // should support the choice, not show the file.
                Text(description)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
                    .multilineTextAlignment(.leading)
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 9)
            .frame(maxWidth: .infinity, alignment: .leading)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        // Identifier on the BUTTON, not on the stack above (see above).
        .accessibilityIdentifier("\(prefix)-slash-\(identifier ?? name)")
    }
}
