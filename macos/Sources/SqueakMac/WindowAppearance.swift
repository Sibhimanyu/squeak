import AppKit
import SwiftUI

/// The main window can use the native behind-window material, or the original solid canvas.
/// Reduce Transparency always selects the solid canvas, regardless of the saved preference.
enum WindowAppearancePreference {
    static let key = "squeakGlassWindowAppearance"
    static let transparencyKey = "squeakGlassTransparency"
    static let sidebarContrastKey = "squeakGlassSidebarContrast"
    static let defaultTransparency = 7.0
    static let defaultSidebarContrast = 68.0
}

private struct GlassWindowEnabledKey: EnvironmentKey {
    static let defaultValue = true
}

private struct GlassTransparencyKey: EnvironmentKey {
    static let defaultValue = WindowAppearancePreference.defaultTransparency
}

private struct GlassSidebarContrastKey: EnvironmentKey {
    static let defaultValue = WindowAppearancePreference.defaultSidebarContrast
}

extension EnvironmentValues {
    var glassWindowEnabled: Bool {
        get { self[GlassWindowEnabledKey.self] }
        set { self[GlassWindowEnabledKey.self] = newValue }
    }

    var glassTransparency: Double {
        get { self[GlassTransparencyKey.self] }
        set { self[GlassTransparencyKey.self] = newValue }
    }

    var glassSidebarContrast: Double {
        get { self[GlassSidebarContrastKey.self] }
        set { self[GlassSidebarContrastKey.self] = newValue }
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
    /// DESIGN.md §3.2: the workbench is opaque (no behind-window material, no tint); the old glass
    /// preference keys stay only so a saved value does not break.
    func body(content: Content) -> some View {
        content.background { Theme.bg.ignoresSafeArea() }
    }
}
