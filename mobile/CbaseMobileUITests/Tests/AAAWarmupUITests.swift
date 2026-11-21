// Warm-up class, not a product test.
//
// Why it exists: in the first minutes after a simulator boots, the SOFTWARE keyboard does not
// appear — `app.keyboards.firstMatch` never shows up or has a frame outside the screen
// (hardware keyboard attached). Every keyboard test then fails on "too much air" or a missing
// keyboard through no fault of the product. The class is named AAA… so it runs alphabetically
// BEFORE all others; the full run also runs it up front ON ITS OWN
// (`-only-testing:CbaseMobileUITests/AAAWarmupUITests`, up to five minutes, with retries), so the first real keyboard test meets a keyboard that has been
// there once.
//
// It types NOTHING into the field: the composer draft is persistent (`cbase.mobile.draft:<chatId>`
// in UserDefaults), and a character here would show up as a stale draft in the next test. If it
// still finds text (a previous run left it), it clears it — cursor to the end, delete over everything.
import XCTest

final class AAAWarmupUITests: CbaseUITestBase {
    func testKeyboardAppears() throws {
        let server = try requireFixture()
        let app = launchApp(server: server)
        try openFirstChat(app)
        let composer = app.textViews["chat-composer"]
        XCTAssertTrue(composer.waitForExistence(timeout: 25), "The composer is missing")
        composer.tap()

        // Up to 60 s: the keyboard must APPEAR and lie INSIDE the screen. A frame outside
        // (or of height 0) is the hardware-keyboard trap — it does not count.
        let keyboard = app.keyboards.firstMatch
        let deadline = Date().addingTimeInterval(60)
        var frame = CGRect.zero
        var within = false
        while Date() < deadline {
            if keyboard.exists {
                frame = keyboard.frame
                within = frame.height > 100 && app.frame.contains(frame)
                if within { break }
            }
            Thread.sleep(forTimeInterval: 0.5)
        }
        if !within {
            attach(app, "Warm-up: keyboard missing or outside the screen")
        }
        XCTAssertTrue(
            within,
            keyboard.exists
                ? "The software keyboard lies outside the screen (\(frame) in \(app.frame)) — "
                    + "hardware keyboard attached or simulator not warm yet"
                : "The software keyboard did not appear within 60 s — simulator freshly booted?"
        )

        // Nothing typed — but a draft left over by a predecessor is cleared.
        for _ in 0..<3 where !((composer.value as? String) ?? "").isEmpty {
            composer.coordinate(withNormalizedOffset: CGVector(dx: 0.97, dy: 0.5)).tap()
            let existing = ((composer.value as? String) ?? "").count
            composer.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: existing + 2))
            Thread.sleep(forTimeInterval: 0.4)
        }
        XCTAssertTrue(
            ((composer.value as? String) ?? "").isEmpty,
            "The composer is not empty after warm-up: \(String(describing: composer.value))"
        )
        // Close the keyboard — without a promise: the next test restarts the app anyway, and a
        // red here would only mean the drag zone is missing, not that the keyboard is cold.

        slideInKeyboard(app)
        _ = keyboard.waitForNonExistence(timeout: 5)
    }
}
