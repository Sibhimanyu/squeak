import Foundation
import Testing

@testable import SqueakMacCore

@Suite struct PondPolishTests {
    private func defaults() -> UserDefaults {
        let name = "pond-polish-\(UUID().uuidString)"
        let d = UserDefaults(suiteName: name)!
        d.removePersistentDomain(forName: name)
        return d
    }

    // MARK: next steps

    private func steps(dismissed: Bool = false, canStart: Bool = true, ducks: Bool = false, invite: Bool = true, members: Int = 1, folder: Bool = true, remote: Bool = false) -> PondNextSteps.Steps? {
        PondNextSteps.steps(dismissed: dismissed, canStartDuck: canStart, hasDucks: ducks, canInvite: invite, memberCount: members, plainFolder: folder, isRemote: remote)
    }

    @Test func aNewFolderPondOffersAllThree() {
        #expect(steps() == .init(startDuck: true, invite: true, gitHub: true))
    }

    @Test func aGitPondNeverOffersGitHub() {
        #expect(steps(folder: false)?.gitHub == false)
    }

    @Test func stepsDropAsTheyAreDone() {
        #expect(steps(ducks: true)?.startDuck == false)
        #expect(steps(members: 2)?.invite == false)
        #expect(steps(ducks: true, members: 2, folder: false) == nil)
    }

    @Test func dismissedNeverShowsAgain() {
        #expect(steps(dismissed: true) == nil)
    }

    @Test func aMemberOrSomeoneElsesPondGetsNothingToInviteOrPublish() {
        #expect(steps(canStart: false, ducks: true, invite: false, folder: true, remote: true) == nil)
    }

    @Test func dismissalPersistsPerPond() {
        let d = defaults()
        let once = PondOnce(defaults: d)
        #expect(!once.done(.nextSteps, pond: "a"))
        once.markDone(.nextSteps, pond: "a")
        #expect(PondOnce(defaults: d).done(.nextSteps, pond: "a"))
        #expect(!PondOnce(defaults: d).done(.nextSteps, pond: "b"))
        #expect(!PondOnce(defaults: d).done(.gitHubLine, pond: "a"))
    }

    // MARK: GitHub line

    @Test func theGitHubLineShowsOnceAfterTheFirstDuckFinishesInAFolderPond() {
        #expect(PondGitHubLine.shows(plainFolder: true, isRemote: false, firstDuckFinished: true, dismissed: false))
        #expect(!PondGitHubLine.shows(plainFolder: true, isRemote: false, firstDuckFinished: false, dismissed: false))
        #expect(!PondGitHubLine.shows(plainFolder: false, isRemote: false, firstDuckFinished: true, dismissed: false))
        #expect(!PondGitHubLine.shows(plainFolder: true, isRemote: true, firstDuckFinished: true, dismissed: false))
        #expect(!PondGitHubLine.shows(plainFolder: true, isRemote: false, firstDuckFinished: true, dismissed: true))
    }

    @Test func nothingFinishedMeansNoLine() {
        #expect(!PondGitHubLine.firstDuckFinished(turns: [], tasks: []))
    }

    // MARK: Make task

    private func message(_ id: String, kind: RoomMessageAuthor.Kind, can: Bool) -> RoomMessage {
        RoomMessage(id: id, at: 1, author: RoomMessageAuthor(kind: kind, key: kind == .duck ? "d" : "p", name: "x"), parts: [], postId: "post-" + id, canMakeTask: can)
    }

    private func group(_ messages: [RoomMessage]) -> RoomItem {
        .group(RoomMessageGroup(author: messages[0].author, messages: messages))
    }

    @Test func theLatestTaskablePersonMessageIsPicked() {
        let items: [RoomItem] = [
            group([message("1", kind: .me, can: true), message("2", kind: .me, can: true)]),
            group([message("3", kind: .duck, can: false)]),
        ]
        #expect(MakeTaskAffordance.latestPostId(in: items) == "post-2")
    }

    @Test func aMessageAlreadyMadeIntoATaskIsSkipped() {
        let items: [RoomItem] = [group([message("1", kind: .me, can: true), message("2", kind: .me, can: false)])]
        #expect(MakeTaskAffordance.latestPostId(in: items) == "post-1")
        #expect(MakeTaskAffordance.latestPostId(in: []) == nil)
    }

    @Test func itShowsAtRestOnTheLatestAndOnHoverOnTheRest() {
        #expect(MakeTaskAffordance.isShown(postId: "a", latest: "a", hovering: false))
        #expect(!MakeTaskAffordance.isShown(postId: "b", latest: "a", hovering: false))
        #expect(MakeTaskAffordance.isShown(postId: "b", latest: "a", hovering: true))
        #expect(!MakeTaskAffordance.isShown(postId: nil, latest: nil, hovering: false))
    }

    // MARK: words

    @Test func shareADuckNoLongerSoundsLikeSharingThePond() {
        #expect(!ShareDuckWords.menu.contains("Share a duck"))
        #expect(ShareDuckWords.menu.contains("chat"))
    }

    // MARK: clone

    @Test func theCloneLineNamesTheSignedInAccount() {
        #expect(CloneSignIn.line(GitHubSignIn(ok: true, login: "sibhi"))?.contains("sibhi") == true)
    }

    @Test func notSignedInSaysSoAndHowToFixIt() {
        let line = CloneSignIn.line(GitHubSignIn(ok: false, reason: "not-signed-in"))
        #expect(line?.hasPrefix("Not signed in to GitHub") == true)
        #expect(line?.contains("gh auth login") == true)
        #expect(CloneSignIn.line(GitHubSignIn(ok: false, reason: "not-installed"))?.contains("cli.github.com") == true)
    }

    @Test func nothingIsClaimedBeforeItIsKnown() {
        #expect(CloneSignIn.line(nil) == nil)
        #expect(!CloneSignIn.asksBeforeCloning(nil))
    }

    @Test func onlyAPrivateRepositoryAsksFirst() {
        #expect(CloneSignIn.asksBeforeCloning(GitHubSignIn(ok: true, login: "a", repo: "o/r", visibility: "private")))
        #expect(!CloneSignIn.asksBeforeCloning(GitHubSignIn(ok: true, login: "a", repo: "o/r", visibility: "public")))
        #expect(!CloneSignIn.asksBeforeCloning(GitHubSignIn(ok: true, login: "a", repo: "o/r", visibility: "unknown")))
    }

    @Test func theHostAnswerDecodes() throws {
        let json = #"{"ok":true,"login":"a","repo":"o/r","visibility":"private"}"#.data(using: .utf8)!
        let s = try JSONDecoder().decode(GitHubSignIn.self, from: json)
        #expect(s == GitHubSignIn(ok: true, login: "a", repo: "o/r", visibility: "private"))
    }
}
