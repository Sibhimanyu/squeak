import AppKit
import os
import QuartzCore
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
        AppModel.shared.openPondHome(origin.pond)
        returning = false
    }
    /// True while `goBack` sets the route.
    private(set) var returning = false
}

extension AppModel {
    /// What the pond's centre shows now, read from the live state (the page preference, the open Duck, the selected item tab).
    func liveCentre(pond: String) -> PondCentre {
        var duck: String?
        if let s = selectedSession, WorkPaneActions.isDuckView(s), PondsModel.shared.key(of: s) == pond {
            duck = PondCentre.liveDuck(selected: s.duckId ?? s.key.stringValue, location: baseLocation, selectedKey: s.key)
        }
        let item = PondWorkspace(pond: pond).flatMap { tabStore.currentPondItem($0.project.id) }
        // The New duck page is its own centre state: it is open when the creation page is, in the pond it was opened from.
        let composing = focus.composePage == .newThread && (location.pondKey ?? selectedSession.flatMap { PondsModel.shared.key(of: $0) }) == pond
        return PondCentre(page: RoomViewPref.shared.mode(for: pond), duck: duck, item: item, newDuck: composing)
    }

    /// The one way the pond's centre changes: the switch, the swipe, Esc and a deep link each hand in an event on
    /// `PondCentre`, and the difference is carried out here, never by writing the page preference from a view.
    func applyCentre(pond: String, openDuck: (String) -> Void = { _ in }, _ event: (inout PondCentre) -> Void) {
        let old = liveCentre(pond: pond)
        var next = old
        event(&next)
        let e = next.effects(from: old)
        if let page = e.page { RoomViewPref.shared.set(page, for: pond) }
        if e.deselectItem { leavePondItem(pond: pond) }
        if let duck = e.openDuck { openDuck(duck) }
        if e.leaveDuck || e.closeNewDuck { openPondHome(pond) }
    }

    /// Opens a thread as a tab, remembering the pond page it was opened from so closing it comes back.
    func openFromPond(_ key: SessionKey, pond: String?, page: PondPage) {
        if let pond { PondOrigin.shared.opened(tab: key.stringValue, pond: pond, page: page) }
        openInStream(key)
    }

    /// The chat a clicked duck id names (a turn id is read as its session), among the Squeak chats the host lists.
    func pondDuckSession(_ clicked: String) -> HostSession? {
        // The room and the ducks list speak the host's own chat id; the app keys a Squeak chat as `keyPrefix + id`.
        let ducks = allSessions.filter { $0.source == .squeak }
        let byId = Dictionary(ducks.map { (NativeAdapter.nativeId($0) ?? $0.key.hostSessionId, $0) }, uniquingKeysWith: { a, _ in a })
        guard let id = PondOpenResolver.sessionId(for: clicked, among: Set(byId.keys)) else { return nil }
        return byId[id]
    }

    /// What a click in the room opens: a duck's tab, or a duck's tab with its ducklings' tabs. False when no chat is known
    /// for the duck (nothing opened); a closed duck is the caller's to reopen.
    @discardableResult
    func openFromPond(_ target: PondOpenTarget, pond: String?, page: PondPage) -> Bool {
        guard let s = pondDuckSession(target.duck) else { return false }
        if let pond {
            // One source of truth: the deep link is an event on the pond's centre (PondCentre), which opens the Duck's chat.
            applyCentre(pond: pond, openDuck: { _ in openFromPond(s.key, pond: pond, page: page) }) { $0.deepLink(duck: s.duckId ?? s.key.stringValue) }
        } else {
            openFromPond(s.key, pond: pond, page: page)
        }
        if let request = ChatTurnJump.request(for: target, chat: s.key.stringValue, previous: turnJump) { turnJump = request }
        guard case .ducklings(_, let labels) = target, let items = ducklings(for: s)?.items else { return true }
        let wanted = labels.isEmpty ? items : items.filter { d in
            labels.contains { l in d.title.localizedCaseInsensitiveContains(l) || l.localizedCaseInsensitiveContains(d.title) }
        }
        for d in wanted {
            let ref = DucklingRef(session: s.key, taskId: d.id)
            if openDuckling(ref) { continue }
            if let pond { PondOrigin.shared.opened(tab: PondOrigin.ducklingTab(ref), pond: pond, page: page) }
            DockStore.shared.openDuckling(ref)
        }
        return true
    }
}

// MARK: Two pages

private let swipeSignposts = OSLog(subsystem: "app.squeak.mac", category: "PondSwipe")

/// Where the two-page strip is: 0 the Dashboard, 1 the Room. Only this changes while the fingers move or the spring settles,
/// and only the small views that read it (`PanPage`, the switch's pill, the hint) re-evaluate: the pages themselves are built
/// once by `PondSpace`, both stay mounted and laid out, and nothing here is published to `AppModel` per frame.
@MainActor @Observable
final class PondPanState {
    enum Mode { case rest, dragging, gliding }

    private(set) var mode = Mode.rest
    /// The strip's position while dragging or gliding.
    private(set) var position = 0.0
    /// The page the strip rests on while at rest (follows `RoomViewPref` through `reconcile`).
    private(set) var restPage = PondPage.dashboard
    /// The view whose display drives the spring (the swipe monitor sits in the window).
    @ObservationIgnored weak var host: NSView?
    @ObservationIgnored private var spring: SwipeSpring?
    @ObservationIgnored private var springStart: CFTimeInterval = 0
    @ObservationIgnored private var springPage: PondPage?
    @ObservationIgnored private var link: CADisplayLink?
    @ObservationIgnored private var finished: (() -> Void)?

    /// The strip's position now, for drawing.
    var drawn: Double { mode == .rest ? PondDrag.home(restPage) : position }
    /// The position the top bar's switch follows while the strip moves; nil at rest (it then follows `PondCentre`).
    var moving: Double? { mode == .rest ? nil : position }

    /// True between the pond page appearing and leaving; while false the state may be stale against the page preference.
    var isMounted = false

    func mount(page: PondPage) { stopSpring(); mode = .rest; restPage = page }

    /// The pond page left the screen (a pond page mounts only while shown, this state outlives it): whatever was in flight
    /// can never finish, so rest on `page`, or the next mount finds the Room slid off screen.
    func unmount(page: PondPage) { mount(page: page); isMounted = false }

    /// The fingers moved the strip to `p`: it follows at once, and a spring still in flight stops where it is.
    func track(_ p: Double) {
        if mode != .dragging { stopSpring(); mode = .dragging }
        position = p
    }

    /// Springs from where the strip is to `page`'s rest, at `towardPointsPerSecond` (the fingers' speed toward it).
    func release(to page: PondPage, from: Double? = nil, towardPointsPerSecond: Double = 0, width: Double) {
        let start = from ?? drawn
        let target = PondDrag.home(page)
        let v = SwipeSettle.velocity(pointsPerSecond: towardPointsPerSecond, width: width, from: start, to: target)
        run(SwipeSpring(from: start, target: target, velocity: v), page: page, done: nil)
    }

    private func run(_ s: SwipeSpring, page: PondPage?, done: (() -> Void)?) {
        stopSpring()
        guard !Motion.reduceMotion, let host, host.window != nil else {
            mode = .rest; if let page { restPage = page }; done?(); return
        }
        mode = .gliding; position = s.from
        spring = s; springPage = page; springStart = CACurrentMediaTime(); finished = done
        let l = host.displayLink(target: self, selector: #selector(frame(_:)))
        l.add(to: .main, forMode: .common)
        link = l
    }

    @objc private func frame(_ link: CADisplayLink) {
        guard let s = spring else { stopSpring(); return }
        let id = OSSignpostID(log: swipeSignposts)
        os_signpost(.begin, log: swipeSignposts, name: "frame", signpostID: id)
        defer { os_signpost(.end, log: swipeSignposts, name: "frame", signpostID: id) }
        let t = CACurrentMediaTime() - springStart
        if s.isSettled(at: t) || t > 1.5 {
            let page = springPage, done = finished
            stopSpring()
            position = s.target; mode = .rest
            if let page { restPage = page }
            done?()
        } else {
            position = s.position(at: t)
        }
    }

    private func stopSpring() {
        link?.invalidate(); link = nil
        spring = nil; springPage = nil; finished = nil
    }

    /// The strip's speed now in position units per second (a grab or a retarget continues it).
    private func currentSpeed() -> Double {
        guard mode == .gliding, let s = spring else { return 0 }
        return s.speed(at: CACurrentMediaTime() - springStart)
    }

    /// The page changed from outside the gesture (the switch, the header control, Esc, a deep link, the way back from a tab):
    /// the strip springs to it from where it is drawn, with the speed it already has.
    func reconcile(page: PondPage) {
        guard mode != .dragging else { return }
        if mode == .rest, restPage == page { return }
        if mode == .gliding, springPage == page { return }
        let start = drawn
        run(SwipeSpring(from: start, target: PondDrag.home(page), velocity: currentSpeed()), page: page, done: nil)
    }

    /// First visit: the page slides a little toward the other and eases back, showing the gesture. One critically damped
    /// spring that starts at rest on the page with a push toward the other: it peaks at the peek distance and comes home.
    func peek(page: PondPage, width: Double) async {
        guard mode == .rest, restPage == page else { return }
        let home = PondDrag.home(page), out = PondSwipeHint.peekPosition(page: page, width: width)
        let response = 0.34, omega = 2 * Double.pi / response
        run(SwipeSpring(from: home, target: home, velocity: (out - home) * omega * M_E, response: response), page: page, done: nil)
    }
}

/// One state per pond, so the inspector (another part of the window) can follow the same gesture.
@MainActor
final class PondPanStore {
    static let shared = PondPanStore()
    private var states: [String: PondPanState] = [:]
    func state(for key: String) -> PondPanState {
        // The page preference can change while the pond page is not on screen (the switch pressed inside a Duck, Esc, a way
        // back): a state that is not mounted always rests on the preference, never on where it was left (PondCentre.stripPage).
        if let s = states[key] { if !s.isMounted { s.mount(page: RoomViewPref.shared.mode(for: key)) }; return s }
        let s = PondPanState(); s.mount(page: RoomViewPref.shared.mode(for: key)); states[key] = s
        return s
    }
}

/// Places one page on the strip. It alone reads the position, so a scroll tick re-runs this small body and not the page.
/// A flat scrim, not the page's own opacity, gives the depth: the page that is leaving or arriving is a little dimmer.
private struct PanPage: ViewModifier {
    let state: PondPanState
    let page: PondPage
    let width: CGFloat

    func body(content: Content) -> some View {
        let x = PondDrag.x(of: page, position: state.drawn, width: Double(width))
        content
            .offset(x: x)
            .zIndex(PondStripPlan.zPosition(of: page, rest: state.restPage))
            // The page the strip shows takes the clicks; read here so only this small body follows the strip per frame.
            .allowsHitTesting(PondStripPlan.takesClicks(page: page, drawn: state.drawn))
            .overlay {
                // Nothing at all over a page at rest: the view exists only while the strip moves.
                let s = state.mode == .rest ? 0 : PondStripPlan.scrim(x: x, width: Double(width))
                if s > 0 { Theme.bg.opacity(s).allowsHitTesting(false) }
            }
    }
}

/// The pond's Dashboard and Room, side by side: the Dashboard on the left, the Room on the right. Both stay alive so each
/// keeps its scroll position and the room keeps following its stream; a two-finger swipe moves the strip one to one with
/// the fingers and finishes from where it is, at the fingers' speed. Under Reduce Motion the swap is instant.
struct PondSpace<Dashboard: View>: View {
    let key: String
    let projectId: String
    /// A Member's pond: the Room is the Owner's, read through the cloud (`projectId` is then the pond's id).
    var member = false
    var leadingInset: CGFloat = 0
    /// False when the pond's shared header is drawn above the strip: neither page carries one, so it never moves.
    var showsHeader = true
    @ViewBuilder let dashboard: () -> Dashboard
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.controlActiveState) private var activeState
    @Environment(\.workbenchVisible) private var visible
    @State private var pan: PondPanState
    @State private var swipes = UserDefaults.standard.integer(forKey: PondHintStore.swipesKey)
    @State private var visits = 0
    @State private var width = 0.0
    @State private var haptic = SwipeHapticLatch()

    init(key: String, projectId: String, member: Bool = false, leadingInset: CGFloat = 0, showsHeader: Bool = true, @ViewBuilder dashboard: @escaping () -> Dashboard) {
        self.key = key; self.projectId = projectId; self.member = member; self.leadingInset = leadingInset; self.showsHeader = showsHeader; self.dashboard = dashboard
        _pan = State(initialValue: PondPanStore.shared.state(for: key))
    }

    var body: some View {
        let page = RoomViewPref.shared.mode(for: key)
        GeometryReader { geo in
            let w = geo.size.width
            ZStack {
                dashboard()
                    .frame(width: w, height: geo.size.height)
                    .modifier(PanPage(state: pan, page: .dashboard, width: w))
                    .accessibilityHidden(page != .dashboard)
                PondRoomView(projectId: projectId, member: member, key: key, leadingInset: leadingInset, showsHeader: showsHeader).id(key).screen("Pond room")
                    .frame(width: w, height: geo.size.height)
                    .modifier(PanPage(state: pan, page: .room, width: w))
                    .accessibilityHidden(page != .room)
            }
            .frame(width: w, height: geo.size.height)
            .onAppear { width = Double(w) }
            .onChange(of: w) { _, new in width = Double(new) }
        }
        .clipped()
        .background(PondSwipeMonitor(
            current: { RoomViewPref.shared.mode(for: key) }, pan: pan,
            trackingEnabled: !reduceMotion, update: { if visible { update($0) } }))
        .onChange(of: page) { _, new in pan.reconcile(page: new) }
        // However a spring ends (settled, cancelled, interrupted), the strip at rest shows the page the centre holds.
        .onChange(of: pan.mode) { _, mode in
            let held = RoomViewPref.shared.mode(for: key)
            if mode == .rest, pan.restPage != held { pan.reconcile(page: held) }
        }
        .onDisappear { pan.unmount(page: RoomViewPref.shared.mode(for: key)) }
        .onAppear { pan.isMounted = true; pan.reconcile(page: RoomViewPref.shared.mode(for: key)) }
        .task { await runHint() }
    }

    private func switchTo(_ page: PondPage) { RoomViewPref.shared.set(page, for: key) }

    private func update(_ u: PondDrag.Update) {
        let page = RoomViewPref.shared.mode(for: key)
        switch u {
        case .track(let p):
            guard !reduceMotion else { return }
            pan.track(p)
            if haptic.crosses(progress: PondDrag.progress(position: p, page: page)) {
                NSHapticFeedbackManager.defaultPerformer.perform(.alignment, performanceTime: .now)
            }
        case .settle(let from, let v):
            haptic.reset()
            pan.release(to: page, from: from, towardPointsPerSecond: v, width: width)
        case .commit(let target, let from, let v):
            haptic.reset()
            swipes += 1
            UserDefaults.standard.set(swipes, forKey: PondHintStore.swipesKey)
            // PondCentre holds the new page first (the switch, Esc, a deep link and a reopen all read it); the strip then springs
            // on from where the fingers left it, at their speed, to the page the centre actually holds, never to a page it refused.
            AppModel.shared.applyCentre(pond: key) { $0.swipe(to: target) }
            pan.release(to: RoomViewPref.shared.mode(for: key), from: from, towardPointsPerSecond: v, width: width)
        }
    }

    /// Counts this visit and, on the first, peeks once after a moment.
    private func runHint() async {
        let defaults = UserDefaults.standard
        let n = defaults.integer(forKey: PondHintStore.visitsKey) + 1
        defaults.set(n, forKey: PondHintStore.visitsKey)
        visits = n
        guard PondSwipeHint(visits: n, swipes: swipes).peeks(reduceMotion: reduceMotion) else { return }
        try? await Task.sleep(for: .seconds(PondSwipeHint.peekDelay))
        if Task.isCancelled { return }
        await pan.peek(page: RoomViewPref.shared.mode(for: key), width: width)
    }
}

enum PondHintStore {
    static let visitsKey = "pondSwipeHintVisits"
    static let swipesKey = "pondSwipeHintSwipes"
}

// MARK: Swipe

/// Watches two-finger horizontal scrolls over the view it sits behind and reports what the strip should do (`PondDrag`
/// decides). The event always carries on, so vertical scrolling is untouched; a horizontally scrollable view under the
/// cursor keeps its own scrolling. Phase events (`began`, `changed`, `ended`, then momentum, which is ignored) drive it; the strip moves with each event.
struct PondSwipeMonitor: NSViewRepresentable {
    let current: () -> PondPage
    let pan: PondPanState
    let trackingEnabled: Bool
    let update: (PondDrag.Update) -> Void

    func makeNSView(context: Context) -> Watcher { Watcher() }
    func updateNSView(_ view: Watcher, context: Context) {
        view.current = current; view.pan = pan; view.update = update; view.trackingEnabled = trackingEnabled
    }
    static func dismantleNSView(_ view: Watcher, coordinator: ()) { view.stop() }

    final class Watcher: NSView {
        var current: () -> PondPage = { .dashboard }
        var pan = PondPanState()
        var update: (PondDrag.Update) -> Void = { _ in }
        var trackingEnabled = true
        private var swipe = PondDrag()
        private var monitor: Any?
        private var began = false
        /// "A sideways scroll view is under the cursor" is asked once per gesture (`SwipeGestureGate`), not per event.
        private var gate = SwipeGestureGate()
        private var gestureSeen = false

        override func viewDidMoveToWindow() {
            super.viewDidMoveToWindow()
            if window == nil { stop() } else { pan.host = self; start() }
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
            swipe.reset(); gate.reset(); gestureSeen = false
        }

        private func handle(_ event: NSEvent) {
            guard let window, event.window === window, event.hasPreciseScrollingDeltas else { return }
            let inside = bounds.contains(convert(event.locationInWindow, from: nil))
            let phase = Self.phase(event)
            // The end of a gesture is always fed, so one that finished off the view does not leave the next half-counted.
            guard inside || phase == .ended || phase == .cancelled else { return }
            if inside {
                let begins = phase == .began || (phase == .changed && !gestureSeen)
                let standalone = phase == .none && event.momentumPhase.isEmpty
                let blocked = gate.blocked(begins: begins, standalone: standalone) { scrollsSideways(under: event) }
                if phase == .changed || phase == .began { gestureSeen = true }
                if phase == .ended || phase == .cancelled { gestureSeen = false }
                if blocked { swipe.reset(); return }
            } else if phase == .ended || phase == .cancelled { gestureSeen = false }
            let sign: Double = event.isDirectionInvertedFromDevice ? 1 : -1
            let first = phase == .began || (phase == .changed && !began)
            if first { began = true }
            let result = swipe.feed(
                dx: Double(event.scrollingDeltaX) * sign, dy: Double(event.scrollingDeltaY) * sign, phase: phase,
                momentum: !event.momentumPhase.isEmpty, current: current(), width: Double(bounds.width),
                time: event.timestamp, origin: first ? pan.drawn : nil)
            if phase == .ended || phase == .cancelled { began = false }
            guard let result else { return }
            // Reduce Motion: no tracking, the swap alone.
            if !trackingEnabled {
                if case .commit = result { update(result) }
                return
            }
            // The strip follows each event at once (no frame hop): the fingers and the page never lag.
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
    /// Called once when the person scrolls near the top (older rows are wanted); the position is kept when they arrive.
    var onNearTop: (() -> Void)?

    func makeNSView(context: Context) -> Anchor { Anchor() }
    func updateNSView(_ view: Anchor, context: Context) { view.id = id; view.fromBottom = fromBottom; view.onNearTop = onNearTop }
    static func dismantleNSView(_ view: Anchor, coordinator: ()) { view.detach() }

    final class Anchor: NSView {
        var id = ""
        var fromBottom = false
        var onNearTop: (() -> Void)?
        private weak var scroll: NSScrollView?
        private var observer: NSObjectProtocol?
        private var frameObserver: NSObjectProtocol?
        private var recording = false
        /// Until the layout has settled, every change of the document's size puts the saved position back (no timers).
        private var settling = false
        private var armed = false
        private var target: CGFloat?
        /// The document's height when older rows were asked for; the next growth is the rows arriving at the top.
        private var prependFrom: CGFloat?

        override func viewWillMove(toWindow newWindow: NSWindow?) {
            if newWindow == nil { detach() }
            super.viewWillMove(toWindow: newWindow)
        }

        override func viewDidMoveToWindow() {
            super.viewDidMoveToWindow()
            guard window != nil else { return }
            // At once, so the position is right before the first display; later only if the scroll view was not there yet.
            attach()
            if observer == nil { DispatchQueue.main.async { [weak self] in self?.attach() } }
        }

        func detach() {
            if let observer { NotificationCenter.default.removeObserver(observer) }
            if let frameObserver { NotificationCenter.default.removeObserver(frameObserver) }
            observer = nil; frameObserver = nil; recording = false; settling = false; armed = false; prependFrom = nil
        }

        private func attach() {
            guard observer == nil, window != nil else { return }
            var v: NSView? = self
            while let x = v, !(x is NSScrollView) { v = x.superview }
            guard let scroll = v as? NSScrollView else { return }
            self.scroll = scroll
            scroll.contentView.postsBoundsChangedNotifications = true
            target = PondScrollMemory.offset(id)
            observer = NotificationCenter.default.addObserver(forName: NSView.boundsDidChangeNotification, object: scroll.contentView, queue: .main) { [weak self] _ in
                MainActor.assumeIsolated { self?.record() }
            }
            if let doc = scroll.documentView {
                doc.postsFrameChangedNotifications = true
                frameObserver = NotificationCenter.default.addObserver(forName: NSView.frameDidChangeNotification, object: doc, queue: .main) { [weak self] _ in
                    MainActor.assumeIsolated { self?.documentResized() }
                }
            }
            if let target { settling = true; restore(target) } else { recording = true }
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { [weak self] in
                guard let self else { return }
                self.settling = false; self.recording = true; self.armed = true
            }
        }

        private func metrics() -> (y: CGFloat, doc: CGFloat, visible: CGFloat)? {
            guard let scroll, let doc = scroll.documentView else { return nil }
            return (scroll.contentView.bounds.origin.y, doc.frame.height, scroll.contentView.bounds.height)
        }

        private func documentResized() {
            guard let m = metrics() else { return }
            if settling, let target { restore(target); return }
            if let from = prependFrom, m.doc != from {
                prependFrom = nil
                let y = CGFloat(RoomScroll.afterPrepend(y: Double(m.y), oldDocument: Double(from), newDocument: Double(m.doc)))
                scrollTo(y)
            }
        }

        private func record() {
            guard let m = metrics() else { return }
            if armed, prependFrom == nil, let onNearTop, RoomScroll.nearTop(y: Double(m.y), document: Double(m.doc), visible: Double(m.visible)) {
                prependFrom = m.doc
                onNearTop()
                // A request that brought nothing must not block the next one.
                DispatchQueue.main.asyncAfter(deadline: .now() + 3) { [weak self] in self?.prependFrom = nil }
            }
            guard recording else { return }
            let value = fromBottom ? max(0, m.doc - m.visible - m.y) : m.y
            PondScrollMemory.save(id, value)
        }

        private func scrollTo(_ y: CGFloat) {
            guard let scroll else { return }
            scroll.contentView.scroll(to: NSPoint(x: scroll.contentView.bounds.origin.x, y: y))
            scroll.reflectScrolledClipView(scroll.contentView)
        }

        private func restore(_ target: CGFloat) {
            guard let m = metrics() else { return }
            if fromBottom {
                scrollTo(CGFloat(RoomScroll.restored(fromBottom: Double(target), document: Double(m.doc), visible: Double(m.visible))))
            } else {
                scrollTo(min(max(0, target), max(0, m.doc - m.visible)))
            }
        }
    }
}
