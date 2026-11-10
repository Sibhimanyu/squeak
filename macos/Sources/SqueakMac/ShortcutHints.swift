import SqueakMacCore
import SwiftUI

// DESIGN.md §8.10, shortcut hints: a control with a shortcut names it on hover, in Squeak's own small label
// ("Hide sidebar  ⌘B") about 400 ms after the pointer rests on it. The words and keys come from `ShortcutRegistry`,
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
    @State private var shown = false
    @State private var pending: Task<Void, Never>?

    func body(content: Content) -> some View {
        content
            .onHover { inside in
                pending?.cancel()
                if inside {
                    pending = Task { @MainActor in
                        try? await Task.sleep(for: .milliseconds(400))
                        if !Task.isCancelled { shown = true }
                    }
                } else {
                    shown = false
                }
            }
            .overlay(alignment: .bottom) {
                if shown {
                    // Just under the control; the guide moves the label's own bottom reference above its top.
                    ShortcutHintLabel(text: text)
                        .alignmentGuide(.bottom) { $0[.top] - 6 }
                        .transition(.opacity)
                        .zIndex(10)
                }
            }
            .accessibilityHint(text)
            .onDisappear { pending?.cancel(); shown = false }
    }
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
