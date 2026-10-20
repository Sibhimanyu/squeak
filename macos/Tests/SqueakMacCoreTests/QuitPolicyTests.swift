import Testing
@testable import SqueakMacCore

@Suite("QuitPolicy")
struct QuitPolicyTests {
    @Test func cmdQWithWindowClosesWindowsOnly() {
        #expect(QuitPolicy.decide(explicitQuit: false, externalQuitEvent: false, updating: false, hasAppWindows: true) == .closeWindows)
    }

    @Test func cmdQWithoutWindowQuits() {
        #expect(QuitPolicy.decide(explicitQuit: false, externalQuitEvent: false, updating: false, hasAppWindows: false) == .quit)
    }

    @Test func explicitQuitAlwaysQuits() {
        for windows in [true, false] {
            #expect(QuitPolicy.decide(explicitQuit: true, externalQuitEvent: false, updating: false, hasAppWindows: windows) == .quit)
        }
    }

    @Test func externalQuitEventAlwaysQuits() {
        for windows in [true, false] {
            #expect(QuitPolicy.decide(explicitQuit: false, externalQuitEvent: true, updating: false, hasAppWindows: windows) == .quit)
        }
    }

    @Test func updateAlwaysQuits() {
        for windows in [true, false] {
            #expect(QuitPolicy.decide(explicitQuit: false, externalQuitEvent: false, updating: true, hasAppWindows: windows) == .quit)
        }
    }
}
