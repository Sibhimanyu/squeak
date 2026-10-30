import Foundation
import Testing

@testable import SqueakMacCore

@Suite struct UpdateFlowTests {
    private let t0 = Date(timeIntervalSince1970: 1_000_000)
    private func at(_ s: TimeInterval) -> Date { t0.addingTimeInterval(s) }

    private func flow(after events: [UpdateFlow.Event] = []) -> UpdateFlow {
        var f = UpdateFlow()
        for e in events { f.handle(e, now: t0) }
        return f
    }

    // MARK: Checking

    @Test func aCheckStartsSparkleAndFindsAnUpdate() {
        var f = UpdateFlow()
        #expect(f.handle(.checkRequested(sparkle: .idle), now: t0) == [.startCheck])
        #expect(f.phase == .checking)
        f.handle(.updateFound(version: "2.12.22"), now: at(1))
        #expect(f.phase == .available(version: "2.12.22"))
        #expect(f.deadline == nil)
    }

    @Test func aCheckThatFindsNothingSaysUpToDate() {
        var f = flow(after: [.checkRequested(sparkle: .idle)])
        f.handle(.noUpdate, now: at(1))
        #expect(f.phase == .upToDate)
        f.handle(.dismissRequested, now: at(2))
        #expect(f.phase == .idle)
    }

    @Test func aCheckTimesOutAtSixtySeconds() {
        var f = flow(after: [.checkRequested(sparkle: .idle)])
        #expect(f.tick(now: at(59)).isEmpty)
        #expect(f.phase == .checking)
        let cmds = f.tick(now: at(60))
        #expect(cmds == [.cancelSession, .endAttempt])
        guard case .failed(let failure) = f.phase else { Issue.record("not failed"); return }
        #expect(failure.stage == .check)
        #expect(failure.recoveries == [.tryAgain, .downloadManually])
    }

    @Test func aBackgroundCheckAndItsQuietFailureNeverShowAnything() {
        var f = UpdateFlow()
        f.handle(.checkBegan(userInitiated: false), now: t0)
        #expect(f.phase == .idle)
        #expect(f.handle(.failed(stage: .check, reason: "offline", userInitiated: false), now: t0).isEmpty)
        #expect(f.phase == .idle)
    }

    @Test func aPersonsCheckThatFailsIsTold() {
        var f = flow(after: [.checkRequested(sparkle: .idle)])
        f.handle(.failed(stage: .check, reason: "Can't reach the server", userInitiated: true), now: at(2))
        guard case .failed(let failure) = f.phase else { Issue.record("not failed"); return }
        #expect(failure.reason == "Can't reach the server")
    }

    // MARK: Busy and attach (a press is never a silent no-op)

    @Test func installWhileSparkleIsBusyQueuesAndShowsDownloading() {
        var f = flow(after: [.updateFound(version: "2.12.22")])
        let cmds = f.handle(.installRequested(sparkle: .busy), now: t0)
        #expect(cmds.isEmpty)
        #expect(f.phase == .downloading(version: "2.12.22", progress: nil))
        #expect(f.pendingInstall && f.waitingForSparkle)
    }

    @Test func installWhileSparkleIsBusyStartsTheCheckWhenSparkleGoesIdle() {
        var f = flow(after: [.updateFound(version: "2.12.22")])
        f.handle(.installRequested(sparkle: .busy), now: t0)
        #expect(f.handle(.sparkleBecameIdle, now: at(5)) == [.startCheck])
        #expect(!f.waitingForSparkle)
        // Found now: accepted at once, since the person already asked for it.
        #expect(f.handle(.updateFound(version: "2.12.22"), now: at(6)) == [.acceptUpdate])
    }

    @Test func installWhileSparkleIsBusyTimesOutInsteadOfWaitingForever() {
        var f = flow(after: [.updateFound(version: "2.12.22")])
        f.handle(.installRequested(sparkle: .busy), now: t0)
        #expect(f.tick(now: at(180)) == [.cancelSession, .endAttempt])
        guard case .failed(let failure) = f.phase else { Issue.record("not failed"); return }
        #expect(failure.stage == .download && failure.version == "2.12.22")
    }

    @Test func installDuringABackgroundDownloadAttachesAndDoesNotStartAnotherCheck() {
        var f = flow(after: [.updateFound(version: "2.12.22"), .downloadBegan(version: "2.12.22")])
        f.handle(.downloadProgress(0.4), now: t0)
        #expect(f.handle(.installRequested(sparkle: .busy), now: at(1)).isEmpty)
        #expect(f.phase == .downloading(version: "2.12.22", progress: 0.4))
    }

    @Test func aSecondCheckWhileOneRunsJustAttaches() {
        var f = flow(after: [.checkRequested(sparkle: .idle)])
        #expect(f.handle(.checkRequested(sparkle: .busy), now: at(1)).isEmpty)
        #expect(f.phase == .checking)
    }

    @Test func aCheckWhileSparkleIsBusyWithSomethingUnseenWaitsThenStarts() {
        var f = UpdateFlow()
        #expect(f.handle(.checkRequested(sparkle: .busy), now: t0).isEmpty)
        #expect(f.phase == .checking && f.waitingForSparkle)
        #expect(f.handle(.sparkleBecameIdle, now: at(3)) == [.startCheck])
    }

    @Test func installAcceptsAnOfferedUpdateAtOnce() {
        var f = flow(after: [.checkRequested(sparkle: .idle), .updateFound(version: "2.12.22")])
        #expect(f.handle(.installRequested(sparkle: .awaitingChoice), now: at(1)) == [.acceptUpdate])
        #expect(f.phase == .downloading(version: "2.12.22", progress: nil))
    }

    @Test func installWithNoSessionRunsACheckThatWillAcceptWhatItFinds() {
        var f = flow(after: [.updateFound(version: "2.12.22")])
        #expect(f.handle(.installRequested(sparkle: .idle), now: at(1)) == [.startCheck])
        #expect(f.handle(.updateFound(version: "2.12.22"), now: at(2)) == [.acceptUpdate])
    }

    @Test func aSessionThatEndsBeforeTheUpdateIsReadyIsRetriedOnceThenFails() {
        var f = flow(after: [.updateFound(version: "2.12.22")])
        f.handle(.installRequested(sparkle: .idle), now: t0)
        f.handle(.downloadBegan(version: "2.12.22"), now: at(1))
        #expect(f.handle(.sparkleBecameIdle, now: at(2)) == [.startCheck])
        #expect(f.handle(.sparkleBecameIdle, now: at(3)) == [.endAttempt])
        guard case .failed(let failure) = f.phase else { Issue.record("not failed"); return }
        #expect(failure.reason == UpdateFlowCopy.sessionEnded)
    }

    // MARK: Download, extract, ready

    @Test func downloadProgressRefreshesTheStallClock() {
        var f = flow(after: [.downloadBegan(version: "2.12.22")])
        f.handle(.downloadProgress(0.05), now: t0)
        #expect(f.deadline == t0.addingTimeInterval(180))
        f.handle(.downloadProgress(0.1), now: at(80))
        #expect(f.deadline == at(260))
        #expect(f.tick(now: at(259)).isEmpty)
        #expect(f.tick(now: at(260)) == [.cancelSession, .endAttempt])
    }

    @Test func anyDownloadActivityKeepsASlowDownloadAlive() {
        var f = flow(after: [.updateFound(version: "2.12.22")])
        f.handle(.installRequested(sparkle: .awaitingChoice), now: t0)
        f.handle(.downloadBegan(version: "2.12.22"), now: t0)
        f.handle(.downloadProgress(0.01), now: t0)
        // Bytes keep arriving but the percentage does not move: the stall clock follows the bytes.
        for s in stride(from: 100.0, through: 400.0, by: 100.0) { f.handle(.downloadActivity, now: at(s)) }
        #expect(f.tick(now: at(500)).isEmpty)
        #expect(f.phase == .downloading(version: "2.12.22", progress: 0.01))
    }

    @Test func aBackgroundDownloadWithNoProgressIsNotCalledStalledAfterNinetySeconds() {
        // An automatic session reports no progress; it ends with Sparkle's own session, not with our clock.
        var f = flow(after: [.downloadBegan(version: "2.12.22")])
        #expect(f.tick(now: at(120)).isEmpty)
        #expect(f.phase == .downloading(version: "2.12.22", progress: nil))
        #expect(f.deadline == t0.addingTimeInterval(900))
    }

    @Test func aDownloadWeGaveUpOnThatKeepsReceivingDataComesBackToDownloading() {
        var f = flow(after: [.updateFound(version: "2.12.22")])
        f.handle(.installRequested(sparkle: .awaitingChoice), now: t0)
        f.handle(.downloadProgress(0.3), now: t0)
        f.tick(now: at(181))
        guard case .failed = f.phase else { Issue.record("not failed"); return }
        f.handle(.downloadActivity, now: at(190))
        #expect(f.phase == .downloading(version: "2.12.22", progress: nil))
        f.handle(.staged(version: "2.12.22"), now: at(200))
        #expect(f.phase == .readyToInstall(version: "2.12.22"))
    }

    @Test func aBackgroundDownloadShowsProgressTooAndFinishesReady() {
        var f = UpdateFlow()
        f.handle(.updateFound(version: "2.12.22"), now: t0)
        f.handle(.downloadBegan(version: "2.12.22"), now: at(1))
        #expect(f.phase == .downloading(version: "2.12.22", progress: nil))
        f.handle(.downloadProgress(0.5), now: at(2))
        f.handle(.extractBegan, now: at(3))
        #expect(f.phase == .extracting(version: "2.12.22", progress: nil))
        f.handle(.extractProgress(0.5), now: at(4))
        #expect(f.phase == .extracting(version: "2.12.22", progress: 0.5))
        f.handle(.staged(version: "2.12.22"), now: at(5))
        #expect(f.phase == .readyToInstall(version: "2.12.22"))
        #expect(f.deadline == nil)
    }

    @Test func extractionTimesOutAtOneTwentySeconds() {
        var f = flow(after: [.updateFound(version: "2.12.22"), .extractBegan])
        #expect(f.tick(now: at(119)).isEmpty)
        #expect(f.tick(now: at(120)) == [.cancelSession, .endAttempt])
        guard case .failed(let failure) = f.phase else { Issue.record("not failed"); return }
        #expect(failure.stage == .extract)
    }

    @Test func cancelReturnsToAvailableAndStopsSparkle() {
        var f = flow(after: [.updateFound(version: "2.12.22"), .downloadBegan(version: "2.12.22")])
        #expect(f.handle(.cancelRequested, now: at(1)) == [.cancelSession])
        #expect(f.phase == .available(version: "2.12.22"))
        #expect(!f.pendingInstall)
    }

    @Test func aCanceledDownloadReportedBySparkleReturnsToAvailable() {
        var f = flow(after: [.updateFound(version: "2.12.22"), .downloadBegan(version: "2.12.22")])
        f.handle(.canceledByUser, now: at(1))
        #expect(f.phase == .available(version: "2.12.22"))
    }

    @Test func aDownloadFailureShowsTheFailureWithBothRecoveries() {
        var f = flow(after: [.updateFound(version: "2.12.22"), .downloadBegan(version: "2.12.22")])
        #expect(f.handle(.failed(stage: .download, reason: "The update couldn't be downloaded.", userInitiated: false), now: at(1)) == [.endAttempt])
        #expect(UpdateFlowCopy.actions(f.phase) == [.tryAgain, .downloadManually, .dismiss])
    }

    // MARK: Restart to update

    @Test func restartInstallsAndTimesOutAtOneTwentySeconds() {
        var f = flow(after: [.staged(version: "2.12.22")])
        #expect(f.handle(.restartRequested(canInstallNow: true), now: at(10)) == [.installNow])
        #expect(f.phase == .installing(version: "2.12.22"))
        #expect(f.tick(now: at(129)).isEmpty)
        #expect(f.tick(now: at(130)) == [.endAttempt])
        guard case .failed(let failure) = f.phase else { Issue.record("not failed"); return }
        #expect(failure.stage == .install && failure.version == "2.12.22")
    }

    @Test func relaunchingHasItsOwnTwoMinuteLimit() {
        var f = flow(after: [.staged(version: "2.12.22")])
        f.handle(.restartRequested(canInstallNow: true), now: t0)
        f.handle(.willRelaunch, now: at(30))
        #expect(f.phase == .relaunching(version: "2.12.22"))
        #expect(f.deadline == at(150))
        #expect(f.tick(now: at(150)) == [.endAttempt])
        guard case .failed(let failure) = f.phase else { Issue.record("not failed"); return }
        #expect(failure.stage == .relaunch)
    }

    @Test func restartWithADeadInstallerFailsInsteadOfDoingNothing() {
        var f = flow(after: [.staged(version: "2.12.22")])
        #expect(f.handle(.restartRequested(canInstallNow: false), now: at(1)) == [.endAttempt])
        guard case .failed(let failure) = f.phase else { Issue.record("not failed"); return }
        #expect(failure.reason == UpdateFlowCopy.installerGone)
    }

    @Test func restartIsIgnoredWhenNothingIsReady() {
        var f = flow(after: [.updateFound(version: "2.12.22")])
        #expect(f.handle(.restartRequested(canInstallNow: true), now: t0).isEmpty)
        #expect(f.phase == .available(version: "2.12.22"))
    }

    @Test func aSecondPressOnRestartWhileInstallingDoesNothing() {
        var f = flow(after: [.staged(version: "2.12.22")])
        f.handle(.restartRequested(canInstallNow: true), now: t0)
        #expect(f.handle(.restartRequested(canInstallNow: true), now: at(1)).isEmpty)
        #expect(f.handle(.installRequested(sparkle: .busy), now: at(1)).isEmpty)
    }

    @Test func tryAgainAfterAFailedInstallRunsTheInstallerAgainWhenItIsStillThere() {
        var f = flow(after: [.staged(version: "2.12.22")])
        f.handle(.restartRequested(canInstallNow: true), now: t0)
        _ = f.tick(now: at(200))
        #expect(f.handle(.retryRequested(sparkle: .busy, canInstallNow: true), now: at(201)) == [.installNow])
        #expect(f.phase == .installing(version: "2.12.22"))
        #expect(f.deadline == at(321))
    }

    @Test func tryAgainAfterAFailedInstallWithNoInstallerChecksAgain() {
        var f = flow(after: [.staged(version: "2.12.22")])
        f.handle(.restartRequested(canInstallNow: true), now: t0)
        _ = f.tick(now: at(200))
        #expect(f.handle(.retryRequested(sparkle: .idle, canInstallNow: false), now: at(201)) == [.startCheck])
        #expect(f.phase == .downloading(version: "2.12.22", progress: nil))
    }

    @Test func tryAgainAfterADownloadFailureStartsOver() {
        var f = flow(after: [.updateFound(version: "2.12.22"), .downloadBegan(version: "2.12.22")])
        f.handle(.failed(stage: .download, reason: "x", userInitiated: false), now: at(1))
        #expect(f.handle(.retryRequested(sparkle: .idle, canInstallNow: false), now: at(2)) == [.startCheck])
    }

    @Test func aFailureWithNoVersionRetriesAsACheck() {
        var f = flow(after: [.checkRequested(sparkle: .idle)])
        f.handle(.failed(stage: .check, reason: "x", userInitiated: true), now: at(1))
        #expect(f.handle(.retryRequested(sparkle: .idle, canInstallNow: false), now: at(2)) == [.startCheck])
        #expect(f.phase == .checking)
    }

    @Test func dismissingAFailureKeepsTheAvailableUpdate() {
        var f = flow(after: [.updateFound(version: "2.12.22"), .downloadBegan(version: "2.12.22")])
        f.handle(.failed(stage: .download, reason: "x", userInitiated: false), now: at(1))
        f.handle(.dismissRequested, now: at(2))
        #expect(f.phase == .available(version: "2.12.22"))
    }

    @Test func aLaunchOnTheOldVersionAfterRestartIsAFailureNamingTheTarget() {
        var f = UpdateFlow()
        f.handle(.restartDidNotApply(target: "2.12.22", running: "2.12.21"), now: t0)
        guard case .failed(let failure) = f.phase else { Issue.record("not failed"); return }
        #expect(failure.stage == .relaunch)
        #expect(failure.reason.contains("2.12.22") && failure.reason.contains("didn't install"))
        #expect(f.knownVersion == "2.12.22")
    }

    @Test func aDeniedInstallSaysSoPlainlyAndOffersTheWayOut() {
        var f = UpdateFlow()
        f.handle(.restartDidNotApply(target: "2.12.25", running: "2.12.24"), now: t0)
        guard case .failed(let failure) = f.phase else { Issue.record("not failed"); return }
        #expect(failure.reason == "macOS wouldn't let Squeak replace itself, so the update to 2.12.25 didn't install. Download the update and drag Squeak to Applications — or allow Squeak in System Settings › Privacy & Security › App Management and try again.")
        #expect(UpdateFlowCopy.actions(f.phase) == [.downloadUpdate, .openAppManagement, .tryAgain, .dismiss])
        #expect(UpdateFlowCopy.primaryAction(f.phase) == .downloadUpdate)
        #expect(f.inPlaceInstallDenied)
    }

    @Test func aCapturedReasonThatIsNotADenialIsShownAndNotRemembered() {
        var f = UpdateFlow()
        f.handle(.restartDidNotApply(target: "2.12.25", running: "2.12.24", installerReason: "The update is improperly signed"), now: t0)
        guard case .failed(let failure) = f.phase else { Issue.record("not failed"); return }
        #expect(failure.reason.contains("The installer said: The update is improperly signed."))
        #expect(failure.recoveries == [.tryAgain, .downloadManually])
        #expect(!f.inPlaceInstallDenied)
    }

    @Test func aReasonThatArrivesLaterRefinesTheMessageOnScreen() {
        var f = UpdateFlow()
        f.handle(.restartDidNotApply(target: "2.12.25", running: "2.12.24"), now: t0)
        f.handle(.installerReasonArrived(target: "2.12.25", running: "2.12.24", reason: "Failed: disk full"), now: at(5))
        guard case .failed(let failure) = f.phase else { Issue.record("not failed"); return }
        #expect(failure.reason.contains("Failed: disk full"))
        // Someone who already dismissed it is not pulled back.
        var g = UpdateFlow()
        g.handle(.restartDidNotApply(target: "2.12.25", running: "2.12.24"), now: t0)
        g.handle(.dismissRequested, now: at(1))
        g.handle(.installerReasonArrived(target: "2.12.25", running: "2.12.24", reason: "x"), now: at(5))
        #expect(g.phase == .available(version: "2.12.25"))
    }

    @Test func deniedWordingIsRecognised() {
        #expect(UpdateFlowCopy.looksDenied("“Squeak” couldn’t be moved because you don’t have permission to access it"))
        #expect(UpdateFlowCopy.looksDenied("NSPOSIXErrorDomain Code=13 \"Permission denied\""))
        #expect(!UpdateFlowCopy.looksDenied("The update is improperly signed"))
    }

    @Test func onAMacThatDeniedAnInPlaceInstallTheBannerLeadsWithDownload() {
        var f = UpdateFlow()
        f.handle(.inPlaceDenialRestored(true), now: t0)
        f.handle(.updateFound(version: "2.12.26"), now: t0)
        #expect(UpdateFlowCopy.actions(f.phase, inPlaceDenied: f.inPlaceInstallDenied) == [.downloadUpdate, .install])
        #expect(UpdateFlowCopy.status(f.phase, inPlaceDenied: true) == "Update 2.12.26 available. This Mac blocks Squeak from updating itself in place.")
        f.handle(.staged(version: "2.12.26"), now: at(1))
        #expect(UpdateFlowCopy.actions(f.phase, inPlaceDenied: true) == [.downloadUpdate, .tryRestartAnyway])
        #expect(UpdateFlowCopy.label(.tryRestartAnyway) == "Try restart anyway")
        // Not denied: unchanged.
        #expect(UpdateFlowCopy.actions(f.phase) == [.restart])
        #expect(f.handle(.inPlaceDenialRestored(false), now: at(2)).isEmpty)
        #expect(!f.inPlaceInstallDenied)
    }

    @Test func theDenialIsClearedOnlyByAnInPlaceUpdateThatWorked() {
        let now = Date()
        let denial = InPlaceInstallDenial(failedVersion: "2.12.25", runningVersion: "2.12.24", recordedAt: now)
        let marker = UpdateRestoreMarker(fromVersion: "2.12.24", window: .none, savedAt: now, restartAttempt: true, restartTarget: "2.12.25")
        // New version after an update quit wrote a marker: in-place worked.
        #expect(denial.clears(change: .updated(from: "2.12.24"), marker: marker, currentVersion: "2.12.25", now: now))
        // A new version with no update marker (dragged in by hand): the Mac still blocks in-place updates.
        #expect(!denial.clears(change: .updated(from: "2.12.24"), marker: nil, currentVersion: "2.12.25", now: now))
        // The failed launch itself, or a plain relaunch.
        #expect(!denial.clears(change: .unchanged, marker: marker, currentVersion: "2.12.24", now: now))
        #expect(InPlaceInstallDenial.decode(denial.encoded()) == denial)
    }

    @Test func settingsLinksAndTheDMGAreTheOnesWeMean() {
        #expect(UpdateFlowCopy.appManagementSettingsURL.absoluteString == "x-apple.systempreferences:com.apple.preference.security?Privacy_AppBundles")
        #expect(UpdateFlowCopy.privacySettingsURL.absoluteString == "x-apple.systempreferences:com.apple.preference.security")
        #expect(UpdateFlowCopy.label(.downloadUpdate) == "Download update")
        #expect(UpdateFlowCopy.label(.openAppManagement) == "Open App Management settings")
        #expect(UpdateInstallerReason.pick(from: "Error: a\nError: couldn’t be moved because you don’t have permission\n") == "couldn’t be moved because you don’t have permission")
    }

    @Test func installedReturnsToIdle() {
        var f = flow(after: [.staged(version: "2.12.22")])
        f.handle(.installed, now: t0)
        #expect(f.phase == .idle && f.knownVersion == nil)
    }

    @Test func aBackgroundFoundDoesNotHideAFailureTheUserHasNotSeen() {
        var f = flow(after: [.updateFound(version: "2.12.22"), .downloadBegan(version: "2.12.22")])
        f.handle(.failed(stage: .download, reason: "x", userInitiated: false), now: at(1))
        f.handle(.updateFound(version: "2.12.22"), now: at(2))
        if case .failed = f.phase {} else { Issue.record("failure was replaced") }
    }

    @Test func idleNeverTimesOut() {
        var f = UpdateFlow()
        #expect(f.tick(now: at(10_000)).isEmpty)
        #expect(f.phase == .idle)
    }

    @Test func timeoutsAreInjectable() {
        var t = UpdateFlow.Timeouts(); t.checking = 5
        var f = UpdateFlow(timeouts: t)
        f.handle(.checkRequested(sparkle: .idle), now: t0)
        #expect(f.tick(now: at(5)) == [.cancelSession, .endAttempt])
    }
}

@Suite struct UpdateFlowCopyTests {
    @Test func theBannerSaysWhatIsHappening() {
        typealias P = UpdateFlow.Phase
        #expect(UpdateFlowCopy.status(.idle) == nil)
        #expect(UpdateFlowCopy.status(.available(version: "2.12.22")) == "Update 2.12.22 available")
        #expect(UpdateFlowCopy.status(.downloading(version: "2.12.22", progress: 0.426)) == "Downloading 2.12.22… 43%")
        #expect(UpdateFlowCopy.status(.downloading(version: nil, progress: nil)) == "Downloading the update…")
        #expect(UpdateFlowCopy.status(.extracting(version: "2.12.22", progress: nil)) == "Preparing 2.12.22…")
        #expect(UpdateFlowCopy.status(.readyToInstall(version: "2.12.22")) == "Update 2.12.22 is ready")
        #expect(UpdateFlowCopy.status(.installing(version: "2.12.22")) == "Installing 2.12.22…")
        #expect(UpdateFlowCopy.status(.relaunching(version: "2.12.22")) == "Restarting Squeak…")
        #expect(UpdateFlowCopy.status(.checking) == "Checking for updates…")
        #expect(UpdateFlowCopy.status(.upToDate) == "Squeak is up to date")
    }

    @Test func eachPhaseOffersTheRightButtons() {
        #expect(UpdateFlowCopy.actions(.available(version: "1")) == [.install])
        #expect(UpdateFlowCopy.actions(.downloading(version: "1", progress: nil)) == [.cancel])
        #expect(UpdateFlowCopy.actions(.readyToInstall(version: "1")) == [.restart])
        #expect(UpdateFlowCopy.actions(.installing(version: "1")).isEmpty)
        #expect(UpdateFlowCopy.actions(.relaunching(version: "1")).isEmpty)
        #expect(UpdateFlowCopy.label(.restart) == "Restart to update")
        #expect(UpdateFlowCopy.label(.downloadManually) == "Download manually")
    }

    @Test func manualDownloadPointsAtTheDMGOrTheSite() {
        #expect(UpdateFlowCopy.manualDownloadURL(version: "2.12.22").absoluteString == "https://sibhimanyu.github.io/squeak/download/Squeak-2.12.22.dmg")
        #expect(UpdateFlowCopy.manualDownloadURL(version: nil) == UpdateFlowCopy.siteURL)
        #expect(UpdateFlowCopy.manualDownloadURL(version: "../evil") == UpdateFlowCopy.siteURL)
        #expect(UpdateFlowCopy.manualDownloadURL(version: "2.1/x") == UpdateFlowCopy.siteURL)
    }
}

@Suite struct UpdateLogTests {
    private func temp() -> URL { FileManager.default.temporaryDirectory.appendingPathComponent("updlog-\(UUID().uuidString)/updates.log") }

    @Test func writesStampedLinesAndTailsThem() {
        let log = UpdateLog(url: temp(), now: { Date(timeIntervalSince1970: 0) })
        log.write("phase checking -> available(2.12.22)")
        log.write("second")
        let lines = log.tail(10)
        #expect(lines.count == 2)
        #expect(lines[0].contains("phase checking -> available(2.12.22)"))
        #expect(lines[0].hasPrefix("1970-01-01T"))
        #expect(log.tail(1) == [lines[1]])
    }

    @Test func redactsPathsAndUrlsAndKeepsOneLine() {
        let log = UpdateLog(url: temp())
        log.write("error: cannot write /Users/jane/Library/x and https://example.com/a?b=c\nnext")
        let line = log.tail(1)[0]
        #expect(!line.contains("jane") && !line.contains("example.com"))
        #expect(log.tail(5).count == 1)
    }

    @Test func staysUnderItsCapKeepingTheNewestLines() throws {
        let url = temp()
        let log = UpdateLog(url: url, capBytes: 2_000)
        for i in 0..<200 { log.write("line number \(i) with some padding text") }
        let size = try #require(try FileManager.default.attributesOfItem(atPath: url.path)[.size] as? Int)
        #expect(size <= 2_000)
        #expect(log.tail(1)[0].contains("line number 199"))
        #expect(!log.tail(500).contains { $0.contains("line number 0 ") })
    }

    @Test func aDisabledLogWritesNothing() {
        let url = temp()
        let log = UpdateLog(url: url, enabled: false)
        log.write("nope")
        #expect(!FileManager.default.fileExists(atPath: url.path))
        #expect(log.tail(5).isEmpty)
    }

    @Test func diagnosticsIncludeTheUpdateLog() {
        let input = DiagnosticsInput(
            appVersion: "2.12.21", osVersion: "14", adapters: [], stateCounts: [:], lastUpdateCheck: nil, logLines: [],
            updateLogLines: ["2026-10-30T10:00:00+0530 phase idle -> checking"])
        let text = DiagnosticsReport.render(input)
        #expect(text.contains("Update log"))
        #expect(text.contains("phase idle -> checking"))
    }
}

@Suite struct UpdateRestartMarkerTests {
    private let now = Date(timeIntervalSince1970: 2_000_000)

    @Test func aRestartThatLeftTheVersionAloneDidNotApply() {
        let m = UpdateRestoreMarker(fromVersion: "2.12.21", window: .none, savedAt: now.addingTimeInterval(-60), restartAttempt: true, restartTarget: "2.12.22")
        #expect(m.restartDidNotApply(currentVersion: "2.12.21", now: now))
        #expect(!m.restartDidNotApply(currentVersion: "2.12.22", now: now))
    }

    @Test func aPlainQuitOrAnOldMarkerIsNotAFailedRestart() {
        let plain = UpdateRestoreMarker(fromVersion: "2.12.21", window: .none, savedAt: now.addingTimeInterval(-60))
        #expect(!plain.restartDidNotApply(currentVersion: "2.12.21", now: now))
        let old = UpdateRestoreMarker(fromVersion: "2.12.21", window: .none, savedAt: now.addingTimeInterval(-3600), restartAttempt: true)
        #expect(!old.restartDidNotApply(currentVersion: "2.12.21", now: now))
    }

    @Test func oldMarkersStillDecode() throws {
        let json = #"{"fromVersion":"2.12.21","window":"none","savedAt":0}"#.data(using: .utf8)
        _ = json
        let old = UpdateRestoreMarker(fromVersion: "2.12.21", window: .settings, savedAt: now)
        let data = try #require(old.encoded())
        #expect(UpdateRestoreMarker.decode(data)?.restartAttempt == nil)
    }

    @Test func relaunchIsNeverOfferedAfterAQuitThePersonChose() {
        #expect(QuitPolicy.shouldRelaunchAfterUpdate(explicitQuit: false, userQuit: false))
        #expect(!QuitPolicy.shouldRelaunchAfterUpdate(explicitQuit: true, userQuit: false))
        #expect(!QuitPolicy.shouldRelaunchAfterUpdate(explicitQuit: false, userQuit: true))
    }
}

@Suite struct UpdateFlowExtrasTests {
    private let t0 = Date(timeIntervalSince1970: 1_000_000)

    @Test func skippingForgetsTheVersion() {
        var f = UpdateFlow()
        f.handle(.updateFound(version: "2.12.22"), now: t0)
        f.handle(.skipped, now: t0)
        #expect(f.phase == .idle && f.knownVersion == nil)
    }

    @Test func errorsAreFiledUnderTheStageTheFlowIsIn() {
        #expect(UpdateFlow.Phase.downloading(version: nil, progress: nil).failureStage == .download)
        #expect(UpdateFlow.Phase.extracting(version: nil, progress: nil).failureStage == .extract)
        #expect(UpdateFlow.Phase.installing(version: nil).failureStage == .install)
        #expect(UpdateFlow.Phase.relaunching(version: nil).failureStage == .relaunch)
        #expect(UpdateFlow.Phase.checking.failureStage == .check)
    }

    @Test func theLogNamesCarryVersionsButNoProgress() {
        #expect(UpdateFlow.Phase.downloading(version: "2.12.22", progress: 0.5).description == "downloading 2.12.22")
    }
}
