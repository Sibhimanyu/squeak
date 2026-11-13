import Foundation
import Testing
@testable import SqueakMacCore

@Suite struct PondWordsTests {
    private func project(_ id: String, _ name: String) -> NativeProject {
        NativeProject(id: id, name: name, rootPath: "/r/\(name)", defaultBranch: "main")
    }

    @Test func theWordsSayPond() {
        #expect(PondWords.sidebarHeader == "Ponds")
        #expect(PondWords.newPond == "New pond")
        #expect(PondWords.openFolderAsPond == "Open folder as pond\u{2026}")
        #expect(PondWords.breadcrumb("alpha") == "Open alpha\u{2019}s dashboard")
        #expect(PondWords.makePondFirst == PondWords.makePondFirst)
        #expect(DashboardFilter.project("alpha").chipText == "Showing pond alpha")
        #expect(DashboardFilter.workspace(id: "w", name: "main").chipText == "Showing main")
    }

    @Test func inviteRoutesByCloudAndSignIn() {
        #expect(PondInviteStart.decide(cloud: false, linked: true) == .say(PondWords.noCloud))
        #expect(PondInviteStart.decide(cloud: false, linked: false) == .say(PondWords.noCloud))
        #expect(PondInviteStart.decide(cloud: true, linked: false) == .signIn)
        #expect(PondInviteStart.decide(cloud: true, linked: true) == .invite)
    }

    @Test func aLocalPondDecodes() throws {
        let json = #"{"id":"a","name":"n","role":"owner","local":true}"#.data(using: .utf8)!
        #expect(try JSONDecoder().decode(PondSummary.self, from: json).local)
        let old = #"{"id":"a","name":"n","role":"owner"}"#.data(using: .utf8)!
        #expect(try JSONDecoder().decode(PondSummary.self, from: old).local == false)
    }
}
