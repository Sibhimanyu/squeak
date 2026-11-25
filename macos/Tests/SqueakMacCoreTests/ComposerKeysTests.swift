import Testing
@testable import SqueakMacCore

struct ComposerKeysTests {
    @Test func idleReturnSends() {
        #expect(ComposerKeys.action(.plain, working: false) == .send)
        #expect(ComposerKeys.action(.command, working: false) == .send)
        #expect(ComposerKeys.action(.shift, working: false) == .newLine)
    }

    @Test func workingReturnSteersAndCommandReturnQueuesByDefault() {
        #expect(ComposerKeys.action(.plain, working: true) == .steer)
        #expect(ComposerKeys.action(.command, working: true) == .queue)
        #expect(ComposerKeys.action(.shiftCommand, working: true) == .queue)
        #expect(ComposerKeys.action(.shift, working: true) == .newLine)
    }

    @Test func anExplicitQueueChoiceKeepsReturnQueuing() {
        #expect(ComposerKeys.action(.plain, working: true, primary: .queue) == .queue)
        #expect(ComposerKeys.action(.command, working: true, primary: .queue) == .steer)
        #expect(ComposerKeys.action(.plain, working: false, primary: .queue) == .send)
    }

    @Test func aMacThatNeverPickedStartsOnSteer() {
        #expect(SendDefault.initial.mode == .steer)
        #expect(SendDefault.initial.statusLine == "Steers now \u{00B7} \u{2318}\u{21A9} to queue")
        #expect(SendDefault(.queue).statusLine == "Queues \u{00B7} \u{2318}\u{21A9} to steer now")
    }

    @Test func actionsMapToHostModes() {
        #expect(ComposerKeys.mode(.queue) == .queue)
        #expect(ComposerKeys.mode(.steer) == .steer)
        #expect(ComposerKeys.mode(.send) == .queue)
        #expect(ComposerKeys.mode(.newLine) == nil)
    }

    @Test func hintOnlyNamesLiveKeys() {
        #expect(ComposerKeys.workingHint(canStop: false) == "↵ steer · ⌘↵ queue")
        #expect(ComposerKeys.workingHint(canStop: false, primary: .queue) == "↵ queue · ⌘↵ steer")
        #expect(ComposerKeys.workingHint(canStop: true) == "↵ steer · ⌘↵ queue · ⌘. stop")
    }
}
