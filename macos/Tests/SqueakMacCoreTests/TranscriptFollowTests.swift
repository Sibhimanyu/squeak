import AppKit
import Testing
@testable import SqueakMacCore

@Suite struct TranscriptFollowTests {
    @Test func opensFollowingAndScrollsToEnd() {
        var f = TranscriptFollow()
        #expect(f.handle(.opened) == .scrollToBottom)
        #expect(f.following)
    }

    @Test func streamingWhileFollowingScrollsEveryChange() {
        var f = TranscriptFollow()
        f.handle(.opened)
        for _ in 0..<50 { #expect(f.handle(.contentChanged) == .scrollToBottom) }
        #expect(f.following)
    }

    @Test func userScrollUpDetaches() {
        var f = TranscriptFollow()
        f.handle(.opened)
        #expect(f.handle(.userScrolled(distanceFromBottom: 300)) == .none)
        #expect(!f.following)
    }

    @Test func smallUserNudgeStaysAttachedAndNeverFightsTheGesture() {
        var f = TranscriptFollow()
        f.handle(.opened)
        #expect(f.handle(.userScrolled(distanceFromBottom: 10)) == .none)
        #expect(f.following)
        // Settles on the end only when the gesture is over.
        #expect(f.handle(.userScrollEnded(distanceFromBottom: 10)) == .scrollToBottom)
    }

    @Test func contentGrowthWhileDetachedDoesNothing() {
        var f = TranscriptFollow()
        f.handle(.opened)
        f.handle(.userScrolled(distanceFromBottom: 500))
        for _ in 0..<50 { #expect(f.handle(.contentChanged) == .none) }
        #expect(!f.following)
    }

    @Test func growthNeverDetaches() {
        // The end moving away because the last row grew is not the reader scrolling: no event carries it.
        var f = TranscriptFollow()
        f.handle(.opened)
        f.handle(.contentChanged)
        #expect(f.following)
    }

    @Test func scrollingBackNearTheEndReattaches() {
        var f = TranscriptFollow()
        f.handle(.opened)
        f.handle(.userScrolled(distanceFromBottom: 400))
        #expect(!f.following)
        f.handle(.userScrolled(distanceFromBottom: 24))
        #expect(f.following)
        #expect(f.handle(.contentChanged) == .scrollToBottom)
        f.handle(.userScrolled(distanceFromBottom: 25))
        #expect(!f.following)
    }

    @Test func jumpReattaches() {
        var f = TranscriptFollow()
        f.handle(.opened)
        f.handle(.userScrolled(distanceFromBottom: 900))
        #expect(f.handle(.jumpTapped) == .scrollToBottom)
        #expect(f.following)
        #expect(f.handle(.contentChanged) == .scrollToBottom)
    }

    @Test func prependKeepsTheReadersRowWhileDetached() {
        var f = TranscriptFollow()
        f.handle(.opened)
        f.handle(.userScrolled(distanceFromBottom: 1200))
        f.handle(.holdPlace(distanceFromBottom: 1200))
        // Older rows land above: hold the distance from the end, so the same row stays where it was.
        #expect(f.handle(.contentChanged) == .restore(distanceFromBottom: 1200))
        // The reader keeps scrolling while the page lays out: their place is the new one.
        f.handle(.userScrolled(distanceFromBottom: 1100))
        #expect(f.handle(.contentChanged) == .restore(distanceFromBottom: 1100))
        f.handle(.releasePlace)
        #expect(f.handle(.contentChanged) == .none)
    }

    @Test func holdIsIgnoredWhileFollowing() {
        var f = TranscriptFollow()
        f.handle(.opened)
        f.handle(.holdPlace(distanceFromBottom: 0))
        #expect(f.handle(.contentChanged) == .scrollToBottom)
    }
}

/// The AppKit side on a real (never shown) NSScrollView: a flipped document that grows like SwiftUI's hosting view.
@MainActor
@Suite struct TranscriptScrollFollowerTests {
    private final class Doc: NSView { override var isFlipped: Bool { true } }

    private func rig(content: CGFloat = 1000, viewport: CGFloat = 400) -> (NSScrollView, Doc, TranscriptScrollFollower) {
        let sv = NSScrollView(frame: NSRect(x: 0, y: 0, width: 300, height: viewport))
        let doc = Doc(frame: NSRect(x: 0, y: 0, width: 300, height: content))
        sv.documentView = doc
        let follower = TranscriptScrollFollower(frame: .zero)
        doc.addSubview(follower)
        follower.attach()
        return (sv, doc, follower)
    }

    private func grow(_ doc: NSView, by h: CGFloat) { doc.frame.size.height += h }
    private var origin: (NSScrollView) -> CGFloat { { $0.contentView.bounds.origin.y } }

    @Test func attachesAndStartsAtTheEnd() {
        let (sv, _, f) = rig()
        #expect(f.isAttached)
        #expect(origin(sv) == 600)
        #expect(f.model.following)
    }

    @Test func followsStreamedGrowthImmediately() {
        let (sv, doc, _) = rig()
        for _ in 0..<20 {
            grow(doc, by: 17)
            // No wait for a debounce or an animation: the end is in view as soon as the content has grown.
            #expect(origin(sv) == doc.frame.height - 400)
        }
    }

    private func readerScrolls(_ sv: NSScrollView, _ f: TranscriptScrollFollower, to y: CGFloat) { f.scrollAsReader(to: y) }

    @Test func detachedReaderIsNeverMovedByGrowth() {
        let (sv, doc, f) = rig()
        readerScrolls(sv, f, to: 200)
        #expect(!f.model.following)
        for _ in 0..<20 { grow(doc, by: 40) }
        #expect(origin(sv) == 200)
    }

    @Test func scrollingBackToTheEndFollowsAgain() {
        let (sv, doc, f) = rig()
        readerScrolls(sv, f, to: 200)
        grow(doc, by: 100)
        readerScrolls(sv, f, to: doc.frame.height - 400 - 10)
        #expect(f.model.following)
        grow(doc, by: 50)
        #expect(origin(sv) == doc.frame.height - 400)
    }

    @Test func jumpTokenReattachesAndScrollsToTheEnd() {
        let (sv, doc, f) = rig()
        f.update(jumpToken: 0, holdPlace: false)
        readerScrolls(sv, f, to: 100)
        grow(doc, by: 300)
        #expect(origin(sv) == 100)
        f.update(jumpToken: 1, holdPlace: false)
        #expect(origin(sv) == doc.frame.height - 400)
        #expect(f.model.following)
    }

    @Test func pagedInRowsAboveKeepTheReadersPlace() {
        let (sv, doc, f) = rig()
        readerScrolls(sv, f, to: 200)
        f.update(jumpToken: 0, holdPlace: true)
        // 900 pt of older rows land above: the content below them is unchanged, so the reader's row must not move on screen.
        grow(doc, by: 900)
        #expect(origin(sv) == 1100)
        f.update(jumpToken: 0, holdPlace: false)
        grow(doc, by: 50)
        #expect(origin(sv) == 1100)
    }
}

@Suite struct TranscriptRowCacheTests {
    private func messages(_ n: Int) -> [ChatMessage] {
        (0..<n).map { i in
            ChatMessage(
                id: "m\(i)", role: i % 2 == 0 ? .user : .assistant,
                text: String(repeating: "A long paragraph with `code` and **bold** words. ", count: 60), at: Date(timeIntervalSince1970: Double(i) * 60))
        }
    }

    @Test func unchangedMessagesAreNotRebuiltAcrossPasses() {
        let cache = TranscriptRowCache()
        let list = messages(40)
        for _ in 0..<100 {
            _ = cache.footers(list, working: false)
            for m in list { _ = cache.choiceLayout(for: m) }
        }
        #expect(cache.footerBuilds == 1)
        #expect(cache.layoutBuilds == 40)
    }

    @Test func aStreamedDeltaRebuildsOnlyWhatChanged() {
        let cache = TranscriptRowCache()
        var list = messages(40)
        _ = cache.footers(list, working: true)
        for m in list { _ = cache.choiceLayout(for: m) }
        list[39].text += " more"
        _ = cache.footers(list, working: true)
        for m in list { _ = cache.choiceLayout(for: m) }
        #expect(cache.footerBuilds == 2)
        #expect(cache.layoutBuilds == 41)
        #expect(cache.footers(list, working: true) == TurnFooters.make(list, working: true))
    }

    @Test func aRowsEqualityIgnoresUnrelatedState() {
        // The view compares exactly these inputs; the same message with the same inputs is equal however often it is rebuilt.
        let m = messages(2)[1]
        let a = RowProbe(message: m, working: true, footer: TurnFooters.make([m], working: false)[m.id])
        let b = RowProbe(message: m, working: true, footer: TurnFooters.make([m], working: false)[m.id])
        #expect(a == b)
        var changed = m
        changed.text += "!"
        #expect(a != RowProbe(message: changed, working: true, footer: a.footer))
    }

    private struct RowProbe: Equatable { var message: ChatMessage; var working: Bool; var footer: TurnFooter? }
}
