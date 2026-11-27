import XCTest

/// P1's proof (docs/ios-plan.md): the app starts, syncs with a server started by the CI
/// job, shows the tasks another replica put there, and what is typed on the phone goes
/// back (the job checks the server afterwards). Screenshots are kept as attachments.
final class WalkingSkeletonTests: XCTestCase {
    @MainActor
    func testSyncsWithTheServerAndAddsATask() {
        let app = XCUIApplication()
        app.launchEnvironment["TM_UI_TEST"] = "1"
        app.launchEnvironment["TM_SERVER_URL"] = "http://127.0.0.1:8787"
        app.launch()

        // The app opens on Today; the server's captures are in the Inbox.
        let tabs = app.tabBars.firstMatch
        tabs.buttons["Inbox"].tap()
        XCTAssertTrue(
            app.staticTexts["Seeded on the server"].waitForExistence(timeout: 60),
            "the server's tasks never arrived")
        XCTAssertTrue(app.staticTexts["Water the plants"].exists)
        shot("01-inbox")

        // Capture is the bar over the tab bar; it opens the composer, which stays open
        // for the next line.
        app.buttons["captureBar"].tap()
        let field = app.textFields["captureField"]
        XCTAssertTrue(field.waitForExistence(timeout: 5))
        field.typeText("Written on the phone !high\n")
        XCTAssertTrue(app.descendants(matching: .any)["addedNote"].waitForExistence(timeout: 10))
        shot("02-composer")
        // A tap above the sheet closes it.
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.15)).tap()
        XCTAssertTrue(app.staticTexts["Written on the phone"].waitForExistence(timeout: 10))
        shot("03-task-added")

        tabs.buttons["Today"].tap()
        XCTAssertTrue(app.staticTexts["Water the plants"].waitForExistence(timeout: 10))
        XCTAssertFalse(app.staticTexts["Seeded on the server"].exists)
        shot("04-today")

        app.buttons["syncButton"].tap()
        // A labelled row reads as one element ("State, Up to date").
        let upToDate = app.descendants(matching: .any)
            .matching(NSPredicate(format: "label CONTAINS 'Up to date'")).firstMatch
        XCTAssertTrue(upToDate.waitForExistence(timeout: 30))
        shot("05-sync")
    }

    @MainActor
    private func shot(_ name: String) {
        let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
