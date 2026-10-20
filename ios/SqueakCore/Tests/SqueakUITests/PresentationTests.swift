import SqueakCore
import XCTest
@testable import SqueakUI

final class PresentationTests: XCTestCase {
    private func session(state: String, steps: [String] = [], label: String = "storefront · payment-retries", title: String? = "Payment retry logic") -> PhoneSnapshot.Session {
        .init(key: "k", conductorSessionId: "id", label: label, agent: "claude", state: state, lastActivityAt: "2026-10-19T10:00:00Z",
              detail: nil, git: nil, contextPercent: nil, turnId: "t", message: nil, choices: nil,
              activity: steps.isEmpty ? nil : .init(total: steps.count, steps: steps.map { .init(kind: "tool", text: $0) }),
              title: title)
    }

    func testFirstLineIsThePreviewOfAMessage() {
        XCTAssertEqual(Presentation.firstLine("\n## **Done.** Tests pass\nMore"), "Done. Tests pass")
        XCTAssertEqual(Presentation.firstLine("- `npm test` is green"), "npm test is green")
        XCTAssertNil(Presentation.firstLine("  \n\n"))
        XCTAssertNil(Presentation.firstLine(nil))
    }

    #if os(iOS) // Connection lives in iOS-only HomeView.swift; `swift test` also runs on the Mac.
    func testTheConnectionBarOnlyShowsWhenSomethingIsWrong() {
        let now = Date()
        let json = #"{"v":1,"mac":"Mac","generatedAt":"2026-10-19T08:00:00Z","duck":{"blockedCount":0,"workingCount":0},"sessions":[]}"#
        let snapshot = try! JSONDecoder().decode(PhoneSnapshot.self, from: Data(json.utf8))
        XCTAssertTrue(Connection.read(snapshot: snapshot, problem: nil, demo: false, lastFetch: now.addingTimeInterval(-10), now: now).healthy)
        XCTAssertFalse(Connection.read(snapshot: snapshot, problem: nil, demo: false, lastFetch: now.addingTimeInterval(-120), now: now).healthy)
        XCTAssertFalse(Connection.read(snapshot: snapshot, problem: "down", demo: false, lastFetch: now, now: now).healthy)
        XCTAssertFalse(Connection.read(snapshot: nil, problem: nil, demo: false, now: now).healthy)
    }

    func testAnAsleepMacIsNotShownAsConnectedThoughTheServerAnswers() {
        // Heresay r_iGq-9fy2nmPGmsfv: the lid shut, the Mac slept, and the phone kept saying "Synced just now".
        let now = Date()
        let json = #"{"v":1,"mac":"Mac","generatedAt":"2026-10-19T08:00:00Z","duck":{"blockedCount":0,"workingCount":0},"sessions":[]}"#
        let snapshot = try! JSONDecoder().decode(PhoneSnapshot.self, from: Data(json.utf8))
        let asleep = Connection.read(snapshot: snapshot, problem: nil, demo: false, lastFetch: now,
                                     mac: .silent(since: now.addingTimeInterval(-37 * 60)), now: now)
        XCTAssertFalse(asleep.healthy)
        XCTAssertEqual(asleep.text, "Mac not answering, maybe asleep · last heard 37m ago")
        XCTAssertTrue(Connection.read(snapshot: snapshot, problem: nil, demo: false, lastFetch: now, mac: .answering, now: now).healthy)
        XCTAssertTrue(Connection.read(snapshot: snapshot, problem: nil, demo: false, lastFetch: now, mac: .checking, now: now).healthy)
        XCTAssertTrue(Connection.read(snapshot: snapshot, problem: nil, demo: false, lastFetch: now, mac: .unknown, now: now).healthy)
    }
    #endif

    func testHeaderLinesNeverRepeat() {
        // A chat with no diff once crashed the app: two identical candidates in a ViewThatFits.
        XCTAssertEqual(Presentation.headerLines(state: "idle · 3h", subtitle: "storefront · Claude", git: nil),
                       ["idle · 3h · storefront · Claude", "idle · 3h"])
        XCTAssertEqual(Presentation.headerLines(state: "idle · 3h", subtitle: "", git: nil), ["idle · 3h"])
        XCTAssertEqual(Presentation.headerLines(state: "working · 1m", subtitle: "atlas · Codex", git: "+3 −1"),
                       ["working · 1m · atlas · Codex · +3 −1", "working · 1m · atlas · Codex", "working · 1m"])
    }

    func testLabelSplitsIntoRepoAndTitle() {
        XCTAssertEqual(Presentation.split(label: "storefront · Payment retry logic").repo, "storefront")
        XCTAssertEqual(Presentation.split(label: "orchard").title, "orchard")
        XCTAssertEqual(Presentation.readable("irrigation-pull-to-refresh"), "Irrigation pull to refresh")
        XCTAssertEqual(Presentation.readable("fix/foo-bar"), "fix/foo-bar")
        XCTAssertEqual(Presentation.subtitle(session(state: "idle")), "storefront · Claude")
    }

    func testHeadlineIsTheChatTitleElseRepoBranch() {
        XCTAssertEqual(Presentation.displayTitle(session(state: "idle")), "Payment retry logic")
        XCTAssertEqual(Presentation.displayTitle(session(state: "idle", title: nil)), "storefront · payment-retries")
        XCTAssertEqual(Presentation.displayTitle(session(state: "idle", title: "Untitled")), "storefront · payment-retries")
        // A Mac that only sends the disambiguated label still gives the title.
        XCTAssertEqual(Presentation.displayTitle(session(state: "idle", label: "storefront · payment-retries (Retry logic)", title: nil)), "Retry logic")
        XCTAssertEqual(Presentation.repoBranch(session(state: "idle", label: "storefront · payment-retries (Retry logic)")), "storefront · payment-retries")
    }

    func testStatusUsesDesignVocabulary() {
        XCTAssertEqual(Presentation.status(session(state: "awaiting_input")), .init(text: "needs an answer", tone: .needsYou))
        XCTAssertEqual(Presentation.status(session(state: "awaiting_approval")).text, "needs approval")
        XCTAssertEqual(Presentation.status(session(state: "working")).text, "working")
        XCTAssertEqual(Presentation.status(session(state: "working", steps: ["Read a.ts", "Run npm test -- x"])).text, "running tests")
        XCTAssertEqual(Presentation.status(session(state: "working", steps: ["Edit a.ts", "Edit b.ts"])).text, "editing 2 files")
        XCTAssertEqual(Presentation.status(session(state: "working", steps: ["Mystery tool"])).text, "working")
        XCTAssertEqual(Presentation.status(session(state: "finished")).text, "done")
    }

    func testOptionSplit() {
        XCTAssertEqual(Presentation.splitOption("Retry automatically — 3 attempts").detail, "3 attempts")
        XCTAssertEqual(Presentation.splitOption("Do it: carefully").title, "Do it")
        XCTAssertEqual(Presentation.splitOption("Arm it. Restart the add-on.").detail, "Restart the add-on.")
        XCTAssertNil(Presentation.splitOption("Leave it off").detail)
    }

    func testMessageReadingTakesOptionsOutOfProse() {
        let choices = PhoneSnapshot.Choices(question: "How should failures be retried?",
            options: [.init(letter: "A", title: "Retry"), .init(letter: "B", title: "Customer retries")], recommended: "A")
        let message = "I added a check.\n\n**How should failures be retried?**\n\n**A) Retry.** Three attempts.\n\n**B) Customer retries.** Keep checkout.\n\nBoth are safe."
        let reading = Presentation.read(message: message, choices: choices)
        XCTAssertEqual(reading.before, ["I added a check."])
        XCTAssertEqual(reading.after, ["Both are safe."])
        XCTAssertEqual(reading.details["A"], "Three attempts.")
    }

    func testReplyBlock() {
        XCTAssertNotNil(Presentation.replyBlock(session(state: "awaiting_input")))
        XCTAssertNil(Presentation.replyBlock(session(state: "finished")))
    }

    func testAges() {
        let now = ISO8601DateFormatter().date(from: "2026-10-19T10:05:00Z")!
        XCTAssertEqual(Age.describe("2026-10-19T10:00:00Z", now: now), "5m")
        XCTAssertEqual(Age.spoken("2026-10-19T10:00:00Z", now: now), "5 minutes ago")
        let fetched = now.addingTimeInterval(-12)
        XCTAssertEqual(Age.sync(fetched, now: now), "12s ago")
        XCTAssertEqual(Age.sync(now.addingTimeInterval(-2), now: now), "just now")
        XCTAssertEqual(Age.sync(now.addingTimeInterval(-190), now: now), "3m ago")
    }
}
