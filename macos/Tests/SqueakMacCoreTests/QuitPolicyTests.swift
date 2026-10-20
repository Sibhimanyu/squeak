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
