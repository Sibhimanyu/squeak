import AppKit
import SqueakIcons
import SwiftUI

/// Squeak's in-app menus: shared rows, selection, keyboard handling and dismissal.
/// Actions remain ordinary Buttons, so disabled states and accessibility labels travel with them.
struct SqueakMenu<Content: View, Label: View>: View {
    @ViewBuilder var content: () -> Content
    @ViewBuilder var label: () -> Label
    var primaryAction: (() -> Void)? = nil
    @Environment(SqueakMenuInteraction.self) private var parent: SqueakMenuInteraction?
    @State private var presented = false

    var body: some View {
        Group {
            if parent != nil {
                Button { presented.toggle() } label: {
                    HStack {
                        label()
                        Spacer(minLength: 12)
                        Lucide(.chevronRight, size: 12, color: Theme.muted)
                    }
                }
                .buttonStyle(SqueakMenuButtonStyle(dismissOnTrigger: false))
            } else if let primaryAction {
                HStack(spacing: 2) {
                    Button(action: primaryAction, label: label).buttonStyle(.plain)
                    Button { presented.toggle() } label: {
                        Lucide(.chevronDown, size: 12, color: Theme.muted).frame(width: 20, height: 28)
                    }
                    .buttonStyle(.plain).accessibilityLabel("More actions")
                }
            } else {
                Button { presented.toggle() } label: { label() }.buttonStyle(.plain)
            }
        }
        .popover(isPresented: $presented, arrowEdge: parent == nil ? .bottom : .trailing) {
            SqueakMenuSurface(close: { presented = false }, perform: {
                presented = false
                parent?.dismiss()
            }, content: content)
        }
    }
}

extension SqueakMenu where Label == SqueakMenuTitle {
    init(_ title: String, @ViewBuilder content: @escaping () -> Content) {
        self.content = content
        self.label = { SqueakMenuTitle(title: title) }
    }
}

struct SqueakMenuTitle: View {
    let title: String
    var body: some View {
        HStack(spacing: 8) {
            Text(title)
            Lucide(.chevronDown, size: 12, color: Theme.muted)
        }
        .font(.system(size: 13)).foregroundStyle(Theme.ink)
        .padding(.horizontal, 10).padding(.vertical, 7)
        .background(Theme.surfaceRaised, in: RoundedRectangle(cornerRadius: Radius.control))
        .overlay(RoundedRectangle(cornerRadius: Radius.control).strokeBorder(Theme.line))
    }
}

@Observable @MainActor
private final class SqueakMenuInteraction {
    var selected: UUID?
    var dismiss: () -> Void = {}
}

private struct SqueakMenuEntry: Equatable {
    var id: UUID
    var enabled: Bool
    var opensSubmenu: Bool
    var trigger: () -> Void
    static func == (lhs: Self, rhs: Self) -> Bool { lhs.id == rhs.id && lhs.enabled == rhs.enabled }
}

private struct SqueakMenuEntries: PreferenceKey {
    static var defaultValue: [SqueakMenuEntry] { [] }
    static func reduce(value: inout [SqueakMenuEntry], nextValue: () -> [SqueakMenuEntry]) { value += nextValue() }
}

private struct SqueakMenuHeight: PreferenceKey {
    static var defaultValue: CGFloat { 0 }
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) { value = max(value, nextValue()) }
}

struct SqueakMenuSurface<Content: View>: View {
    let close: () -> Void
    let perform: () -> Void
    @ViewBuilder var content: () -> Content
    @State private var interaction = SqueakMenuInteraction()
    @State private var entries: [SqueakMenuEntry] = []
    @State private var height: CGFloat = 100
    @FocusState private var focused: Bool

    var body: some View {
        ScrollViewReader { scroll in
            ScrollView {
                VStack(alignment: .leading, spacing: 3, content: content)
                    .buttonStyle(SqueakMenuButtonStyle())
                    .toggleStyle(SqueakMenuToggleStyle())
                    .font(.system(size: 13))
                    .foregroundStyle(Theme.muted)
                    .padding(6)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(GeometryReader { geometry in
                        Color.clear.preference(key: SqueakMenuHeight.self, value: geometry.size.height)
                    })
            }
            .scrollIndicators(.automatic)
            .frame(width: 280, height: min(max(height, 36), 440))
            .background(Theme.surface)
            .clipShape(RoundedRectangle(cornerRadius: Radius.control))
            .environment(interaction)
            .focusable().focused($focused).focusEffectDisabled()
            .onPreferenceChange(SqueakMenuHeight.self) { height = $0 }
            .onPreferenceChange(SqueakMenuEntries.self) { items in
                entries = items
                if !items.contains(where: { $0.id == interaction.selected && $0.enabled }) {
                    interaction.selected = items.first(where: \.enabled)?.id
                }
            }
            .onChange(of: interaction.selected) { _, id in
                if let id { scroll.scrollTo(id) }
            }
            .onKeyPress(.downArrow) { move(1); return .handled }
            .onKeyPress(.upArrow) { move(-1); return .handled }
            .onKeyPress(.return) { activate(); return .handled }
            .onKeyPress(.space) { activate(); return .handled }
            .onKeyPress(.rightArrow) { activate(submenuOnly: true); return .handled }
            .onKeyPress(.escape) { close(); return .handled }
            .onKeyPress(.leftArrow) { close(); return .handled }
            .onKeyPress(.tab) { close(); return .handled }
            .onAppear { interaction.dismiss = perform; focused = true }
        }
        .padding(2)
        .presentationBackground(Theme.surface)
    }

    private func move(_ delta: Int) {
        let enabled = entries.filter(\.enabled)
        guard !enabled.isEmpty else { return }
        let current = enabled.firstIndex { $0.id == interaction.selected } ?? (delta > 0 ? -1 : 0)
        interaction.selected = enabled[(current + delta + enabled.count) % enabled.count].id
    }

    private func activate(submenuOnly: Bool = false) {
        entries.first { $0.id == interaction.selected && $0.enabled && (!submenuOnly || $0.opensSubmenu) }?.trigger()
    }
}

private struct SqueakMenuButtonStyle: PrimitiveButtonStyle {
    var dismissOnTrigger = true
    func makeBody(configuration: Configuration) -> some View {
        SqueakMenuRow(role: configuration.role, dismissOnTrigger: dismissOnTrigger, action: configuration.trigger) {
            configuration.label
        }
    }
}

private struct SqueakMenuRow<Label: View>: View {
    let role: ButtonRole?
    let dismissOnTrigger: Bool
    let action: () -> Void
    @ViewBuilder var label: () -> Label
    @Environment(\.isEnabled) private var enabled
    @Environment(\.keyboardShortcut) private var shortcut
    @Environment(SqueakMenuInteraction.self) private var interaction: SqueakMenuInteraction?
    @State private var id = UUID()

    private func trigger() {
        guard enabled else { return }
        if dismissOnTrigger { interaction?.dismiss() }
        action()
    }

    private func shortcutText(_ shortcut: KeyboardShortcut) -> String {
        let flags = shortcut.modifiers
        let key: String
        switch shortcut.key {
        case .return: key = "↩"
        case .escape: key = "⎋"
        case .tab: key = "⇥"
        case .space: key = "Space"
        default: key = String(shortcut.key.character).uppercased()
        }
        return (flags.contains(.control) ? "⌃" : "") + (flags.contains(.option) ? "⌥" : "")
            + (flags.contains(.shift) ? "⇧" : "") + (flags.contains(.command) ? "⌘" : "") + key
    }

    var body: some View {
        Button(role: role, action: trigger) {
            HStack(spacing: 12) {
                label()
                if let shortcut {
                    Spacer(minLength: 0)
                    Text(shortcutText(shortcut)).font(.system(size: 11)).foregroundStyle(Theme.subtle)
                }
            }
                .font(.system(size: 13))
                .foregroundStyle(role == .destructive ? Theme.negative : Theme.ink)
                .labelStyle(.titleAndIcon)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 10).padding(.vertical, 7)
                .frame(minHeight: 32)
                .background(enabled && interaction?.selected == id ? Theme.selected : .clear,
                            in: RoundedRectangle(cornerRadius: 6))
                .contentShape(Rectangle())
                .opacity(enabled ? 1 : 0.4)
        }
        .buttonStyle(.plain)
        .id(id)
        .onHover { if $0 && enabled { interaction?.selected = id } }
        .preference(key: SqueakMenuEntries.self, value: [SqueakMenuEntry(id: id, enabled: enabled, opensSubmenu: !dismissOnTrigger, trigger: trigger)])
    }
}

private struct SqueakMenuToggleStyle: ToggleStyle {
    func makeBody(configuration: Configuration) -> some View {
        Button { configuration.isOn.toggle() } label: {
            HStack(spacing: 8) {
                configuration.label
                Spacer(minLength: 12)
                Lucide(.check, size: 14, color: Theme.ink).opacity(configuration.isOn ? 1 : 0)
            }
        }
        .accessibilityValue(configuration.isOn ? "Selected" : "Not selected")
        .accessibilityAddTraits(configuration.isOn ? .isSelected : [])
    }
}

extension View {
    func squeakContextMenu<Items: View>(@ViewBuilder items: @escaping () -> Items) -> some View {
        modifier(SqueakContextMenu(items: items))
    }
}

private struct SqueakContextMenu<Items: View>: ViewModifier {
    @ViewBuilder var items: () -> Items
    @State private var presented = false
    @State private var point = UnitPoint.center

    func body(content: Content) -> some View {
        content
            .background(SqueakContextAnchor { location in point = location; presented = true })
            .popover(isPresented: $presented, attachmentAnchor: .point(point), arrowEdge: .bottom) {
                SqueakMenuSurface(close: { presented = false }, perform: { presented = false }, content: items)
            }
    }
}

/// Observe secondary clicks without placing an event-catching layer over row buttons or drag targets.
private struct SqueakContextAnchor: NSViewRepresentable {
    var open: (UnitPoint) -> Void
    func makeNSView(context: Context) -> Anchor { let view = Anchor(); view.open = open; return view }
    func updateNSView(_ nsView: Anchor, context: Context) { nsView.open = open }
    static func dismantleNSView(_ nsView: Anchor, coordinator: ()) { nsView.stop() }

    final class Anchor: NSView {
        var open: ((UnitPoint) -> Void)?
        private var monitor: Any?
        override func hitTest(_ point: NSPoint) -> NSView? { nil }
        override func viewDidMoveToWindow() {
            super.viewDidMoveToWindow()
            stop()
            guard window != nil else { return }
            monitor = NSEvent.addLocalMonitorForEvents(matching: [.rightMouseDown, .leftMouseDown]) { [weak self] event in
                guard let self, let window = self.window, window == event.window,
                      event.type == .rightMouseDown || event.modifierFlags.contains(.control),
                      self.visibleRect.width > 0, self.visibleRect.height > 0 else { return event }
                let location = self.convert(event.locationInWindow, from: nil)
                guard self.visibleRect.contains(location) else { return event }
                self.open?(UnitPoint(x: location.x / max(self.bounds.width, 1),
                                     y: 1 - location.y / max(self.bounds.height, 1)))
                return nil
            }
        }
        func stop() { if let monitor { NSEvent.removeMonitor(monitor) }; monitor = nil }
    }
}

/// Typed choices keep picker values and their bindings intact while using the same menu rows.
struct SqueakChoice<Value: Hashable> {
    let title: String
    let value: Value
    func accessibilityLabel(_ label: String) -> Self { self }
}

@resultBuilder
struct SqueakChoiceBuilder<Value: Hashable> {
    static func buildExpression(_ item: SqueakChoice<Value>) -> [SqueakChoice<Value>] { [item] }
    static func buildExpression(_ items: [SqueakChoice<Value>]) -> [SqueakChoice<Value>] { items }
    static func buildBlock(_ parts: [SqueakChoice<Value>]...) -> [SqueakChoice<Value>] { parts.flatMap { $0 } }
    static func buildOptional(_ items: [SqueakChoice<Value>]?) -> [SqueakChoice<Value>] { items ?? [] }
    static func buildEither(first: [SqueakChoice<Value>]) -> [SqueakChoice<Value>] { first }
    static func buildEither(second: [SqueakChoice<Value>]) -> [SqueakChoice<Value>] { second }
}

func SqueakOptions<Data: RandomAccessCollection, Value: Hashable>(_ data: Data,
    @SqueakChoiceBuilder<Value> content: (Data.Element) -> [SqueakChoice<Value>]) -> [SqueakChoice<Value>] {
    data.flatMap(content)
}

func SqueakOptions<Data: RandomAccessCollection, ID: Hashable, Value: Hashable>(_ data: Data, id: KeyPath<Data.Element, ID>,
    @SqueakChoiceBuilder<Value> content: (Data.Element) -> [SqueakChoice<Value>]) -> [SqueakChoice<Value>] {
    data.flatMap(content)
}

struct SqueakPicker<Value: Hashable>: View {
    let title: String
    let selection: Binding<Value>
    @SqueakChoiceBuilder<Value> var choices: () -> [SqueakChoice<Value>]

    init(_ title: String, selection: Binding<Value>, @SqueakChoiceBuilder<Value> choices: @escaping () -> [SqueakChoice<Value>]) {
        self.title = title; self.selection = selection; self.choices = choices
    }

    var body: some View {
        let items = choices()
        LabeledContent(title) {
            SqueakMenu {
                ForEach(items, id: \.value) { item in
                    Button { selection.wrappedValue = item.value } label: {
                        HStack(spacing: 8) {
                            Text(verbatim: item.title)
                            Spacer(minLength: 12)
                            Lucide(.check, size: 14, color: Theme.ink).opacity(selection.wrappedValue == item.value ? 1 : 0)
                        }
                    }
                    .accessibilityAddTraits(selection.wrappedValue == item.value ? .isSelected : [])
                }
            } label: {
                HStack(spacing: 8) {
                    Text(verbatim: items.first { $0.value == selection.wrappedValue }?.title ?? title).lineLimit(1)
                    Lucide(.chevronDown, size: 12, color: Theme.muted)
                }
                .font(.system(size: 13)).foregroundStyle(Theme.ink)
                .padding(.horizontal, 10).padding(.vertical, 7)
                .background(Theme.surfaceRaised, in: RoundedRectangle(cornerRadius: Radius.control))
                .overlay(RoundedRectangle(cornerRadius: Radius.control).strokeBorder(Theme.line))
                .contentShape(Rectangle())
            }
            .accessibilityLabel(title)
            .accessibilityValue(items.first { $0.value == selection.wrappedValue }?.title ?? "")
        }
    }
}
