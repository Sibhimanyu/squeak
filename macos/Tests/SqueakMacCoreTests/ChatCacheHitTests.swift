import Foundation
import Testing
@testable import SqueakMacCore

/// Appending one message must leave every cached derivation of the older rows alone (hit), and a changed text must miss.
struct ChatCacheHitTests {
    private func msgs(_ n: Int) -> [ChatMessage] {
        (0..<n).map { ChatMessage(id: "m\($0)", role: $0 % 2 == 0 ? .user : .assistant, text: "message \($0) body", at: Date(timeIntervalSince1970: Double($0)), turnId: "t\($0 / 2)") }
    }

    @Test func choiceLayoutIsParsedOncePerIdAndText() {
        let cache = TranscriptRowCache()
        let all = msgs(30)
        for m in all { _ = cache.choiceLayout(for: m) }
        let built = cache.layoutBuilds
        for m in msgs(31) { _ = cache.choiceLayout(for: m) }
        #expect(cache.layoutBuilds == built + 1)
        var edited = all[3]; edited.text += " (edited)"
        _ = cache.choiceLayout(for: edited)
        #expect(cache.layoutBuilds == built + 2)
        _ = cache.choiceLayout(for: edited)
        #expect(cache.layoutBuilds == built + 2)
    }

    @Test func derivedRowsAreRebuiltOncePerRowsChangeNotPerRead() {
        let rows = ChatRowsCache(), derived = RowDerivedCache()
        let all = msgs(30)
        let r = rows.rows(messages: all, state: .idle)
        _ = derived.derived(rows: r, generation: rows.generation)
        for _ in 0..<5 { _ = derived.derived(rows: rows.rows(messages: all, state: .idle), generation: rows.generation) }
        #expect(derived.computeCount == 1 && rows.computeCount == 1)
        let r2 = rows.rows(messages: msgs(31), state: .idle)
        let d2 = derived.derived(rows: r2, generation: rows.generation)
        #expect(derived.computeCount == 2 && d2.rowIDs.count == 31)
        #expect(Array(d2.rowIDs.prefix(30)) == all.map(\.id))
    }
}
