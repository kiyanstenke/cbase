import SwiftUI

// Overview of the Coding tab: tapping "Coding" (top of the right drawer) lands here, with the categories in two
// sections, one row each with sign, name and a short clause.
//
// No cards: the row language from `Kit/CbRows.swift` — rows straight on the page ground, sign in a round
// circle, pressed state in `CbColor.markiert`, a quiet section header, no chevron.
//
// The split matches the drawer and the desktop tab row: before the divider what the agents work with (chats,
// agents, skills, workflows, projects, MCP, context, credentials), after it the tools (code, terminal, browser).
// Reordering means changing `WorkspaceCategory`, not this view.
struct CodingOverview: View {
    @EnvironmentObject private var state: AppState

    var body: some View {
        PaneScaffold(
            // The title is the tab's name (the overview IS the tab). The subtitle names the scope
            // (workspace or entered project): the list differs by it ("Projects" exists only in the
            // workspace, not inside an entered project).
            title: L("Coding"),
            subtitle: state.scopeName
        ) {
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    section(L("Work and setup"), state.categories.filter { !$0.isTool })
                    section(L("Tools"), state.categories.filter(\.isTool))
                        .padding(.top, 18)
                }
                .padding(.horizontal, 8)
                .padding(.top, 2)
                .padding(.bottom, 24)
            }
            .cbRefreshable { await state.reloadOverview() }
        }
    }

    private func section(_ title: String, _ categories: [WorkspaceCategory]) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            CbSectionHeader(title: title)
            VStack(spacing: 2) {
                ForEach(categories, id: \.id) { category in
                    categoryRow(category)
                }
            }
        }
    }

    // No count: a count belongs on the target page anyway.
    private func categoryRow(_ category: WorkspaceCategory) -> some View {
        Button {
            state.openCoding(category)
        } label: {
            CbListRow(
                character: CbSign(symbol: state.categorySymbol(category)),
                title: L(state.categoryTitle(category)),
                shortLine: Text(L(state.categoryClause(category))),
                // A whole clause (up to 50 characters) would be cut off on one line on the iPhone.
                shortLineRows: 2
            )
        }
        .cbRowPress()
        // Identifier on the BUTTON, not the stack — on the container it propagated to every child.
        .accessibilityIdentifier("coding-overview-\(category.rawValue)")
    }
}
