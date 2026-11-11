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
                    Button {
                        presented = false
                        SqueakMenuWindows.hideAll()
                        primaryAction()
                    } label: { label() }.buttonStyle(.plain)
                    Button { presented.toggle() } label: {
                        Lucide(.chevronDown, size: 12, color: Theme.muted).frame(width: 20, height: 28)
                    }
                    .buttonStyle(.plain).accessibilityLabel("More actions")
                }
            } else {
                Button { presented.toggle() } label: { label() }.buttonStyle(.plain)
            }
        }
        .modifier(SqueakMenuPresentation(presented: $presented, submenu: parent != nil) { resize in
            SqueakMenuSurface(close: { presented = false }, perform: {
                presented = false
                parent?.dismiss()
            }, resize: resize, content: content)
        })
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
    @Environment(SqueakMenuInteraction.self) private var interaction: SqueakMenuInteraction?
    var body: some View {
        if interaction != nil {
            Text(title)
        } else {
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
    var resize: (CGFloat) -> Void = { _ in }
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
            .onPreferenceChange(SqueakMenuHeight.self) {
                height = $0
                resize(min(max($0, 36), 440) + 4)
            }
            .onPreferenceChange(SqueakMenuEntries.self) { items in
                entries = items
                if !items.contains(where: { $0.id == interaction.selected && $0.enabled }) {
                    interaction.selected = items.first(where: \.enabled)?.id
                }
            }
            .onChange(of: interaction.selected) { _, id in
                if let id { scroll.scrollTo(id) }
            }
            .onAppear { interaction.dismiss = perform; focused = true }
        }
        .padding(2)
        .background(SqueakMenuWindowRegistration(handleKey: handleKey))
        .background(Theme.surface, in: RoundedRectangle(cornerRadius: Radius.control))
        .clipShape(RoundedRectangle(cornerRadius: Radius.control))
        .overlay(RoundedRectangle(cornerRadius: Radius.control).strokeBorder(Theme.line))
    }

    private func handleKey(_ event: NSEvent) -> Bool {
        guard event.modifierFlags.intersection([.command, .option, .control]).isEmpty else { return false }
        switch event.keyCode {
        case 125: move(1)
        case 126: move(-1)
        case 36, 76, 49: activate()
        case 124: activate(submenuOnly: true)
        case 123, 53, 48: close()
        case 115: interaction.selected = entries.first(where: \.enabled)?.id
        case 119: interaction.selected = entries.last(where: \.enabled)?.id
        default: return false
        }
        return true
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
        if dismissOnTrigger {
            // Hide before running an action: a native chooser may start a modal loop immediately.
            SqueakMenuWindows.hideAll()
            interaction?.dismiss()
        }
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
            .modifier(SqueakMenuPresentation(presented: $presented, point: point) { resize in
                SqueakMenuSurface(close: { presented = false }, perform: { presented = false }, resize: resize, content: items)
            })
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
                guard self.bounds.contains(location), self.visibleRect.contains(location) else { return event }
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


/// Floating quick-message and menu-bar panels treat these menu windows as part of their own UI.
@MainActor enum SqueakMenuWindows {
    private final class WindowReference {
        weak var value: NSWindow?
        init(_ value: NSWindow) { self.value = value }
    }
    private static var windows: [ObjectIdentifier: WindowReference] = [:]
    private static var order: [ObjectIdentifier] = []
    private static var handlers: [ObjectIdentifier: (NSEvent) -> Bool] = [:]
    private static var monitor: Any?
    static func contains(_ window: NSWindow) -> Bool { window.isVisible && handlers[ObjectIdentifier(window)] != nil }

    static func register(_ window: NSWindow, handleKey: @escaping (NSEvent) -> Bool) {
        let id = ObjectIdentifier(window)
        if handlers[id] == nil { order.append(id) }
        handlers[id] = handleKey
        windows[id] = WindowReference(window)
        // Install once SwiftUI finishes mounting the new menu, after any ancestor's handler.
        DispatchQueue.main.async { rearmKeyMonitor() }
    }

    private static func rearmKeyMonitor() {
        if let monitor { NSEvent.removeMonitor(monitor) }
        monitor = nil
        guard !order.isEmpty else { return }
        monitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { event in
                let handled = MainActor.assumeIsolated {
                    // The newest visible menu owns navigation keys, including nested menus.
                    guard let id = order.reversed().first(where: { windows[$0]?.value?.isVisible == true }) else { return false }
                    return handlers[id]?(event) == true
                }
                return handled ? nil : event
        }
    }

    static func hideAll() {
        let menus = order.compactMap { windows[$0]?.value }
        let source = menus.first?.parent
        for menu in menus.reversed() {
            menu.orderOut(nil)
            unregister(ObjectIdentifier(menu))
        }
        if NSApp.isActive, source?.isVisible == true { source?.makeKey() }
    }

    static func unregister(_ id: ObjectIdentifier) {
        handlers.removeValue(forKey: id)
        windows.removeValue(forKey: id)
        order.removeAll { $0 == id }
        if order.isEmpty, let monitor { NSEvent.removeMonitor(monitor); self.monitor = nil }
    }
}

private struct SqueakMenuWindowRegistration: NSViewRepresentable {
    var handleKey: (NSEvent) -> Bool
    func makeNSView(context: Context) -> Registration { let view = Registration(); view.handleKey = handleKey; return view }
    func updateNSView(_ nsView: Registration, context: Context) { nsView.handleKey = handleKey }
    static func dismantleNSView(_ nsView: Registration, coordinator: ()) { nsView.unregister() }
    final class Registration: NSView {
        var handleKey: ((NSEvent) -> Bool)?
        private var registered: ObjectIdentifier?
        override func hitTest(_ point: NSPoint) -> NSView? { nil }
        override func viewDidMoveToWindow() {
            super.viewDidMoveToWindow()
            unregister()
            if let window {
                registered = ObjectIdentifier(window)
                SqueakMenuWindows.register(window) { [weak self] in self?.handleKey?($0) ?? false }
            }
        }
        func unregister() {
            if let registered { SqueakMenuWindows.unregister(registered) }
            registered = nil
        }
    }
}


/// Borderless, anchored panels keep menu chrome and nested dismissal under Squeak's control.
/// SwiftUI's full environment is forwarded so bindings, theme and model-backed actions stay live.
private struct SqueakMenuPresentation<Items: View>: ViewModifier {
    @Binding var presented: Bool
    var submenu = false
    var point: UnitPoint? = nil
    var items: (@escaping (CGFloat) -> Void) -> Items
    func body(content: Content) -> some View {
        content.background(SqueakMenuPanelAnchor(presented: $presented, submenu: submenu, point: point, items: items))
    }
}

private struct SqueakMenuPanelAnchor<Items: View>: NSViewRepresentable {
    @Binding var presented: Bool
    let submenu: Bool
    let point: UnitPoint?
    let items: (@escaping (CGFloat) -> Void) -> Items

    func makeCoordinator() -> Coordinator { Coordinator() }
    func makeNSView(context: Context) -> NSView { AnchorView() }
    func updateNSView(_ nsView: NSView, context: Context) {
        let coordinator = context.coordinator
        coordinator.anchor = nsView
        coordinator.submenu = submenu
        coordinator.point = point
        coordinator.dismiss = { presented = false }
        guard presented else { coordinator.close(); return }
        let root = AnyView(items { [weak coordinator] height in coordinator?.resize(height) }
            .environment(\.self, context.environment))
        coordinator.show(root)
    }
    static func dismantleNSView(_ nsView: NSView, coordinator: Coordinator) { coordinator.close() }

    final class AnchorView: NSView {
        override func hitTest(_ point: NSPoint) -> NSView? { nil }
    }
    final class Panel: NSPanel {
        override var canBecomeKey: Bool { true }
        override var canBecomeMain: Bool { false }
    }
    @MainActor final class Coordinator {
        weak var anchor: NSView?
        var submenu = false
        var point: UnitPoint?
        var dismiss: () -> Void = {}
        private var panel: Panel?
        private var host: NSHostingView<AnyView>?
        private var height: CGFloat = 104
        private var local: Any?
        private var global: Any?
        private var observers: [NSObjectProtocol] = []

        func show(_ root: AnyView) {
            guard let source = anchor?.window else { return }
            if let host { host.rootView = root; position(); return }
            let panel = Panel(contentRect: NSRect(x: 0, y: 0, width: 284, height: height),
                styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
            panel.backgroundColor = .clear
            panel.isOpaque = false
            panel.hasShadow = true
            panel.level = .popUpMenu
            panel.animationBehavior = .none
            panel.hidesOnDeactivate = true
            panel.collectionBehavior = [.transient, .fullScreenAuxiliary]
            panel.appearance = source.effectiveAppearance
            let host = NSHostingView(rootView: root)
            self.panel = panel; self.host = host
            panel.contentView = host
            source.addChildWindow(panel, ordered: .above)
            position()
            panel.makeKeyAndOrderFront(nil)
            installMonitors(source)
        }

        func resize(_ height: CGFloat) {
            guard abs(self.height - height) > 0.5 else { return }
            self.height = height
            panel?.setContentSize(NSSize(width: 284, height: height))
            position()
        }

        private func position() {
            guard let anchor, let source = anchor.window, let panel else { return }
            let rect = source.convertToScreen(anchor.convert(anchor.bounds, to: nil))
            let screen = source.screen?.visibleFrame ?? rect.insetBy(dx: -400, dy: -400)
            var x = submenu ? rect.maxX + 5 : rect.minX
            var top = submenu ? rect.maxY : rect.minY - 5
            if let point { x = rect.minX + point.x * rect.width; top = rect.maxY - point.y * rect.height }
            if submenu && x + 284 > screen.maxX { x = rect.minX - 289 }
            x = max(screen.minX + 6, min(x, screen.maxX - 290))
            let y = max(screen.minY + 6, min(top - height, screen.maxY - height - 6))
            panel.setFrameOrigin(NSPoint(x: x, y: y))
        }

        private func installMonitors(_ source: NSWindow) {
            let clicks: NSEvent.EventTypeMask = [.leftMouseDown, .rightMouseDown, .otherMouseDown]
            local = NSEvent.addLocalMonitorForEvents(matching: clicks) { [weak self] event in
                guard let self else { return event }
                if let window = event.window {
                    var candidate: NSWindow? = window
                    while let current = candidate {
                        if current === self.panel { return event }
                        candidate = current.parent
                    }
                    if let anchor = self.anchor, window === anchor.window,
                       anchor.bounds.contains(anchor.convert(event.locationInWindow, from: nil)) { return event }
                }
                self.dismiss()
                self.close()
                return event
            }
            global = NSEvent.addGlobalMonitorForEvents(matching: clicks) { [weak self] _ in
                MainActor.assumeIsolated { self?.dismiss(); self?.close() }
            }
            let center = NotificationCenter.default
            observers = [
                center.addObserver(forName: NSApplication.didResignActiveNotification, object: nil, queue: .main) { [weak self] _ in
                    MainActor.assumeIsolated { self?.dismiss(); self?.close() }
                },
                center.addObserver(forName: NSWindow.willMoveNotification, object: source, queue: .main) { [weak self] _ in
                    MainActor.assumeIsolated { self?.dismiss(); self?.close() }
                },
            ]
        }

        func close() {
            if let local { NSEvent.removeMonitor(local) }
            if let global { NSEvent.removeMonitor(global) }
            observers.forEach(NotificationCenter.default.removeObserver)
            local = nil; global = nil; observers = []
            if let panel {
                SqueakMenuWindows.unregister(ObjectIdentifier(panel))
                let source = panel.parent
                let restoreKey = panel.isKeyWindow && NSApp.isActive
                source?.removeChildWindow(panel)
                panel.orderOut(nil)
                panel.contentView = nil
                if restoreKey, source?.isVisible == true { source?.makeKey() }
            }
            host = nil; panel = nil
        }
    }
}
