import Foundation
import Testing

@testable import SqueakMacCore

@Suite struct FirstPondJourneyTests {
    @Test func theMenuOffersInviteToTheOwnerOfAKnownPond() {
        #expect(FirstPondJourney.menuOffer(canInvite: true, hasPond: true, plainFolder: false, isRemote: false).invite)
        #expect(!FirstPondJourney.menuOffer(canInvite: false, hasPond: true, plainFolder: false, isRemote: false).invite)
        #expect(!FirstPondJourney.menuOffer(canInvite: true, hasPond: false, plainFolder: false, isRemote: false).invite)
        #expect(!FirstPondJourney.menuOffer(canInvite: true, hasPond: true, plainFolder: false, isRemote: true).invite)
    }

    @Test func theMenuOffersGitPondOnlyForAPlainFolderOnThisMac() {
        #expect(FirstPondJourney.menuOffer(canInvite: true, hasPond: true, plainFolder: true, isRemote: false).gitPond)
        #expect(!FirstPondJourney.menuOffer(canInvite: true, hasPond: true, plainFolder: false, isRemote: false).gitPond)
        #expect(!FirstPondJourney.menuOffer(canInvite: true, hasPond: true, plainFolder: true, isRemote: true).gitPond)
    }

    @Test func aFolderPondPointsToThePublishStepAndAGitPondDoesNot() {
        #expect(FirstPondJourney.emptyPondDetail(plainFolder: true).contains("GitHub"))
        #expect(!FirstPondJourney.emptyPondDetail(plainFolder: false).contains("GitHub"))
        #expect(FirstPondJourney.emptyPondDetail(plainFolder: false).contains("Room"))
    }

    @Test func theEmptyRoomSaysHowToHandOutWork() {
        #expect(FirstPondJourney.emptyRoom.contains("Make task"))
    }

    @Test func theNewBlankPondSaysItStaysLocalAndCanBePublishedLater() {
        let note = FirstPondJourney.choiceNote(.blank, blankPath: "~/Squeak/notes")
        #expect(note?.contains("~/Squeak/notes") == true)
        #expect(note?.contains("stays on this Mac") == true)
        #expect(note?.contains("GitHub") == true)
        #expect(FirstPondJourney.choiceNote(.blank, blankPath: nil)?.contains("~/Squeak") == true)
        #expect(FirstPondJourney.choiceNote(.clone, blankPath: nil) == nil)
    }

    @Test func noCopyUsesTheAvoidedWords() {
        let all = [FirstPondJourney.noPondsDetail, FirstPondJourney.emptyRoom, FirstPondJourney.emptyPondDetail(plainFolder: true),
                   FirstPondJourney.emptyPondDetail(plainFolder: false)]
        for s in all {
            #expect(!s.localizedCaseInsensitiveContains("thread"))
            #expect(!s.localizedCaseInsensitiveContains("worktree"))
        }
    }
}
