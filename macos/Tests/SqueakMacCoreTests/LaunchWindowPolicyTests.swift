import Foundation
import Testing
@testable import SqueakMacCore

@Suite struct LaunchWindowPolicyTests {
    @Test func normalLaunchOpensWindow() {
        #expect(LaunchWindowPolicy.opensWindow(source: .user, captureOrDemo: false, welcomeShowing: false))
    }
    @Test func loginLaunchStaysQuiet() {
        #expect(!LaunchWindowPolicy.opensWindow(source: .loginItem, captureOrDemo: false, welcomeShowing: false))
    }
    @Test func captureAndDemoUnchanged() {
        #expect(!LaunchWindowPolicy.opensWindow(source: .user, captureOrDemo: true, welcomeShowing: false))
    }
    @Test func welcomeShowingGetsNoSecondWindow() {
        #expect(!LaunchWindowPolicy.opensWindow(source: .user, captureOrDemo: false, welcomeShowing: true))
    }
    @Test func updateRelaunchOpensOnlyIfWindowWasOpen() {
        #expect(LaunchWindowPolicy.opensWindow(source: .user, captureOrDemo: false, welcomeShowing: false, updateRelaunchWindow: .conversation))
        #expect(!LaunchWindowPolicy.opensWindow(source: .user, captureOrDemo: false, welcomeShowing: false, updateRelaunchWindow: Optional.some(.none)))
        #expect(!LaunchWindowPolicy.opensWindow(source: .user, captureOrDemo: false, welcomeShowing: false, updateRelaunchWindow: .settings))
    }
    @Test func fullScreenRestoredOnceWhenSaved() {
        #expect(LaunchWindowPolicy.restoresFullScreen(saved: true, alreadyRestored: false, captureOrDemo: false))
        #expect(!LaunchWindowPolicy.restoresFullScreen(saved: true, alreadyRestored: true, captureOrDemo: false))
        #expect(!LaunchWindowPolicy.restoresFullScreen(saved: false, alreadyRestored: false, captureOrDemo: false))
        #expect(!LaunchWindowPolicy.restoresFullScreen(saved: true, alreadyRestored: false, captureOrDemo: true))
    }
    @Test func fullScreenRestoreWaitsForRegularVisibleKeyWindow() {
        #expect(LaunchWindowPolicy.canRestoreFullScreen(appIsRegular: true, windowVisible: true, windowIsKey: true))
        #expect(!LaunchWindowPolicy.canRestoreFullScreen(appIsRegular: false, windowVisible: true, windowIsKey: true))
        #expect(!LaunchWindowPolicy.canRestoreFullScreen(appIsRegular: true, windowVisible: false, windowIsKey: true))
        #expect(!LaunchWindowPolicy.canRestoreFullScreen(appIsRegular: true, windowVisible: true, windowIsKey: false))
    }
    @Test func quitDoesNotClearFullScreenFlag() {
        #expect(LaunchWindowPolicy.savedFullScreen(current: false, leavingBecauseAppIsQuitting: true, previous: true))
        #expect(!LaunchWindowPolicy.savedFullScreen(current: false, leavingBecauseAppIsQuitting: false, previous: true))
        #expect(LaunchWindowPolicy.savedFullScreen(current: true, leavingBecauseAppIsQuitting: false, previous: false))
    }
}
