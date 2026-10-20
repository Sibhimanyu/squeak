import AppKit
import SwiftUI

/// The menu-bar panel's own pieces, after the system menus (Sound, Wi-Fi): a muted semibold heading,
/// softly contrasting grouped bands, separators inset from the edges, and footer actions as plain
/// menu rows. Used by `PopoverView` and `UsageSection` only; the shared components stay as they are.
enum PopoverMetrics {
    static let width: CGFloat = 320
    static let corner: CGFloat = 18
    /// Left/right inset of every row's content, so headings, rows and footer text share one edge.
    static let inset: CGFloat = 16
    /// Room left around the panel on a short screen (menu bar, shadow, a margin).
    static let screenMargin: CGFloat = 48
}

/// Section heading: 13pt semibold, muted, like "Listening Mode" in the Sound menu.
struct MenuHeading: View {
    let title: String
    init(_ title: String) { self.title = title }

    var body: some View {
        Text(title)
            .font(.system(size: 13, weight: .semibold))
            .foregroundStyle(Theme.muted)
            .frame(maxWidth: .infinity, alignment: .leading)
            .accessibilityAddTraits(.isHeader)
    }
}

/// A separator that stops short of both edges.
struct InsetSeparator: View {
    var body: some View {
        Rectangle().fill(Theme.line).frame(height: 1)
            .padding(.horizontal, Space.m)
            .accessibilityHidden(true)
    }
}

/// A grouped area: full width, a fill a step lighter (dark) or darker (light) than the panel.
struct GroupBand<Content: View>: View {
    @ViewBuilder var content: Content

    var body: some View {
        content
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Theme.panelBand)
    }
}

/// A footer action drawn as a menu row: plain text, a hover highlight, an optional shortcut hint.
struct MenuRow: View {
    let title: String
    var hint: String?
    var role: ButtonRole?
    var disabled = false
    let action: () -> Void
    @State private var hovering = false

    var body: some View {
        Button(role: role, action: action) {
            HStack(spacing: Space.s) {
                Text(title).font(.system(size: 13)).lineLimit(1)
                Spacer(minLength: Space.s)
                if let hint { Text(hint).font(.system(size: 12)).foregroundStyle(Theme.subtle) }
            }
            .foregroundStyle(disabled ? Theme.subtle : Theme.ink)
            .padding(.horizontal, Space.m)
            .frame(height: 26)
            .background(RoundedRectangle(cornerRadius: 6, style: .continuous).fill(Theme.ink.opacity(hovering && !disabled ? 0.09 : 0)))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(disabled)
        .onHover { hovering = $0 }
        .padding(.horizontal, 4)
        .accessibilityElement(children: .combine)
    }
}

/// The panel's surface for a preview that has no system window around it (the offline captures):
/// native material, an inset outline, large continuous corners. The real `MenuBarExtra` window draws
/// its own material, border and shadow, so `PopoverView` leaves this off there. Reduce Transparency
/// gets the near-opaque token (see `PanelBackground`).
struct PanelSurface: ViewModifier {
    func body(content: Content) -> some View {
        let shape = RoundedRectangle(cornerRadius: PopoverMetrics.corner, style: .continuous)
        content
            .background(PanelBackground())
            .clipShape(shape)
            .overlay(shape.strokeBorder(Theme.lineStrong, lineWidth: 1))
    }
}

extension View {
    func panelSurface() -> some View { modifier(PanelSurface()) }
}

/// Height of the parts of the panel that never scroll, summed, so the list can take what is left.
struct PopoverChromeKey: PreferenceKey {
    static let defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) { value += nextValue() }
}

extension View {
    func measuredAsChrome() -> some View {
        background(GeometryReader { Color.clear.preference(key: PopoverChromeKey.self, value: $0.size.height) })
    }
}

/// Height of the footer, which stays on screen however short the screen is.
struct PopoverFooterKey: PreferenceKey {
    static let defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) { value += nextValue() }
}

extension View {
    func measuredAsFooter() -> some View {
        background(GeometryReader { Color.clear.preference(key: PopoverFooterKey.self, value: $0.size.height) })
    }
}

/// Reports the usable height of the screen the hosting window is on, and follows the window to
/// another display. Nothing here reads a process-global screen: until the view is in a window the
/// callback is not called and the owner keeps its fallback.
struct ScreenHeightReader: NSViewRepresentable {
    let onChange: @MainActor (CGFloat?) -> Void

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeNSView(context: Context) -> TrackingView {
        let view = TrackingView()
        context.coordinator.attach(to: view, onChange: onChange)
        return view
    }

    func updateNSView(_ view: TrackingView, context: Context) {
        context.coordinator.onChange = onChange
    }

    static func dismantleNSView(_ view: TrackingView, coordinator: Coordinator) {
        coordinator.detach()
    }

    /// Tells its owner when it joins or leaves a window.
    final class TrackingView: NSView {
        var windowChanged: (@MainActor (NSWindow?) -> Void)?

        override func viewDidMoveToWindow() {
            super.viewDidMoveToWindow()
            let window = window
            MainActor.assumeIsolated { windowChanged?(window) }
        }
    }

    @MainActor final class Coordinator {
        var onChange: @MainActor (CGFloat?) -> Void = { _ in }
        // Tokens are removed on the main actor in `detach`; `deinit` is a backstop.
        private nonisolated(unsafe) var tokens: [NSObjectProtocol] = []
        private weak var window: NSWindow?

        func attach(to view: TrackingView, onChange: @escaping @MainActor (CGFloat?) -> Void) {
            self.onChange = onChange
            view.windowChanged = { [weak self] window in self?.follow(window) }
        }

        func detach() {
            removeObservers()
            window = nil
        }

        private func follow(_ window: NSWindow?) {
            removeObservers()
            self.window = window
            guard let window else { return }
            let center = NotificationCenter.default
            let wake: @Sendable (Notification) -> Void = { [weak self] _ in
                MainActor.assumeIsolated { self?.report() }
            }
            tokens = [
                center.addObserver(forName: NSWindow.didChangeScreenNotification, object: window, queue: .main, using: wake),
                center.addObserver(forName: NSApplication.didChangeScreenParametersNotification, object: nil, queue: .main, using: wake),
            ]
            report()
        }

        private func report() {
            onChange(window?.screen?.visibleFrame.height)
        }

        private func removeObservers() {
            for token in tokens { NotificationCenter.default.removeObserver(token) }
            tokens = []
        }

        deinit {
            for token in tokens { NotificationCenter.default.removeObserver(token) }
        }
    }
}
