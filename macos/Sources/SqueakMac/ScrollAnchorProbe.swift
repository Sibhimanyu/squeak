import AppKit
import SwiftUI

/// Reads and sets how far down the enclosing scroll view is, as the top edge's share of the document's height. It is a
/// zero-size background inside a SwiftUI `ScrollView`; the Markdown preview uses it to hand its place to the source
/// view and take one back (`MarkdownAnchor` turns the share into a source line).
struct ScrollAnchorProbe: NSViewRepresentable {
    /// Where to put the top edge once the content has its height, if anywhere.
    var restoreTo: Double?
    /// The top edge's share after the person scrolls (never while a restore is settling).
    var onScroll: (Double) -> Void

    func makeNSView(context: Context) -> ProbeView {
        let v = ProbeView()
        v.restoreTo = restoreTo
        v.onScroll = onScroll
        return v
    }

    func updateNSView(_ v: ProbeView, context: Context) { v.onScroll = onScroll }

    final class ProbeView: NSView {
        var restoreTo: Double?
        var onScroll: (Double) -> Void = { _ in }
        private var restoring = true
        nonisolated(unsafe) private var observer: NSObjectProtocol?

        override func viewDidMoveToWindow() {
            super.viewDidMoveToWindow()
            guard window != nil, observer == nil else { return }
            DispatchQueue.main.async { [weak self] in self?.attach() }
        }

        deinit { if let observer { NotificationCenter.default.removeObserver(observer) } }

        private func attach() {
            guard let scroll = enclosingScrollView else { return }
            let clip = scroll.contentView
            clip.postsBoundsChangedNotifications = true
            observer = NotificationCenter.default.addObserver(forName: NSView.boundsDidChangeNotification, object: clip, queue: .main) { [weak self] _ in
                MainActor.assumeIsolated { self?.report() }
            }
            settle(tries: 0)
        }

        /// The document's height arrives after the first layout: try a few times, then let the person's scrolling count.
        private func settle(tries: Int) {
            guard let scroll = enclosingScrollView, let doc = scroll.documentView else { restoring = false; return }
            guard let share = restoreTo, share > 0 else { restoring = false; return }
            let room = doc.frame.height - scroll.contentView.bounds.height
            if room > 1 || tries >= 12 {
                let y = min(max(0, share * doc.frame.height), max(0, room))
                scroll.contentView.scroll(to: NSPoint(x: 0, y: doc.isFlipped ? y : doc.frame.height - scroll.contentView.bounds.height - y))
                scroll.reflectScrolledClipView(scroll.contentView)
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) { [weak self] in self?.restoring = false }
            } else {
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) { [weak self] in self?.settle(tries: tries + 1) }
            }
        }

        private func report() {
            guard !restoring, let scroll = enclosingScrollView, let doc = scroll.documentView, doc.frame.height > 0 else { return }
            let top = scroll.contentView.bounds.origin.y
            let y = doc.isFlipped ? top : doc.frame.height - scroll.contentView.bounds.height - top
            onScroll(min(1, max(0, y / doc.frame.height)))
        }
    }
}
