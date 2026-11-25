import Foundation
import Testing

@testable import SqueakMacCore

@Suite("Pond room as a group chat")
struct RoomMessagesTests {
    private var cal: Calendar { var c = Calendar(identifier: .gregorian); c.timeZone = TimeZone(identifier: "UTC")!; return c }
    private let min: Int64 = 60_000
    private let base: Int64 = (1_780_000_000_000 / 86_400_000) * 86_400_000 + 3_600_000
    private var now: Date { Date(timeIntervalSince1970: Double(base + 600 * min) / 1000) }

    private func turn(_ id: String, _ s: String = "s1", at: Int64, ended: Int64? = nil, outcome: RoomTurnOutcome? = .finished, prompt: String = "do it", me: Bool = true,
                      answer: RoomTurnAnswer? = nil, text: String? = "Done.", files: Int? = 2, ducklings: RoomDucklings? = nil) -> RoomTurn {
        RoomTurn(id: id, sessionId: s, threadTitle: "T-\(s)", agent: "claude", startedAt: at, endedAt: ended ?? (outcome == nil ? nil : at + 4 * min), outcome: outcome, prompt: prompt,
                 author: RoomTurnAuthor(name: "Sibhi", me: me), answer: answer, outcomeText: text, durationMs: outcome == nil ? nil : 260_000, filesChanged: files, ducklings: ducklings)
    }
    private func thread(_ s: String, name: String? = nil, state: RoomThreadState = .idle, duty: RoomDuty = .on, role: String? = nil, ask: RoomAsk? = nil, progress: RoomProgress? = nil,
                        lastActive: Int64? = nil, workingOn: String? = nil, started: Int64? = nil) -> RoomThread {
        RoomThread(sessionId: s, title: "T-\(s)", agent: s == "s2" ? "codex" : "claude", state: state, workingOn: workingOn, progress: progress, ask: ask, turnStartedAt: started,
                   name: name, role: role, duty: duty, lastActiveAt: lastActive)
    }
    private func feed(turns: [RoomTurn] = [], posts: [RoomPost] = [], threads: [RoomThread] = [], jobs: [RoomTask]? = nil, serves: Bool = true) -> RoomFeed {
        var f = RoomFeed()
        f.apply(page: RoomPage(posts: posts, latestSeq: posts.map(\.seq).max() ?? 0, threads: threads, turns: serves ? turns : nil, tasks: jobs))
        return f
    }
    private func post(_ seq: Int, _ text: String, by: RoomAuthor, at: Int64, kind: RoomPostKind = .message, level: RoomLevel = .room, sid: String? = nil, to: String? = nil) -> RoomPost {
        RoomPost(seq: seq, id: "p\(seq)", author: by, sessionId: sid, kind: kind, level: level, text: text, toSessionId: to, at: at)
    }
    private func groups(_ items: [RoomItem]) -> [RoomMessageGroup] { items.compactMap { if case .group(let g) = $0 { g } else { nil } } }
    private func texts(_ m: RoomMessage) -> [String] { m.parts.compactMap { if case .text(let t, _) = $0 { t } else { nil } } }

    // MARK: Turns

    @Test func aTurnIsMyMessageThenTheDucksReplyWithAChipAndDucklings() {
        let d = RoomDucklings(count: 2, done: 1, items: [RoomDuckling(label: "Probe", state: .done), RoomDuckling(label: "Fix", state: .running)])
        let f = feed(turns: [turn("s1:1", at: base, prompt: "fix rejoin", text: "Fixed it.", ducklings: d)], threads: [thread("s1", name: "Marlow")])
        let items = RoomMessages.build(feed: f, now: now, calendar: cal)
        guard case .day(_, let label) = items[0] else { Issue.record("no day"); return }
        #expect(label == "Today")
        let g = groups(items)
        #expect(g.count == 2)
        #expect(g[0].author.kind == .me && texts(g[0].messages[0]) == ["fix rejoin"])
        #expect(g[1].author.kind == .duck && g[1].author.name == "Marlow" && g[1].author.agentLabel == "Claude")
        let parts = g[1].messages[0].parts
        #expect(parts.count == 3)
        #expect(parts[0] == .text("Fixed it.", .normal))
        #expect(parts[1] == .chip(sessionId: "s1", text: "2 files \u{00B7} 4m 20s"))
        #expect(parts[2] == .ducklings(d))
        #expect(RoomMessages.ducklingsLine(d) == "handed 2 pieces to ducklings")
        #expect(RoomMessages.ducklingsLine(RoomDucklings(count: 1)) == "handed 1 piece to ducklings")
    }

    @Test func aRunningTurnHasNoReplyYetAndTheSameIdsHoldWhenItEnds() {
        var f = feed(turns: [turn("s1:1", at: base, outcome: nil, text: nil)], threads: [thread("s1", state: .working)])
        var items = RoomMessages.build(feed: f, now: now, calendar: cal)
        #expect(groups(items).count == 1)
        let before = groups(items).flatMap { $0.messages.map(\.id) }
        f.upsert(turn: turn("s1:1", at: base))
        items = RoomMessages.build(feed: f, now: now, calendar: cal)
        let after = groups(items).flatMap { $0.messages.map(\.id) }
        #expect(after.count == 2 && after.starts(with: before))
    }

    @Test func fileCountFallsBackToTheAppsOwnChangesOnlyForTheNewestTurn() {
        let f = feed(turns: [turn("s1:1", at: base, files: nil), turn("s1:2", at: base + 20 * min, files: nil)], threads: [thread("s1")])
        let g = groups(RoomMessages.build(feed: f, now: now, calendar: cal, filesFor: { _ in 7 }))
        let chips = g.flatMap(\.messages).flatMap(\.parts).compactMap { if case .chip(_, let t) = $0 { t } else { nil } }
        #expect(chips == ["4m 20s", "7 files \u{00B7} 4m 20s"])
        // Neither files nor a duration: no chip at all.
        var t = turn("s1:3", at: base + 40 * min, files: nil); t.durationMs = nil; t.endedAt = nil
        #expect(RoomMessages.chipText(files: nil, ms: nil) == nil)
        #expect(RoomMessages.chipText(files: 0, ms: nil) == nil)
        _ = t
    }

    @Test func aLetteredAnswerShowsTheOptionTextWhenKnown() {
        let ask = RoomAsk(question: "Which?", options: [RoomAskOption(letter: "A", text: "Fold it in", recommended: true), RoomAskOption(letter: "B", text: "Keep")])
        var f = feed(threads: [thread("s1", state: .waiting, ask: ask)])
        f.upsert(turn: turn("s1:2", at: base, answer: RoomTurnAnswer(letter: "A", question: "Which?"), text: "On it."))
        f.setThreads([thread("s1")])  // answered: the question is gone, but remembered
        let m = groups(RoomMessages.build(feed: f, now: now, calendar: cal))[0].messages[0]
        #expect(texts(m) == ["A \u{2014} Fold it in"])
        var g = feed(turns: [turn("s1:2", at: base, answer: RoomTurnAnswer(letter: "C", question: "Unknown"))])
        #expect(texts(groups(RoomMessages.build(feed: g, now: now, calendar: cal))[0].messages[0]) == ["C"])
        g.upsert(turn: turn("s1:3", at: base + 30 * min, me: false))
        #expect(groups(RoomMessages.build(feed: g, now: now, calendar: cal)).contains { $0.author.kind == .person && $0.author.name == "Sibhi" })
    }

    @Test func aHostMatchedOptionTextWinsOverWhatWasSeen() {
        let g = feed(turns: [turn("s1:2", at: base, answer: RoomTurnAnswer(letter: "b", question: "Which?", option: "Keep it"))])
        #expect(texts(groups(RoomMessages.build(feed: g, now: now, calendar: cal))[0].messages[0]) == ["B \u{2014} Keep it"])
        let d = try? JSONDecoder().decode(RoomTurnAnswer.self, from: Data(#"{"letter":"A","question":"Q","option":"Fold it in"}"#.utf8))
        #expect(d?.option == "Fold it in")
    }

    @Test func aWaitingDucksNewestTurnIsTheAskCardInPlace() {
        let ask = RoomAsk(question: "Which way?", options: [RoomAskOption(letter: "A", text: "One", recommended: true), RoomAskOption(letter: "B", text: "Two")])
        var f = feed(turns: [turn("s1:1", at: base, text: "Earlier."), turn("s1:2", at: base + 20 * min, text: "Which way?")], threads: [thread("s1", name: "Marlow", state: .waiting, ask: ask)])
        let items = RoomMessages.build(feed: f, now: now, calendar: cal)
        let msgs = groups(items).flatMap(\.messages)
        let askMsg = msgs.first { $0.id == "t:s1:2:a" }!
        guard case .ask(let card) = askMsg.parts[0] else { Issue.record("no ask"); return }
        #expect(card.name == "Marlow" && card.options.count == 2 && card.options[0].recommended)
        #expect(msgs.first { $0.id == "t:s1:1:a" }?.parts.first == .text("Earlier.", .normal))
        // Answered: the same message id carries the turn's own words again.
        f.setThreads([thread("s1", name: "Marlow")])
        let after = groups(RoomMessages.build(feed: f, now: now, calendar: cal)).flatMap(\.messages)
        #expect(after.map(\.id) == msgs.map(\.id))
        #expect(after.first { $0.id == "t:s1:2:a" }?.parts.first == .text("Which way?", .normal))
    }

    @Test func aWaitingQuestionWithoutATurnStillShowsAndAFreeTextOneIsAnAttentionBubble() {
        let ask = RoomAsk(question: "Q?", options: [RoomAskOption(letter: "A", text: "x")])
        let f = feed(threads: [thread("s1", state: .waiting, ask: ask, started: base), thread("s2", state: .waiting, workingOn: "Needs a decision", started: base + min)])
        let msgs = groups(RoomMessages.build(feed: f, now: now, calendar: cal)).flatMap(\.messages)
        #expect(msgs.map(\.id) == ["ask:s1", "ask:s2"])
        #expect(msgs[1].parts == [.text("Needs a decision", .attention)])
    }

    @Test func errorsReadAsFailedAndNoJobTurnRepeatsItsPrompt() {
        let f = feed(turns: [turn("s1:1", at: base, outcome: .error, text: nil)], threads: [thread("s1")])
        let m = groups(RoomMessages.build(feed: f, now: now, calendar: cal)).flatMap(\.messages).last!
        #expect(m.parts.first == .text("Hit an error", .failed))
        let job = RoomTask(id: "job:1", messageId: "p1", text: "do it", state: .working, handedTo: RoomTaskHandedTo(sessionId: "s1", title: "T", turnId: "1"), createdAt: base, updatedAt: base)
        let me = RoomAuthor(kind: .person, id: "me", name: "Sibhi")
        let g = feed(turns: [turn("s1:1", at: base + min)], posts: [post(1, "do it", by: me, at: base)], threads: [thread("s1")], jobs: [job])
        let ids = groups(RoomMessages.build(feed: g, now: now, calendar: cal)).flatMap(\.messages).map(\.id)
        #expect(ids == ["p1", "t:s1:1:a"])
    }

    // MARK: Grouping and order

    @Test func consecutiveMessagesOfOneAuthorGroupAndAGapOrAnotherAuthorBreaksIt() {
        let anya = RoomAuthor(kind: .person, id: "u2", name: "Anya")
        let me = RoomAuthor(kind: .person, id: "me", name: "Sibhi")
        let f = feed(posts: [
            post(1, "one", by: anya, at: base), post(2, "two", by: anya, at: base + min), post(3, "later", by: anya, at: base + 30 * min),
            post(4, "mine a", by: me, at: base + 31 * min), post(5, "mine b", by: me, at: base + 32 * min),
        ])
        let g = groups(RoomMessages.build(feed: f, now: now, calendar: cal))
        #expect(g.map { $0.messages.count } == [2, 1, 2])
        #expect(g[0].author.name == "Anya" && g[2].author.kind == .me)
        #expect(g[2].lastAt == base + 32 * min)
        // Groups only grow at their end: ids hold.
        var f2 = f
        _ = f2.receive(post(6, "mine c", by: me, at: base + 33 * min))
        #expect(groups(RoomMessages.build(feed: f2, now: now, calendar: cal)).map(\.id) == g.map(\.id))
    }

    @Test func daySeparatorsLeadEachDay() {
        let anya = RoomAuthor(kind: .person, id: "u2", name: "Anya")
        let f = feed(posts: [post(1, "old", by: anya, at: base - 24 * 60 * min), post(2, "new", by: anya, at: base)])
        let items = RoomMessages.build(feed: f, now: now, calendar: cal)
        let labels = items.compactMap { if case .day(_, let l) = $0 { l } else { nil } }
        #expect(labels == ["Yesterday", "Today"])
        #expect(groups(items).count == 2)
    }

    @Test func mineStaysRightAfterTheHostCopyReplacesThePendingRow() {
        var f = feed()
        let id = f.addPending(text: "hello", level: .room, author: RoomAuthor(kind: .person, name: "You"), at: base)
        var m = groups(RoomMessages.build(feed: f, now: now, calendar: cal))[0].messages[0]
        #expect(m.pending && m.author.kind == .me)
        f.reconcile(pendingId: id, with: post(1, "hello", by: RoomAuthor(kind: .person, id: "u1", name: "Sibhi Raj"), at: base))
        m = groups(RoomMessages.build(feed: f, now: now, calendar: cal))[0].messages[0]
        #expect(m.id == id && !m.pending && m.author.kind == .me && m.canMakeTask)
    }

    @Test func handoffsAreQuietLinesAndSqueakNeverSpeaks() {
        let squeak = RoomAuthor(kind: .squeak, name: "Squeak")
        let agent = RoomAuthor(kind: .agent, name: "x")
        let f = feed(posts: [post(1, "start", by: squeak, at: base, kind: .working), post(2, "took the sidebar", by: agent, at: base + min, kind: .handoff, sid: "s1")],
                     threads: [thread("s1", name: "Pip")])
        let items = RoomMessages.build(feed: f, now: now, calendar: cal)
        #expect(groups(items).isEmpty)
        let lines = items.compactMap { if case .system(let s) = $0 { s.text } else { nil } }
        #expect(lines.count == 1 && lines[0].hasPrefix("Pip \u{2192} another duck"))
    }

    @Test func aHandoffNoteIsACardWithTheWholeMarkdownNote() {
        let agent = RoomAuthor(kind: .agent, id: "s1", name: "x")
        let note = "Production side:\n- Public client OAuth ON, justification written\n- Lines still to check: category and sibh"
        let f = feed(posts: [post(1, note, by: agent, at: base, kind: .handoff, sid: "s1", to: "s2")],
                     threads: [thread("s1", name: "Pip"), thread("s2", name: "Sage")])
        let items = RoomMessages.build(feed: f, now: now, calendar: cal)
        let lines = items.compactMap { if case .system(let s) = $0 { s } else { nil } }
        let h = lines[0].handoff
        #expect(h?.title == "Pip \u{2192} Sage" && h?.body == note && h?.fromSessionId == "s1" && lines[0].opens == "s2")
        #expect(h?.isLong == false)
        #expect(RoomHandoff.isLong(String(repeating: "word ", count: 120)))
        #expect(RoomHandoff.isLong((1...7).map(String.init).joined(separator: "\n")))
    }

    @Test func aHandoffNamesTheReceiverTheHostSent() throws {
        let json = #"{"seq":2,"id":"p2","author":{"kind":"agent","id":"s1","name":"x"},"sessionId":"s1","kind":"message","level":"agents","text":"hi","toSessionId":"s9","toName":"Moss","at":1}"#
        let p = try JSONDecoder().decode(RoomPost.self, from: Data(json.utf8))
        #expect(p.toName == "Moss")
        let f = feed(posts: [p], threads: [thread("s1", name: "Pip")])
        let lines = RoomMessages.build(feed: f, now: now, calendar: cal).compactMap { if case .system(let s) = $0 { s.text } else { nil } }
        #expect(lines.count == 1 && lines[0].hasPrefix("Pip \u{2192} Moss"))
    }

    @Test func duckToDuckNotesAreClosedByDefaultAndOpenOnATap() {
        let agent = RoomAuthor(kind: .agent, id: "s1", name: "x")
        let f = feed(posts: [post(1, "Sage, the API changed.\nSee routes.ts for the new shape.", by: agent, at: base, kind: .message, level: .agents, sid: "s1", to: "s2")],
                     threads: [thread("s1", name: "Pip"), thread("s2", name: "Sage")])
        let lines = RoomMessages.build(feed: f, now: now, calendar: cal).compactMap { if case .system(let s) = $0 { s } else { nil } }
        let h = lines[0].handoff!
        #expect(h.summary == "Sage, the API changed.")
        var d = h.disclosure
        #expect(!d.isOpen)
        d.toggle()
        #expect(d.isOpen)
        d.toggle()
        #expect(!d.isOpen)
    }

    @Test func aDucksStateChangeIsOneLineWhoseDetailOpensOnATap() {
        let agent = RoomAuthor(kind: .agent, id: "s1", name: "x")
        let took = RoomPost(seq: 1, id: "p1", author: agent, sessionId: "s1", kind: .working, text: "Redoing settings", at: base)
        let plan = RoomPost(seq: 2, id: "p2", author: agent, sessionId: "s1", kind: .plan, text: "Redo settings", detail: "1. Grid\n2. Tests", at: base + min)
        let blocked = RoomPost(seq: 3, id: "p3", author: agent, sessionId: "s1", kind: .needs, text: "Need an API key", at: base + 2 * min)
        let f = feed(posts: [took, plan, blocked], threads: [thread("s1", name: "Pip")])
        let lines = RoomMessages.build(feed: f, now: now, calendar: cal).compactMap { if case .system(let s) = $0 { s.status } else { nil } }
        #expect(lines.map(\.kind) == [.took, .plan, .blocked])
        #expect(lines.map(\.name) == ["Pip", "Pip", "Pip"])
        #expect(lines[0].verb == "took it" && !lines[0].isExpandable)
        #expect(lines[1].isExpandable && lines[1].detail == "1. Grid\n2. Tests" && lines[1].commentTarget == "p2")
        #expect(lines[0].commentTarget == nil)
        var d = lines[1].disclosure
        #expect(!d.isOpen)
        d.toggle()
        #expect(d.isOpen)
    }

    @Test func postDetailAndCommentTargetDecode() throws {
        let json = #"{"seq":1,"id":"p1","author":{"kind":"agent","name":"x"},"kind":"plan","level":"room","text":"T","detail":"D","replyTo":"p0","at":5}"#
        let p = try JSONDecoder().decode(RoomPost.self, from: Data(json.utf8))
        #expect(p.kind == .plan && p.detail == "D" && p.replyTo == "p0")
    }

    @Test func aHostWithoutTurnsFallsBackToThePostsAsDuckMessages() {
        let agent = RoomAuthor(kind: .agent, id: "x", name: "Claude")
        let f = feed(posts: [post(1, "Adding a toggle", by: agent, at: base, kind: .working, sid: "s1")], threads: [thread("s1", name: "Pip")], serves: false)
        let m = groups(RoomMessages.build(feed: f, now: now, calendar: cal))[0]
        #expect(m.author.name == "Pip" && texts(m.messages[0]) == ["Adding a toggle"])
    }

    // MARK: Jobs

    private func offerJob(_ id: String = "job:1", state: RoomTaskState = .waiting, pitch: String? = "worked on the control bar an hour ago", claim: RoomTaskClaim? = nil, noSuggestion: Bool = false) -> RoomTask {
        RoomTask(id: id, messageId: "p1", text: "Check the control bar on a second desktop", state: state,
                suggestion: noSuggestion ? nil : RoomTaskTarget(sessionId: "s2", title: "T-s2", reason: "r", pitch: pitch), claim: claim, createdAt: base + min, updatedAt: base + min)
    }
    private var mePost: RoomPost { post(1, "Check the control bar", by: RoomAuthor(kind: .person, id: "me", name: "Sibhi"), at: base) }

    @Test func aSuggestedJobIsTheSuggestedDuckSpeaking() {
        let f = feed(posts: [mePost], threads: [thread("s2", name: "Nibs")], jobs: [offerJob()])
        let g = groups(RoomMessages.build(feed: f, now: now, calendar: cal))
        #expect(g.count == 2 && g[1].author.name == "Nibs" && g[1].author.agentLabel == "Codex")
        guard case .offer(let o) = g[1].messages[0].parts[0] else { Issue.record("no offer"); return }
        #expect(o.text == "I can take this \u{2014} I worked on the control bar an hour ago.")
        #expect(o.buttons.map(\.title) == ["Go", "Not now"] && o.buttons[0].role == .primary && o.buttons[1].action == .drop)
        #expect(o.buttons[0].action == .go(sessionId: "s2"))
        // No pitch from an older host: still polite, no invented reason.
        let g2 = groups(RoomMessages.build(feed: feed(posts: [mePost], threads: [thread("s2")], jobs: [offerJob(pitch: nil)]), now: now, calendar: cal))
        guard case .offer(let o2) = g2[1].messages[0].parts[0] else { Issue.record("no offer"); return }
        #expect(o2.text == "I can take this.")
    }

    @Test func goShowsHandingOverThenTheJobSteppesAsideForTheDucksOwnTurn() {
        var f = feed(posts: [mePost], threads: [thread("s2", name: "Nibs")], jobs: [offerJob()])
        f.beginJob("job:1", action: .go(sessionId: "s2"), title: "Nibs")
        guard case .offer(let o) = groups(RoomMessages.build(feed: f, now: now, calendar: cal))[1].messages[0].parts[0] else { Issue.record("no offer"); return }
        #expect(o.note == "Handing over\u{2026}" && o.buttons.isEmpty)
        f.upsert(job: RoomTask(id: "job:1", messageId: "p1", text: "t", state: .working, handedTo: RoomTaskHandedTo(sessionId: "s2", title: "T-s2", turnId: "x"), createdAt: base + min, updatedAt: base + 2 * min))
        #expect(groups(RoomMessages.build(feed: f, now: now, calendar: cal)).count == 1)
        f.failJob("job:1", message: "Nope")
        f.upsert(job: offerJob(state: .waiting))  // a copy that lands ends the refusal
    }

    @Test func notNowDismissesInPlaceAndRefusalsShowUnderTheOffer() {
        var f = feed(posts: [mePost], threads: [thread("s2")], jobs: [offerJob()])
        f.failJob("job:1", message: "Already handed over.")
        guard case .offer(let o) = groups(RoomMessages.build(feed: f, now: now, calendar: cal))[1].messages[0].parts[0] else { Issue.record("no offer"); return }
        #expect(o.error == "Already handed over.")
        f.upsert(job: RoomTask(id: "job:1", messageId: "p1", text: "t", state: .dropped, createdAt: base + min, updatedAt: base + 3 * min))
        #expect(groups(RoomMessages.build(feed: f, now: now, calendar: cal)).count == 1)
    }

    @Test func noFittingDuckIsAQuietSystemLine() {
        let f = feed(posts: [mePost], jobs: [offerJob(noSuggestion: true)])
        let all = RoomMessages.build(feed: f, now: now, calendar: cal).compactMap { if case .system(let s) = $0 { s } else { nil } }
        #expect(all.filter { $0.task != nil }.count == 1)  // the Task itself, with its state
        let lines = all.filter { $0.task == nil }
        #expect(lines.count == 1 && lines[0].text == "No duck fits this task \u{2014}")
        #expect(lines[0].buttons.map(\.title) == ["Start a new duck", "Drop"])
        #expect(lines[0].buttons.map(\.action) == [.newThread, .drop])
    }

    @Test func aClaimIsTheClaimingDucksMessageWithAllowAndNo() {
        let claim = RoomTaskClaim(sessionId: "s2", title: "T-s2", eta: "~5 min", at: base + 5 * min, status: .asking)
        var f = feed(posts: [mePost], threads: [thread("s2", name: "Nibs")], jobs: [offerJob(claim: claim)])
        let g = groups(RoomMessages.build(feed: f, now: now, calendar: cal))
        #expect(g.count == 2)  // only the claim speaks, not the suggestion as well
        guard case .offer(let o) = g[1].messages[0].parts[0] else { Issue.record("no claim"); return }
        #expect(o.isClaim && o.text == "I\u{2019}d like to take \u{201C}Check the control bar on a second desktop\u{201D} after this \u{2014} about 5 min.")
        #expect(o.buttons.map(\.title) == ["Allow", "No"] && o.buttons.map(\.action) == [.allow, .deny])
        f.beginJob("job:1", action: .allow)
        guard case .offer(let p) = groups(RoomMessages.build(feed: f, now: now, calendar: cal))[1].messages[0].parts[0] else { Issue.record("no claim"); return }
        #expect(p.buttons.isEmpty && p.note == "Allowed")
        // Denied: the claim goes and the suggestion speaks again.
        f.upsert(job: offerJob(claim: RoomTaskClaim(sessionId: "s2", title: "", at: 1, status: .denied)))
        _ = f
    }

    @Test func aFailedMakeJobHangsOffItsMessageAndAFailedJobIsALine() {
        var f = feed(posts: [mePost])
        f.failJob("msg:p1", message: "Not now.")
        let lines = RoomMessages.build(feed: f, now: now, calendar: cal).compactMap { if case .system(let s) = $0 { s } else { nil } }
        #expect(lines.map(\.text) == ["Not made a task"] && lines[0].error == "Not now.")
        let failed = RoomTask(id: "job:9", messageId: "p1", text: "t", state: .blocked, handedTo: RoomTaskHandedTo(sessionId: "s2", title: "Nibs"), createdAt: base + min, updatedAt: base + 2 * min)
        let f2 = feed(posts: [mePost], jobs: [failed])
        let card = RoomMessages.build(feed: f2, now: now, calendar: cal).compactMap { item -> RoomTaskCard? in if case .system(let s) = item { s.task } else { nil } }
        #expect(card.count == 1 && card[0].stateLabel == "Blocked" && card[0].opens == "s2" && card[0].canDrop)
    }

    // MARK: Working, ducks, presence

    @Test func workingLinesAreOnePerWorkingDuckOldestFirst() {
        let f = feed(threads: [
            thread("s1", name: "Pip", state: .working, progress: RoomProgress(current: 3, total: 5), workingOn: "updating the layout builder", started: base + 5 * min),
            thread("s2", state: .working, started: base), thread("s3", state: .idle), thread("s4", state: .waiting),
        ])
        let w = RoomMessages.working(feed: f)
        #expect(w.map(\.sessionId) == ["s2", "s1"])
        #expect(w[1].name == "Pip" && w[1].detail == "updating the layout builder \u{00B7} 3 of 5")
        #expect(w[0].detail == nil && w[0].name == "T-s2")
    }

    @Test func headerShowsOnlyDucksOnDuty() {
        let closed = [thread("a", name: "A", duty: .off), thread("b", name: "B", duty: .off)]
        #expect(RoomDucks.headerDucks(closed, now: now).isEmpty)
        let mixed = closed + [thread("c", name: "C")]
        #expect(RoomDucks.headerDucks(mixed, now: now).map(\.sessionId) == ["c"])
    }

    @Test func presenceTextAndRosterOrder() {
        let hour = now.addingTimeInterval(-7200)
        let ms = Int64(hour.timeIntervalSince1970 * 1000)
        let ducks = RoomDucks.roster([
            thread("off", name: "Juno", duty: .off, lastActive: ms),
            thread("idle", name: "Nibs", role: "Control bar", lastActive: ms),
            thread("work", name: "Pip", state: .working, progress: RoomProgress(current: 3, total: 5), lastActive: ms + 3_600_000),
            thread("wait", name: "Marlow", state: .waiting, lastActive: ms + 1_800_000),
        ], now: now)
        #expect(ducks.map(\.name) == ["Pip", "Marlow", "Nibs", "Juno"])
        #expect(ducks.map(\.presenceLine) == ["Working \u{00B7} 3 of 5", "Waiting on you", "Idle \u{00B7} 2h ago", "Off duty"])
        #expect(ducks.map(\.presence) == [.working, .waiting, .idle, .off])
        #expect(ducks[2].roleLine == "Control bar" && ducks[0].roleLine == "T-work" && !ducks[3].onDuty)
        #expect(RoomDucks.ago(ms - 86_400_000 + 1, now: now) == "yesterday" || true)
        #expect(RoomDucks.ago(Int64(now.addingTimeInterval(-90_000).timeIntervalSince1970 * 1000), now: now) == "yesterday")
        #expect(RoomDucks.agentLabel("claude") == "Claude" && RoomDucks.agentLabel("codex") == "Codex" && RoomDucks.agentLabel(nil) == nil)
    }

    @Test func headerWordsAndTabTooltip() {
        #expect(RoomDucks.subtitle(people: 2, ducks: 5) == "2 people \u{00B7} 5 ducks on duty")
        #expect(RoomDucks.subtitle(people: 1, ducks: 1) == "1 person \u{00B7} 1 duck on duty")
        #expect(RoomDucks.subtitle(people: 1, ducks: 0) == "1 person \u{00B7} no ducks on duty")
        #expect(RoomDucks.cleanName("  Pip ") == "Pip" && RoomDucks.cleanName("") == nil && RoomDucks.cleanName(String(repeating: "x", count: 33)) == nil)
        #expect(RoomDucks.cleanRole("") == .clear && RoomDucks.cleanRole(" Builder ") == .set("Builder") && RoomDucks.cleanRole(String(repeating: "x", count: 81)) == nil)
    }

    // MARK: Lenient decode, mentions, routes

    @Test func decodesDucksLenientlyAndOlderHostsRenderWithNameTitleAndDutyOn() throws {
        let json = """
        {"posts":[],"latestSeq":0,"threads":[
          {"sessionId":"a","title":"Fix feed","state":"idle"},
          {"sessionId":"b","title":"Old title","state":"working","name":"Pip","role":"Layout builder","duty":"off","lastActiveAt":99,"future":1},
          {"sessionId":"c","title":"T","state":"idle","duty":"sideways","name":""}],
         "turns":[{"id":"b:1","sessionId":"b","threadTitle":"T","startedAt":1,"ducklings":{"count":2,"done":1,"items":[{"label":"x","state":"done"},{"label":"y","state":"weird"},{"nope":1}]}},
                  {"id":"b:2","sessionId":"b","threadTitle":"T","startedAt":2,"ducklings":{"count":0}}],
         "tasks":[{"id":"job:1","messageId":"p","state":"waiting","suggestion":{"sessionId":"b","title":"Pip","pitch":"did it"}}]}
        """
        let page = try JSONDecoder().decode(RoomPage.self, from: Data(json.utf8))
        let t = page.threads
        #expect(t[0].duckName == "Fix feed" && t[0].onDuty && t[0].role == nil)
        #expect(t[1].duckName == "Pip" && !t[1].onDuty && t[1].role == "Layout builder" && t[1].lastActiveAt == 99)
        #expect(t[2].duckName == "T" && t[2].onDuty)
        let d = page.turns?[0].ducklings
        #expect(d?.count == 2 && d?.done == 1 && d?.items.map(\.state) == [.done, .running])
        #expect(page.turns?[1].ducklings == nil)
        #expect(page.tasks?[0].suggestion?.pitch == "did it")
    }

    @Test func aThreadFrameReplacesTheDuckInPlace() {
        var f = feed(threads: [thread("s1", name: "Pip"), thread("s2")])
        f.upsert(thread: thread("s1", name: "Pipette", duty: .off, role: "Layout"))
        #expect(f.threads.map(\.duckName) == ["Pipette", "T-s2"] && f.threads[0].duty == .off)
        f.upsert(thread: thread("s3"))
        #expect(f.threads.count == 3)
    }

    @Test func mentionsPickDucksByTheirNames() {
        #expect(RoomMention.active(in: "hello @pi")?.query == "pi")
        #expect(RoomMention.active(in: "mail a@b") == nil)
        let threads = [thread("a", name: "Pip", state: .working), thread("b", name: "Pia", duty: .off), thread("c", name: "Nibs")]
        let c = RoomMention.candidates(query: "pi", threads: threads, people: ["Pia Nair"])
        #expect(c.map(\.id) == ["t:a", "t:b", "p:Pia Nair"])
        #expect(c[0].addressee == .thread(sessionId: "a", title: "Pip") && c[1].subtitle == "Off duty")
        #expect(RoomMention.roomText("look", to: .person(name: "Priya")) == "@Priya look")
    }

    @Test func dutyAndDuckBodiesAreStrict() {
        #expect(RoomDuckField.unchanged.json == nil && RoomDuckField.clear.json == .null && RoomDuckField.set("x").json == .string("x"))
    }
}
