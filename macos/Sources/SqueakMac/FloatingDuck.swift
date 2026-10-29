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
    private var moveObserver: NSObjectProtocol?
    private weak var model: AppModel?

    private let enabledKey = "floatingDuckEnabled"
    private let positionKey = "floatingDuckPosition"
    private(set) var isEnabled = UserDefaults.standard.object(forKey: "floatingDuckEnabled") as? Bool ?? false

    func start(model: AppModel) {
        guard !model.demoMode, !model.captureMode else { return }
        self.model = model
        HotKeyCenter.shared.onDuckFire = { [weak self] in self?.toggleFromShortcut() }
        HotKeyCenter.shared.registerDuckShortcut()
        track(model)
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

    func dragOrigin() -> NSPoint? { panel?.frame.origin }

    func move(from origin: NSPoint, by translation: CGSize) {
        panel?.setFrameOrigin(NSPoint(x: origin.x + translation.width, y: origin.y - translation.height))
    }

    private func makePanel(model: AppModel) -> NSPanel {
        let p = NSPanel(contentRect: NSRect(x: 0, y: 0, width: 104, height: 104),
                        styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        p.isOpaque = false
        p.backgroundColor = .clear
        p.hasShadow = false
        p.level = .floating
        p.hidesOnDeactivate = false
        p.isReleasedWhenClosed = false
        p.isMovableByWindowBackground = true
        p.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary]
        p.setAccessibilityLabel("Squeak floating duck")
        p.contentView = NSHostingView(rootView: FloatingDuckView(controller: self).environment(model))
        moveObserver = NotificationCenter.default.addObserver(forName: NSWindow.didMoveNotification, object: p, queue: .main) { [weak self, weak p] _ in
            guard let p else { return }
            MainActor.assumeIsolated { self?.savePosition(p.frame.origin) }
        }
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

    private func track(_ model: AppModel) {
        withObservationTracking {
            _ = model.attentionCount
            _ = model.count(.working)
            _ = model.isConnected
        } onChange: { [weak self, weak model] in
            Task { @MainActor in
                guard let self, let model else { return }
                self.panel?.contentView = NSHostingView(rootView: FloatingDuckView(controller: self).environment(model))
                self.track(model)
            }
        }
    }
}

private struct FloatingDuckView: View {
    @Environment(AppModel.self) private var model
    let controller: FloatingDuckController
    @State private var dragStart: NSPoint?

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
        .simultaneousGesture(DragGesture(minimumDistance: 4)
            .onChanged { value in
                if dragStart == nil { dragStart = controller.dragOrigin() }
                if let dragStart { controller.move(from: dragStart, by: value.translation) }
            }
            .onEnded { _ in dragStart = nil })
        .help("Open Squeak's session menu")
        .accessibilityLabel(accessibilityLabel)
        .contextMenu {
            Button(controller.isEnabled ? "Hide Floating Duck" : "Show Floating Duck") { controller.toggle() }
            Divider()
            Button("Open Squeak") { model.openConversationWindow?() }
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
