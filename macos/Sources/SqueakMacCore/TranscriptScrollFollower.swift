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

    /// Where chats were left (`ChatScrollMemory`), by chat.
    public static var scrollMemory = ChatScrollMemory()
    /// Set before the view attaches: the chat's key and its first and last row ids (kept current while it is open).
    public var memoryKey: String?
    public var firstRow: String?
    public var lastRow: String?
    /// Told once after attaching when the chat was put back mid-scroll; `true` when rows arrived while it was away.
    public var onPlaced: (Bool) -> Void = { _ in }
    /// The saved distance from the top still being put back while the layout settles.
    private var pendingTop: Double?

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
        let resolution = memoryKey.map { ChatScrollMemory.resolve(Self.scrollMemory.snapshot(for: $0), firstRow: firstRow, lastRow: lastRow) } ?? .follow
        switch resolution {
        case .follow:
            apply(model.handle(.opened))
            report(force: true)
        case .place(let top, let newBelow):
            // Reopened where the reader was: not following, and the layout lands over a few passes, so it is put back on each.
            model.handle(.userScrolled(distanceFromBottom: .greatestFiniteMagnitude))
            pendingTop = top
            placePending()
            report(force: true)
            DispatchQueue.main.async { [weak self] in MainActor.assumeIsolated { self?.onPlaced(newBelow) } }
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { [weak self] in MainActor.assumeIsolated { self?.finishPlacing() } }
        }
    }

    public override func viewWillMove(toSuperview newSuperview: NSView?) {
        if newSuperview == nil { saveMemory() }
        super.viewWillMove(toSuperview: newSuperview)
    }

    /// Writes where the reader is into `scrollMemory`. While a saved place is still being put back, that place stays.
    public func saveMemory() {
        guard let key = memoryKey, let sv = scrollView, pendingTop == nil else { return }
        let clip = sv.contentView
        let top = Double(clip.bounds.origin.y - clip.documentRect.minY)
        Self.scrollMemory.save(
            .init(following: model.following, fromTop: max(0, top), firstRow: firstRow, lastRow: lastRow), for: key)
    }

    /// Puts the viewport the saved distance from the top; done once the content is tall enough to hold it.
    private func placePending() {
        guard let want = pendingTop, let sv = scrollView else { return }
        let clip = sv.contentView
        let doc = clip.documentRect
        var origin = clip.bounds.origin
        origin.y = doc.minY + CGFloat(want)
        origin = clip.constrainBoundsRect(NSRect(origin: origin, size: clip.bounds.size)).origin
        if abs(origin.y - clip.bounds.origin.y) > 0.5 {
            applying = true
            clip.scroll(to: origin)
            sv.reflectScrolledClipView(clip)
            applying = false
        }
        if Double(doc.height - clip.bounds.height) >= want - 0.5 { finishPlacing() }
    }

    private func finishPlacing() {
        guard pendingTop != nil, let sv = scrollView else { pendingTop = nil; return }
        pendingTop = nil
        // Back within reach of the end counts as being on it.
        model.handle(.userScrolled(distanceFromBottom: distanceFromBottom(sv)))
        report()
    }

    // MARK: From SwiftUI

    /// The jump button / a message just sent: bumping the token re-attaches. A first sighting of the token is not a jump.
    public func update(jumpToken: Int, holdPlace: Bool) {
        if let last = lastJumpToken, last != jumpToken {
            pendingTop = nil
            apply(model.handle(.jumpTapped))
            report()
            saveMemory()
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
        pendingTop = nil
        model.handle(.userScrolled(distanceFromBottom: distanceFromBottom(sv)))
        report()
        saveMemory()
    }

    @objc private func liveScrollStarted(_ note: Notification) { liveScrolling = true }

    @objc private func liveScrollEnded(_ note: Notification) {
        liveScrolling = false
        guard let sv = scrollView else { return }
        apply(model.handle(.userScrollEnded(distanceFromBottom: distanceFromBottom(sv))))
        report()
        saveMemory()
    }

    /// Content grew, shrank or moved. While the reader's own scroll is in flight nothing is moved under them.
    public func contentChanged() {
        guard let sv = scrollView, !applying, !liveScrolling else { return }
        placePending()
        apply(model.handle(.contentChanged))
        // Layout can land a moment after the frame notification: look once more next turn (idempotent, one per frame).
        guard !recheckScheduled, model.following || model.held != nil || pendingTop != nil else { return }
        recheckScheduled = true
        DispatchQueue.main.async { [weak self] in
            MainActor.assumeIsolated {
                guard let self else { return }
                self.recheckScheduled = false
                guard self.scrollView != nil, !self.liveScrolling else { return }
                self.placePending()
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
