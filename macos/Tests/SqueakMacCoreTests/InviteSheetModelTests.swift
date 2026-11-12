import Foundation
import Testing

@testable import SqueakMacCore

@Suite struct InviteSheetModelTests {
    private func invite() -> PondInvite {
        try! JSONDecoder().decode(PondInvite.self, from: Data(#"{"code":"squeak-pond:abc","link":"https://x.test/app/index.html#squeak-pond:abc"}"#.utf8))
    }

    @Test func stepsGoChooseThenReady() {
        var s = InviteSheetState()
        #expect(s.step == .choose && s.canCreate)
        s.startCreating()
        #expect(!s.canCreate)
        s.created(invite())
        #expect(s.step == .ready && !s.creating)
        #expect(s.shareText.hasPrefix("https://"))
    }

    @Test func failureStaysAndKeepsTheSentence() {
        var s = InviteSheetState()
        s.startCreating(); s.failed("Set up a cloud store first.")
        #expect(s.step == .choose && s.error == "Set up a cloud store first." && s.canCreate)
        s.startCreating(); #expect(s.error == nil)
        s.failed(nil); #expect(s.error == "That didn't go through")
    }

    @Test func arrowsSwitchAndStopAtEnds() {
        var s = InviteSheetState()
        s.move(-1); #expect(s.role == .member)
        s.move(1); #expect(s.role == .viewer)
        s.move(1); #expect(s.role == .viewer)
        s.move(-1); #expect(s.role == .member)
    }

    @Test func copiedLastsOnePointFiveSeconds() {
        var c = CopyFeedback()
        let t = Date(timeIntervalSince1970: 1000)
        #expect(c.label("Copy", now: t) == "Copy")
        c.copied(at: t)
        #expect(c.label("Copy", now: t.addingTimeInterval(1.4)) == "Copied \u{2713}")
        #expect(c.label("Copy", now: t.addingTimeInterval(1.5)) == "Copy")
    }

    @Test func expiryUsesTheRealLifetime() {
        #expect(InviteSheetText.expiryNote() == "Invites expire after 1 day.")
        #expect(InviteSheetText.expiryNote(lifetime: 72 * 3600) == "Invites expire after 3 days.")
        #expect(InviteSheetText.expiryNote(lifetime: 6 * 3600) == "Invites expire after 6 hours.")
    }
}
