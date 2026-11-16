import Foundation
import Testing

@testable import SqueakMacCore

@Suite struct StreamGlyphTests {
    @Test func stateDerivation() {
        let w = ChatMark(.waiting), k = ChatMark(.working), f = ChatMark(.failed), u = ChatMark(.unread)
        #expect(StreamGlyphState.of(marks: []) == .idle)
        #expect(StreamGlyphState.of(marks: [nil, nil]) == .idle)
        #expect(StreamGlyphState.of(marks: [k, w]) == .waiting)
        #expect(StreamGlyphState.of(marks: [f, k]) == .working)
        #expect(StreamGlyphState.of(marks: [nil], ducklingsRunning: 2) == .working)
        #expect(StreamGlyphState.of(marks: [w], ducklingsRunning: 2) == .waiting)
        #expect(StreamGlyphState.of(marks: [u, f]) == .failed)
        #expect(StreamGlyphState.of(marks: [nil, u]) == .unread)
    }

    @Test func finishedChatWithRunningDucklingIsWorkingOnBothPaths() {
        let key = SessionKey(provider: "squeak", hostSessionId: "a")
        let chat = HostSession(key: key, state: .finished, ducklings: DucklingSet(running: 1))
        let fromChats = StreamGlyphState.of(chats: [chat], mark: { _ in nil })
        let row = PondChatRow(id: "a", title: "t", agent: nil, state: PondThreadState(chat.state), mark: nil, lastAt: nil,
                              local: key, pondThread: nil, ducklingsRunning: chat.ducklings?.running ?? 0, people: [])
        #expect(fromChats == .working)
        #expect(StreamGlyphState.of(rows: [row]) == fromChats)
        let idle = PondChatRow(id: "b", title: "t", agent: nil, state: .finished, mark: nil, lastAt: nil, local: key, pondThread: nil, people: [])
        #expect(StreamGlyphState.of(rows: [idle]) == .idle)
        // Another Mac's finished thread carries no count: it stays idle, nothing invented.
        let remote = PondChatRow(id: "thread:x", title: "t", agent: nil, state: .finished, mark: nil, lastAt: nil, local: nil, pondThread: "x", people: [])
        #expect(StreamGlyphState.of(rows: [remote]) == .idle)
    }

    @Test func accessibilityWords() {
        #expect(StreamGlyphState.working.label(for: "Hong Kong") == "Hong Kong, working")
        #expect(StreamGlyphState.idle.label(for: "Hong Kong") == "Hong Kong")
        #expect(StreamGlyphState.waiting.label(for: "A") == "A, waiting on you")
    }

    @Test func onlyTheWorkingLeafMoves() {
        // A rollup over visible chats never animates; the chat itself does.
        #expect(StreamGlyphState.working.asRollup(childrenVisible: true) == .idle)
        #expect(StreamGlyphState.working.asRollup(childrenVisible: false) == .working)
        // Waiting and failed still show on the rollup, as still marks.
        #expect(StreamGlyphState.waiting.asRollup(childrenVisible: true) == .waiting)
        #expect(StreamGlyphState.failed.asRollup(childrenVisible: true) == .failed)
        #expect(ChatMark(.working).asRollup(childrenVisible: true) == nil)
        #expect(ChatMark(.working, quiet: true).asRollup(childrenVisible: true) == nil)
        #expect(ChatMark(.working).asRollup(childrenVisible: false) == ChatMark(.working))
        #expect(ChatMark(.failed).asRollup(childrenVisible: true) == ChatMark(.failed))
    }
}
