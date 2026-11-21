import Testing
@testable import SqueakMacCore

@Suite struct DockAttentionRowTests {
    @Test func atMostOnePillInEveryState() {
        for live in [false, true] {
            for jump in [false, true] {
                let l = DockAttentionRow.layout(showsLiveRow: live, hasAttentionJump: jump)
                #expect(l.pillCount <= 1)
                #expect(l.showsPill == jump)
                #expect(l.showsLive == live)
                #expect(l.showsRow == (live || jump))
            }
        }
    }

    @Test func workingWithLiveRowAndUpdateElsewhere() {
        let l = DockAttentionRow.layout(showsLiveRow: true, hasAttentionJump: true)
        #expect(l.showsLive && l.pillCount == 1)
    }

    @Test func idleWithUnreadElsewhereShowsOnlyThePill() {
        let l = DockAttentionRow.layout(showsLiveRow: false, hasAttentionJump: true)
        #expect(!l.showsLive && l.pillCount == 1 && l.showsRow)
    }

    @Test func waitingAndDucklingsBarDoNotAddPills() {
        // Waiting and a ducklings bar change `showsLiveRow` only; the bar is its own view and carries no pill.
        let waiting = DockAttentionRow.layout(showsLiveRow: true, hasAttentionJump: false)
        #expect(waiting.pillCount == 0 && waiting.showsLive)
        let quiet = DockAttentionRow.layout(showsLiveRow: false, hasAttentionJump: false)
        #expect(!quiet.showsRow && quiet.pillCount == 0)
    }

    @Test func rowKeepsItsPillWhenTheLiveRowComesAndGoes() {
        let working = DockAttentionRow.layout(showsLiveRow: true, hasAttentionJump: true)
        let idle = DockAttentionRow.layout(showsLiveRow: false, hasAttentionJump: true)
        #expect(working.showsRow && idle.showsRow && working.showsPill && idle.showsPill)
    }

    @Test func pillHasOneOwnerAndJumpNeverSharesItsSlot() {
        for live in [false, true] {
            for jump in [false, true] {
                for button in [false, true] {
                    let l = DockAttentionRow.layout(showsLiveRow: live, hasAttentionJump: jump, showsJumpButton: button)
                    #expect(l.pillCount <= 1)
                    #expect(l.pillSlot == .trailing)
                    #expect(l.jumpSlot != l.pillSlot)
                    #expect(l.showsJump == button)
                }
            }
        }
    }
}
