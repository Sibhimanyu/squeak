import Foundation
import Testing
@testable import SqueakMacCore

@Suite struct ThreadArchiveTests {
    private func other(_ id: String, provider: String, state: SessionState = .idle, archived: Date? = nil) -> HostSession {
        HostSession(key: SessionKey(provider: provider, workspaceId: nil, hostSessionId: id), title: id, repoName: "squeak", state: state, archivedAt: archived)
    }

    private func chat(_ id: String, title: String = "", state: SessionState = .idle, archived: Date? = nil, repo: String = "squeak", squeak: Bool = true) -> HostSession {
        HostSession(
            key: SessionKey(provider: squeak ? "claude-squeak" : "claude", workspaceId: nil, hostSessionId: squeak ? "squeak-native:\(id)" : id),
            title: title, repoName: repo, state: state, archivedAt: archived)
    }

    @Test func archiveIsOfferedForEveryKindOfIdleThread() {
        #expect(ThreadArchive.canArchive(chat("a")))
        #expect(ThreadArchive.canArchive(chat("a", state: .finished)))
        #expect(!ThreadArchive.canArchive(chat("a", state: .working)))
        #expect(!ThreadArchive.canArchive(chat("a", state: .blocked)))
        #expect(!ThreadArchive.canArchive(chat("a", archived: Date())))
        // A Conductor, terminal or Codex thread: hidden in Squeak only, by the daemon.
        #expect(ThreadArchive.canArchive(chat("a", squeak: false)))
        #expect(ThreadArchive.canArchive(other("terminal-1", provider: "claude-terminal")))
        #expect(ThreadArchive.canArchive(other("codex-1", provider: "codex-terminal")))
        #expect(ThreadArchive.canArchive(other("c1", provider: "conductor", state: .finished)))
        #expect(!ThreadArchive.canArchive(other("c1", provider: "conductor", state: .working)))
    }

    @Test func eachKindNamesWhoArchivesIt() {
        #expect(ThreadArchive.kind(chat("a")) == .squeak)
        #expect(ThreadArchive.kind(chat("a", squeak: false)) == .fleet)
        #expect(ThreadArchive.kind(other("t", provider: "codex-terminal")) == .fleet)
        // A row with no key to archive by offers nothing.
        #expect(ThreadArchive.kind(other("", provider: "claude-terminal")) == nil)
        #expect(ThreadArchive.menuItem(other("", provider: "claude-terminal")) == nil)
    }

    @Test func unarchiveIsOfferedForAnyArchivedThread() {
        #expect(ThreadArchive.canUnarchive(chat("a", archived: Date())))
        #expect(ThreadArchive.canUnarchive(chat("a", archived: Date(), squeak: false)))
        #expect(ThreadArchive.canUnarchive(other("t", provider: "codex-terminal", archived: Date())))
        #expect(!ThreadArchive.canUnarchive(chat("a")))
        // An archived thread offers Unarchive even if its state still reads working.
        #expect(ThreadArchive.menuItem(other("t", provider: "claude-terminal", state: .working, archived: Date())) == .unarchive)
    }

    @Test func aSharedPondThreadSomeoneElseStartedHidesInYourViewOnly() {
        #expect(ThreadArchive.sharedMenuItem(hidden: false) == .archive)
        #expect(ThreadArchive.sharedMenuItem(hidden: true) == .unarchive)
    }

    @Test func theSidebarEntryIsAlwaysThereAndQuietWhenEmpty() {
        #expect(ThreadArchive.pageEntryTitle(count: 0) == "Archived")
        #expect(ThreadArchive.pageEntryTitle(count: 4) == "Archived (4)")
    }

    @Test func listsDropArchivedAndTheArchivedViewIsNewestFirst() {
        let old = Date(timeIntervalSince1970: 1_000), new = Date(timeIntervalSince1970: 2_000)
        let all = [chat("a", title: "Alpha", archived: old), chat("b", title: "Beta"), chat("c", title: "Gamma", archived: new), chat("d", title: "Delta", archived: new, repo: "other")]
        #expect(ThreadArchive.listed(all).map { $0.label } == ["Beta"])
        #expect(ThreadArchive.archived(all).map { $0.label } == ["Delta", "Gamma", "Alpha"])
        #expect(ThreadArchive.archived(all, inProject: "squeak").map { $0.label } == ["Gamma", "Alpha"])
    }

    @Test func entryShowsOnlyWithACount() {
        #expect(ThreadArchive.entryTitle(count: 0) == nil)
        #expect(ThreadArchive.entryTitle(count: 3) == "Archived (3)")
    }

    @Test func anArchivedChatIsReadOnly() {
        #expect(ThreadArchive.composerReplaced(chat("a", archived: Date())))
        #expect(!ThreadArchive.composerReplaced(chat("a")))
    }
}
