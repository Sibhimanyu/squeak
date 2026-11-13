import Foundation
import Testing
@testable import SqueakMacCore

@Suite struct AccountFlowTests {
    @Test func stuckSessionTimesOutAndFreesTheButtons() {
        var f = AccountFlow()
        let t0 = Date(timeIntervalSince1970: 1000)
        let tok = f.begin(.connect, at: t0)!
        #expect(f.busy)
        #expect(!f.expired(at: t0.addingTimeInterval(299)))
        #expect(f.expired(at: t0.addingTimeInterval(300)))
        f.cancel()
        #expect(!f.busy)
        f.end(tok)   // the late callback of the dead session changes nothing
        #expect(f.begin(.photo) != nil)
        #expect(f.kind == .photo)
    }

    @Test func signOutCancelsAPendingFlowFirst() {
        var f = AccountFlow()
        _ = f.begin(.connect)
        let r = f.beginSignOut()
        #expect(r.cancelled == .connect)
        #expect(f.kind == .signOut)
        #expect(!f.cancellable)
        var idle = AccountFlow()
        #expect(idle.beginSignOut().cancelled == nil)
    }

    @Test func oneFlowAtATimeAndStaleEndIsIgnored() {
        var f = AccountFlow()
        let a = f.begin(.signIn)!
        #expect(f.begin(.connect) == nil)
        f.cancel()
        let b = f.begin(.connect)!
        f.end(a)
        #expect(f.kind == .connect)
        f.end(b)
        #expect(!f.busy)
    }

    @Test func autoConnectRules() {
        let need = HostedCloud(phase: .needsSignIn)
        #expect(AccountFlow.shouldAutoConnect(hosted: need, accountLinked: true, triedThisLaunch: false))
        #expect(!AccountFlow.shouldAutoConnect(hosted: need, accountLinked: true, triedThisLaunch: true))
        #expect(!AccountFlow.shouldAutoConnect(hosted: need, accountLinked: false, triedThisLaunch: false))
        #expect(!AccountFlow.shouldAutoConnect(hosted: HostedCloud(phase: .needsSignIn, moveDeferred: true), accountLinked: true, triedThisLaunch: false))
        #expect(!AccountFlow.shouldAutoConnect(hosted: HostedCloud(phase: .connecting), accountLinked: true, triedThisLaunch: false))
        #expect(!AccountFlow.shouldAutoConnect(hosted: HostedCloud(phase: .ready), accountLinked: true, triedThisLaunch: false))
    }

    @Test func linkedButUnconnectedReadsAsOneStepNotAnError() {
        let line = HostedCloud(phase: .needsSignIn).connectionLine(accountKnown: true)!
        #expect(line.tone == .quiet)
        #expect(line.retry)
        #expect(line.actionTitle == "Finish connecting to Squeak's cloud")
        let hold = HostedCloud(phase: .needsSignIn, moveDeferred: true).connectionLine(accountKnown: true)!
        #expect(hold.text == "Connected. Moving this Mac to Squeak's cloud is on hold.")
        #expect(!hold.retry)
    }

    @Test func freshInstallSignsInOnTheHostedCloudInOnePass() {
        let hosted = HostedCloud(phase: .needsSignIn, signInUrl: "https://hosted.test/app/index.html")
        // A fresh install's account answer has no signInUrl: the hosted one is used, never a dead end.
        let fresh = AccountState(linked: false)
        let base = AccountFlow.signInBase(account: fresh, hosted: hosted)
        #expect(base == "https://hosted.test/app/index.html")
        #expect(AccountFlow.signInBase(account: fresh, hosted: nil) == nil)
        #expect(AccountFlow.signInBase(account: AccountState(linked: false, signInUrl: "https://own.test/app/index.html"), hosted: hosted) == "https://own.test/app/index.html")
        #expect(AccountFlow.wantsBothSteps(signInUrl: base, hosted: hosted))
        // Another relay's page, a held move, or a Mac already connecting keeps the old two passes.
        #expect(!AccountFlow.wantsBothSteps(signInUrl: "https://own.test/app/index.html", hosted: hosted))
        #expect(!AccountFlow.wantsBothSteps(signInUrl: base, hosted: HostedCloud(phase: .needsSignIn, moveDeferred: true, signInUrl: "https://hosted.test/app/index.html")))
        #expect(!AccountFlow.wantsBothSteps(signInUrl: base, hosted: HostedCloud(phase: .connecting, signInUrl: "https://hosted.test/app/index.html")))
        // The token came with the ticket: no "Finish connecting" pass.
        #expect(!AccountFlow.needsSeparateConnect(tokenHandedOver: true))
        #expect(AccountFlow.needsSeparateConnect(tokenHandedOver: false))
    }
}
