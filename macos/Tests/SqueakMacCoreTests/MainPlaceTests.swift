import Foundation
import Testing

@testable import SqueakMacCore

@Suite struct MainPlaceTests {
    let now = Date(timeIntervalSince1970: 1_800_000_000)
    let main = MainPlace(projectId: "p", pondName: "squeak", rootPath: "/repos/squeak", branch: "feature/x")

    private func chat(_ id: String, cwd: String, state: SessionState = .finished, source: String = "claude-squeak", ago: TimeInterval = 30) -> HostSession {
        HostSession(key: SessionKey(provider: source, workspaceId: nil, hostSessionId: id), title: "t-\(id)", repoName: "squeak", branch: nil,
                    cwd: cwd, agent: "claude", state: state, lastActivityAt: now.addingTimeInterval(-ago), alive: true)
    }

    private func project(_ extra: String = "") -> NativeProject {
        let json = #"{"id":"p","name":"squeak","rootPath":"/repos/squeak","defaultBranch":"main"\#(extra)}"#
        return try! JSONDecoder().decode(NativeProject.self, from: Data(json.utf8))
    }

    @Test func theRowReadsMainAndTheBranchTheFolderIsOn() {
        #expect(main.label == "Main \u{00B7} feature/x")
        #expect(MainPlace.label(branch: nil) == "Main")
        #expect(MainPlace.label(branch: "  ") == "Main")
        #expect(MainPlace.label(branch: "a1b2c3d") == "Main \u{00B7} a1b2c3d")
    }

    @Test func onlyAGitPondHasAMainPlace() {
        #expect(MainPlace(project: project(#","mainBranch":"main""#))?.branch == "main")
        #expect(MainPlace(project: project(#","kind":"folder""#)) == nil)
    }

    @Test func aChatIsInMainWhenItsFolderIsTheRootWhateverTheSpelling() {
        #expect(main.contains(chat("a", cwd: "/repos/squeak")))
        #expect(main.contains(chat("a", cwd: "/repos/squeak/")))
        #expect(main.contains(chat("a", cwd: "/repos/other/../squeak")))
        #expect(!main.contains(chat("a", cwd: "/workspaces/squeak/mallard")))
        #expect(!main.contains(chat("a", cwd: "/repos/squeak/sub")))
    }

    // MARK: Sidebar grouping

    @Test func mainChatsGroupUnderOneMainRowFirstNeverUnderAStream() {
        let list = [
            chat("s1", cwd: "/workspaces/squeak/mallard", ago: 5),
            chat("m1", cwd: "/repos/squeak", ago: 500),
            chat("m2", cwd: "/repos/squeak", ago: 900),
        ]
        let tree = SidebarTreeBuilder.build(list, now: now, mains: [main])
        let rows = tree.projects[0].workspaces
        #expect(rows.map(\.isMain) == [true, false])
        #expect(rows[0].displayTitle == "Main \u{00B7} feature/x")
        #expect(rows[0].chats.map(\.title) == ["t-m1", "t-m2"])
        #expect(rows[1].chats.map(\.title) == ["t-s1"])
        // Main leads even though the stream's chat is newer.
        #expect(rows[0].lastActivityAt! < rows[1].lastActivityAt!)
    }

    @Test func aMainChatIsARealProjectChatNotAnOtherSession() {
        let tree = SidebarTreeBuilder.build([chat("m1", cwd: "/repos/squeak")], now: now, mains: [main])
        let directory = PondDirectory(ponds: [PondDirectory.Pond(id: "p1", name: "squeak", projectId: "p1", folder: "/repos/squeak")])
        let sections = SidebarSections.split(tree, directory: directory)
        #expect(sections.workspaces(of: "p1").count == 1)
        #expect(sections.otherSessions.isEmpty)
    }

    @Test func withoutAMainPlaceTheRootChatIsAnOrdinaryRow() {
        let tree = SidebarTreeBuilder.build([chat("m1", cwd: "/repos/squeak")], now: now)
        #expect(tree.projects[0].workspaces.map(\.isMain) == [false])
    }

    @Test func theMainRowIsAlwaysThereFirstEvenWithNoChats() {
        let stream = SidebarWorkspace(id: "squeak/x", name: "mallard", title: nil, branch: "mallard", chats: [], repo: "squeak", foldedMark: nil)
        let row = MainSidebar.row(main: main, in: [stream])
        #expect(row?.isMain == true)
        #expect(row?.chats.isEmpty == true)
        #expect(row?.displayTitle == "Main \u{00B7} feature/x")
        #expect(MainSidebar.row(main: nil, in: [stream]) == nil)
        var existing = stream; existing.isMain = true
        #expect(MainSidebar.row(main: main, in: [stream, existing])?.id == existing.id)
        #expect(MainSidebar.streams([existing, stream]).map(\.id) == [stream.id])
    }

    // MARK: "In:" picker default

    @Test func newThreadStartsInMainUnlessAStreamWasNamed() {
        #expect(NewChatIn.defaultChoice(hasMain: true, requestedStream: nil, newestStream: "w1") == .main)
        #expect(NewChatIn.defaultChoice(hasMain: true, requestedStream: "w2", newestStream: "w1") == .existing("w2"))
        #expect(NewChatIn.defaultChoice(hasMain: false, requestedStream: nil, newestStream: "w1") == .existing("w1"))
        #expect(NewChatIn.defaultChoice(hasMain: false, requestedStream: nil, newestStream: nil) == .new)
    }

    @Test func aPondsStartAThreadOpensInMainOnAGitPondOnly() {
        let pond = PondSummary(id: "p", name: "squeak", projectId: "p", canStartHere: true)
        let git = PondThreadEntry.resolve(pond: pond, workspaces: [], projectKind: "git", hasMain: true)
        guard case .open(let page, let context) = git else { Issue.record("expected open"); return }
        #expect(context.choice == .main)
        #expect(page == .thread(projectId: "p", workspaceId: nil))
        guard case .open(_, let old) = PondThreadEntry.resolve(pond: pond, workspaces: [], projectKind: "git") else { return }
        #expect(old.choice == .new)
        guard case .open(_, let folder) = PondThreadEntry.resolve(pond: pond, workspaces: [], projectKind: "folder", hasMain: false) else { return }
        #expect(folder.choice == .new)
        #expect(!folder.showsPicker)
    }

    @Test func theControlsLabelsAreMainAStreamOrNewStream() {
        #expect(NewChatIn.label(.main, main: main, streams: []) == "Main \u{00B7} feature/x")
        #expect(NewChatIn.label(.new, main: main, streams: []) == "New stream")
        #expect(StartThreadStream.main.workspaceId == nil)
        #expect(StartThreadStream.main.isMain)
        #expect(!StartThreadStream.new.isMain)
        #expect(StartThreadStreams.valid(.main, in: []) == .main)
    }

    // MARK: Busy offer

    @Test func mainIsBusyWhileAChatThereWorksOrWaits() {
        #expect(main.busyChat(in: [chat("m", cwd: "/repos/squeak", state: .finished)]) == nil)
        #expect(main.busyChat(in: [chat("m", cwd: "/repos/squeak", state: .working)])?.title == "t-m")
        #expect(main.busyChat(in: [chat("m", cwd: "/repos/squeak", state: .blocked)])?.title == "t-m")
        // A chat working in a stream does not hold Main, nor does one elsewhere.
        #expect(main.busyChat(in: [chat("s", cwd: "/workspaces/squeak/mallard", state: .working)]) == nil)
        // The newest of several.
        let two = [chat("old", cwd: "/repos/squeak", state: .working, ago: 90), chat("new", cwd: "/repos/squeak", state: .working, ago: 5)]
        #expect(main.busyChat(in: two)?.title == "t-new")
    }

    @Test func theOfferNamesTheChatAndStaysUntilThePersonPicks() {
        #expect(MainPlace.busyOffer(title: "Fix login") == "Main is busy with \u{2018}Fix login\u{2019}. Start in a new stream?")
        #expect(MainPlace.busyOffer(title: "  ") == "Main is busy with \u{2018}another chat\u{2019}. Start in a new stream?")
        let busy = chat("m", cwd: "/repos/squeak", state: .working)
        var offer = NewChatIn.Offer()
        // Default stays Main: the offer shows while Main is chosen and busy, and nothing is switched by itself.
        #expect(offer.shows(choice: .main, busy: busy))
        #expect(!offer.shows(choice: .main, busy: nil))
        #expect(!offer.shows(choice: .new, busy: busy))
        offer.dismissed = true
        #expect(!offer.shows(choice: .main, busy: busy))
    }

    // MARK: Git status for Main

    @Test func noPullRequestIsOfferedOnTheDefaultBranch() throws {
        let onDefault = try JSONDecoder().decode(NativeGitStatus.self, from: Data(
            #"{"branch":"main","base":"main","dirty":2,"ahead":0,"main":true,"onDefaultBranch":true,"prReason":"none"}"#.utf8))
        #expect(onDefault.main && onDefault.onDefaultBranch && !onDefault.canOpenPullRequest)
        #expect(GitPresentation.primary(onDefault) == .action(.commitPush))
        #expect(!GitPresentation.isEnabled(.createPR, onDefault))
        let clean = NativeGitStatus(branch: "main", dirty: 0, main: true, onDefaultBranch: true)
        #expect(GitPresentation.primary(clean) == nil)
        let feature = try JSONDecoder().decode(NativeGitStatus.self, from: Data(
            #"{"branch":"feature/x","base":"main","dirty":1,"main":true,"onDefaultBranch":false,"prReason":"none"}"#.utf8))
        #expect(feature.canOpenPullRequest)
        #expect(GitPresentation.primary(feature) == .action(.createPR))
        #expect(GitPresentation.isEnabled(.createPR, feature))
        // A stream is unchanged.
        let stream = NativeGitStatus(branch: "mallard", dirty: 1)
        #expect(GitPresentation.primary(stream) == .action(.createPR))
    }
}
