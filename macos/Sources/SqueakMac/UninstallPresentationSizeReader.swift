import AppKit
import SwiftUI

/// Measure the presenting window before opening the sheet. A ScrollView alone has no
/// intrinsic height limit, and measuring the sheet itself would create a sizing loop.
struct UninstallPresentationSizeReader: NSViewRepresentable {
    let onChange: @MainActor (CGSize) -> Void

    func makeNSView(context: Context) -> Reader {
        let view = Reader()
        view.onChange = onChange
        return view
    }

    func updateNSView(_ view: Reader, context: Context) { view.onChange = onChange }

    static func dismantleNSView(_ view: Reader, coordinator: ()) { view.stopObserving() }

    final class Reader: NSView {
        var onChange: (@MainActor (CGSize) -> Void)?
        private nonisolated(unsafe) var tokens: [NSObjectProtocol] = []

        override func viewDidMoveToWindow() {
            super.viewDidMoveToWindow()
            stopObserving()
            guard let window else { return }
            let report: @Sendable (Notification) -> Void = { [weak self] _ in
                MainActor.assumeIsolated { self?.reportSize() }
            }
            for name in [NSWindow.didResizeNotification, NSWindow.didMoveNotification, NSWindow.didChangeScreenNotification] {
                tokens.append(NotificationCenter.default.addObserver(forName: name, object: window, queue: .main, using: report))
            }
            tokens.append(NotificationCenter.default.addObserver(
                forName: NSApplication.didChangeScreenParametersNotification, object: nil, queue: .main, using: report))
            reportSize()
        }

        private func reportSize() {
            guard let window, let screen = window.screen else { return }
            let visible = screen.visibleFrame
            // Leave room beneath the window's sheet attachment point, including when
            // the parent sits low on the display. Also fit within the parent content.
            let top = min(window.contentLayoutRect.maxY + window.frame.minY, visible.maxY)
            let size = CGSize(
                width: max(1, min(500, window.contentLayoutRect.width - 32, visible.width - 40)),
                height: max(1, min(640, window.contentLayoutRect.height - 32, top - visible.minY - 24)))
            Task { @MainActor [weak self] in self?.onChange?(size) }
        }

        func stopObserving() {
            for token in tokens { NotificationCenter.default.removeObserver(token) }
            tokens = []
        }

        deinit {
            for token in tokens { NotificationCenter.default.removeObserver(token) }
        }
    }
}
