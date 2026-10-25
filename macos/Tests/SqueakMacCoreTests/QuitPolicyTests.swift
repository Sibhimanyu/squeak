import Foundation
import Testing
@testable import SqueakMacCore

@Suite("QuitPolicy")
struct QuitPolicyTests {
    @Test func cmdQWithWindowClosesWindowsOnly() {
        #expect(QuitPolicy.decide(explicitQuit: false, systemQuit: false, updating: false, hasAppWindows: true) == .closeWindows)
    }

    @Test func cmdQWithoutWindowQuits() {
        #expect(QuitPolicy.decide(explicitQuit: false, systemQuit: false, updating: false, hasAppWindows: false) == .quit)
    }

    @Test func explicitQuitAlwaysQuits() {
        for windows in [true, false] {
            #expect(QuitPolicy.decide(explicitQuit: true, systemQuit: false, updating: false, hasAppWindows: windows) == .quit)
        }
    }

    @Test func systemQuitAlwaysQuits() {
        for windows in [true, false] {
            #expect(QuitPolicy.decide(explicitQuit: false, systemQuit: true, updating: false, hasAppWindows: windows) == .quit)
        }
    }

    @Test func updateAlwaysQuits() {
        for windows in [true, false] {
            #expect(QuitPolicy.decide(explicitQuit: false, systemQuit: false, updating: true, hasAppWindows: windows) == .quit)
        }
    }

    @Test func onlyLogoutRestartShutdownAreSystemReasons() {
        func code(_ s: String) -> UInt32 { s.unicodeScalars.reduce(0) { $0 << 8 | $1.value } }
        for r in ["logo", "rlgo", "rrst", "rsdn", "rest", "shut"] { #expect(QuitPolicy.isSystemQuitReason(code(r))) }
        // The Dock and Cmd-Tab send no reason: with a window open, that closes the window.
        #expect(!QuitPolicy.isSystemQuitReason(nil))
        #expect(!QuitPolicy.isSystemQuitReason(code("abcd")))
        #expect(QuitPolicy.decide(explicitQuit: false, systemQuit: QuitPolicy.isSystemQuitReason(nil), updating: false, hasAppWindows: true) == .closeWindows)
    }
}

@Suite("Update restore")
struct UpdateRestoreTests {
    @Test func markerRoundTrips() throws {
        let m = UpdateRestoreMarker(fromVersion: "2.2.0", window: .settings, session: "conductor:local::abc:def", settingsSection: "about", savedAt: Date(timeIntervalSince1970: 1000))
        #expect(UpdateRestoreMarker.decode(m.encoded()) == m)
    }

    @Test func garbageDecodesToNil() {
        #expect(UpdateRestoreMarker.decode(nil) == nil)
        #expect(UpdateRestoreMarker.decode(Data("nope".utf8)) == nil)
    }

    @Test func usableOnlyAfterVersionChangeAndRecent() {
        let now = Date()
        let m = UpdateRestoreMarker(fromVersion: "2.2.0", window: .conversation, savedAt: now.addingTimeInterval(-30))
        #expect(m.usable(currentVersion: "2.3.0", now: now) != nil)
        #expect(m.usable(currentVersion: "2.2.0", now: now) == nil)
        let old = UpdateRestoreMarker(fromVersion: "2.2.0", window: .conversation, savedAt: now.addingTimeInterval(-7200))
        #expect(old.usable(currentVersion: "2.3.0", now: now) == nil)
    }

    @Test func versionChangeDetection() {
        #expect(VersionChange.detect(lastRun: nil, current: "2.3.0") == .firstRun)
        #expect(VersionChange.detect(lastRun: "", current: "2.3.0") == .firstRun)
        #expect(VersionChange.detect(lastRun: "2.3.0", current: "2.3.0") == .unchanged)
        #expect(VersionChange.detect(lastRun: "2.2.0", current: "2.3.0") == .updated(from: "2.2.0"))
    }

    @Test func restoreSavedOnlyForRealQuitWithUpdate() {
        #expect(QuitPolicy.shouldSaveRestore(decision: .quit, updating: true, installPending: false))
        #expect(QuitPolicy.shouldSaveRestore(decision: .quit, updating: false, installPending: true))
        #expect(!QuitPolicy.shouldSaveRestore(decision: .quit, updating: false, installPending: false))
        #expect(!QuitPolicy.shouldSaveRestore(decision: .closeWindows, updating: true, installPending: true))
    }
}
