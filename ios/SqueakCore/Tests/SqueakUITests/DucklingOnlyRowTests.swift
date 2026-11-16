import SqueakCore
import XCTest
@testable import SqueakUI

/// A chat that works only through its ducklings (Claude waits on one, or its turn ended) is not shown as "Working".
final class DucklingOnlyRowTests: XCTestCase {
    private func chat(state: String, backgroundOnly: Bool?) -> PhoneSnapshot.Session {
        var s = PhoneSnapshot.Session(key: "k", conductorSessionId: "k", label: "a · b", agent: "claude", state: state,
                                      lastActivityAt: "2026-11-16T10:00:00Z", detail: nil, git: nil, contextPercent: nil, turnId: "t",
                                      message: nil, choices: nil, title: "k", question: nil)
        s.backgroundOnly = backgroundOnly
        s.ducklings = .init(running: 1, items: [])
        return s
    }

    func testTheRowSaysDucklingsWorkingNotWorking() {
        let s = chat(state: "working", backgroundOnly: true)
        XCTAssertEqual(Presentation.status(s).text, "1 duckling working")
        XCTAssertEqual(Presentation.status(s).tone, .idle)
    }

    func testWithoutTheFlagAWorkingChatStaysWorking() {
        XCTAssertNotEqual(Presentation.status(chat(state: "working", backgroundOnly: nil)).text, "1 duckling working")
    }
}
