import Testing
@testable import SqueakMacCore

@Suite("DoubleTapDetector")
struct DoubleTapDetectorTests {
    private func make() -> DoubleTapDetector { DoubleTapDetector(modifier: .control) }

    /// Presses and releases `flags`, returning whether the release fired.
    private func tap(_ d: inout DoubleTapDetector, _ flags: TapModifiers = .control, down: Double, hold: Double = 0.08) -> Bool {
        _ = d.flagsChanged(flags, at: down)
        return d.flagsChanged([], at: down + hold)
    }

    @Test func twoQuickTapsFireOnTheSecondRelease() {
        var d = make()
        #expect(!tap(&d, down: 0))
        #expect(tap(&d, down: 0.2))
    }

    @Test func slowTapsDoNotFire() {
        var d = make()
        #expect(!tap(&d, down: 0))
        #expect(!tap(&d, down: 1.0))
    }

    @Test func tapHoldTapDoesNotFire() {
        var d = make()
        #expect(!tap(&d, down: 0))
        #expect(!tap(&d, down: 0.2, hold: 0.6))
    }

    @Test func holdingFirstThenTappingDoesNotFire() {
        var d = make()
        #expect(!tap(&d, down: 0, hold: 0.6))
        #expect(!tap(&d, down: 0.7))
    }

    @Test func controlUsedWithAKeyBetweenTapsDoesNotFire() {
        var d = make()
        #expect(!tap(&d, down: 0))
        d.otherInput()
        #expect(!tap(&d, down: 0.2))
    }

    @Test func controlHeldWithAKeyDoesNotCountAsATap() {
        var d = make()
        _ = d.flagsChanged(.control, at: 0)
        d.otherInput()
        let r01 = d.flagsChanged([], at: 0.1)
        #expect(!r01)
        #expect(!tap(&d, down: 0.2))
    }

    @Test func anotherModifierMixedInDoesNotFire() {
        var d = make()
        #expect(!tap(&d, down: 0))
        _ = d.flagsChanged([.control, .shift], at: 0.2)
        let r028 = d.flagsChanged([], at: 0.28)
        #expect(!r028)
        #expect(!tap(&d, down: 0.35))
    }

    @Test func anotherModifierBeforeControlDoesNotFire() {
        var d = make()
        #expect(!tap(&d, down: 0))
        _ = d.flagsChanged(.shift, at: 0.15)
        _ = d.flagsChanged([.shift, .control], at: 0.17)
        _ = d.flagsChanged(.shift, at: 0.2)
        let r022 = d.flagsChanged([], at: 0.22)
        #expect(!r022)
    }

    @Test func leftAndRightMixFires() {
        var d = make()
        // Left down and up, then right down and up: the flags look the same to the detector.
        #expect(!tap(&d, down: 0))
        #expect(tap(&d, down: 0.25))
    }

    @Test func holdingBothSidesIsOnePress() {
        var d = make()
        #expect(!tap(&d, down: 0))
        _ = d.flagsChanged(.control, at: 0.2)
        let r022 = d.flagsChanged(.control, at: 0.22)
        #expect(!r022)  // the other side goes down: same flags
        let r03 = d.flagsChanged([], at: 0.3)
        #expect(r03)
    }

    @Test func thirdTapDoesNotFireAgain() {
        var d = make()
        #expect(!tap(&d, down: 0))
        #expect(tap(&d, down: 0.2))
        #expect(!tap(&d, down: 0.4))
        #expect(tap(&d, down: 0.6))
    }

    @Test func otherModifierIsNotTheChosenOne() {
        var d = make()
        #expect(!tap(&d, .option, down: 0))
        #expect(!tap(&d, .option, down: 0.2))
    }

    @Test func optionDetectorFiresOnOption() {
        var d = DoubleTapDetector(modifier: .option)
        #expect(!tap(&d, .option, down: 0))
        #expect(tap(&d, .option, down: 0.2))
    }
}

@Suite("Quick shortcut")
struct QuickShortcutTests {
    @Test func newInstallDefaultsToDoubleControl() {
        #expect(HotKeyPreference.resolve(stored: nil, alreadyMigrated: false) == "double-ctrl")
        #expect(HotKeyPreference.resolve(stored: nil, alreadyMigrated: true) == "double-ctrl")
    }

    @Test func oldDefaultAndRemovedPresetsMoveOnce() {
        for old in ["opt-space", "ctrl-shift-k", "ctrl-opt-space", "ctrl-opt-cmd-space", "ctrl-opt-cmd-s", "opt-cmd-m"] {
            #expect(HotKeyPreference.resolve(stored: old, alreadyMigrated: false) == "double-ctrl")
        }
    }

    @Test func controlShiftSpaceAndNoneSurvive() {
        #expect(HotKeyPreference.resolve(stored: "ctrl-shift-space", alreadyMigrated: false) == "ctrl-shift-space")
        #expect(HotKeyPreference.resolve(stored: "", alreadyMigrated: false) == nil)
        #expect(HotKeyPreference.resolve(stored: "", alreadyMigrated: true) == nil)
    }

    @Test func afterMigrationOptionSpaceIsAnOrdinaryChoice() {
        #expect(HotKeyPreference.resolve(stored: "opt-space", alreadyMigrated: true) == "opt-space")
        #expect(HotKeyPreference.resolve(stored: "double-opt", alreadyMigrated: false) == "double-ctrl")
        #expect(HotKeyPreference.resolve(stored: "double-opt", alreadyMigrated: true) == "double-opt")
        #expect(HotKeyPreference.resolve(stored: "opt-cmd-m", alreadyMigrated: true) == "double-ctrl")
    }

    @Test func doubleTapFallsBackUntilInputMonitoringIsGranted() {
        #expect(QuickShortcut.effectiveID(chosen: "double-ctrl", inputMonitoringGranted: false) == "ctrl-shift-space")
        #expect(QuickShortcut.effectiveID(chosen: "double-opt", inputMonitoringGranted: false) == "ctrl-shift-space")
        #expect(QuickShortcut.effectiveID(chosen: "double-ctrl", inputMonitoringGranted: true) == "double-ctrl")
        #expect(QuickShortcut.effectiveID(chosen: "opt-space", inputMonitoringGranted: false) == "opt-space")
        #expect(QuickShortcut.effectiveID(chosen: nil, inputMonitoringGranted: false) == nil)
    }
}
