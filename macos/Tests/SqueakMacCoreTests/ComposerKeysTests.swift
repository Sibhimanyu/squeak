import Testing
@testable import SqueakMacCore

struct ComposerKeysTests {
    @Test func idleReturnSends() {
        #expect(ComposerKeys.action(.plain, working: false) == .send)
        #expect(ComposerKeys.action(.command, working: false) == .send)
        #expect(ComposerKeys.action(.shift, working: false) == .newLine)
    }

    @Test func workingReturnQueuesAndCommandReturnSteers() {
        #expect(ComposerKeys.action(.plain, working: true) == .queue)
        #expect(ComposerKeys.action(.command, working: true) == .steer)
        #expect(ComposerKeys.action(.shiftCommand, working: true) == .queue)
        #expect(ComposerKeys.action(.shift, working: true) == .newLine)
    }

    @Test func actionsMapToHostModes() {
        #expect(ComposerKeys.mode(.queue) == .queue)
        #expect(ComposerKeys.mode(.steer) == .steer)
        #expect(ComposerKeys.mode(.send) == .queue)
        #expect(ComposerKeys.mode(.newLine) == nil)
    }

    @Test func hintOnlyNamesLiveKeys() {
        #expect(ComposerKeys.workingHint(canStop: false) == "↵ queue · ⌘↵ steer")
        #expect(ComposerKeys.workingHint(canStop: true) == "↵ queue · ⌘↵ steer · ⌘. stop")
    }
}
