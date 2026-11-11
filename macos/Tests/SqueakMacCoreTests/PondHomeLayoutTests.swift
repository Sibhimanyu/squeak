import Foundation
import Testing
@testable import SqueakMacCore

private let t0 = Date(timeIntervalSince1970: 1_800_000_000)

private func chat(_ id: String, age: Double, branch: String? = nil, state: SessionState = .idle) -> HostSession {
    HostSession(
        key: SessionKey(provider: "squeak", hostSessionId: id), title: id, repoName: "p", branch: branch, cwd: "/w/\(id)", state: state,
        lastActivityAt: t0.addingTimeInterval(-age), workspaceName: "ws-\(id)")
}

private func project(_ chats: [HostSession]) -> SidebarProject {
    SidebarTreeBuilder.build(chats, now: t0).projects.first ?? SidebarProject(name: "p", workspaces: [])
}

private let hostId: @Sendable (HostSession) -> String? = { $0.key.hostSessionId }
private let me = FlockMember(id: "m1", name: "Me", you: true)

@Suite("Pond home layout")
struct PondHomeLayoutTests {
    @Test func anUnsharedChatIsYouAlone() {
        let p = project([chat("a", age: 10)])
        let l = PondHomeLayout.build(project: p, detail: nil, me: "Sib", hostIdFor: hostId)
        let row = l.workspaces[0].chats[0]
        #expect(!row.shared)
        #expect(row.people.map(\.name) == ["Sib"] && row.people[0].you)
        #expect(l.fromFlock.isEmpty)
    }

    @Test func aSharedThreadShowsParticipantsAndPresenceRing() {
        let p = project([chat("a", age: 10)])
        var t = PondThread(id: "t1", title: "x", starter: "m1", starterName: "Me", state: "idle", sessionId: "a",
                           participants: [PondParticipant(memberId: "m2", name: "Aarav", lastAt: t0), PondParticipant(memberId: "m1", name: "Me", lastAt: t0.addingTimeInterval(-50)),
                                          PondParticipant(memberId: "m3", name: "Zed", lastAt: t0.addingTimeInterval(-5))])
        t.updatedAt = t0
        let detail = PondDetail(
            pond: PondSummary(id: "p", name: "P"), members: [me, FlockMember(id: "m2", name: "Aarav"), FlockMember(id: "m3", name: "Zed")], threads: [t],
            presence: [PondPresenceEntry(member: "m2", viewing: "t1"), PondPresenceEntry(member: "m3", typingIn: "t1"), PondPresenceEntry(member: "m1", online: false, viewing: "t1")])
        let l = PondHomeLayout.build(project: p, detail: detail, me: "Me", hostIdFor: hostId)
        let row = l.workspaces[0].chats[0]
        #expect(row.shared && row.pondThread == "t1" && row.local != nil)
        #expect(row.people.map(\.id) == ["m1", "m2", "m3"])
        #expect(row.people.map(\.live) == [.none, .viewing, .typing])
        #expect(l.chatCounts["m2"] == 1 && l.chatCounts["m1"] == 1)
        #expect(l.fromFlock.isEmpty)
    }

    @Test func aRemoteThreadLandsUnderItsBranchElseFromTheFlock() {
        let p = project([chat("a", age: 100, branch: "feat/x"), chat("b", age: 200, branch: "feat/y")])
        let mine = FlockMember(id: "m1", name: "Me", you: true)
        let onBranch = PondThread(id: "r1", title: "Remote", starter: "m2", starterName: "Aarav", state: "working", updatedAt: t0, branch: "feat/y")
        let byName = PondThread(id: "r2", title: "ByName", starter: "m2", starterName: "Aarav", updatedAt: t0.addingTimeInterval(-1), workspace: "WS-a")
        let nowhere = PondThread(id: "r3", title: "Lost", starter: "m2", starterName: "Aarav", updatedAt: t0.addingTimeInterval(-2), branch: "other")
        let none = PondThread(id: "r4", title: "Bare", starter: "m2", starterName: "Aarav", updatedAt: t0.addingTimeInterval(-3))
        let detail = PondDetail(pond: PondSummary(id: "p", name: "P"), members: [mine], threads: [onBranch, byName, nowhere, none])
        let l = PondHomeLayout.build(project: p, detail: detail, me: "Me", hostIdFor: hostId)
        // Newest activity first: the workspace the remote thread touched now leads.
        #expect(l.workspaces.map(\.name) == ["ws-b", "ws-a"])
        #expect(l.workspaces[0].chats.map(\.title) == ["Remote", "b"])
        #expect(l.workspaces[0].chats[0].local == nil && l.workspaces[0].chats[0].state == .working)
        #expect(l.workspaces[1].chats.map(\.title) == ["ByName", "a"])
        #expect(l.fromFlock.map(\.title) == ["Lost", "Bare"])
        #expect(l.chatCounts["m2"] == 4)
    }

    @Test func chatsAreNewestFirstAndNothingIsEmptyOnlyWithoutWorkspaces() {
        let p = project([chat("old", age: 500), chat("new", age: 5)])
        let l = PondHomeLayout.build(project: p, detail: nil, me: "Me", hostIdFor: hostId)
        #expect(!l.isEmpty)
        #expect(l.workspaces.flatMap(\.chats).map(\.title) == ["new", "old"])
        #expect(PondHomeLayout.build(project: nil, detail: nil, me: "Me", hostIdFor: hostId).isEmpty)
    }

    @Test func threadCountCoversThisMacsChatsAndOtherMacsOnceEach() {
        let p = project([chat("a", age: 100, branch: "feat/x"), chat("b", age: 200, branch: "feat/y")])
        let mine = FlockMember(id: "m1", name: "Me", you: true)
        let sharedA = PondThread(id: "t1", title: "a", starter: "m1", starterName: "Me", state: "idle", sessionId: "a", updatedAt: t0)
        let onBranch = PondThread(id: "r1", title: "Remote", starter: "m2", starterName: "Aarav", updatedAt: t0, branch: "feat/y")
        let lost = PondThread(id: "r2", title: "Lost", starter: "m2", starterName: "Aarav", updatedAt: t0, branch: "other")
        let detail = PondDetail(pond: PondSummary(id: "p", name: "P"), members: [mine], threads: [sharedA, onBranch, lost])
        // Two local chats (one of them shared, so not counted again) + two from other Macs.
        #expect(PondHomeLayout.build(project: p, detail: detail, me: "Me", hostIdFor: hostId).threadCount == 4)
        #expect(PondHomeLayout.build(project: p, detail: nil, me: "Me", hostIdFor: hostId).threadCount == 2)
        #expect(PondHomeLayout.build(project: nil, detail: nil, me: "Me", hostIdFor: hostId).threadCount == 0)
    }

    @Test func aBranchWithNoThreadsIsListedAndOrderedByCreation() {
        let p = project([chat("a", age: 100, branch: "hong-kong")])
        let empty = NativeWorkspace(id: "w2", projectId: "pr", name: "mallard", path: "/w/mallard", branch: "feat/duck", createdAt: t0.addingTimeInterval(-10))
        let older = NativeWorkspace(id: "w3", projectId: "pr", name: "kiwi", path: "/w/kiwi", branch: "kiwi", createdAt: t0.addingTimeInterval(-500))
        let l = PondHomeLayout.build(project: p, detail: nil, me: "Me", emptyBranches: [older, empty], hostIdFor: hostId)
        // Newest first: the new empty branch leads, the chat's workspace (100 s) next, the older empty one last.
        #expect(l.workspaces.map(\.name) == ["mallard", "ws-a", "kiwi"])
        #expect(l.workspaces[0].chats.isEmpty && l.workspaces[0].empty?.id == "w2" && l.workspaces[0].branch == "feat/duck")
        #expect(l.workspaces[2].branch == nil)
        #expect(l.workspaces[1].empty == nil && l.threadCount == 1 && !l.isEmpty)
    }

    @Test func emptyBranchesSkipArchivedOtherProjectsAndBranchesWithChats() {
        let chats = [chat("a", age: 1)]
        let ws = [
            NativeWorkspace(id: "1", projectId: "pr", name: "has-chat", path: "/w/a", branch: "a"),
            NativeWorkspace(id: "2", projectId: "pr", name: "gone", path: "/w/gone", branch: "g", state: "archived"),
            NativeWorkspace(id: "3", projectId: "other", name: "x", path: "/w/x", branch: "x"),
            NativeWorkspace(id: "4", projectId: "pr", name: "mallard", path: "/w/mallard", branch: "m"),
        ]
        #expect(PondHomeLayout.emptyBranches(ws, projectId: "pr", chats: chats).map(\.id) == ["4"])
        #expect(PondHomeLayout.emptyBranches(ws, projectId: nil, chats: chats).isEmpty)
    }

    @Test func aRemoteThreadCanLandOnAnEmptyBranchAndFillsIt() {
        let empty = NativeWorkspace(id: "w2", projectId: "pr", name: "mallard", path: "/w/mallard", branch: "mallard")
        let t = PondThread(id: "r1", title: "Remote", starter: "m2", starterName: "Aarav", state: "idle", updatedAt: t0, branch: "mallard")
        let detail = PondDetail(pond: PondSummary(id: "p", name: "P"), members: [me], threads: [t])
        let l = PondHomeLayout.build(project: nil, detail: detail, me: "Me", emptyBranches: [empty], hostIdFor: hostId)
        #expect(l.workspaces.count == 1 && l.workspaces[0].chats.map(\.title) == ["Remote"] && l.workspaces[0].empty == nil && l.fromFlock.isEmpty)
    }
}
