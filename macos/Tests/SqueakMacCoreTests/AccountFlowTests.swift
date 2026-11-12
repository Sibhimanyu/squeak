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
}
