import AppKit

/// Puts `TranscriptFollow` on the NSScrollView under a SwiftUI `ScrollView`. It is an invisible view placed inside the
/// scroll content (a `.background`): it finds its `enclosingScrollView`, watches the document view's frame (content
/// growth) and the clip view's bounds (scrolling), and moves the clip view's origin directly, never with an animation and
/// never through `ScrollViewProxy.scrollTo` (whose animations stack up behind streamed text). The same code serves
/// macOS 14 and later: SwiftUI's ScrollView is an NSScrollView on every one of them.
///
/// What moves the reader is decided only here: the reader's own scrolls (live scroll, scroll wheel, scrollbar drag, keys)
/// are the only thing that can detach; growth never does.
@MainActor
public final class TranscriptScrollFollower: NSView {
    public private(set) var model = TranscriptFollow()
    /// Told (async, never during a SwiftUI update) whenever following flips, and once after attaching.
    public var onFollowChange: (Bool) -> Void = { _ in }

    private weak var scrollView: NSScrollView?
    private var applying = false
    private var recheckScheduled = false
    private var attachTries = 0
    private var lastReported: Bool?
    private var lastJumpToken: Int?
    private var holding = false
    private var simulatingUser = false
    /// Between willStartLiveScroll and didEndLiveScroll: the reader's gesture (momentum included) is in flight.
    private var liveScrolling = false

    public override func hitTest(_ point: NSPoint) -> NSView? { nil }
    public override var isFlipped: Bool { true }

    public var isAttached: Bool { scrollView != nil }

    // MARK: Attaching

    public override func viewDidMoveToSuperview() { super.viewDidMoveToSuperview(); attach() }
    public override func viewDidMoveToWindow() { super.viewDidMoveToWindow(); attach() }

    /// SwiftUI may add this view before its own hosting view sits inside the scroll view: try again a few times.
    public func attach() {
        guard scrollView == nil else { return }
        guard let sv = enclosingScrollView, let doc = sv.documentView else {
            if attachTries < 40 {
                attachTries += 1
                DispatchQueue.main.async { [weak self] in MainActor.assumeIsolated { self?.attach() } }
            }
            return
        }
        scrollView = sv
        doc.postsFrameChangedNotifications = true
        sv.contentView.postsFrameChangedNotifications = true
        sv.contentView.postsBoundsChangedNotifications = true
        let nc = NotificationCenter.default
        nc.addObserver(self, selector: #selector(contentFrameChanged), name: NSView.frameDidChangeNotification, object: doc)
        nc.addObserver(self, selector: #selector(contentFrameChanged), name: NSView.frameDidChangeNotification, object: sv.contentView)
        nc.addObserver(self, selector: #selector(clipBoundsChanged), name: NSView.boundsDidChangeNotification, object: sv.contentView)
        nc.addObserver(self, selector: #selector(liveScrollStarted), name: NSScrollView.willStartLiveScrollNotification, object: sv)
        nc.addObserver(self, selector: #selector(liveScrollEnded), name: NSScrollView.didEndLiveScrollNotification, object: sv)
        apply(model.handle(.opened))
        report(force: true)
    }

    // MARK: From SwiftUI

    /// The jump button / a message just sent: bumping the token re-attaches. A first sighting of the token is not a jump.
    public func update(jumpToken: Int, holdPlace: Bool) {
        if let last = lastJumpToken, last != jumpToken {
            apply(model.handle(.jumpTapped))
            report()
        }
        lastJumpToken = jumpToken
        if holdPlace != holding {
            holding = holdPlace
            if holdPlace, let sv = scrollView {
                model.handle(.holdPlace(distanceFromBottom: distanceFromBottom(sv)))
            } else {
                model.handle(.releasePlace)
            }
        }
    }

    // MARK: Events

    @objc private func contentFrameChanged(_ note: Notification) { contentChanged() }

    @objc private func clipBoundsChanged(_ note: Notification) {
        guard !applying, let sv = scrollView else { return }
        if userInitiated(sv) {
            noteUserScroll()
        } else {
            // Not the reader: an inset or viewport change, or the clip view clamping after the content shrank.
            contentChanged()
        }
    }

    /// Tests: scroll as the reader's wheel would (the clip view's bounds change reaches the model as a user scroll).
    func scrollAsReader(to y: CGFloat) {
        guard let sv = scrollView else { return }
        simulatingUser = true
        sv.contentView.scroll(to: NSPoint(x: sv.contentView.bounds.origin.x, y: y))
        sv.reflectScrolledClipView(sv.contentView)
        simulatingUser = false
    }

    /// The reader moved the view: where they are now decides whether the end is followed.
    func noteUserScroll() {
        guard let sv = scrollView else { return }
        model.handle(.userScrolled(distanceFromBottom: distanceFromBottom(sv)))
        report()
    }

    @objc private func liveScrollStarted(_ note: Notification) { liveScrolling = true }

    @objc private func liveScrollEnded(_ note: Notification) {
        liveScrolling = false
        guard let sv = scrollView else { return }
        apply(model.handle(.userScrollEnded(distanceFromBottom: distanceFromBottom(sv))))
        report()
    }

    /// Content grew, shrank or moved. While the reader's own scroll is in flight nothing is moved under them.
    public func contentChanged() {
        guard let sv = scrollView, !applying, !liveScrolling else { return }
        apply(model.handle(.contentChanged))
        // Layout can land a moment after the frame notification: look once more next turn (idempotent, one per frame).
        guard !recheckScheduled, model.following || model.held != nil else { return }
        recheckScheduled = true
        DispatchQueue.main.async { [weak self] in
            MainActor.assumeIsolated {
                guard let self else { return }
                self.recheckScheduled = false
                guard self.scrollView != nil, !self.liveScrolling else { return }
                self.apply(self.model.handle(.contentChanged))
            }
        }
    }

    /// A scroll the reader made: a live scroll (trackpad, wheel, momentum) or a scrollbar drag. Not a click or a key: typing
    /// in the composer resizes the dock, which moves the clip view's bounds and must never read as scrolling up.
    private func userInitiated(_ sv: NSScrollView) -> Bool {
        if liveScrolling || simulatingUser { return true }
        switch NSApp?.currentEvent?.type {
        case .scrollWheel, .leftMouseDragged: return true
        default: return false
        }
    }

    // MARK: Geometry

    /// Points between the viewport's bottom edge and the content's end (0 = at the end; negative while rubber-banding).
    public func distanceFromBottom(_ sv: NSScrollView) -> Double {
        let clip = sv.contentView
        let inset = sv.contentInsets
        let doc = clip.documentRect
        if clip.isFlipped { return Double(doc.maxY + inset.bottom - clip.bounds.maxY) }
        return Double(clip.bounds.minY - (doc.minY - inset.bottom))
    }

    private func apply(_ action: TranscriptFollow.Action) {
        guard let sv = scrollView else { return }
        switch action {
        case .none: break
        case .scrollToBottom: scroll(sv, toDistanceFromBottom: 0)
        case .restore(let d): scroll(sv, toDistanceFromBottom: d)
        }
    }

    private func scroll(_ sv: NSScrollView, toDistanceFromBottom want: Double) {
        guard abs(distanceFromBottom(sv) - want) > 0.5 else { return }
        let clip = sv.contentView
        let inset = sv.contentInsets
        let doc = clip.documentRect
        var origin = clip.bounds.origin
        if clip.isFlipped {
            origin.y = doc.maxY + inset.bottom - clip.bounds.height - CGFloat(want)
        } else {
            origin.y = doc.minY - inset.bottom + CGFloat(want)
        }
        origin = clip.constrainBoundsRect(NSRect(origin: origin, size: clip.bounds.size)).origin
        applying = true
        clip.scroll(to: origin)
        sv.reflectScrolledClipView(clip)
        applying = false
    }

    private func report(force: Bool = false) {
        let now = model.following
        guard force || now != lastReported else { return }
        lastReported = now
        DispatchQueue.main.async { [weak self] in MainActor.assumeIsolated { self?.onFollowChange(now) } }
    }
}
