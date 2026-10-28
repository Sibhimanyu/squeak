import AppKit
import SwiftUI

/// The main window can use the native behind-window material, or the original solid canvas.
/// Reduce Transparency always selects the solid canvas, regardless of the saved preference.
enum WindowAppearancePreference {
    static let key = "squeakGlassWindowAppearance"
    static let transparencyKey = "squeakGlassTransparency"
    static let sidebarContrastKey = "squeakGlassSidebarContrast"
    static let defaultTransparency = 62.0
    static let defaultSidebarContrast = 22.0
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
    @Environment(\.glassWindowEnabled) private var glassEnabled
    @Environment(\.glassTransparency) private var transparency

    func body(content: Content) -> some View {
        content.background {
            if glassEnabled {
                ZStack {
                    WindowMaterialBackground()
                    Theme.bg.opacity(washOpacity)
                }
                .ignoresSafeArea()
            } else {
                Theme.bg.ignoresSafeArea()
            }
        }
    }

    /// Keep the native material visible while letting people soften it with an adaptive tint.
    private var washOpacity: Double { (1 - min(max(transparency, 0), 100) / 100) * 0.42 }
}
