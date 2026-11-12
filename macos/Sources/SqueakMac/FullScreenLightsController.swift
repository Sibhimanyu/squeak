import AppKit
import SqueakMacCore
import SwiftUI

/// Full screen without a bar. macOS still slides its own titlebar (with the three buttons) down when the pointer reaches
/// the top; here that titlebar is made to show nothing: the standard buttons are hidden and the titlebar container is
/// transparent, so no strip is ever drawn and the window has no toolbar to reserve one. Squeak draws its own controls
/// (`FullScreenLightsView`) in the sidebar's top row, and this controller decides when they are in: a poll of the
/// pointer (30 Hz, only in full screen; `NSEvent.mouseLocation` needs no permission, and a mouse monitor would miss the
/// menu bar's strip) fed to `FullScreenReveal`.
@MainActor
final class FullScreenLightsController {
    static let shared = FullScreenLightsController()
    private weak var window: NSWindow?
    private var timer: Timer?
    private var reveal = FullScreenReveal()

    private static let hiddenButtons: [NSWindow.ButtonType] = [.closeButton, .miniaturizeButton, .zoomButton]

    func enter(_ w: NSWindow) {
        window = w
        reveal.reset()
        Self.hideSystemChrome(w, hidden: true)
        timer?.invalidate()
        let t = Timer(timeInterval: 1.0 / 30, repeats: true) { [weak self] _ in MainActor.assumeIsolated { self?.tick() } }
        RunLoop.main.add(t, forMode: .common)
        timer = t
    }

    func exit(_ w: NSWindow) {
        timer?.invalidate(); timer = nil
        reveal.reset()
        Self.hideSystemChrome(w, hidden: false)
        set(false, animated: false)
    }

    private func tick() {
        guard let w = window, w.styleMask.contains(.fullScreen) else { return }
        // AppKit re-shows the buttons each time it reveals its titlebar; keep them off.
        Self.hideSystemChrome(w, hidden: true)
        guard NSApp.isActive, let screen = w.screen ?? NSScreen.main else { reveal.reset(); set(false, animated: true); return }
        let p = NSEvent.mouseLocation
        let inScreen = screen.frame.contains(p) || p.y >= screen.frame.maxY   // the very top edge is outside `contains`
        let fromTop = screen.frame.maxY - p.y
        let overControls = inScreen && p.x - screen.frame.minX <= FullScreenLights.width + PaneToggle.barPadding + 8 && fromTop <= Metrics.header
        let menuBar = max(24, NSApp.mainMenu?.menuBarHeight ?? 24)
        let now = reveal.update(now: Date(), fromTop: inScreen ? fromTop : .infinity, menuBarHeight: menuBar, overControls: overControls)
        set(now, animated: true)
    }

    private func set(_ revealed: Bool, animated: Bool) {
        let model = AppModel.shared
        guard model.fullScreenLightsRevealed != revealed else { return }
        // Slide in at 0.2 s ease-out; with Reduce Motion the row jumps and the controls fade (FullScreenLightsView).
        if animated, !Motion.reduceMotion { withAnimation(.easeOut(duration: 0.2)) { model.fullScreenLightsRevealed = revealed } }
        else { model.fullScreenLightsRevealed = revealed }
    }

    /// The buttons, and the titlebar container that would draw a strip behind them. The container is found by the
    /// class name of the close button's ancestors (NSTitlebarContainerView), never by position.
    static func hideSystemChrome(_ w: NSWindow, hidden: Bool) {
        for type in hiddenButtons { w.standardWindowButton(type)?.isHidden = hidden }
        var v = w.standardWindowButton(.closeButton)?.superview
        while let view = v {
            if String(describing: type(of: view)).contains("NSTitlebarContainerView") {
                view.alphaValue = hidden ? 0 : 1
                break
            }
            v = view.superview
        }
    }
}

/// Squeak's own window controls, DESIGN.md §8.10: macOS's size, spacing and colours (12pt circles, 8pt apart; red, yellow,
/// green). Close closes the window, Minimise is disabled in full screen (as in macOS), the green one leaves full screen.
/// Glyphs (x, minus, arrows) show while the pointer is on the group.
struct FullScreenLightsView: View {
    @Environment(AppModel.self) private var model
    @State private var hovering = false

    var body: some View {
        HStack(spacing: FullScreenLights.gap) {
            light(Color(nsColor: NSColor(hex: 0xFF5F57)), glyph: "xmark", enabled: true, label: "Close") { model.conversationWindow?.performClose(nil) }
            light(Color(nsColor: NSColor(hex: 0xFEBC2E)), glyph: "minus", enabled: false, label: "Minimise") {}
            light(Color(nsColor: NSColor(hex: 0x28C840)), glyph: "arrow.up.left.and.arrow.down.right", enabled: true, label: "Exit full screen") {
                model.conversationWindow?.toggleFullScreen(nil)
            }
        }
        .onHover { hovering = $0 }
    }

    private func light(_ colour: Color, glyph: String, enabled: Bool, label: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            ZStack {
                Circle().fill(enabled ? colour : Color.gray.opacity(0.45))
                if hovering, enabled {
                    Image(systemName: glyph).font(.system(size: 7, weight: .heavy)).foregroundStyle(Color.black.opacity(0.6))
                }
            }
            .frame(width: FullScreenLights.diameter, height: FullScreenLights.diameter)
        }
        .buttonStyle(.plain).disabled(!enabled).accessibilityLabel(label)
    }
}
