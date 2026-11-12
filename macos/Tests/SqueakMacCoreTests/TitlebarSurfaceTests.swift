import Testing
@testable import SqueakMacCore

@Suite struct TitlebarSurfaceTests {
    @Test func backgroundsAreHiddenButContainerAndButtonsAreNot() {
        #expect(TitlebarSurface.paintsBackground(className: "NSTitlebarBackgroundView"))
        #expect(TitlebarSurface.paintsBackground(className: "NSVisualEffectView"))
        #expect(TitlebarSurface.paintsBackground(className: "NSTitlebarSeparatorView"))
        #expect(!TitlebarSurface.paintsBackground(className: "NSTitlebarContainerView"))
        #expect(!TitlebarSurface.paintsBackground(className: "NSTitlebarView"))
        #expect(!TitlebarSurface.paintsBackground(className: "NSButton"))
    }

    @Test func revealWindowIsRecognised() {
        #expect(TitlebarSurface.isFullScreenTitlebarWindow(className: "NSToolbarFullScreenWindow", isContentWindow: false))
        #expect(!TitlebarSurface.isFullScreenTitlebarWindow(className: "NSToolbarFullScreenWindow", isContentWindow: true))
        #expect(!TitlebarSurface.isFullScreenTitlebarWindow(className: "NSWindow", isContentWindow: false))
    }
}
