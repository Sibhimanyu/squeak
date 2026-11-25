import Foundation
import SqueakIcons
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
        let row = PondChatRow(id: "a", title: "t", agent: nil, state: PondThreadState(chat.state), mark: ChatMark.of(chat, unread: false), lastAt: nil,
                              local: key, pondThread: nil, ducklingsRunning: chat.ducklings?.running ?? 0, people: [])
        #expect(fromChats == .working)
        #expect(StreamGlyphState.of(rows: [row]) == fromChats)
        let idle = PondChatRow(id: "b", title: "t", agent: nil, state: .finished, mark: nil, lastAt: nil, local: key, pondThread: nil, people: [])
        #expect(StreamGlyphState.of(rows: [idle]) == .idle)
        // Another Mac's finished thread carries no count: it stays idle, nothing invented.
        let remote = PondChatRow(id: "thread:x", title: "t", agent: nil, state: .finished, mark: nil, lastAt: nil, local: nil, pondThread: "x", people: [])
        #expect(StreamGlyphState.of(rows: [remote]) == .idle)
    }

    // The owner's bug: an idle Duck drew the working glyph. The host's rule (`helpersKeepWorking`) is the only word on whether
    // background helpers keep a chat working; a bare count of running helpers includes a dev server left up for days.
    @Test func aShellLeftUpDoesNotKeepAnIdleChatWorking() {
        let key = SessionKey(provider: "squeak", hostSessionId: "dev")
        var chat = HostSession(key: key, state: .finished, ducklings: DucklingSet(running: 1))
        chat.helpersWorking = false
        #expect(!chat.helpersKeepWorking)
        #expect(!chat.isActive)
        #expect(ChatMark.of(chat, unread: false) == nil)
        #expect(SessionGrouping.kind(of: chat, now: Date()) != .working)
        #expect(StreamGlyphState.of(chats: [chat], mark: { ChatMark.of($0, unread: false) }) == .idle)
        #expect(StatusRollup.of(marks: [nil], ducklingsRunning: [chat.helpersKeepWorking ? 1 : 0]).state == .idle)
        // The host says the helpers keep it working: the quiet mark, as before.
        chat.helpersWorking = true
        #expect(ChatMark.of(chat, unread: false) == ChatMark(.working, quiet: true))
        #expect(chat.isActive)
        // An older host that says nothing keeps the count's meaning.
        chat.helpersWorking = nil
        #expect(chat.helpersKeepWorking)
    }

    @Test func anErroredChatNeverDrawsWorkingBecauseOfHelpers() {
        let key = SessionKey(provider: "squeak", hostSessionId: "err")
        for says in [nil, true] as [Bool?] {
            var chat = HostSession(key: key, state: .error, lastActivityAt: Date(), ducklings: DucklingSet(running: 1))
            chat.helpersWorking = says
            #expect(!chat.helpersKeepWorking)
            #expect(!chat.isActive)
            #expect(ChatMark.of(chat, unread: false) == ChatMark(.failed))
        }
    }

    @Test func aRosterDuckReadsByTheHostsActivityNotItsHelperCount() {
        let key = SessionKey(provider: "squeak", hostSessionId: "d")
        // Idle Duck whose host counted one running shell: the host's activity is idle, so no glyph.
        var idle = PondChatRow(id: "duck:1", title: "t", agent: nil, state: .finished, mark: nil, lastAt: nil, local: key, pondThread: nil, ducklingsRunning: 1, people: [])
        idle.duckId = "1"
        #expect(StreamGlyphState.of(rows: [idle]) == .idle)
        var working = idle
        working.state = .working
        #expect(StreamGlyphState.of(rows: [working]) == .working)
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

    @Test func glyphOnlyWhenWorking() {
        for state in [StreamGlyphState.idle, .unread, .waiting, .failed] {
            #expect(state.glyph(reduceMotion: false) == .none)
            #expect(state.glyph(reduceMotion: true) == .none)
        }
        #expect(StreamGlyphState.working.glyph(reduceMotion: false) == .animatedGlyph)
        #expect(StreamGlyphState.working.glyph(reduceMotion: true) == .reduceMotionIcon)
        // A folded row shows it only when a duck under it works right now; an open one leaves it to the chats.
        #expect(StreamGlyphState.of(marks: [nil, ChatMark(.unread)]).glyph(reduceMotion: false) == .none)
        #expect(StreamGlyphState.of(marks: [nil, ChatMark(.working, quiet: true)]).asRollup(childrenVisible: false).glyph(reduceMotion: false) == .animatedGlyph)
        #expect(StreamGlyphState.working.asRollup(childrenVisible: true).glyph(reduceMotion: false) == .none)
    }
}
