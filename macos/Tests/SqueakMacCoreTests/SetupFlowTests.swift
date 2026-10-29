import XCTest
@testable import SqueakMacCore

final class SetupFlowTests: XCTestCase {
    private let both = AgentDetection(claudeCode: true, codex: true, conductor: false)

    private func facts(
        service: SetupServiceFact = .running, hooks: HooksStatus? = nil, detection: AgentDetection? = nil,
        relay: RelayStatus? = nil, active: Bool = false, away: Bool = false, busy: Bool = false
    ) -> SetupFlowFacts {
        SetupFlowFacts(
            setup: SetupFacts(service: service, hooks: hooks, relay: relay, conductorInstalled: false),
            detection: detection ?? both, hasActiveSession: active, awayConfigured: away, connectBusy: busy)
    }

    private let installed = HooksStatus(state: .installed, claude: .init(settingsFound: true, hooksInstalled: true),
                                        codex: .init(agentsFound: true, askFormat: true))

    func testDetection() {
        let present: Set<String> = ["/h/.claude", "/opt/bin/codex", "/Applications/Conductor.app"]
        let d = AgentDetection.detect(home: "/h", pathDirs: ["/usr/bin", "/opt/bin"], exists: present.contains)
        XCTAssertEqual(d, AgentDetection(claudeCode: true, codex: true, conductor: true))
        let none = AgentDetection.detect(home: "/h", pathDirs: ["/usr/bin"], exists: { _ in false })
        XCTAssertFalse(none.anyAgent); XCTAssertFalse(none.conductor)
        let onPath = AgentDetection.detect(home: "/h", pathDirs: ["/usr/local/bin"], exists: { $0 == "/usr/local/bin/claude" })
        XCTAssertTrue(onPath.claudeCode); XCTAssertFalse(onPath.codex)
    }

    func testStageOrderAndSkipRules() {
        XCTAssertEqual(SetupStage.allCases, [.welcome, .connect, .firstWin, .away, .done])
        XCTAssertFalse(SetupStage.connect.canSkip)
        XCTAssertTrue(SetupStage.firstWin.canSkip); XCTAssertTrue(SetupStage.away.canSkip)
        let f = SetupFlow(facts())
        XCTAssertNil(f.previous(before: .connect)); XCTAssertNil(f.previous(before: .welcome))
        XCTAssertEqual(f.previous(before: .firstWin), .connect)
        XCTAssertEqual(f.previous(before: .done), .away)
        XCTAssertEqual(SetupFlow.skipping(.connect, in: []), [])
        XCTAssertEqual(SetupFlow.skipping(.away, in: ["firstWin"]), ["firstWin", "away"])
    }

    func testFreshStartsAtWelcomeThenConnect() {
        let none = SetupFlow(facts(service: .notInstalled))
        XCTAssertEqual(none.startStage, .welcome)
        let started = SetupFlow(facts(service: .notInstalled), progress: SetupProgress(started: true))
        XCTAssertEqual(started.startStage, .connect)
    }

    func testReturningUserGoesStraightToDone() {
        let f = SetupFlow(facts(hooks: installed))
        XCTAssertTrue(f.isReturning)
        XCTAssertEqual(f.startStage, .done)
        let finished = SetupFlow(facts(service: .notInstalled), progress: SetupProgress(finished: true))
        XCTAssertEqual(finished.startStage, .done)
    }

    func testResumeAtFirstUnfinishedScreen() {
        // Connected, no session yet.
        var progress = SetupProgress(started: true)
        let connected = SetupFlow(facts(hooks: installed), progress: progress)
        XCTAssertEqual(connected.startStage, .done) // returning wins
        // Not returning (hooks pending) but connect completed earlier and first win skipped.
        progress.skipped = ["firstWin"]; progress.completed = ["connect"]
        let f = SetupFlow(facts(service: .running, hooks: HooksStatus(state: .partial)), progress: progress)
        XCTAssertEqual(f.state(.firstWin), .skipped)
        XCTAssertEqual(f.startStage, .away)
        progress.skipped = ["firstWin", "away"]
        XCTAssertEqual(SetupFlow(facts(hooks: HooksStatus(state: .partial)), progress: progress).startStage, .done)
    }

    func testCompletedStageStaysDoneWhenFactsChange() {
        let f = SetupFlow(facts(active: false), progress: SetupProgress(completed: ["firstWin"]))
        XCTAssertEqual(f.state(.firstWin), .done)
        let live = SetupFlow(facts(active: true))
        XCTAssertTrue(live.newlyCompleted.contains("firstWin"))
    }

    func testConnectRowsShowOnlyAgentsFound() {
        let claudeOnly = AgentDetection(claudeCode: true)
        let rows = SetupFlow(facts(hooks: HooksStatus(state: .missing), detection: claudeOnly)).connectRows
        XCTAssertEqual(rows.map(\.id), ["service", "hooks"])
        XCTAssertEqual(rows[1].detail, "Claude Code …")
        let done = SetupFlow(facts(hooks: installed)).connectRows
        XCTAssertEqual(done[1].detail, "Claude Code ✓  Codex ✓")
        XCTAssertTrue(done.allSatisfy { $0.state == .done })
    }

    func testConductorRowOnlyWhenInstalled() {
        let withConductor = AgentDetection(claudeCode: true, conductor: true)
        let waiting = SetupFlow(facts(hooks: installed, detection: withConductor))
        XCTAssertEqual(waiting.connectRows.map(\.id), ["service", "hooks", "conductor"])
        XCTAssertFalse(waiting.connectReady)
        let up = SetupFlow(facts(hooks: installed, detection: withConductor, relay: RelayStatus(state: .connected)))
        XCTAssertTrue(up.connectReady)
        let notInstalled = SetupFlow(facts(hooks: installed, detection: withConductor, relay: RelayStatus(state: .notInstalled, conductorInstalled: false)))
        XCTAssertTrue(notInstalled.connectReady)
    }

    func testNoAgentsExplainsAndStillConnects() {
        let f = SetupFlow(facts(hooks: HooksStatus(state: .missing), detection: AgentDetection()))
        XCTAssertEqual(f.agentsFound, [])
        guard case .failed(let text)? = f.connectFailure?.state else { return XCTFail("expected a failed row") }
        XCTAssertTrue(text.contains("Install Claude Code or Codex"))
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
        let busy = SetupFlow(facts(hooks: HooksStatus(state: .missing), busy: true))
        XCTAssertNil(busy.nextConnectAction(attempted: []))
        let failed = SetupFlow(facts(service: .failed("Port 8477 is taken.")))
        XCTAssertEqual(failed.connectFailure?.state, .failed("Port 8477 is taken."))
        let conductor = AgentDetection(claudeCode: true, conductor: true)
        let relayNext = SetupFlow(facts(hooks: installed, detection: conductor))
        XCTAssertEqual(relayNext.nextConnectAction(attempted: []), .conductor)
    }

    func testOpenStagesForSettings() {
        let f = SetupFlow(facts(hooks: installed, active: true), progress: SetupProgress(skipped: ["away"]))
        XCTAssertEqual(f.openStages, [.away])
        XCTAssertEqual(f.state(.away), .skipped)
        let all = SetupFlow(facts(hooks: installed, active: true, away: true))
        XCTAssertEqual(all.openStages, [])
    }

    func testOldSkipNamesAreIgnored() {
        XCTAssertEqual(SetupProgress.clean(["iphone", "telegram", "away", "connect"]), ["away", "connect"])
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
