import Foundation
import Testing
@testable import SqueakMacCore

@Suite struct LayoutGuardsTests {
    @Test func heightWritesOnlyWhenMovedMoreThanHalfAPoint() {
        #expect(!HeightGuard.shouldWrite(old: 100, new: 100))
        #expect(!HeightGuard.shouldWrite(old: 100, new: 100.4))
        #expect(!HeightGuard.shouldWrite(old: 100, new: 99.6))
        #expect(HeightGuard.shouldWrite(old: 100, new: 100.6))
        #expect(HeightGuard.shouldWrite(old: 0, new: 1))
    }

    @Test func tokenChangesOnlyWhenTheEndsOrCountChange() {
        let a = RowsToken(ids: ["a", "b", "c"])
        #expect(a == RowsToken(ids: ["a", "b", "c"]))
        #expect(a != RowsToken(ids: ["a", "b", "c", "d"]))
        #expect(a != RowsToken(ids: ["a", "b", "x"]))
        #expect(RowsToken(ids: []) == RowsToken(count: 0, first: nil, last: nil))
    }

    @Test func liveAppendIsOneOrTwoRowsAtTheEnd() {
        let old = RowsToken(ids: ["a", "b"])
        #expect(RowsToken.isLiveAppend(old: old, new: RowsToken(ids: ["a", "b", "c"])))
        #expect(!RowsToken.isLiveAppend(old: old, new: RowsToken(ids: ["a", "b", "c", "d", "e"])))
        #expect(!RowsToken.isLiveAppend(old: old, new: RowsToken(ids: ["z", "a", "b"])))
        #expect(!RowsToken.isLiveAppend(old: RowsToken(ids: []), new: old))
    }

    @Test func publishOnlyWhenChanged() {
        var v = [1, 2]
        #expect(!publishIfChanged(&v, [1, 2]))
        #expect(publishIfChanged(&v, [1, 2, 3]))
        #expect(v == [1, 2, 3])
    }
}
