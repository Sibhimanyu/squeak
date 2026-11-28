import Foundation
import Testing

@testable import SqueakMacCore

@Suite struct RoomRowsTests {
    private func thread(_ id: String, name: String) -> RoomThread {
        RoomThread(sessionId: id, title: "T", agent: "claude", state: .idle, name: name, isOpen: true)
    }
    private let ducks = [("s1", "Sage 2"), ("s2", "Dot 2")]
    private var threads: [RoomThread] { ducks.map { thread($0.0, name: $0.1) } }

    @Test func mineIsMarkedOnlyByItsLineEveryoneElseHasAnAvatarAndName() {
        #expect(RoomRowPlan.isOwn(.me))
        #expect(!RoomRowPlan.isOwn(.person("Anya")))
        #expect(!RoomRowPlan.isOwn(.duck(nil, sessionId: "s1", fallbackName: "Sage 2", agent: nil)))
        #expect(RoomRowPlan.showsHeader(index: 0))
        #expect(!RoomRowPlan.showsHeader(index: 1))
    }

    @Test func groupsBreakAfterFiveMinutes() {
        #expect(RoomMessages.groupGap == 5 * 60 * 1000)
    }

    @Test func rowMetricsFollowTheMock() {
        #expect(RoomRowPlan.textInset == 48)
        #expect(RoomRowPlan.avatar == 36 && RoomRowPlan.gutterGap == 12 && RoomRowPlan.ownLineWidth == 2)
    }

    @Test func ownStatesReadSendingSentFailed() {
        #expect(RoomRowPlan.words(RoomRowPlan.ownState(pending: false, failed: false)) == nil)
        #expect(RoomRowPlan.words(RoomRowPlan.ownState(pending: true, failed: false)) == "Sending\u{2026}")
        #expect(RoomRowPlan.words(RoomRowPlan.ownState(pending: true, failed: true)) == "Not sent")
    }

    // MARK: Long messages

    @Test func aMessageShowsInFullUnlessUnusuallyLong() {
        let three = "One.\nTwo.\nThree."
        #expect(RoomRowPlan.clip(three) == .init(shown: three, clipped: false))
        let longish = (1...12).map { "line \($0)" }.joined(separator: "\n")
        #expect(!RoomRowPlan.isLong(longish))
        #expect(!RoomRowPlan.clip(longish).clipped)
        // A long paragraph is not cut by sentence: it wraps and shows in full while it fits twelve lines.
        let paragraph = String(repeating: "word ", count: 120)
        #expect(!RoomRowPlan.isLong(paragraph))
    }

    @Test func overTwelveLinesEndsWithOpenInChatAndKeepsTheFirstTwelve() {
        let text = (1...20).map { "line \($0)" }.joined(separator: "\n")
        #expect(RoomRowPlan.isLong(text))
        let clip = RoomRowPlan.clip(text)
        #expect(clip.clipped)
        #expect(clip.shown == (1...12).map { "line \($0)" }.joined(separator: "\n"))
        #expect(RoomRowPlan.openLabel(name: "Kit") == "Open in Kit\u{2019}s chat")
        #expect(RoomRowPlan.openLabel(name: " ") == "Open in chat")
    }

    @Test func wrappedLinesCountTowardTheLimit() {
        let wide = String(repeating: "x", count: RoomRowPlan.charsPerLine * 13)
        #expect(RoomRowPlan.estimatedLines(wide) == 13)
        let clip = RoomRowPlan.clip(wide)
        #expect(clip.clipped && clip.shown.hasSuffix("\u{2026}"))
        #expect(clip.shown.count <= RoomRowPlan.charsPerLine * RoomRowPlan.longLines + 1)
    }

    @Test func aCutInsideACodeBlockClosesTheFence() {
        let code = "Run:\n```\n" + (1...20).map { "cmd \($0)" }.joined(separator: "\n") + "\n```\nDone."
        let clip = RoomRowPlan.clip(code)
        #expect(clip.clipped)
        #expect(clip.shown.hasSuffix("```"))
        #expect(clip.shown.components(separatedBy: "```").count - 1 == 2)
    }

    @Test func clipNeverChangesForTheSameText() {
        let text = (1...30).map { "item \($0)" }.joined(separator: "\n")
        #expect(RoomRowPlan.clip(text) == RoomRowPlan.clip(text))
    }

    // MARK: Hover actions

    private func message(by author: RoomMessageAuthor, canMakeTask: Bool = false, postId: String? = nil) -> RoomMessage {
        var m = RoomMessage(id: "m", at: 1, author: author, parts: [.text("hello", .normal)])
        m.canMakeTask = canMakeTask; m.postId = postId
        return m
    }

    @Test func hoverBarIsReplyCopyMakeTaskInThatOrder() {
        let m = message(by: .person("Anya"), canMakeTask: true, postId: "p1")
        #expect(RoomRowPlan.actions(for: m, text: "hello", canReply: true) == [.reply, .copy, .makeTask])
        #expect(RoomRowPlan.Action.makeTask.rawValue == "Make task")
    }

    @Test func myOwnRowHasNoReplyAndAMessageThatCannotBeATaskHasNoMakeTask() {
        let mine = message(by: .me, canMakeTask: true, postId: "p1")
        #expect(RoomRowPlan.actions(for: mine, text: "hello", canReply: true) == [.copy, .makeTask])
        let duck = message(by: .duck(nil, sessionId: "s1", fallbackName: "Kit", agent: nil))
        #expect(RoomRowPlan.actions(for: duck, text: "hello", canReply: true) == [.reply, .copy])
        #expect(RoomRowPlan.actions(for: duck, text: "hello", canReply: false) == [.copy])
    }

    // MARK: Written by Squeak

    @Test func aFallbackSummaryCarriesAQuietMark() {
        var m = message(by: .duck(nil, sessionId: "s1", fallbackName: "Kit", agent: nil))
        #expect(RoomRowPlan.fallbackMark(for: m) == nil)
        m.fallback = true
        #expect(RoomRowPlan.fallbackMark(for: m) == "written by Squeak")
    }

    // MARK: Unread

    private func group(_ id: String, _ author: RoomMessageAuthor, at times: [Int64]) -> RoomItem {
        .group(RoomMessageGroup(author: author, messages: times.enumerated().map { RoomMessage(id: "\(id)\($0.offset)", at: $0.element, author: author, parts: [.text("x", .normal)]) }))
    }
    private let kit = RoomMessageAuthor.duck(nil, sessionId: "s1", fallbackName: "Kit", agent: nil)

    @Test func whatArrivesWhileLookingAtTheRoomNeverEarnsADivider() {
        let items: [RoomItem] = [group("a", kit, at: [10]), group("c", kit, at: [30]), group("d", kit, at: [40, 50])]
        // The visit began when 30 was the newest: 40 and 50 arrived under the person's eyes.
        let out = RoomUnread.insert(into: items, seenAt: 15, through: 30)
        #expect(out.map(\.id) == ["g:a0", "unread", "g:c0", "g:d0"])
        #expect(out[1] == .unread(count: 1))
        #expect(RoomUnread.insert(into: items, seenAt: 35, through: 30) == items)
    }

    @Test func theDividerSitsBeforeTheFirstUnseenThingFromSomeoneElse() {
        let items: [RoomItem] = [group("a", kit, at: [10]), group("b", .me, at: [20]), group("c", kit, at: [30, 31]), group("d", kit, at: [40])]
        let out = RoomUnread.insert(into: items, seenAt: 15)
        #expect(out.map(\.id) == ["g:a0", "g:b0", "unread", "g:c0", "g:d0"])
        #expect(out[2] == .unread(count: 3))
        #expect(RoomUnread.label(3) == "3 new")
    }

    @Test func myOwnNewMessagesAreNeverUnread() {
        let items: [RoomItem] = [group("a", kit, at: [10]), group("b", .me, at: [20])]
        #expect(RoomUnread.insert(into: items, seenAt: 15) == items)
    }

    @Test func noSeenTimeOrNothingNewShowsNoDivider() {
        let items: [RoomItem] = [group("a", kit, at: [10])]
        #expect(RoomUnread.insert(into: items, seenAt: nil) == items)
        #expect(RoomUnread.insert(into: items, seenAt: 10) == items)
        #expect(RoomUnread.insert(into: items, seenAt: 50) == items)
    }

    @Test func aGroupThatStraddlesTheSeenTimeSplitsThereAndTheFirstPartKeepsItsId() {
        let items: [RoomItem] = [group("a", kit, at: [10, 20, 30])]
        let out = RoomUnread.insert(into: items, seenAt: 15)
        #expect(out.map(\.id) == ["g:a0", "unread", "g:a1"])
        #expect(out[1] == .unread(count: 2))
    }

    @Test func aTaskOrNoteAfterTheSeenTimeCountsAsOne() {
        let card = RoomItem.system(RoomSystemLine(id: "task:1", at: 30, text: "T", jobId: nil, buttons: []))
        let out = RoomUnread.insert(into: [group("a", kit, at: [10]), card], seenAt: 15)
        #expect(out.map(\.id) == ["g:a0", "unread", "task:1"])
        #expect(out[1] == .unread(count: 1))
    }

    @Test func theRoomIsReadUpToItsNewestThing() {
        #expect(RoomUnread.seenUpTo([.day(id: "d", label: "Today"), group("a", kit, at: [10, 40])]) == 40)
        #expect(RoomUnread.seenUpTo([]) == nil)
    }

    // MARK: Tap opens the chat at the turn

    @Test func aDucksMessageOpensItsChatAtTheTurnItCameFrom() {
        var m = message(by: kit)
        #expect(PondClick.target(message: m) == .duck("s1"))
        m.turnId = "t14"
        #expect(PondClick.target(message: m) == .turn(duck: "s1", turnId: "t14"))
        #expect(PondOpenTarget.turn(duck: "s1", turnId: "t14").duck == "s1")
    }

    @Test func aPersonsMessageOpensTheDuckItWentToAtThatTurn() {
        var m = message(by: .person("Anya"))
        #expect(PondClick.target(message: m) == nil)
        m.goesTo = "s2"; m.turnId = "t3"
        #expect(PondClick.target(message: m) == .turn(duck: "s2", turnId: "t3"))
    }

    @Test func aTaskCardOpensItsDucksChatAtTheTurnItBeganIn() {
        var card = RoomTaskCard(taskId: "j", title: "T", state: .done, stateLabel: "Done", opens: "s1", discussion: [], excluded: [], canDrop: false)
        #expect(PondClick.open(task: card) == .duck("s1"))
        card.opensTurn = "t9"
        #expect(PondClick.open(task: card) == .turn(duck: "s1", turnId: "t9"))
        card.opens = nil
        #expect(PondClick.open(task: card) == nil)
    }

    @Test func turnIdsComeBareFromEitherSpelling() {
        #expect(RoomTurnId.bare("s1:t14", session: "s1") == "t14")
        #expect(RoomTurnId.bare("t14", session: "s1") == "t14")
        #expect(RoomTurnId.bare("t14", session: "") == "t14")
    }

    @Test func replyQuotesOneLineAndMentionsTheDuckByName() throws {
        let sage = RoomMessageAuthor.duck(threads[0], sessionId: "s1", fallbackName: "Chat title", agent: nil)
        let reply = try #require(RoomRowPlan.reply(to: sage, quoting: "\r\n  The build passed. \r\n Details below."))
        #expect(reply.quote == "The build passed.")
        #expect(reply.mention == "@Sage 2")
        let draft = reply.insertingMention(in: "How long did it take?", replacing: nil)
        #expect(draft == "@Sage 2 How long did it take?")
        #expect(reply.messageText(draft) == "> “The build passed.”\n\n@Sage 2 How long did it take?")
    }

    @Test func replyToAPersonShortensLongQuotesAtACharacterBoundary() throws {
        let emoji = "👩🏽‍💻"
        let text = String(repeating: emoji, count: 95)
        let reply = try #require(RoomRowPlan.reply(to: .person("Anya Rao"), quoting: text))
        #expect(reply.quote == String(repeating: emoji, count: 89) + "…")
        #expect(reply.insertingMention(in: "", replacing: nil) == "@Anya Rao ")
        #expect(RoomMention.active(in: reply.insertingMention(in: "", replacing: nil)) == nil)
    }

    @Test func replyingToAnotherBubbleReplacesThePreviousMentionAndKeepsTheDraft() throws {
        let first = try #require(RoomRowPlan.reply(to: .person("Anya"), quoting: "First"))
        let second = try #require(RoomRowPlan.reply(to: .person("Sam"), quoting: "Second"))
        let draft = first.insertingMention(in: "I have a question.", replacing: nil)
        #expect(first.insertingMention(in: draft, replacing: first) == draft)
        #expect(second.insertingMention(in: draft, replacing: first) == "@Sam I have a question.")
        #expect(second.insertingMention(in: "@Anyabelle is ready.", replacing: first) == "@Sam @Anyabelle is ready.")
    }

    @Test func quotedMentionsStayInTheQuoteAndReplyingAgainQuotesTheNewMessage() throws {
        let reply = try #require(RoomRowPlan.reply(to: .person("Anya"), quoting: "I checked with @Dot 2"))
        let text = reply.messageText("@Anya Thanks!")
        #expect(text == "> “I checked with ＠Dot 2”\n\n@Anya Thanks!")
        #expect(RoomRowPlan.reply(to: .person("Sam"), quoting: text)?.quote == "@Anya Thanks!")
    }

    @Test func replyRequiresAnotherSenderAndNonemptyText() {
        #expect(RoomRowPlan.reply(to: .me, quoting: "My message") == nil)
        #expect(RoomRowPlan.reply(to: .person("Anya"), quoting: " \r\n\t ") == nil)
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

    @Test func rowBarLivesInTheGapAndAddsNoHeight() {
        // Between 10 and 14 points, so the feed stays concise, continuation rows included (the gap is the same for them).
        #expect((10.0...14.0).contains(RoomRowPlan.rowGap))
        #expect(RoomRowPlan.barHeight <= 20)
        #expect(RoomRowPlan.glyphClearsNextRow)
        #expect(RoomRowPlan.barOverlapOfNext <= RoomRowPlan.rowPad)
        #expect(RoomRowPlan.barOpacity(hover: false, focusWithin: false) == 0)
        #expect(RoomRowPlan.barOpacity(hover: true, focusWithin: false) == 1)
        #expect(RoomRowPlan.barOpacity(hover: false, focusWithin: true) == 1)
    }
}
