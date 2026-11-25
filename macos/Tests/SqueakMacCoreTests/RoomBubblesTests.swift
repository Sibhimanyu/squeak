import Foundation
import Testing

@testable import SqueakMacCore

@Suite struct RoomBubblesTests {
    private func thread(_ id: String, name: String) -> RoomThread {
        RoomThread(sessionId: id, title: "T", agent: "claude", state: .idle, name: name, duty: .on)
    }
    private let ducks = [("s1", "Sage 2"), ("s2", "Dot 2")]
    private var threads: [RoomThread] { ducks.map { thread($0.0, name: $0.1) } }

    @Test func mineIsOnTheRightWithoutAnAvatarEveryoneElseOnTheLeft() {
        #expect(RoomBubblePlan.side(of: .me) == .trailing)
        #expect(RoomBubblePlan.side(of: .person("Anya")) == .leading)
        #expect(RoomBubblePlan.side(of: .duck(nil, sessionId: "s1", fallbackName: "Sage 2", agent: nil)) == .leading)
        #expect(!RoomBubblePlan.showsAvatar(.me))
        #expect(RoomBubblePlan.showsAvatar(.person("Anya")))
    }

    @Test func onlyTheLastBubbleOfAGroupHasATail() {
        #expect(!RoomBubblePlan.hasTail(index: 0, count: 3))
        #expect(RoomBubblePlan.hasTail(index: 2, count: 3))
        #expect(RoomBubblePlan.hasTail(index: 0, count: 1))
    }

    @Test func groupsBreakAfterFiveMinutes() {
        #expect(RoomMessages.groupGap == 5 * 60 * 1000)
    }

    @Test func bubbleWidthIsAShareOfTheColumn() {
        #expect(RoomBubblePlan.maxWidth(column: 740) == 503)
    }

    @Test func ownStatesReadSendingSentFailed() {
        #expect(RoomBubblePlan.words(RoomBubblePlan.ownState(pending: false, failed: false)) == nil)
        #expect(RoomBubblePlan.words(RoomBubblePlan.ownState(pending: true, failed: false)) == "Sending\u{2026}")
        #expect(RoomBubblePlan.words(RoomBubblePlan.ownState(pending: true, failed: true)) == "Not sent")
    }

    @Test func replyQuotesOneLineAndMentionsTheDuckByName() throws {
        let sage = RoomMessageAuthor.duck(threads[0], sessionId: "s1", fallbackName: "Chat title", agent: nil)
        let reply = try #require(RoomBubblePlan.reply(to: sage, quoting: "\r\n  The build passed. \r\n Details below."))
        #expect(reply.quote == "The build passed.")
        #expect(reply.mention == "@Sage 2")
        let draft = reply.insertingMention(in: "How long did it take?", replacing: nil)
        #expect(draft == "@Sage 2 How long did it take?")
        #expect(reply.messageText(draft) == "> “The build passed.”\n\n@Sage 2 How long did it take?")
    }

    @Test func replyToAPersonShortensLongQuotesAtACharacterBoundary() throws {
        let emoji = "👩🏽‍💻"
        let text = String(repeating: emoji, count: 95)
        let reply = try #require(RoomBubblePlan.reply(to: .person("Anya Rao"), quoting: text))
        #expect(reply.quote == String(repeating: emoji, count: 89) + "…")
        #expect(reply.insertingMention(in: "", replacing: nil) == "@Anya Rao ")
        #expect(RoomMention.active(in: reply.insertingMention(in: "", replacing: nil)) == nil)
    }

    @Test func replyingToAnotherBubbleReplacesThePreviousMentionAndKeepsTheDraft() throws {
        let first = try #require(RoomBubblePlan.reply(to: .person("Anya"), quoting: "First"))
        let second = try #require(RoomBubblePlan.reply(to: .person("Sam"), quoting: "Second"))
        let draft = first.insertingMention(in: "I have a question.", replacing: nil)
        #expect(first.insertingMention(in: draft, replacing: first) == draft)
        #expect(second.insertingMention(in: draft, replacing: first) == "@Sam I have a question.")
        #expect(second.insertingMention(in: "@Anyabelle is ready.", replacing: first) == "@Sam @Anyabelle is ready.")
    }

    @Test func quotedMentionsStayInTheQuoteAndReplyingAgainQuotesTheNewMessage() throws {
        let reply = try #require(RoomBubblePlan.reply(to: .person("Anya"), quoting: "I checked with @Dot 2"))
        let text = reply.messageText("@Anya Thanks!")
        #expect(text == "> “I checked with ＠Dot 2”\n\n@Anya Thanks!")
        #expect(RoomBubblePlan.reply(to: .person("Sam"), quoting: text)?.quote == "@Anya Thanks!")
    }

    @Test func replyRequiresAnotherSenderAndNonemptyText() {
        #expect(RoomBubblePlan.reply(to: .me, quoting: "My message") == nil)
        #expect(RoomBubblePlan.reply(to: .person("Anya"), quoting: " \r\n\t ") == nil)
    }

    @Test func momentsAreOneCompactLine() {
        #expect(RoomMoment.line(name: "Ruby 2", verb: "finished", summary: "Released Greenroom 1.8.5") == "Ruby 2 finished \u{00B7} Released Greenroom 1.8.5")
        #expect(RoomMoment.line(name: "Ruby 2", verb: "took it", summary: "") == "Ruby 2 took it")
        #expect(RoomMoment.line(name: "A", verb: "finished", summary: "line one\nline two") == "A finished \u{00B7} line one")
        #expect(RoomMoment.line(name: "A", verb: "finished", summary: String(repeating: "x", count: 200)).count < 120)
        #expect(RoomMoment.foldLabel(name: "Ruby 2", updates: 4) == "Ruby 2 \u{00B7} 4 updates")
        #expect(RoomMoment.foldLabel(name: "Ruby 2", updates: 1) == "Ruby 2 \u{00B7} 1 update")
    }

    @Test func aDuckOpensBySessionThenByName() {
        #expect(PondClick.duck(session: "s1", name: "Whoever", threads: threads) == .duck("s1"))
        #expect(PondClick.duck(session: nil, name: "Dot 2", threads: threads) == .duck("s2"))
        #expect(PondClick.duck(session: nil, name: "Anya", threads: threads) == nil)
        #expect(PondClick.duck(session: "", name: nil, threads: threads) == nil)
    }

    @Test func aNoteOpensItsSenderAndItsReceiver() {
        let note = RoomHandoff(fromSessionId: "s1", from: "Sage 2", agent: nil, to: "Dot 2", body: "hi")
        #expect(PondClick.sender(of: note, threads: threads) == .duck("s1"))
        #expect(PondClick.receiver(of: note, threads: threads) == .duck("s2"))
        let anon = RoomHandoff(fromSessionId: nil, from: "Dot 2", agent: nil, to: nil, body: "hi")
        #expect(PondClick.receiver(of: anon, threads: threads) == nil)
        #expect(PondClick.sender(of: anon, threads: threads) == .duck("s2"))
    }
}
