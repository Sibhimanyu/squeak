import Foundation
import Testing

@testable import SqueakMacCore

@Suite("Row derived cache")
struct RowDerivedCacheTests {
    private func messages(_ n: Int) -> [ChatMessage] {
        (0..<n).map { ChatMessage(id: "m\($0)", role: $0 % 2 == 0 ? .user : .assistant, text: "t\($0)", turnId: "t\($0 / 2)") }
    }

    @Test func derivesOncePerRowsChange() {
        let rowsCache = ChatRowsCache()
        let derived = RowDerivedCache()
        let m = messages(4)
        for _ in 0..<5 {
            let rows = rowsCache.rows(messages: m, state: .idle)
            let d = derived.derived(rows: rows, generation: rowsCache.generation)
            #expect(d.rowIDs == rows.map(\.id))
            #expect(d.foldRows.count == rows.count)
        }
        #expect(derived.computeCount == 1)
        let rows = rowsCache.rows(messages: messages(6), state: .idle)
        #expect(derived.derived(rows: rows, generation: rowsCache.generation).rowIDs.count == rows.count)
        #expect(derived.computeCount == 2)
    }
}
