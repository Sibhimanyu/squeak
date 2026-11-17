import AppKit
import SqueakIcons
import SqueakMacCore
import SwiftUI

// The pond's navigation flow on screen (logic: SqueakMacCore `PondFlow.swift`): the Dashboard and the Room side by side with
// a slide, the two-finger swipe between them, opening a tab from either, and the way back when that tab is closed.

/// Where tabs opened from a pond came from.
@MainActor
final class PondOrigin {
    static let shared = PondOrigin()
    private var stack = PondOriginStack()

    func opened(tab: String, pond: String, page: PondPage) { stack.opened(tab: tab, pond: pond, page: page) }
    /// Consumes the tab; non-nil when it was the last one opened from the pond.
    func closed(tab: String) -> PondOriginStack.Origin? { stack.closed(tab: tab) }
    func clear() { stack.clear() }
    func pondOpened(_ key: String) { stack.pondOpened(key) }

    static func ducklingTab(_ ref: DucklingRef) -> String { "duckling:\(ref.session.stringValue):\(ref.taskId)" }

    /// Back to the page of the pond a tab was opened from.
    func goBack(to origin: PondOriginStack.Origin) {
        RoomViewPref.shared.set(origin.page, for: origin.pond)
        returning = true
        PondsModel.shared.route = .home(project: origin.pond)
        returning = false
    }
    /// True while `goBack` sets the route.
    private(set) var returning = false
}

extension AppModel {
    /// Opens a thread as a tab, remembering the pond page it was opened from so closing it comes back.
    func openFromPond(_ key: SessionKey, pond: String?, page: PondPage) {
        if let pond { PondOrigin.shared.opened(tab: key.stringValue, pond: pond, page: page) }
        openInStream(key)
    }

    /// What a click in the room opens: a duck's tab, or a duck's tab with its ducklings' tabs. An off-duty duck is the
    /// caller's to put back on duty.
    func openFromPond(_ target: PondOpenTarget, pond: String?, page: PondPage) {
        guard let s = allSessions.first(where: { $0.key.hostSessionId == target.duck && $0.source == .squeak }) else { return }
        openFromPond(s.key, pond: pond, page: page)
        guard case .ducklings(_, let labels) = target, let items = ducklings(for: s)?.items else { return }
        let wanted = labels.isEmpty ? items : items.filter { d in
            labels.contains { l in d.title.localizedCaseInsensitiveContains(l) || l.localizedCaseInsensitiveContains(d.title) }
        }
        for d in wanted {
            let ref = DucklingRef(session: s.key, taskId: d.id)
            if let pond { PondOrigin.shared.opened(tab: PondOrigin.ducklingTab(ref), pond: pond, page: page) }
            DockStore.shared.openDuckling(ref)
        }
    }
}

// MARK: Two pages

/// The pond's Dashboard and Room, side by side: the Dashboard on the left, the Room on the right. Both stay alive so each
/// keeps its scroll position and the room keeps following its stream; the switch, or a two-finger swipe, slides one out and
/// the other in with a cross-fade. Under Reduce Motion the swap is instant.
struct PondSpace<Dashboard: View>: View {
    let key: String
    let projectId: String
    var leadingInset: CGFloat = 0
    @ViewBuilder let dashboard: () -> Dashboard
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    /// How far the current page has followed the fingers; 0 at rest.
    @State private var drag = 0.0
    @State private var nudge = 0.0
    @State private var swipes = UserDefaults.standard.integer(forKey: PondHintStore.swipesKey)

    var body: some View {
        let page = RoomViewPref.shared.mode(for: key)
        GeometryReader { geo in
            let w = geo.size.width
            let d = PondDrag.layout(of: .dashboard, current: page, offset: drag, width: w)
            let r = PondDrag.layout(of: .room, current: page, offset: drag, width: w)
            ZStack {
                dashboard()
                    .frame(width: w, height: geo.size.height)
                    .offset(x: d.x).opacity(d.opacity)
                    .allowsHitTesting(page == .dashboard).accessibilityHidden(page != .dashboard)
                PondRoomView(projectId: projectId, key: key, leadingInset: leadingInset).id(key).screen("Pond room")
                    .frame(width: w, height: geo.size.height)
                    .offset(x: r.x).opacity(r.opacity)
                    .allowsHitTesting(page == .room).accessibilityHidden(page != .room)
            }
            .frame(width: w, height: geo.size.height)
            .animation(reduceMotion ? nil : Motion.emphasis, value: page)
            .overlay(alignment: page == .dashboard ? .trailing : .leading) {
                PondSwipeHintView(
                    page: page, showsWord: PondSwipeHint(swipes: swipes).showsWord, nudge: nudge,
                    progress: PondDrag.progress(offset: drag, width: w, page: page)
                ) { switchTo(page == .dashboard ? .room : .dashboard) }
            }
        }
        .clipped()
        .background(PondSwipeMonitor(
            current: { RoomViewPref.shared.mode(for: key) }, trackingEnabled: !reduceMotion, update: { update($0) }))
        .task { await runHint() }
    }

    private func switchTo(_ page: PondPage) {
        withAnimation(reduceMotion ? nil : Motion.emphasis) { RoomViewPref.shared.set(page, for: key) }
    }

    private func update(_ u: PondDrag.Update) {
        switch u {
        case .track(let o):
            guard !reduceMotion else { return }
            var t = Transaction(); t.disablesAnimations = true
            withTransaction(t) { drag = o }
        case .settle:
            withAnimation(reduceMotion ? nil : Motion.standard) { drag = 0 }
        case .commit(let page):
            swipes += 1
            UserDefaults.standard.set(swipes, forKey: PondHintStore.swipesKey)
            // From where the fingers left it: the page changes and the offset returns to rest in one animated step.
            withAnimation(reduceMotion ? nil : Motion.emphasis) {
                RoomViewPref.shared.set(page, for: key)
                drag = 0
            }
        }
    }

    /// Counts this visit and, on the first few, nudges the chevron twice after a moment.
    private func runHint() async {
        let defaults = UserDefaults.standard
        let visits = defaults.integer(forKey: PondHintStore.visitsKey) + 1
        defaults.set(visits, forKey: PondHintStore.visitsKey)
        guard PondSwipeHint(visits: visits).nudges(reduceMotion: reduceMotion) else { return }
        try? await Task.sleep(for: .seconds(PondSwipeHint.nudgeDelay))
        for _ in 0..<PondSwipeHint.nudgeRepeats {
            if Task.isCancelled { return }
            withAnimation(Motion.standard) { nudge = PondSwipeHint.nudgeDistance }
            try? await Task.sleep(for: .milliseconds(200))
            withAnimation(Motion.standard) { nudge = 0 }
            try? await Task.sleep(for: .milliseconds(200))
        }
    }
}

enum PondHintStore {
    static let visitsKey = "pondSwipeHintVisits"
    static let swipesKey = "pondSwipeHintSwipes"
}

/// The quiet edge affordance: a chevron and the other page's name on a faint pill, at the right edge of the Dashboard and the
/// left edge of the Room. Neutral colours only (§3), 40% until hovered, and it stretches toward a swipe in progress.
struct PondSwipeHintView: View {
    let page: PondPage
    let showsWord: Bool
    let nudge: Double
    let progress: Double
    let action: () -> Void
    @State private var hover = false

    var body: some View {
        let toRoom = page == .dashboard
        Button(action: action) {
            HStack(spacing: 2) {
                if !toRoom { Lucide(.chevronLeft, size: 12, color: Theme.muted) }
                if showsWord { Text(toRoom ? "Room" : "Dashboard").font(Typo.meta).foregroundStyle(Theme.muted) }
                if toRoom { Lucide(.chevronRight, size: 12, color: Theme.muted) }
            }
            .padding(.horizontal, 8).padding(.vertical, 6)
            .background(Capsule().fill(Theme.surfaceRaised.opacity(0.6)))
            .scaleEffect(x: PondSwipeHint.stretch(progress: progress), y: 1, anchor: toRoom ? .trailing : .leading)
            .offset(x: toRoom ? nudge : -nudge)
            .padding(.horizontal, 6)
            .opacity(hover || progress > 0 ? 1 : 0.4)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { hover = $0 }
        .animation(Motion.quick, value: hover)
        .help(toRoom ? "Show the Room" : "Show the Dashboard")
        .accessibilityLabel(toRoom ? "Show the Room" : "Show the Dashboard")
        .id(page)
        .transition(.opacity)
    }
}

// MARK: Swipe

/// Watches two-finger horizontal scrolls over the view it sits behind and reports a switch (`PondSwipe` decides). The
/// event always carries on, so vertical scrolling is untouched; a horizontally scrollable view under the cursor keeps its
/// own scrolling.
struct PondSwipeMonitor: NSViewRepresentable {
    let current: () -> PondPage
    let trackingEnabled: Bool
    let update: (PondDrag.Update) -> Void

    func makeNSView(context: Context) -> Watcher { Watcher() }
    func updateNSView(_ view: Watcher, context: Context) {
        view.current = current; view.update = update; view.trackingEnabled = trackingEnabled
    }
    static func dismantleNSView(_ view: Watcher, coordinator: ()) { view.stop() }

    final class Watcher: NSView {
        var current: () -> PondPage = { .dashboard }
        var update: (PondDrag.Update) -> Void = { _ in }
        var trackingEnabled = true
        private var swipe = PondDrag()
        private var monitor: Any?

        override func viewDidMoveToWindow() {
            super.viewDidMoveToWindow()
            window == nil ? stop() : start()
        }

        private func start() {
            guard monitor == nil else { return }
            monitor = NSEvent.addLocalMonitorForEvents(matching: .scrollWheel) { [weak self] event in
                self?.handle(event)
                return event
            }
        }

        func stop() {
            if let monitor { NSEvent.removeMonitor(monitor) }
            monitor = nil
            swipe.reset()
        }

        private func handle(_ event: NSEvent) {
            guard let window, event.window === window, event.hasPreciseScrollingDeltas else { return }
            let inside = bounds.contains(convert(event.locationInWindow, from: nil))
            let phase = Self.phase(event)
            // The end of a gesture is always fed, so one that finished off the view does not leave the next half-counted.
            guard inside || phase == .ended || phase == .cancelled else { return }
            if inside, scrollsSideways(under: event) { swipe.reset(); return }
            let sign: Double = event.isDirectionInvertedFromDevice ? 1 : -1
            let result = swipe.feed(
                dx: Double(event.scrollingDeltaX) * sign, dy: Double(event.scrollingDeltaY) * sign, phase: phase,
                momentum: !event.momentumPhase.isEmpty, current: current(), width: Double(bounds.width))
            guard let result else { return }
            // Reduce Motion: no tracking, the swap alone.
            if case .track = result, !trackingEnabled { return }
            if case .settle = result, !trackingEnabled { return }
            update(result)
        }

        private static func phase(_ event: NSEvent) -> PondSwipe.Phase {
            if event.phase.contains(.began) { return .began }
            if event.phase.contains(.changed) { return .changed }
            if event.phase.contains(.ended) { return .ended }
            if event.phase.contains(.cancelled) { return .cancelled }
            return .none
        }

        /// A scroll view under the cursor that scrolls sideways (a wide code block, a table) keeps the gesture.
        private func scrollsSideways(under event: NSEvent) -> Bool {
            guard let content = window?.contentView, let host = content.superview else { return false }
            var view = content.hitTest(host.convert(event.locationInWindow, from: nil))
            while let v = view {
                if let scroll = v as? NSScrollView, scroll.hasHorizontalScroller || (scroll.documentView?.frame.width ?? 0) > scroll.contentSize.width + 1 { return true }
                view = v.superview
            }
            return false
        }
    }
}

// MARK: Scroll memory

/// Remembers a scroll view's position by id, so a page that was left (a tab opened over it) comes back where it was. Put it
/// as a background inside the scrolled content. `fromBottom` keeps the distance from the bottom (the room follows its end).
@MainActor
enum PondScrollMemory {
    private static var saved: [String: CGFloat] = [:]
    static func offset(_ id: String) -> CGFloat? { saved[id] }
    static func save(_ id: String, _ value: CGFloat) { saved[id] = value }
}

struct ScrollMemory: NSViewRepresentable {
    let id: String
    var fromBottom = false

    func makeNSView(context: Context) -> Anchor { Anchor() }
    func updateNSView(_ view: Anchor, context: Context) { view.id = id; view.fromBottom = fromBottom }
    static func dismantleNSView(_ view: Anchor, coordinator: ()) { view.detach() }

    final class Anchor: NSView {
        var id = ""
        var fromBottom = false
        private weak var scroll: NSScrollView?
        private var observer: NSObjectProtocol?
        private var recording = false

        override func viewWillMove(toWindow newWindow: NSWindow?) {
            if newWindow == nil { detach() }
            super.viewWillMove(toWindow: newWindow)
        }

        override func viewDidMoveToWindow() {
            super.viewDidMoveToWindow()
            guard window != nil else { return }
            DispatchQueue.main.async { [weak self] in self?.attach() }
        }

        func detach() {
            if let observer { NotificationCenter.default.removeObserver(observer) }
            observer = nil; recording = false
        }

        private func attach() {
            guard observer == nil, window != nil else { return }
            var v: NSView? = self
            while let x = v, !(x is NSScrollView) { v = x.superview }
            guard let scroll = v as? NSScrollView else { return }
            self.scroll = scroll
            scroll.contentView.postsBoundsChangedNotifications = true
            // Nothing is recorded until the saved position has been put back (the layout settles over a few passes).
            let target = PondScrollMemory.offset(id)
            observer = NotificationCenter.default.addObserver(forName: NSView.boundsDidChangeNotification, object: scroll.contentView, queue: .main) { [weak self] _ in
                MainActor.assumeIsolated { self?.record() }
            }
            guard let target else { recording = true; return }
            for delay in [0.0, 0.05, 0.15] { DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in self?.restore(target) } }
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) { [weak self] in self?.recording = true }
        }

        private func metrics() -> (y: CGFloat, doc: CGFloat, visible: CGFloat)? {
            guard let scroll, let doc = scroll.documentView else { return nil }
            return (scroll.contentView.bounds.origin.y, doc.frame.height, scroll.contentView.bounds.height)
        }

        private func record() {
            guard recording, let m = metrics() else { return }
            let value = fromBottom ? max(0, m.doc - m.visible - m.y) : m.y
            PondScrollMemory.save(id, value)
        }

        private func restore(_ target: CGFloat) {
            guard let scroll, let m = metrics() else { return }
            let y = fromBottom ? m.doc - m.visible - target : target
            let clamped = min(max(0, y), max(0, m.doc - m.visible))
            scroll.contentView.scroll(to: NSPoint(x: scroll.contentView.bounds.origin.x, y: clamped))
            scroll.reflectScrolledClipView(scroll.contentView)
        }
    }
}
