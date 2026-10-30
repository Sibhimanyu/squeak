import AppKit
import Observation
import SwiftUI

/// A small, native AppKit panel that can follow the user between Spaces without taking focus.
@MainActor
@Observable
final class FloatingDuckController: NSObject {
    static let shared = FloatingDuckController()
    private let defaults = UserDefaults.standard
    private var panel: NSPanel?
    private weak var model: AppModel?

    private let enabledKey = "floatingDuckEnabled"
    private let positionKey = "floatingDuckPosition"
    private(set) var isEnabled = UserDefaults.standard.object(forKey: "floatingDuckEnabled") as? Bool ?? false

    func start(model: AppModel) {
        guard !model.demoMode, !model.captureMode else { return }
        self.model = model
        HotKeyCenter.shared.onDuckFire = { [weak self] in self?.toggleFromShortcut() }
        HotKeyCenter.shared.registerDuckShortcut()
        if isEnabled { show() }
    }

    func setEnabled(_ enabled: Bool) {
        defaults.set(enabled, forKey: enabledKey)
        isEnabled = enabled
        if enabled { show() } else { hide() }
    }

    func toggle() { setEnabled(!isEnabled) }
    func toggleFromShortcut() { setEnabled(panel?.isVisible != true) }

    func show() {
        guard let model, !model.demoMode, !model.captureMode else { return }
        let panel = self.panel ?? makePanel(model: model)
        self.panel = panel
        if !panel.isVisible { panel.setFrame(initialFrame(for: panel), display: false) }
        panel.orderFrontRegardless()
    }

    func hide() { panel?.orderOut(nil) }

    private func makePanel(model: AppModel) -> NSPanel {
        let p = NSPanel(contentRect: NSRect(x: 0, y: 0, width: 104, height: 104),
                        styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        p.isOpaque = false
        p.backgroundColor = .clear
        p.hasShadow = false
        p.level = .floating
        p.hidesOnDeactivate = false
        p.isReleasedWhenClosed = false
        p.isMovableByWindowBackground = false
        p.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary]
        p.setAccessibilityLabel("Squeak floating duck")
        let content = FloatingDuckHostingView(rootView: FloatingDuckView(controller: self).environment(model))
        content.onClick = { MenuBarController.shared.toggle() }
        content.onDragEnded = { [weak self, weak p] in
            if let p { self?.savePosition(p.frame.origin) }
        }
        p.contentView = content
        return p
    }

    private func initialFrame(for panel: NSPanel) -> NSRect {
        let size = panel.frame.size
        if let saved = defaults.array(forKey: positionKey) as? [Double], saved.count == 2 {
            let point = NSPoint(x: saved[0], y: saved[1])
            if NSScreen.screens.contains(where: { $0.frame.intersects(NSRect(origin: point, size: size)) }) {
                return NSRect(origin: point, size: size)
            }
        }
        let visible = (NSScreen.main?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1440, height: 900))
        return NSRect(x: visible.maxX - size.width - 24, y: visible.minY + 32, width: size.width, height: size.height)
    }

    private func savePosition(_ point: NSPoint) {
        defaults.set([Double(point.x), Double(point.y)], forKey: positionKey)
    }
}

/// Window movement must use screen coordinates: a gesture in this view's moving
/// local coordinate space feeds the window movement back into its own translation.
/// Keep this host alive as the observed model changes, including during a drag.
@MainActor
private final class FloatingDuckHostingView<Content: View>: NSHostingView<Content> {
    var onClick: (() -> Void)?
    var onDragEnded: (() -> Void)?
    private var mouseDownPoint: NSPoint?
    private var windowOrigin: NSPoint?
    private var isDragging = false

    override var mouseDownCanMoveWindow: Bool { false }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    override func hitTest(_ point: NSPoint) -> NSView? {
        // Keep SwiftUI's context menu and accessibility button. Only the primary
        // mouse sequence belongs to the window drag handler.
        if let event = NSApp.currentEvent, event.type == .leftMouseDown,
           !event.modifierFlags.contains(.control), super.hitTest(point) != nil {
            return self
        }
        return super.hitTest(point)
    }

    override func mouseDown(with event: NSEvent) {
        if event.modifierFlags.contains(.control) {
            super.mouseDown(with: event)
            return
        }
        guard let window else { return }
        mouseDownPoint = window.convertPoint(toScreen: event.locationInWindow)
        windowOrigin = window.frame.origin
        isDragging = false
    }

    override func mouseDragged(with event: NSEvent) {
        guard let start = mouseDownPoint, let origin = windowOrigin else {
            super.mouseDragged(with: event)
            return
        }
        // Absolute AppKit screen points work across displays, including screens
        // to the left of or below the primary display, without scale conversion.
        let cursor = NSEvent.mouseLocation
        let delta = NSPoint(x: cursor.x - start.x, y: cursor.y - start.y)
        if !isDragging {
            guard hypot(delta.x, delta.y) >= 4 else { return }
            isDragging = true
        }
        window?.setFrameOrigin(NSPoint(x: origin.x + delta.x, y: origin.y + delta.y))
    }

    override func mouseUp(with event: NSEvent) {
        guard mouseDownPoint != nil else {
            super.mouseUp(with: event)
            return
        }
        let didDrag = isDragging
        mouseDownPoint = nil
        windowOrigin = nil
        isDragging = false
        if didDrag {
            onDragEnded?()
        } else if bounds.contains(convert(event.locationInWindow, from: nil)) {
            onClick?()
        }
    }
}

private struct FloatingDuckView: View {
    @Environment(AppModel.self) private var model
    let controller: FloatingDuckController

    private var mood: String {
        guard model.isConnected else { return "duck-offline.png" }
        if model.attentionCount > 0 { return "duck-needs_you.png" }
        if model.count(.working) > 0 || model.awake != nil { return "duck-working.png" }
        return "duck-asleep.png"
    }

    var body: some View {
        Button {
            MenuBarController.shared.toggle()
        } label: {
            Group {
                if let url = BrandAssets.moodURL(mood), let image = NSImage(contentsOf: url) {
                    Image(nsImage: image).resizable().interpolation(.high).scaledToFit()
                } else {
                    DuckMark(width: 80)
                }
            }
            .frame(width: 88, height: 88)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .help("Click to open Squeak’s session menu. Drag to move the duck.")
        .accessibilityLabel(accessibilityLabel)
        .contextMenu {
            Button(controller.isEnabled ? "Hide Floating Duck" : "Show Floating Duck") { controller.toggle() }
            Divider()
            Button("Open Squeak") { model.showConversationWindow() }
            Button("Settings…") { model.openSettings() }
        }
    }

    private var accessibilityLabel: String {
        let count = model.attentionCount
        if count > 0 { return "Squeak duck; \(count) sessions need you. Open the session menu." }
        return model.count(.working) > 0 ? "Squeak duck; sessions are working. Open the session menu." : "Squeak duck. Open the session menu."
    }
}

extension BrandAssets {
    static func moodURL(_ name: String) -> URL? {
        if let resource = Bundle.main.resourceURL?.appendingPathComponent("brand/mood-sprites/\(name)"),
           FileManager.default.fileExists(atPath: resource.path) { return resource }
        var dir = URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
        for _ in 0..<8 {
            let url = dir.appendingPathComponent("brand/mood-sprites/\(name)")
            if FileManager.default.fileExists(atPath: url.path) { return url }
            dir.deleteLastPathComponent()
        }
        return nil
    }
}
