import Foundation
import Testing
@testable import SqueakMacCore

/// The owner's greenroom report (2026-11-26): the sidebar mark, the Pond Dashboard tile, the Duck badge and the board each
/// counted a failed chat differently, and the red mark led nowhere. One rule (`NeedsYou`, the host's `needs-you.ts`) now
/// names what needs the person; every surface below is a mapping of it.
@Suite("Needs you: the one rule and each surface's mapping")
struct NeedsYouTests {
    let now = Date(timeIntervalSince1970: 1_800_000_000)
    static let zoom = "Zoom SDK Video Subscription Instability"

    private func chat(_ id: String, _ state: SessionState, title: String? = nil, ago: TimeInterval = 600, seen: Bool = false, why: String? = nil) -> HostSession {
        var s = HostSession(
            key: SessionKey(provider: "squeak", hostSessionId: id), title: title ?? id, repoName: "greenroom", branch: "main", cwd: "/w/greenroom",
            agent: "claude", state: state, lastActivityAt: now.addingTimeInterval(-ago), alive: true)
        if seen { s.errorSeenAt = now.addingTimeInterval(-60) }
        s.failureText = why
        return s
    }

    // MARK: the rule

    @Test func namesEachReasonAndNothingElse() {
        #expect(NeedsYou.reason(of: chat("a", .blocked), now: now) == .answer)
        var approval = chat("b", .blocked); approval.awaitingApproval = true
        #expect(NeedsYou.reason(of: approval, now: now) == .approval)
        var plan = chat("c", .blocked); plan.pendingQuestion = PendingQuestion.planDetail
        #expect(NeedsYou.reason(of: plan, now: now) == .plan)
        #expect(NeedsYou.reason(of: chat("d", .error), now: now) == .failed)
        for quiet in [SessionState.finished, .working, .idle] { #expect(NeedsYou.reason(of: chat("e", quiet), now: now) == nil) }
    }

    @Test func aFailureStopsCountingWhenSeenAndAfterADayUntouched() {
        #expect(NeedsYou.reason(of: chat("a", .error, seen: true), now: now) == nil)
        let edge = NeedsYou.failedStaysFor
        #expect(NeedsYou.reason(of: chat("b", .error, ago: edge - 60), now: now) == .failed)
        #expect(NeedsYou.reason(of: chat("c", .error, ago: edge + 60), now: now) == nil)
        // No date to judge by: never hide a failure for want of one.
        var undated = chat("d", .error); undated.lastActivityAt = nil
        #expect(NeedsYou.reason(of: undated, now: now) == .failed)
    }

    // MARK: sidebar mark, rollup, board

    @Test func theSidebarMarkAndItsRollupFollowTheRule() {
        let fresh = chat("a", .error)
        let seen = chat("b", .error, seen: true)
        #expect(ChatMark.of(fresh, unread: false, now: now)?.kind == .failed)
        #expect(ChatMark.of(seen, unread: false, now: now) == nil)
        let rollup = StatusRollup.of(marks: [fresh, seen, chat("c", .finished)].map { ChatMark.of($0, unread: false, now: now) })
        // The pond says "1 needs you" and draws the failed mark (nothing waits, so no triangle).
        #expect(rollup.state == .failed && rollup.needsYou == 1)
        #expect(rollup.label(for: "greenroom") == "greenroom, 1 failed")
        let mixed = StatusRollup.of(marks: [fresh, chat("w", .blocked)].map { ChatMark.of($0, unread: false, now: now) })
        #expect(mixed.state == .waiting && mixed.needsYou == 2)
        #expect(PondRowMark.of(rollup, count: 4) == .error)
    }

    @Test func theBoardPutsAnUnseenFailureUnderNeedsYouAndReleasesASeenOne() {
        func lane(_ s: HostSession) -> DashboardLane {
            DashboardBoard.lane(for: SidebarTreeBuilder.build([s], now: now, includeEarlier: true).projects[0].workspaces[0], now: now)
        }
        #expect(lane(chat("a", .error, title: Self.zoom)) == .needsYou)
        #expect(lane(chat("a", .error, title: Self.zoom, seen: true)) != .needsYou)
        #expect(lane(chat("a", .error, ago: NeedsYou.failedStaysFor + 60)) != .needsYou)
    }

    // MARK: the sidebar mark's tooltip and click

    @Test func theMarkSaysWhichChatFailedAndWhereAClickGoes() {
        let failed = chat("z", .error, title: Self.zoom, why: "Squeak couldn't load this chat's earlier conversation.")
        let items = PondNeedsYou.items([chat("ok", .finished), failed, chat("seen", .error, seen: true)], title: { $0.title }, now: now)
        #expect(items.map(\.key.hostSessionId) == ["z"])
        #expect(PondNeedsYou.help(items) == "1 chat failed: \(Self.zoom)")
        #expect(items[0].sentence == "Failed: Squeak couldn't load this chat's earlier conversation.")
        #expect(PondNeedsYou.target(items) == .chat(failed.key))

        let several = PondNeedsYou.items(
            [chat("a", .error, ago: 30), chat("b", .error, ago: 20), chat("c", .blocked, ago: 10), chat("d", .error, ago: 5)], title: { $0.title }, now: now)
        #expect(several.map(\.title) == ["d", "c", "b", "a"], "newest first")
        #expect(PondNeedsYou.target(several) == .list)
        #expect(PondNeedsYou.help(several) == "4 chats need you: d, c, b and 1 more")
        #expect(PondNeedsYou.help(Array(several.filter { $0.reason == .failed })) == "3 chats failed: d, b, a")
        #expect(PondNeedsYou.target([]) == .nothing && PondNeedsYou.help([]) == "")
    }

    // MARK: the Pond Dashboard tile and the Ducks list

    private func duck(_ id: String, off: Bool = false, reason: String? = nil, failure: String? = nil, activity: PondDuckActivity = .idle) -> PondDuck {
        var d = PondDuck(id: "duck-\(id)", name: id.uppercased(), duty: off ? .off : .on, currentSessionId: id)
        d.activity = activity
        d.needsYou = reason != nil
        d.needsYouReason = reason
        d.failure = failure
        return d
    }

    @Test func theTileAndTheListCountTheFailedOffDutyDuckThatTheOldTileMissed() {
        // greenroom: Pickle on duty and idle, the Zoom chat's Duck off duty with an unseen failure.
        let ducks = [duck("pickle"), duck("zoom", off: true, reason: "failed", failure: "Couldn't load", activity: .error)]
        let sessions = [chat("pickle", .idle), chat("zoom", .error, title: Self.zoom)]
        let l = PondHomeLayout.buildRoster(ducks: ducks, sessions: sessions, detail: nil, me: "Me", hostIdFor: { $0.key.hostSessionId })
        #expect(l.count(in: .needsYou) == 1)
        let row = l.threads.first { $0.duckId == "duck-zoom" }!
        #expect(row.failed && row.failureText == "Couldn't load" && row.needsYou)
        #expect(PondDashboardScope.needsYou.includes(row))
        #expect(!PondDashboardScope.needsYou.includes(l.threads.first { $0.duckId == "duck-pickle" }!))
        // The host's counts agree: the same rule, any duty.
        let counts = PondCounts(onDuty: 1, working: 0, needsYou: 1, offDuty: 1, total: 2)
        #expect(counts.count(.needsYou) == 1)
    }

    @Test func aSeenFailureLeavesTheListAndCarriesNoRedMark() {
        let l = PondHomeLayout.buildRoster(
            ducks: [duck("zoom", off: true)], sessions: [chat("zoom", .error, seen: true)], detail: nil, me: "Me", hostIdFor: { $0.key.hostSessionId })
        #expect(l.count(in: .needsYou) == 0 && !l.threads[0].failed && l.threads[0].state == .finished)
        // On this Mac's own build path the row's state follows the rule too.
        #expect(PondThreadState(chat("x", .error, seen: true)) == .finished)
        #expect(PondThreadState(chat("x", .error)) == .failed)
    }

    @Test func decodesTheHostsRosterFieldsAndAnOldHostWithout() throws {
        let sent = #"{"id":"d","name":"","duty":"off","activity":"error","needsYou":true,"needsYouReason":"failed","failure":"Boom"}"#
        let d = try JSONDecoder().decode(PondDuck.self, from: Data(sent.utf8))
        #expect(d.needsYou && d.needsYouReason == "failed" && d.failure == "Boom")
        let old = try JSONDecoder().decode(PondDuck.self, from: Data(#"{"id":"d","name":"x","activity":"needsYou"}"#.utf8))
        #expect(old.needsYou && old.needsYouReason == nil)
        let quiet = try JSONDecoder().decode(PondDuck.self, from: Data(#"{"id":"d","name":"x","activity":"idle"}"#.utf8))
        #expect(!quiet.needsYou)
    }

    // MARK: the Duck badge

    @Test func aDucksFailureBadgeSaysWhyAndASeenOneIsGone() {
        let failed = duck("pickle", reason: "failed", failure: "Couldn't load", activity: .error)
        let model = DuckAvatarRow.build(roster: RoomRoster.roster([failed, duck("moss")]), place: .dashboard)
        let a = model.ducks.first { $0.id == "duck-pickle" }!
        #expect(a.failed && a.needsYou && a.opensChat)
        #expect(a.needsYouWords == "Failed: Couldn't load")
        let b = model.ducks.first { $0.id == "duck-moss" }!
        #expect(!b.failed && !b.needsYou && b.needsYouWords == nil)
        // Waiting keeps the triangle: needs you, but not failed.
        var waiting = duck("w", reason: "question", activity: .needsYou)
        waiting.statusLine = "Needs you"
        let w = DuckAvatarRow.build(roster: RoomRoster.roster([waiting]), place: .dashboard).ducks[0]
        #expect(w.needsYou && !w.failed && w.needsYouWords == "Waiting on you")
    }

    // MARK: the host's words reach the Mac

    @Test func theHostsSeenTimeAndFailureWordsReachTheChat() throws {
        let json = #"{"id":"6afc","status":"error","errorSeenAt":"2026-11-26T03:00:00.000Z","needsYou":{"reason":"failed","text":"Couldn't load"}}"#
        let s = try JSONDecoder().decode(NativeSession.self, from: Data(json.utf8))
        #expect(s.errorSeenAt != nil && s.failureText == "Couldn't load")
        let h = NativeAdapter.map(s, overlay: nil, workspaceName: nil, workspaceTitle: nil)
        #expect(h.errorSeenAt != nil && h.failureText == "Couldn't load" && h.state == .error)
        #expect(NeedsYou.reason(of: h, now: h.lastActivityAt ?? now) == nil, "seen: no longer counts")
        let plain = try JSONDecoder().decode(NativeSession.self, from: Data(#"{"id":"b","status":"error"}"#.utf8))
        #expect(plain.errorSeenAt == nil && plain.failureText == nil)
    }
}
