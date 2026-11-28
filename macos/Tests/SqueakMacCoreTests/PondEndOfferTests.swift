import Foundation
import Testing
@testable import SqueakMacCore

// The daemon's PondEnding offer and sharing state, as the Mac draws them (issues #142, #143): the words come from the host, a
// view decides nothing about local versus shared, and Invite is on every Pond the person owns.
@Suite("Ending and sharing a Pond") struct PondEndOfferTests {
    private func pond(_ extra: String = "", role: String = "owner", local: Bool = false) -> PondSummary {
        let json = """
        {"id":"p1","name":"Alpha","role":"\(role)","memberCount":3,"threadCount":0,"needsYou":0,"local":\(local),"status":"active"\(extra)}
        """
        return try! JSONDecoder().decode(PondSummary.self, from: Data(json.utf8))
    }

    @Test func drawsTheOfferTheDaemonSends() {
        let p = pond(#","sharing":"shared","endOffer":{"primary":"delete","words":{"menu":"Delete Pond…","title":"Delete Alpha for everyone?","message":"2 other people will lose access.","button":"Delete for everyone"}}"#)
        #expect(p.endOffering.primary == .delete)
        #expect(p.endOffering.words.menu == "Delete Pond\u{2026}")
        #expect(p.endOffering.words.button == "Delete for everyone")
        #expect(p.endOffering.blockedBy == nil)
        #expect(p.sharingState == .shared)
    }

    @Test func aLocalDeleteIsRemoveFromSqueakNotForEveryone() {
        let p = pond(#","sharing":"local","endOffer":{"primary":"delete","words":{"menu":"Remove from Squeak…","title":"Remove Alpha from Squeak?","message":"Squeak forgets this folder and its Pond. The folder and its files stay on your Mac.","button":"Remove from Squeak"}}"#, local: true)
        #expect(p.sharingState == .local)
        #expect(p.endOffering.words.menu == "Remove from Squeak\u{2026}")
        #expect(p.endOffering.words.title == "Remove Alpha from Squeak?")
        // An older host sends no offer: the same local words are made here, never "for everyone".
        let old = pond(local: true)
        #expect(old.endOffering.words.button == "Remove from Squeak")
        #expect(old.endOffering.words.message == "Squeak forgets this folder and its Pond. The folder and its files stay on your Mac.")
        #expect(!old.endOffering.words.title.contains("everyone"))
        #expect(old.sharingState == .local)
    }

    @Test func aMemberLeavesAndAnEndedJoinIsRemoved() {
        #expect(pond(role: "member").endOffering.primary == .leave)
        #expect(pond(role: "member").endOffering.words.menu == "Leave Pond\u{2026}")
        let ended = try! JSONDecoder().decode(PondSummary.self, from: Data(#"{"id":"p2","name":"Beta","role":"member","status":"removed"}"#.utf8))
        #expect(ended.endOffering.primary == .forget)
    }

    @Test func anUnfinishedEndKeepsItsSentenceForTryAgain() {
        let p = pond(#","ending":{"kind":"delete","line":"Couldn't finish deleting Alpha.","failed":"Squeak couldn't end the Pond in the cloud. Try again."}"#)
        #expect(p.ending?.kind == .delete)
        #expect(p.ending?.failed == "Squeak couldn't end the Pond in the cloud. Try again.")
        #expect(pond().ending == nil)
    }

    @Test func aSharingStateOutsideTheThreeReadsFromTheRow() {
        #expect(pond(#","sharing":"sharing""#, local: true).sharingState == .sharing)
        #expect(pond(#","sharing":"???""#, local: true).sharingState == .local)
        #expect(pond().sharingState == .shared)
    }

    @Test func inviteIsOnEveryPondThePersonOwns() {
        // A local Pond: no Ducks, no page read yet, no cloud record.
        #expect(pond(local: true).mayInvite(detailRole: nil))
        #expect(pond().mayInvite(detailRole: nil))
        #expect(!pond(role: "member").mayInvite(detailRole: nil))
        #expect(!pond(role: "viewer").mayInvite(detailRole: nil))
        // The page's role wins once it is read.
        #expect(!pond().mayInvite(detailRole: .viewer))
    }

    @Test func theInviteSheetSaysOnceThatInvitingShares() {
        #expect(InviteSheetPlan.note(for: .local) == "Inviting someone shares this Pond. Your Ducks stay private until you share them.")
        #expect(InviteSheetPlan.note(for: .sharing) != nil)
        #expect(InviteSheetPlan.note(for: .shared) == nil)
    }
}
