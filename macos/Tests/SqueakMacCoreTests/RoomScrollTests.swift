import Testing
@testable import SqueakMacCore

@Suite struct RoomScrollTests {
    @Test func nearTopOnlyWhenScrollable() {
        #expect(RoomScroll.nearTop(y: 0, document: 1000, visible: 500))
        #expect(!RoomScroll.nearTop(y: 0, document: 400, visible: 500))
        #expect(!RoomScroll.nearTop(y: 600, document: 1000, visible: 500))
    }
    @Test func prependKeepsPosition() {
        #expect(RoomScroll.afterPrepend(y: 20, oldDocument: 1000, newDocument: 1800) == 820)
        #expect(RoomScroll.afterPrepend(y: 20, oldDocument: 1000, newDocument: 1000) == 20)
        #expect(RoomScroll.afterPrepend(y: 20, oldDocument: 1000, newDocument: 900) == 20)
    }
    @Test func restoreClamps() {
        #expect(RoomScroll.restored(fromBottom: 0, document: 1000, visible: 400) == 600)
        #expect(RoomScroll.restored(fromBottom: 5000, document: 1000, visible: 400) == 0)
        #expect(RoomScroll.restored(fromBottom: 0, document: 300, visible: 400) == 0)
    }
}
