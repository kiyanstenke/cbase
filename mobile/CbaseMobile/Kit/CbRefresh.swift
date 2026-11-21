import SwiftUI

// ── Pull to refresh that survives its cancellation ──────────────────────────────────────────────────────────────────────
//
// SwiftUI cancels the task of `.refreshable` ~10–40 ms after its start as soon as the work changes an observed property and the
// view with the modifier is redrawn — in the git sheet, `loading = true` at the start of `GitModel.load()`. The running request
// then ends with `URLError(.cancelled)`, `APIClient.abortAsCancellation` turns that into `CancellationError`, and its
// `localizedDescription` is "The operation couldn't be completed. (Swift.CancellationError error 1.)". Counter-proof: the same
// refresh WITHOUT a state change (`load(quiet: true)`) never ran into the cancellation. Work that knows only `try?` silently
// refreshed nothing after the cancellation.
//
// `cbRefreshable` therefore runs the work in its OWN task and waits for it: the cancellation of the `.refreshable` task does not
// reach it (an unstructured `Task` inherits no cancellation), the spinner stays until it is done, and the answer lands. EVERY pull
// to refresh in the app goes through this — `web/test/refresh-ios.test.mjs` guards it (a bare `.refreshable` in app code is red).
// A cancellation for another reason (the view disappears mid-load) must still be caught where the error is shown: `catch is
// CancellationError` is no error.
extension View {
    /// `.refreshable` whose work is not cancelled with the pull-to-refresh task (see above).
    func cbRefreshable(_ work: @escaping @MainActor () async -> Void) -> some View {
        refreshable { await Task { @MainActor in await work() }.value }
    }
}
