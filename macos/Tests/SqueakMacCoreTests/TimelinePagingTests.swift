import Foundation
import Testing
@testable import SqueakMacCore

struct TimelinePagingTests {
    @Test func pagesAreSmallSoOpeningAndPagingUpLayOutLittleAtOnce() {
        #expect(TimelinePaging.firstPage <= 15 && TimelinePaging.firstPage > 0)
        #expect(TimelinePaging.olderPage <= 15 && TimelinePaging.olderPage > 0)
    }

    @Test func aTopStillInViewAsksForTheNextPageOnceNothingHoldsTheReader() {
        let idle = EarlierPaging(reachedStart: false, loading: false, error: nil, known: true)
        #expect(TimelinePaging.wantsNextPage(topVisible: true, paging: idle, holdingAnchor: false))
        // The anchor is still holding the reader's place while the last page is laid out.
        #expect(!TimelinePaging.wantsNextPage(topVisible: true, paging: idle, holdingAnchor: true))
        // Out of view, mid-load, or failed (the row offers a retry): never by itself.
        #expect(!TimelinePaging.wantsNextPage(topVisible: false, paging: idle, holdingAnchor: false))
        #expect(!TimelinePaging.wantsNextPage(topVisible: true, paging: EarlierPaging(loading: true, known: true), holdingAnchor: false))
        #expect(!TimelinePaging.wantsNextPage(topVisible: true, paging: EarlierPaging(error: "x", known: true), holdingAnchor: false))
    }

    @Test func smallPagesStillCoverALongChatInOrderWithNoGapOrRepeat() {
        var log: [TimelineEvent] = []
        var seq = 0
        for n in 1...40 {
            seq += 1
            log.append(TimelineEvent(seq: seq, body: .turnStarted(turnId: "t\(n)", promptMessageId: "native-\(seq)", clientNonce: nil, text: "p\(n)", author: nil, queuedId: nil, auto: false)))
            seq += 1
            log.append(TimelineEvent(seq: seq, body: .turnEnded(turnId: "t\(n)", outcome: .done, error: nil, replyMessageId: nil)))
        }
        func page(before: Int?) -> [TimelineEvent] {
            let startSeqs = log.filter { if case .turnStarted = $0.body { true } else { false } }.map(\.seq).filter { before == nil || $0 < before! }
            guard let from = startSeqs.suffix(TimelinePaging.olderPage).first else { return [] }
            return log.filter { $0.seq >= from && (before == nil || $0.seq < before!) }
        }
        var t = TurnTimeline()
        t.load(page(before: nil), hasEarlier: true)
        #expect(t.turns.count == TimelinePaging.firstPage)
        while let oldest = t.oldestSeq, oldest > 1 {
            let before = t.turns.count
            t.prepend(page(before: oldest), hasEarlier: true)
            #expect(t.turns.count > before)
        }
        #expect(t.turns.count == 40)
        #expect(Set(t.turns.map(\.id)).count == 40)
        #expect(t.turns.first?.prompt == "p1" && t.turns.last?.prompt == "p40")
    }
}
