import SqueakMacCore
import AppKit
import SwiftUI

// DESIGN.md §8.10, shortcut hints: a control with a shortcut names it on hover, in Squeak's own small label
// ("Hide sidebar  ⌘B") about 500 ms after the pointer rests on it. The words and keys come from `ShortcutRegistry`,
// the same list that binds the menu items and fills the shortcut sheet. VoiceOver gets the same sentence as the
// control's accessibility hint, not as a second tooltip.

extension KeyChord {
    /// The SwiftUI shortcut for a chord, or nil for a range ("1–9") or a key SwiftUI has no name for.
    var keyboardShortcut: KeyboardShortcut? {
        var mods: EventModifiers = []
        if modifiers.contains(.control) { mods.insert(.control) }
        if modifiers.contains(.option) { mods.insert(.option) }
        if modifiers.contains(.shift) { mods.insert(.shift) }
        if modifiers.contains(.command) { mods.insert(.command) }
        let equivalent: KeyEquivalent
        switch key {
        case "↵": equivalent = .return
        case "⌫": equivalent = .delete
        case "Tab": equivalent = .tab
        case "↑": equivalent = .upArrow
        case "↓": equivalent = .downArrow
        default:
            guard key.count == 1, let c = key.lowercased().first else { return nil }
            equivalent = KeyEquivalent(c)
        }
        return KeyboardShortcut(equivalent, modifiers: mods)
    }
}

extension View {
    /// Binds the registry's first chord for `id` to this control (a menu item or a hidden button).
    @ViewBuilder func registryShortcut(_ id: ShortcutID) -> some View {
        if let shortcut = ShortcutRegistry.chords(for: id).first?.keyboardShortcut { keyboardShortcut(shortcut) } else { self }
    }

    /// The hover label ("Hide sidebar  ⌘B") and the same words for VoiceOver.
    func shortcutHint(_ name: String, _ id: ShortcutID) -> some View {
        modifier(ShortcutHintModifier(text: ShortcutRegistry.hint(name, id), name: name))
    }
}

private struct ShortcutHintModifier: ViewModifier {
    let text: String
    let name: String
    @State private var anchor = HintAnchor()
    @State private var pending: Task<Void, Never>?

    func body(content: Content) -> some View {
        content
            .background(HintAnchorView(anchor: anchor))
            .onHover { inside in
                pending?.cancel()
                if inside {
                    pending = Task { @MainActor in
                        try? await Task.sleep(for: .milliseconds(500))
                        if !Task.isCancelled { anchor.show(text) }
                    }
                } else {
                    anchor.hide()
                }
            }
            .accessibilityHint(text)
            .onDisappear { pending?.cancel(); anchor.hide() }
    }
}

/// Holds the control's NSView and the hint's own panel. A child window escapes every scroll view and toolbar clip.
@MainActor final class HintAnchor {
    weak var view: NSView?
    private var panel: NSPanel?
    private var monitor: Any?

    func show(_ text: String) {
        guard panel == nil, let view, let window = view.window else { return }
        let host = NSHostingView(rootView: ShortcutHintLabel(text: text).padding(8))
        let size = host.fittingSize
        host.frame = CGRect(origin: .zero, size: size)
        // Control and window in top-left, y-down space relative to the window's frame.
        let inWindow = view.convert(view.bounds, to: nil)
        let wf = window.frame
        let control = CGRect(x: inWindow.minX, y: wf.height - inWindow.maxY, width: inWindow.width, height: inWindow.height)
        let o = HintPlacement.origin(control: control, hint: size, window: CGRect(origin: .zero, size: wf.size))
        let p = NSPanel(contentRect: CGRect(x: wf.minX + o.x, y: wf.maxY - o.y - size.height, width: size.width, height: size.height),
                        styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        p.isOpaque = false; p.backgroundColor = .clear; p.hasShadow = false
        p.ignoresMouseEvents = true; p.level = window.level; p.hidesOnDeactivate = true
        p.contentView = host
        window.addChildWindow(p, ordered: .above)
        panel = p
        monitor = NSEvent.addLocalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown, .keyDown]) { [weak self] e in
            self?.hide(); return e
        }
    }

    func hide() {
        if let monitor { NSEvent.removeMonitor(monitor) }
        monitor = nil
        if let panel { panel.parent?.removeChildWindow(panel); panel.orderOut(nil) }
        panel = nil
    }
}

private struct HintAnchorView: NSViewRepresentable {
    let anchor: HintAnchor
    func makeNSView(context: Context) -> NSView { let v = NSView(); anchor.view = v; return v }
    func updateNSView(_ v: NSView, context: Context) { anchor.view = v }
}

/// The small label: `surface-raised`, `line`, `radius-control`, the name in `ink` and the keys in `muted`.
struct ShortcutHintLabel: View {
    let text: String

    var body: some View {
        let parts = text.components(separatedBy: "  ")
        HStack(spacing: 8) {
            Text(verbatim: parts[0]).foregroundStyle(Theme.ink)
            if parts.count > 1 { Text(verbatim: parts[1]).foregroundStyle(Theme.muted).monospacedDigit() }
        }
        .font(Typo.meta).lineLimit(1).fixedSize()
        .padding(.horizontal, 8).padding(.vertical, 5)
        .background(Theme.surfaceRaised, in: RoundedRectangle(cornerRadius: Radius.control))
        .overlay(RoundedRectangle(cornerRadius: Radius.control).strokeBorder(Theme.line))
        .shadow(color: .black.opacity(0.12), radius: 4, y: 1)
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }
}

extension Notification.Name {
    static let squeakCloseTab = Notification.Name("SqueakCloseTab")
    /// `object`: the step, +1 or −1.
    static let squeakStepTab = Notification.Name("SqueakStepTab")
    static let squeakShowAllChanges = Notification.Name("SqueakShowAllChanges")
    static let squeakModelPicker = Notification.Name("SqueakModelPicker")
    static let squeakNextEffort = Notification.Name("SqueakNextEffort")
    static let squeakAttach = Notification.Name("SqueakAttach")
    static let squeakToggleCode = Notification.Name("SqueakToggleCode")
    static let squeakShowCode = Notification.Name("SqueakShowCode")
    static let squeakToggleInspector = Notification.Name("SqueakToggleInspector")
    static let squeakToggleTerminal = Notification.Name("SqueakToggleTerminal")
}
