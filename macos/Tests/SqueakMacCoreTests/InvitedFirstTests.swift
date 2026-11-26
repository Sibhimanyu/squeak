import Testing
@testable import SqueakMacCore

/// First launch for someone who came from an invitation (docs/spec.md "Invited without Squeak: the invite page is the welcome"):
/// sign in, then the Invitations, before any other setup; the rest waits until they make a Pond of their own.
@Suite struct InvitedFirstTests {
    private func flow(
        signedIn: Bool = false, invitations: Int = 0, own: Int = 0, joined: Int = 0,
        service: SetupServiceFact = .notInstalled, progress: SetupProgress = SetupProgress()
    ) -> SetupFlow {
        SetupFlow(
            SetupFlowFacts(setup: SetupFacts(service: service), signedIn: signedIn,
                           pendingInvitations: invitations, ownPonds: own, joinedPonds: joined),
            progress: progress)
    }

    @Test func aSignedOutFirstLaunchGoesToSignInBeforeAnythingElse() {
        let f = flow()
        #expect(f.entry == .signIn)
        #expect(f.startStage == .account)
        #expect(!f.setupWaits)
    }

    @Test func afterSignInAnInvitationComesBeforeAnySetup() {
        let f = flow(signedIn: true, invitations: 1)
        #expect(f.entry == .invitations)
        #expect(f.setupWaits)
        #expect(f.openStages.isEmpty)
    }

    @Test func aPondSomeoneSharedKeepsTheSetupWaitingToo() {
        let f = flow(signedIn: true, joined: 1)
        #expect(f.entry == .invitations)
        #expect(f.openStages.isEmpty)
    }

    @Test func theRestOfSetupComesBackWhenTheyMakeAPondOfTheirOwn() {
        let f = flow(signedIn: true, invitations: 1, own: 1)
        #expect(f.entry == .setup)
        #expect(!f.setupWaits)
        #expect(f.openStages == [.service, .agents, .phone])
        #expect(f.startStage == .welcome)
    }

    @Test func signedInWithNoInvitationIsTheOrdinaryFirstRun() {
        let f = flow(signedIn: true)
        #expect(f.entry == .setup)
        #expect(f.startStage == .welcome)
    }

    @Test func nobodyAlreadyInSetupIsMovedUnderTheirFeet() {
        // Pressed Get started, finished, or already running Squeak: the ordinary flow whatever the account has.
        #expect(flow(progress: SetupProgress(started: true)).entry == .setup)
        #expect(flow(signedIn: true, invitations: 2, progress: SetupProgress(finished: true)).entry == .setup)
        #expect(flow(signedIn: true, invitations: 2, service: .running).entry == .invitations)
        let returning = SetupFlow(
            SetupFlowFacts(setup: SetupFacts(service: .running, hooks: HooksStatus(state: .installed, claude: .init(settingsFound: true, hooksInstalled: true), codex: .init(agentsFound: true, askFormat: true))),
                           signedIn: false, pendingInvitations: 1))
        #expect(returning.entry == .setup)
        #expect(returning.startStage == .done)
    }

    @Test func theOrderIsSignInThenInvitationsThenSetup() {
        var seen: [SetupEntry] = []
        seen.append(flow().entry)
        seen.append(flow(signedIn: true, invitations: 1).entry)
        seen.append(flow(signedIn: true, invitations: 1, own: 1).entry)
        #expect(seen == [.signIn, .invitations, .setup])
    }
}
