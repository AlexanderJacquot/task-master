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

        XCTAssertTrue(
            app.staticTexts["Seeded on the server"].waitForExistence(timeout: 60),
            "the server's tasks never arrived")
        XCTAssertTrue(app.staticTexts["Water the plants"].exists)
        shot("01-inbox")

        let field = app.textFields["captureField"]
        field.tap()
        field.typeText("Written on the phone !high\n")
        XCTAssertTrue(app.staticTexts["Written on the phone"].waitForExistence(timeout: 10))
        shot("02-task-added")

        app.buttons["Today"].tap()
        XCTAssertTrue(app.staticTexts["Water the plants"].waitForExistence(timeout: 10))
        XCTAssertFalse(app.staticTexts["Seeded on the server"].exists)
        shot("03-today")

        app.buttons["syncButton"].tap()
        XCTAssertTrue(app.staticTexts["Up to date"].waitForExistence(timeout: 30))
        shot("04-sync")
    }

    @MainActor
    private func shot(_ name: String) {
        let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
