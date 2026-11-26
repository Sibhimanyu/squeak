import Foundation
import Testing
@testable import SqueakMacCore

@Suite struct CopyFeedbackTests {
    @Test func copiedShowsForAMomentThenReturnsToTheLabel() {
        var c = CopyFeedback()
        let t = Date(timeIntervalSince1970: 1000)
        #expect(c.label("Copy", now: t) == "Copy")
        c.copied(at: t)
        #expect(c.label("Copy", now: t.addingTimeInterval(1)) == "Copied \u{2713}")
        #expect(c.label("Copy", now: t.addingTimeInterval(CopyFeedback.holdFor + 0.1)) == "Copy")
    }
}
