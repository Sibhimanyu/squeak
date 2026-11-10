import XCTest
@testable import SqueakMacCore

final class SetupFlowTests: XCTestCase {
    private let both = AgentDetection(claudeCode: true, codex: true, conductor: false)

    private func facts(
        service: SetupServiceFact = .running, hooks: HooksStatus? = nil, detection: AgentDetection? = nil,
        signedIn: Bool = false, phone: Bool = false, busy: Bool = false
    ) -> SetupFlowFacts {
        SetupFlowFacts(
            setup: SetupFacts(service: service, hooks: hooks, conductorInstalled: false),
            detection: detection ?? both, hasActiveSession: false, signedIn: signedIn, phonePaired: phone, connectBusy: busy)
    }

    private let installed = HooksStatus(state: .installed, claude: .init(settingsFound: true, hooksInstalled: true),
                                        codex: .init(agentsFound: true, askFormat: true))

    func testDetection() {
        let present: Set<String> = ["/h/.claude", "/opt/bin/codex", "/Applications/Conductor.app"]
        let d = AgentDetection.detect(home: "/h", pathDirs: ["/usr/bin", "/opt/bin"], exists: present.contains)
        XCTAssertEqual(d, AgentDetection(claudeCode: true, codex: true, conductor: true))
        let none = AgentDetection.detect(home: "/h", pathDirs: ["/usr/bin"], exists: { _ in false })
        XCTAssertFalse(none.anyAgent)
        let onPath = AgentDetection.detect(home: "/h", pathDirs: ["/usr/local/bin"], exists: { $0 == "/usr/local/bin/claude" })
        XCTAssertTrue(onPath.claudeCode); XCTAssertFalse(onPath.codex)
    }

    func testStageOrderAndSkipRules() {
        XCTAssertEqual(SetupStage.allCases, [.welcome, .service, .agents, .account, .phone, .done])
        XCTAssertEqual(SetupStage.allCases.filter(\.isRequired), [.service, .agents])
        XCTAssertEqual(SetupStage.allCases.filter(\.canSkip), [.account, .phone])
        XCTAssertEqual(SetupStage.listed, [.service, .agents, .account, .phone])
        let f = SetupFlow(facts())
        XCTAssertNil(f.previous(before: .welcome))
        XCTAssertEqual(f.previous(before: .agents), .service)
        XCTAssertEqual(f.previous(before: .done), .phone)
        XCTAssertEqual(f.next(after: .phone), .done)
        XCTAssertNil(f.next(after: .done))
        XCTAssertEqual(SetupFlow.skipping(.service, in: []), [])
        XCTAssertEqual(SetupFlow.skipping(.agents, in: []), [])
        XCTAssertEqual(SetupFlow.skipping(.phone, in: ["account"]), ["account", "phone"])
    }

    func testRequiredStagesGateContinue() {
        let down = SetupFlow(facts(service: .notInstalled))
        XCTAssertFalse(down.canContinue(.service)); XCTAssertFalse(down.canDismiss(.service))
        XCTAssertFalse(down.canContinue(.agents))
        let upNoHooks = SetupFlow(facts(hooks: HooksStatus(state: .missing)))
        XCTAssertTrue(upNoHooks.canContinue(.service))
        XCTAssertFalse(upNoHooks.canContinue(.agents))
        XCTAssertTrue(SetupFlow(facts(hooks: installed)).canContinue(.agents))
        for s in [SetupStage.welcome, .account, .phone, .done] { XCTAssertTrue(down.canContinue(s)); XCTAssertTrue(down.canDismiss(s)) }
    }

    func testNoAgentsExplainsAndStillContinues() {
        let f = SetupFlow(facts(hooks: HooksStatus(state: .missing), detection: AgentDetection()))
        XCTAssertEqual(f.agentsFound, [])
        guard case .failed(let text) = f.hooksRow.state else { return XCTFail("expected a failed row") }
        XCTAssertTrue(text.contains("Install Claude Code or Codex"))
        XCTAssertTrue(f.canContinue(.agents))
        XCTAssertNil(f.nextConnectAction(attempted: []))
        XCTAssertFalse(f.isDone(.agents)) // explained, not connected
    }

    func testFreshStartsAtWelcomeThenService() {
        XCTAssertEqual(SetupFlow(facts(service: .notInstalled)).startStage, .welcome)
        let started = SetupFlow(facts(service: .notInstalled), progress: SetupProgress(started: true))
        XCTAssertEqual(started.startStage, .service)
    }

    func testReturningUserNeverSeesSetup() {
        let f = SetupFlow(facts(hooks: installed))
        XCTAssertTrue(f.isReturning)
        XCTAssertEqual(f.startStage, .done)
        let finished = SetupFlow(facts(service: .notInstalled), progress: SetupProgress(finished: true))
        XCTAssertEqual(finished.startStage, .done)
    }

    func testResumeAtTheRightStage() {
        var progress = SetupProgress(started: true)
        // Service up, hooks not yet: resumes at Your agents.
        let f = SetupFlow(facts(hooks: HooksStatus(state: .missing)), progress: progress)
        XCTAssertEqual(f.startStage, .agents)
        // Required steps remembered done, account skipped: resumes at Your phone.
        progress.completed = ["service", "agents"]; progress.skipped = ["account"]
        let g = SetupFlow(facts(service: .notInstalled), progress: progress)
        XCTAssertEqual(g.state(.account), .skipped)
        XCTAssertEqual(g.startStage, .phone)
        progress.skipped = ["account", "phone"]
        XCTAssertEqual(SetupFlow(facts(service: .notInstalled), progress: progress).startStage, .done)
        // Signed in on the web already: Account is done without a press.
        let signed = SetupFlow(facts(hooks: HooksStatus(state: .missing), signedIn: true), progress: SetupProgress(completed: ["service", "agents"], started: true))
        XCTAssertEqual(signed.startStage, .phone)
    }

    func testOldStageNamesAreIgnoredSoOldRunsResumeFromFacts() {
        XCTAssertEqual(SetupProgress.clean(["connect", "firstWin", "away", "iphone", "account", "service"]), ["account", "service"])
        let old = SetupProgress(skipped: SetupProgress.clean(["away"]), completed: SetupProgress.clean(["connect"]), started: true)
        XCTAssertEqual(SetupFlow(facts(service: .notInstalled), progress: old).startStage, .service)
    }

    func testCompletedStageStaysDoneWhenFactsChange() {
        let f = SetupFlow(facts(phone: false), progress: SetupProgress(completed: ["phone"]))
        XCTAssertEqual(f.state(.phone), .done)
        XCTAssertTrue(SetupFlow(facts(signedIn: true)).newlyCompleted.contains("account"))
        XCTAssertFalse(SetupFlow(facts(signedIn: true), progress: SetupProgress(completed: ["account"])).newlyCompleted.contains("account"))
    }

    func testSkippedOnlyForOptionalStages() {
        let f = SetupFlow(facts(service: .notInstalled), progress: SetupProgress(skipped: ["service", "account"]))
        XCTAssertEqual(f.state(.service), .todo)
        XCTAssertEqual(f.state(.account), .skipped)
    }

    func testRowsShowOnlyAgentsFound() {
        let claudeOnly = AgentDetection(claudeCode: true)
        let rows = SetupFlow(facts(hooks: HooksStatus(state: .missing), detection: claudeOnly)).connectRows
        XCTAssertEqual(rows.map(\.id), ["service", "hooks"])
        XCTAssertEqual(rows[1].detail, "Claude Code …")
        let done = SetupFlow(facts(hooks: installed)).connectRows
        XCTAssertEqual(done[1].detail, "Claude Code ✓  Codex ✓")
        XCTAssertTrue(done.allSatisfy { $0.state == .done })
    }

    func testConductorIsNotPartOfSetup() {
        let withConductor = AgentDetection(claudeCode: true, conductor: true)
        let f = SetupFlow(facts(hooks: installed, detection: withConductor))
        XCTAssertEqual(f.connectRows.map(\.id), ["service", "hooks"])
        XCTAssertTrue(f.connectReady)
        XCTAssertNil(f.nextConnectAction(attempted: []))
    }

    func testAutoRunOrderAndStopsOnFailure() {
        let notRunning = SetupFlow(facts(service: .notInstalled))
        XCTAssertEqual(notRunning.nextConnectAction(attempted: []), .service)
        XCTAssertNil(notRunning.nextConnectAction(attempted: [.service]))
        let hooksNext = SetupFlow(facts(hooks: HooksStatus(state: .missing)))
        XCTAssertEqual(hooksNext.nextConnectAction(attempted: [.service]), .hooks)
        XCTAssertNil(hooksNext.nextConnectAction(attempted: [.hooks]))
        XCTAssertNil(SetupFlow(facts(hooks: HooksStatus(state: .missing), busy: true)).nextConnectAction(attempted: []))
        let failed = SetupFlow(facts(service: .failed("Port 8477 is taken.")))
        XCTAssertEqual(failed.serviceRow.state, .failed("Port 8477 is taken."))
    }

    func testOpenStagesForSettings() {
        let f = SetupFlow(facts(hooks: installed, signedIn: true), progress: SetupProgress(skipped: ["phone"]))
        XCTAssertEqual(f.openStages, [.phone])
        XCTAssertEqual(f.state(.phone), .skipped)
        XCTAssertEqual(SetupFlow(facts(hooks: installed, signedIn: true, phone: true)).openStages, [])
    }

    func testWebPairLinkKeepsPayloadExactly() {
        let payload = "eyJhIjoiYiIsImMiOiJkIn0%3D-_abc"
        XCTAssertEqual(WebPairLink.payload(fromPairingURL: "squeak://pair?d=\(payload)"), payload)
        XCTAssertEqual(WebPairLink.url(fromPairingURL: "squeak://pair?d=\(payload)"), "https://squeak-mac.web.app/#pair=\(payload)")
        XCTAssertEqual(WebPairLink.payload(fromPairingURL: "squeak://pair?x=1&d=abc&y=2"), "abc")
        XCTAssertNil(WebPairLink.url(fromPairingURL: "https://example.com/?d=abc"))
        XCTAssertNil(WebPairLink.url(fromPairingURL: "squeak://pair?d="))
    }

    func testTelegramStepFollowsWhatIsTrue() {
        XCTAssertEqual(TelegramStep.current(botFatherOpened: false, tokenReady: false, chatLinked: false), .openBotFather)
        XCTAssertEqual(TelegramStep.current(botFatherOpened: true, tokenReady: false, chatLinked: false), .copyToken)
        XCTAssertEqual(TelegramStep.current(botFatherOpened: true, tokenReady: true, chatLinked: false), .sendMessage)
        XCTAssertEqual(TelegramStep.current(botFatherOpened: true, tokenReady: true, chatLinked: true), .test)
    }
}

final class PermissionFlowTests: XCTestCase {
    func testAppToFindInList() {
        XCTAssertEqual(PermissionKind.accessibility.appInList, "Squeak Hands")
        XCTAssertEqual(PermissionKind.automation.appInList, "Squeak Hands")
        XCTAssertEqual(PermissionKind.location.appInList, "Squeak Hands")
        XCTAssertEqual(PermissionKind.inputMonitoring.appInList, "Squeak")
        XCTAssertEqual(PermissionKind.notifications.appInList, "Squeak")
    }

    func testPromptKindsAndPanes() {
        XCTAssertTrue(PermissionKind.notifications.hasSystemPrompt)
        XCTAssertTrue(PermissionKind.inputMonitoring.hasSystemPrompt)
        XCTAssertFalse(PermissionKind.accessibility.hasSystemPrompt)
        XCTAssertTrue(PermissionKind.accessibility.paneURL.hasSuffix("Privacy_Accessibility"))
        XCTAssertTrue(PermissionKind.inputMonitoring.paneURL.hasSuffix("Privacy_ListenEvent"))
    }

    func testGrantedTicks() {
        XCTAssertTrue(PermissionFlow(kind: .notifications, grant: .granted).isGranted)
        XCTAssertNil(PermissionFlow(kind: .notifications, grant: .granted).denialLine)
    }

    func testNotificationDenialIsCalmAndOpensPane() {
        let f = PermissionFlow(kind: .notifications).pressed().reading(.denied)
        XCTAssertFalse(f.isGranted)
        XCTAssertTrue(f.opensPane)
        XCTAssertEqual(f.buttonTitle, "Open Notification settings")
        XCTAssertEqual(f.denialLine, PermissionKind.notifications.withoutIt)
    }

    func testHandsGrantNeedsPersonConfirm() {
        var f = PermissionFlow(kind: .accessibility, grant: .unreadable)
        XCTAssertTrue(f.opensPane)
        XCTAssertFalse(f.offersConfirm)
        f = f.pressed()
        XCTAssertTrue(f.offersConfirm)
        XCTAssertFalse(f.isGranted)
        f = f.confirmedByPerson()
        XCTAssertTrue(f.isGranted); XCTAssertFalse(f.offersConfirm)
    }

    func testInputMonitoringOffersRelaunchAfterAsking() {
        var f = PermissionFlow(kind: .inputMonitoring)
        XCTAssertFalse(f.offersRelaunch)
        XCTAssertFalse(f.opensPane)
        f = f.pressed()
        XCTAssertTrue(f.offersRelaunch)
        XCTAssertTrue(f.opensPane)
        XCTAssertFalse(f.reading(.granted).offersRelaunch)
    }
}

final class PairTargetTests: XCTestCase {
    private let link = "squeak://pair?d=eyJ2IjoxfQ"

    func testTheAppCodeIsTheDaemonsLinkAndTheWebCodeOpensTheWebApp() {
        XCTAssertEqual(PairTarget.app.qrText(pairingURL: link), link)
        XCTAssertEqual(PairTarget.web.qrText(pairingURL: link), "https://squeak-mac.web.app/#pair=eyJ2IjoxfQ")
    }

    func testCopyIsExactlyWhatTheCodeCarries() {
        for target in PairTarget.allCases {
            XCTAssertEqual(target.copyText(pairingURL: link), target.qrText(pairingURL: link))
        }
    }

    func testSomethingThatIsNotAPairingLinkMakesNoCode() {
        XCTAssertNil(PairTarget.app.qrText(pairingURL: "https://example.com/?d=abc"))
        XCTAssertNil(PairTarget.web.qrText(pairingURL: "https://example.com/?d=abc"))
        XCTAssertNil(PairTarget.web.qrText(pairingURL: "squeak://pair?d="))
    }
}
