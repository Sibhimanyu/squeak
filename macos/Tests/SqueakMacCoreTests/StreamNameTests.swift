import Testing

@testable import SqueakMacCore

@Suite("One stream name everywhere")
struct StreamNameTests {
    @Test func renamedStreamUsesItsOwnTitle() {
        #expect(StreamName.resolve(title: "Fix the login", name: "hong-kong", branch: "x/hk", repo: "greenroom") == "Fix the login")
    }

    @Test func untitledStreamIsItsFolderNameMadeReadable() {
        #expect(StreamName.resolve(title: nil, name: "hong-kong", branch: "x/hk", repo: "greenroom") == "Hong Kong")
        #expect(StreamName.resolve(title: "  ", name: "wood_duck", branch: nil, repo: nil) == "Wood Duck")
        #expect(StreamName.resolve(title: nil, name: "Hong Kong", branch: nil, repo: nil) == "Hong Kong")
    }

    @Test func mainCheckoutIsRepoAndBranch() {
        #expect(StreamName.resolve(title: nil, name: "squeak", branch: "master", repo: "Squeak") == "Squeak · master")
        #expect(StreamName.resolve(title: nil, name: "squeak", branch: nil, repo: "squeak") == "squeak")
    }

    @Test func sidebarWorkspaceNeverTakesAChatTitle() {
        let chat = makeSession("c1", title: "Use sonnet 5.5 to code it")
        let w = SidebarWorkspace(id: "p/w", name: "hong-kong", title: nil, branch: "hk", chats: [chat], repo: "greenroom", foldedMark: nil)
        #expect(w.displayTitle == "Hong Kong")
    }
}
