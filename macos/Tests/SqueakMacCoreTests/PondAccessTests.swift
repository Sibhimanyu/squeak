import Foundation
import Testing
@testable import SqueakMacCore

@Suite("A shared pond works like one's own")
struct PondAccessTests {
    private func access(_ role: PondRole, mine: Bool = false, starterName: String = "Aarav", asks: Bool? = nil) -> ThreadAccess {
        ThreadAccess(role: role, starter: "starter", me: mine ? "starter" : "me", starterName: starterName, asks: asks)
    }

    @Test func aMemberMessagesSteersAnswersAndReadsChangesOnSomeoneElsesThread() {
        let a = access(.member)
        for action in [ThreadAccess.Action.message, .steer, .answer, .viewChanges] { #expect(a.gate(action).enabled && a.gate(action).tooltip == nil) }
        #expect(a.composer(working: false) == .open(placeholder: "Message"))
        #expect(a.composer(working: true) == .open(placeholder: "Message, \u{21B5} queue \u{00B7} \u{2318}\u{21B5} steer"))
        #expect(a.canAnswer)
    }

    @Test func theOwnerOfThePondIsStillOnlyAMemberOnSomeoneElsesThread() {
        let a = access(.owner)
        #expect(!a.gate(.approve).enabled && !a.gate(.stop).enabled)
        #expect(a.gate(.message).enabled)
    }

    @Test func approveAndStopStayWithTheStarterAsDisabledControlsWithAReason() {
        let a = access(.member)
        #expect(a.gate(.approve) == ThreadAccess.Gate(enabled: false, tooltip: "Only Aarav can approve on their thread", visible: true))
        #expect(a.gate(.stop) == ThreadAccess.Gate(enabled: false, tooltip: "Only Aarav can stop on their thread", visible: true))
        #expect(access(.member, starterName: "").gate(.stop).tooltip == "Only the starter can stop on their thread")
        let mine = access(.member, mine: true)
        #expect(mine.gate(.approve).enabled && mine.gate(.stop).enabled && mine.gate(.approve).tooltip == nil)
    }

    @Test func aViewerWatchesOnlyAndTheComposerIsOneMutedLine() {
        let v = access(.viewer)
        #expect(v.composer(working: true) == .watchOnly(line: "You can watch this pond"))
        #expect(ThreadAccess.watchLine == "You can watch this pond")
        for action in [ThreadAccess.Action.message, .steer, .answer] { #expect(!v.gate(action).enabled) }
        #expect(!v.canAnswer)
        #expect(v.gate(.viewChanges).enabled)
    }

    @Test func aChatThatRunsWithoutAskingTakesOnlyItsStarter() {
        #expect(access(.member, asks: false).composer(working: false) == .closed(reason: "Only Aarav can message this thread while it runs without asking."))
        #expect(!access(.member, asks: false).gate(.message).enabled)
        #expect(access(.member, mine: true, asks: false).composer(working: false) == .open(placeholder: "Message"))
        #expect(access(.member, asks: true).gate(.message).enabled && access(.member, asks: nil).gate(.message).enabled)
    }

    @Test func onlyTheStarterTogglesPrivateAndOthersDoNotSeeIt() {
        #expect(access(.member, mine: true).gate(.togglePrivate).visible)
        #expect(!access(.member).gate(.togglePrivate).visible && !access(.member).gate(.togglePrivate).enabled)
        // no identity yet: never mine
        #expect(!ThreadAccess(role: .member, starter: "", me: nil, starterName: "").isMine)
    }

    @Test func aThreadThatIsNotMineSaysWhoseItIsAndWhereItRuns() {
        #expect(ThreadOwnership.line(starterName: "Aarav", isMine: false) == "Aarav\u{2019}s thread \u{00B7} runs on their Mac")
        #expect(ThreadOwnership.line(starterName: " ", isMine: false) == "A teammate\u{2019}s thread \u{00B7} runs on their Mac")
        #expect(ThreadOwnership.line(starterName: "Aarav", isMine: true) == nil)
        #expect(ThreadOwnership.tabAvatar(starterId: "m1", starterName: "Aarav Patel", isMine: true) == nil)
        let tab = ThreadOwnership.tabAvatar(starterId: "m1", starterName: "Aarav Patel", isMine: false)
        #expect(tab?.initials == "AP")
        #expect(ThreadOwnership.tabHelp(title: "Fix login", starterName: "Aarav", isMine: false) == "Fix login\nAarav\u{2019}s thread \u{00B7} runs on their Mac")
        #expect(ThreadOwnership.tabHelp(title: "Fix login", starterName: "Aarav", isMine: true) == "Fix login")
        #expect(ThreadOwnership.tabHelp(title: "", starterName: "", isMine: true) == "Thread")
    }
}

@Suite("Avatars and the group chat")
struct GroupChatTests {
    private func user(_ id: Int, _ by: String?) -> ThreadRow { .user(id: id, by: by, text: "m\(id)", at: nil) }
    private func agent(_ id: Int) -> ThreadRow { .agent(id: id, text: "a\(id)", at: nil) }
    private let names = ["me": "Sibhi R", "aa": "Aarav Patel", "starter": "Mira"]

    @Test func initialsAreTheFirstAndLastWordsAndQuestionMarkWithNoName() {
        #expect(PondAvatars.initials("Aarav Patel") == "AP" && PondAvatars.initials("mira") == "M")
        #expect(PondAvatars.initials("Sibhi Rajan Kumar") == "SK" && PondAvatars.initials("   ") == "?")
    }

    @Test func theColourIsStableFromTheMemberIdAndNeverInTheDucksBand() {
        let a = PondAvatars.spec(memberId: "abc123", name: "One")
        #expect(a == PondAvatars.spec(memberId: "abc123", name: "One"))
        #expect(a.hue == PondAvatars.spec(memberId: "abc123", name: "Renamed").hue)
        for i in 0..<400 {
            let h = PondAvatars.spec(memberId: "member-\(i)", name: "x").hue
            #expect(!PondTint.duckBand.contains(h) && h >= 0 && h < 360)
        }
        #expect(Set((0..<50).map { PondAvatars.spec(memberId: "m\($0)", name: "x").hue }).count > 10)
    }

    @Test func aThreadWithOnePersonSpeakingIsUnchanged() {
        let rows = [user(1, nil), agent(2), user(3, "starter"), agent(4)]
        #expect(!GroupChat.isGroup(rows, starter: "starter", me: "starter"))
        #expect(GroupChat.lay(rows, starter: "starter", me: "starter", nameOf: { names[$0] ?? "" }) == rows.map { .plain($0) })
    }

    @Test func anOutgoingMessageFromMeMakesItAGroupBeforeTheHostShowsIt() {
        let rows = [user(1, nil), agent(2)]
        #expect(!GroupChat.isGroup(rows, starter: "starter", me: "me"))
        #expect(GroupChat.isGroup(rows, starter: "starter", me: "me", pendingMine: true))
    }

    @Test func mineSitsOnTheRightAndOthersOnTheLeftWithTheNameOncePerRun() {
        let rows = [user(1, nil), user(2, nil), agent(3), user(4, "aa"), user(5, "aa"), user(6, "me"), user(7, "aa")]
        let out = GroupChat.lay(rows, starter: "starter", me: "me", nameOf: { names[$0] ?? "" })
        func message(_ i: Int) -> GroupChat.Message? { if case .message(_, let m)? = out.first(where: { $0.id == i }) { m } else { nil } }
        // the starter's own (no `by`) are the starter's, on the left: I am not the starter
        #expect(message(1)?.author == "starter" && message(1)?.side == .leading && message(1)?.showsName == true)
        #expect(message(2)?.showsName == false)
        // the agent's reply breaks the run and stays full width
        if case .plain(.agent)? = out.first(where: { $0.id == 3 }) {} else { Issue.record("the agent stays plain") }
        #expect(message(4)?.showsName == true && message(4)?.avatar.initials == "AP")
        #expect(message(5)?.showsName == false)
        #expect(message(6)?.side == .trailing && message(6)?.isMine == true && message(6)?.showsName == true)
        #expect(message(7)?.showsName == true && message(7)?.side == .leading)
        #expect(GroupChat.label(for: message(6)!, name: "Sibhi R") == "You")
        #expect(GroupChat.label(for: message(4)!, name: "Aarav Patel") == "Aarav Patel")
        #expect(GroupChat.label(for: message(4)!, name: "") == "A teammate")
        #expect(GroupChat.avatarSize == 22)
    }

    @Test func myMessagesAreOnTheRightWhenIAmTheStarterToo() {
        let rows = [user(1, nil), user(2, "aa")]
        let out = GroupChat.lay(rows, starter: "me", me: "me", nameOf: { names[$0] ?? "" })
        if case .message(_, let m)? = out.first, case .message(_, let n)? = out.last {
            #expect(m.side == .trailing && m.isMine && n.side == .leading && !n.isMine)
        } else { Issue.record("both are messages") }
    }

    @Test func theNewThreadPlaceLineIsFixedAndNamesTheOwner() {
        #expect(PondStartThread.noRemoteSharedLine(ownerName: "Sibhi") == "This pond has no Git remote, so new threads run on Sibhi\u{2019}s Mac")
        #expect(PondStartThread.noRemoteSharedLine(ownerName: nil) == "This pond has no Git remote, so new threads run on the owner\u{2019}s Mac")
        let shared = PondSummary(id: "p", name: "Site", role: .member)
        var withOwner = shared
        withOwner.ownerName = "Sibhi"
        #expect(PondStartThread.offer(for: withOwner) == .shareOnly(why: "This pond has no Git remote, so new threads run on Sibhi\u{2019}s Mac"))
        // mine, or with a remote: the older words
        #expect(PondStartThread.offer(for: PondSummary(id: "p", name: "Mine", role: .owner)) == .shareOnly(why: PondStartThread.noRemote))
        #expect(PondStartThread.offer(for: PondSummary(id: "p", name: "Site", role: .member, gitRemote: "git@x:o.git")) == .start)
    }

    @Test func aSharedThreadRunsOnTheOwnersMacAnyFolderAnOwnThreadNeedsARemote() {
        var pond = PondSummary(id: "p", name: "Site", role: .member)
        pond.ownerName = "Sibhi"
        let none = PondStartThread.places(for: pond)
        #expect(none.map(\.kind) == [.shared, .own])
        #expect(none[0].enabled && none[0].detail == "Runs on Sibhi\u{2019}s Mac, any folder")
        #expect(!none[1].enabled && none[1].detail == PondStartThread.noRemoteSharedLine(ownerName: "Sibhi"))
        pond.gitRemote = "git@x:o.git"
        let with = PondStartThread.places(for: pond)
        #expect(with[1].enabled && with[1].detail == "Runs on your Mac")
        // the owner has no one else's Mac to run on
        #expect(PondStartThread.places(for: PondSummary(id: "p", name: "Mine", role: .owner, gitRemote: "g")).map(\.kind) == [.own])
        #expect(PondStartThread.places(for: PondSummary(id: "p", name: "Site", role: .viewer)).isEmpty)
    }

    @Test func joiningNeedsSignInAndTypesNoName() {
        #expect(PondJoinGate.needsSignIn(linked: false) && !PondJoinGate.needsSignIn(linked: true))
        #expect(PondJoinGate.signInLine == "Sign in to Squeak to join a pond. Your name comes from your account.")
    }
}
