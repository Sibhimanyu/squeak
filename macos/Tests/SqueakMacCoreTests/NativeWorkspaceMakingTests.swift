import Testing
@testable import SqueakMacCore

@Suite struct NativeWorkspaceMakingTests {
    private let projects = [
        NativeProject(id: "p1", name: "squeak", rootPath: "/r/squeak", defaultBranch: "main"),
        NativeProject(id: "p2", name: "Atlas", rootPath: "/r/atlas", defaultBranch: "master"),
    ]

    @Test func matchesByNameIgnoringCase() {
        #expect(NativeWorkspaceMaking.project(named: "Squeak", in: projects)?.id == "p1")
        #expect(NativeWorkspaceMaking.project(named: " atlas ", in: projects)?.id == "p2")
        #expect(NativeWorkspaceMaking.project(named: "compass", in: projects) == nil)
        #expect(NativeWorkspaceMaking.project(named: "", in: projects) == nil)
    }

    @Test func problemsAreSentences() {
        #expect(NativeWorkspaceMaking.problem(NativeHostError.hostDown) == "Squeak's session host isn't running.")
        #expect(NativeWorkspaceMaking.problem(NativeHostError.http(409, "git worktree failed")) == "git worktree failed.")
        #expect(NativeWorkspaceMaking.problem(NativeHostError.http(500, nil)) == "Squeak couldn't make the stream.")
        #expect(NativeWorkspaceMaking.problem(NativeHostError.uncertain("x")).contains("Check the pond's streams"))
        struct Odd: Error {}
        #expect(NativeWorkspaceMaking.problem(Odd()) == "Squeak couldn't make the stream.")
    }
}
