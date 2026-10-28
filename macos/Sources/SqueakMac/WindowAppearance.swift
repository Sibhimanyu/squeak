import AppKit
import SwiftUI

/// The main window can use the native behind-window material, or the original solid canvas.
/// Reduce Transparency always selects the solid canvas, regardless of the saved preference.
enum WindowAppearancePreference {
    static let key = "squeakGlassWindowAppearance"
}

private struct GlassWindowEnabledKey: EnvironmentKey {
    static let defaultValue = true
}

extension EnvironmentValues {
    var glassWindowEnabled: Bool {
        get { self[GlassWindowEnabledKey.self] }
        set { self[GlassWindowEnabledKey.self] = newValue }
    }
}

struct WindowMaterialBackground: NSViewRepresentable {
    func makeNSView(context: Context) -> NSVisualEffectView {
        let view = NSVisualEffectView()
        view.material = .underWindowBackground
        view.blendingMode = .behindWindow
        view.state = .followsWindowActiveState
        return view
    }

    func updateNSView(_ view: NSVisualEffectView, context: Context) {}
}

extension View {
    /// A full-window background that reveals the native material when glass is enabled.
    func squeakWindowCanvas() -> some View {
        modifier(WindowCanvasModifier())
    }
}

private struct WindowCanvasModifier: ViewModifier {
    @Environment(\.glassWindowEnabled) private var glassEnabled

    func body(content: Content) -> some View {
        content.background {
            if glassEnabled {
                WindowMaterialBackground().ignoresSafeArea()
            } else {
                Theme.bg.ignoresSafeArea()
            }
        }
    }
}
