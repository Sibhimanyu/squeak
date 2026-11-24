import AppKit
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
    /// for the duck (nothing opened); an off-duty duck is the caller's to put back on duty.
    @discardableResult
    func openFromPond(_ target: PondOpenTarget, pond: String?, page: PondPage) -> Bool {
        guard let s = pondDuckSession(target.duck) else { return false }
        openFromPond(s.key, pond: pond, page: page)
        guard case .ducklings(_, let labels) = target, let items = ducklings(for: s)?.items else { return true }
        let wanted = labels.isEmpty ? items : items.filter { d in
            labels.contains { l in d.title.localizedCaseInsensitiveContains(l) || l.localizedCaseInsensitiveContains(d.title) }
        }
        for d in wanted {
            let ref = DucklingRef(session: s.key, taskId: d.id)
            if let pond { PondOrigin.shared.opened(tab: PondOrigin.ducklingTab(ref), pond: pond, page: page) }
            DockStore.shared.openDuckling(ref)
        }
        return true
    }
}

// MARK: Two pages

/// Where the two-page strip is: 0 the Dashboard, 1 the Room. Only this changes while the fingers move, and only the small
/// views that read it (`PanPage`, the hint) re-evaluate: the pages themselves are built once by `PondSpace` and
/// never rebuilt per scroll tick.
@MainActor @Observable
final class PondPanState {
    enum Mode { case rest, dragging, gliding }

    private(set) var mode = Mode.rest
    /// The strip's position while dragging or gliding.
    private(set) var position = 0.0
    /// The page the strip rests on while at rest (follows `RoomViewPref` through `reconcile`).
    private(set) var restPage = PondPage.dashboard
    private var glide: (from: Double, to: Double, start: CFTimeInterval, duration: Double)?
    private var token = 0
    /// The overlay that moves two bitmaps of the pages (`PondSnapshotStrip`). While `snapshotActive` it alone follows the
    /// fingers and the finish; the live pages do not move until it is done.
    weak var strip: PondSnapshotStrip?
    private(set) var snapshotActive = false
    /// Set for a moment while a page is captured: the pages lay out as if this one were at rest, the hint hidden.
    private(set) var staging: PondPage?

    /// The strip's position now, for drawing (the hint reads it).
    var drawn: Double { mode == .rest ? PondDrag.home(restPage) : position }
    /// Where the live pages sit: still while a snapshot glide moves the bitmaps, `drawn` otherwise.
    var layoutPosition: Double {
        PondDrag.layoutPosition(staging: staging, snapshotActive: snapshotActive, restPage: restPage, drawn: drawn)
    }

    private func stage(_ page: PondPage?) {
        var t = Transaction(); t.disablesAnimations = true
        withTransaction(t) { staging = page }
        strip?.sync()
    }

    /// Captures both pages and shows them on the strip; false (nothing changed) when anything fails, and the live pages
    /// carry the gesture as before.
    private func beginSnapshot() -> Bool {
        guard !Motion.reduceMotion, let strip, !snapshotActive, strip.bounds.width > 1 else { return false }
        let source = restPage, destination = PondSnapshotPlan.destination(of: source)
        strip.isHidden = true  // never captured itself
        stage(source)
        let a = strip.capture()
        stage(destination)
        let b = strip.capture()
        stage(nil)
        let ok = PondSnapshotPlan.usable(
            width: Double(strip.bounds.width), height: Double(strip.bounds.height),
            capturedBoth: a?.cgImage != nil && b?.cgImage != nil,
            identical: a != nil && b != nil && PondSnapshotStrip.identical(a!, b!))
        guard ok, let ia = a?.cgImage, let ib = b?.cgImage else { return false }
        strip.show(images: [source: ia, destination: ib], rest: source, position: PondDrag.home(source))
        snapshotActive = true
        return true
    }

    private func endSnapshot() {
        guard snapshotActive else { return }
        snapshotActive = false
        strip?.dismiss()
    }

    /// Where the strip is on screen right now, while a finish is in flight (the animation's own curve, so a grab continues
    /// from the very spot, never from where the finish was going).
    func presented(at now: CFTimeInterval = CACurrentMediaTime()) -> Double {
        guard mode == .gliding, let g = glide else { return drawn }
        if snapshotActive, let p = strip?.presentedPosition() { return p }
        let t = g.duration > 0 ? (now - g.start) / g.duration : 1
        return g.from + (g.to - g.from) * SwipeCurve.value(t)
    }

    func mount(page: PondPage) { mode = .rest; restPage = page; glide = nil; token += 1 }

    /// The pond page left the screen (a pond page mounts only while shown, this state outlives it): whatever was in flight
    /// can never finish, so rest on `page` with no snapshot or staging, or the next mount finds the Room slid off screen.
    func unmount(page: PondPage) {
        mount(page: page); snapshotActive = false; staging = nil; strip = nil
    }

    func track(_ p: Double) {
        if mode != .dragging {
            token += 1
            if snapshotActive { strip?.freeze() } else if mode == .rest { _ = beginSnapshot() }
            mode = .dragging; glide = nil
        }
        if snapshotActive { strip?.place(position: p) }
        var t = Transaction(); t.disablesAnimations = true
        withTransaction(t) { position = p }
    }

    /// Moves the strip to `page`'s rest over `duration` on the swipe curve, from where it is drawn now.
    func finish(to page: PondPage, from: Double? = nil, duration: Double) {
        let start = from ?? presented()
        token += 1
        let mine = token
        if !snapshotActive, mode == .rest { _ = beginSnapshot() }
        var t = Transaction(); t.disablesAnimations = true
        withTransaction(t) { mode = .gliding; position = start }
        let target = PondDrag.home(page)
        glide = (start, target, CACurrentMediaTime(), duration)
        if snapshotActive, let strip, !Motion.reduceMotion {
            strip.glide(from: start, to: target, duration: duration) { [weak self] in
                MainActor.assumeIsolated {
                    guard let self, self.token == mine else { return }
                    self.mode = .rest; self.restPage = page; self.glide = nil
                    self.endSnapshot()
                }
            }
            withAnimation(Motion.swipe(duration: duration)) { position = target }
            return
        }
        if snapshotActive { endSnapshot() }
        withAnimation(Motion.swipe(duration: duration)) { position = target } completion: { [weak self] in
            guard let self, self.token == mine else { return }
            self.mode = .rest; self.restPage = page; self.glide = nil
        }
        if Motion.reduceMotion { mode = .rest; restPage = page; glide = nil }
    }

    /// The page changed from outside the gesture (the switch, the header control, the way back from a tab).
    func reconcile(page: PondPage, width: Double) {
        guard mode != .dragging else { return }
        if mode == .rest, restPage == page { return }
        if mode == .gliding, glide?.to == PondDrag.home(page) { return }
        let remaining = abs(PondDrag.home(page) - presented())
        let duration = SwipeFinish.commitDuration(remainingShare: remaining, width: width, velocity: 0)
        // The snapshots are taken outside this view update, in the next turn; nothing has moved by then.
        guard mode == .rest, strip != nil, !Motion.reduceMotion else { finish(to: page, duration: duration); return }
        token += 1
        let mine = token
        DispatchQueue.main.async { [weak self] in
            guard let self, self.token == mine, self.mode == .rest else { return }
            self.finish(to: page, duration: duration)
        }
    }

    /// First visit: the page slides a little toward the other and eases back, showing the gesture.
    func peek(page: PondPage, width: Double) async {
        guard mode == .rest, restPage == page else { return }
        let home = PondDrag.home(page), out = PondSwipeHint.peekPosition(page: page, width: width)
        token += 1
        let mine = token
        var t = Transaction(); t.disablesAnimations = true
        withTransaction(t) { mode = .gliding; position = home }
        glide = (home, out, CACurrentMediaTime(), 0.3)
        withAnimation(Motion.swipe(duration: 0.3)) { position = out }
        try? await Task.sleep(for: .milliseconds(380))
        guard token == mine, mode == .gliding else { return }
        finish(to: page, duration: 0.4)
    }
}

/// One state per pond, so the inspector (another part of the window) can follow the same gesture.
@MainActor
final class PondPanStore {
    static let shared = PondPanStore()
    private var states: [String: PondPanState] = [:]
    func state(for key: String) -> PondPanState {
        if let s = states[key] { return s }
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
        let x = PondDrag.x(of: page, position: state.layoutPosition, width: Double(width))
        content
            .offset(x: x)
            .zIndex(PondSnapshotPlan.zPosition(of: page, rest: state.restPage))
            .overlay {
                // Nothing at all over a page at rest: the view exists only while a live slide moves it.
                let s = PondSnapshotPlan.liveScrim(x: x, width: Double(width), snapshotActive: state.snapshotActive, moving: state.mode != .rest)
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
    @ViewBuilder let dashboard: () -> Dashboard
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.controlActiveState) private var activeState
    @State private var pan: PondPanState
    @State private var swipes = UserDefaults.standard.integer(forKey: PondHintStore.swipesKey)
    @State private var visits = 0
    @State private var width = 0.0
    @State private var haptic = SwipeHapticLatch()

    init(key: String, projectId: String, member: Bool = false, leadingInset: CGFloat = 0, @ViewBuilder dashboard: @escaping () -> Dashboard) {
        self.key = key; self.projectId = projectId; self.member = member; self.leadingInset = leadingInset; self.dashboard = dashboard
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
                    .allowsHitTesting(page == .dashboard).accessibilityHidden(page != .dashboard)
                PondRoomView(projectId: projectId, member: member, key: key, leadingInset: leadingInset).id(key).screen("Pond room")
                    .frame(width: w, height: geo.size.height)
                    .modifier(PanPage(state: pan, page: .room, width: w))
                    .allowsHitTesting(page == .room).accessibilityHidden(page != .room)
            }
            .frame(width: w, height: geo.size.height)
            .overlay { PondSnapshotLayer(state: pan).allowsHitTesting(false) }
            .overlay(alignment: page == .dashboard ? .trailing : .leading) {
                PondSwipeHintView(
                    state: pan, page: page, hint: PondSwipeHint(visits: visits, swipes: swipes)
                ) { switchTo(page == .dashboard ? .room : .dashboard) }
                .opacity(pan.staging == nil ? 1 : 0)
            }
            .onAppear { width = Double(w) }
            .onChange(of: w) { _, new in width = Double(new) }
        }
        .clipped()
        .background(PondSwipeMonitor(
            current: { RoomViewPref.shared.mode(for: key) }, origin: { pan.presented() },
            trackingEnabled: !reduceMotion, update: { update($0) }))
        .onChange(of: page) { _, new in pan.reconcile(page: new, width: width) }
        .onDisappear { pan.unmount(page: RoomViewPref.shared.mode(for: key)) }
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
            let remaining = abs(from - PondDrag.home(page))
            pan.finish(to: page, from: from, duration: SwipeFinish.settleDuration(remainingShare: remaining, width: width, velocity: v))
        case .commit(let target, let from, let v):
            haptic.reset()
            swipes += 1
            UserDefaults.standard.set(swipes, forKey: PondHintStore.swipesKey)
            let remaining = abs(PondDrag.home(target) - from)
            // The strip finishes from where the fingers left it; the page changes in the same step, so nothing restarts.
            pan.finish(to: target, from: from, duration: SwipeFinish.commitDuration(remainingShare: remaining, width: width, velocity: v))
            RoomViewPref.shared.set(target, for: key)
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

/// The edge affordance: a 36 pt round button with an 18 pt chevron and, while it still teaches, the other page's name under
/// it. Idle it is static (a repeating animation paces the whole window's frame rate). While dragging, a thin ring fills toward the commit point and the chevron turns once it would commit.
/// Neutral colours only (§3).
struct PondSwipeHintView: View {
    let state: PondPanState
    let page: PondPage
    let hint: PondSwipeHint
    let action: () -> Void
    @State private var hover = false

    var body: some View {
        let toRoom = page == .dashboard
        VStack(spacing: 6) {
            Button(action: action) {
                ZStack {
                    Circle().fill(Theme.surfaceRaised.opacity(0.9))
                    Circle().strokeBorder(Theme.line, lineWidth: 1)
                    PanRing(state: state, page: page)
                    PanChevron(state: state, page: page, toRoom: toRoom)
                }
                .frame(width: 36, height: 36)
                .contentShape(Circle())
            }
            .buttonStyle(.plain)
            if hint.showsWord {
                Text(toRoom ? "Room" : "Dashboard").font(Typo.meta).foregroundStyle(Theme.muted)
            }
        }
        .padding(.horizontal, 10)
        .opacity(hover ? 1 : hint.restingOpacity)
        .onHover { hover = $0 }
        .animation(Motion.quick, value: hover)
        .help(toRoom ? "Show the Room" : "Show the Dashboard")
        .accessibilityElement(children: .contain)
        .accessibilityLabel(toRoom ? "Show the Room" : "Show the Dashboard")
        .id(page)
        .transition(.opacity)
    }
}

/// The ring's stroke, trimmed by the drag's progress. Reads the position itself so only it re-evaluates per tick.
private struct PanRing: View {
    let state: PondPanState
    let page: PondPage
    var body: some View {
        let progress = PondDrag.progress(position: state.drawn, page: page)
        Circle().trim(from: 0, to: SwipeRing.trim(progress: progress))
            .stroke(Theme.ink.opacity(0.6), style: StrokeStyle(lineWidth: 2, lineCap: .round))
            .rotationEffect(.degrees(-90))
    }
}

private struct PanChevron: View {
    let state: PondPanState
    let page: PondPage
    let toRoom: Bool
    var body: some View {
        let flipped = SwipeRing.flipped(progress: PondDrag.progress(position: state.drawn, page: page))
        Lucide(toRoom ? .chevronRight : .chevronLeft, size: 18, color: flipped ? Theme.ink : Theme.muted)
            .rotationEffect(.degrees(flipped ? 180 : 0))
            .animation(Motion.quick, value: flipped)
    }
}

// MARK: Swipe

/// Watches two-finger horizontal scrolls over the view it sits behind and reports what the strip should do (`PondDrag`
/// decides). The event always carries on, so vertical scrolling is untouched; a horizontally scrollable view under the
/// cursor keeps its own scrolling. Tracking is coalesced to one update per display frame.
struct PondSwipeMonitor: NSViewRepresentable {
    let current: () -> PondPage
    let origin: () -> Double
    let trackingEnabled: Bool
    let update: (PondDrag.Update) -> Void

    func makeNSView(context: Context) -> Watcher { Watcher() }
    func updateNSView(_ view: Watcher, context: Context) {
        view.current = current; view.origin = origin; view.update = update; view.trackingEnabled = trackingEnabled
    }
    static func dismantleNSView(_ view: Watcher, coordinator: ()) { view.stop() }

    final class Watcher: NSView {
        var current: () -> PondPage = { .dashboard }
        var origin: () -> Double = { 0 }
        var update: (PondDrag.Update) -> Void = { _ in }
        var trackingEnabled = true
        private var swipe = PondDrag()
        private var monitor: Any?
        private var link: CADisplayLink?
        private var pending: Double?
        private var began = false
        /// "A sideways scroll view is under the cursor" is asked once per gesture (`SwipeGestureGate`), not per event.
        private var gate = SwipeGestureGate()
        private var gestureSeen = false

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
            link?.invalidate(); link = nil; pending = nil
            swipe.reset(); gate.reset(); gestureSeen = false
        }

        /// One update per display frame: the newest position wins.
        @objc private func frame(_ link: CADisplayLink) {
            guard let p = pending else { link.invalidate(); self.link = nil; return }
            pending = nil
            update(.track(p))
        }

        private func schedule(_ position: Double) {
            pending = position
            if link == nil {
                let l = displayLink(target: self, selector: #selector(frame(_:)))
                l.add(to: .main, forMode: .common)
                link = l
            }
            link?.isPaused = false
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
                if blocked { swipe.reset(); pending = nil; return }
            } else if phase == .ended || phase == .cancelled { gestureSeen = false }
            let sign: Double = event.isDirectionInvertedFromDevice ? 1 : -1
            let first = phase == .began || (phase == .changed && !began)
            if first { began = true }
            let result = swipe.feed(
                dx: Double(event.scrollingDeltaX) * sign, dy: Double(event.scrollingDeltaY) * sign, phase: phase,
                momentum: !event.momentumPhase.isEmpty, current: current(), width: Double(bounds.width),
                time: event.timestamp, origin: first ? origin() : nil)
            if phase == .ended || phase == .cancelled { began = false }
            guard let result else { return }
            // Reduce Motion: no tracking, the swap alone.
            if !trackingEnabled {
                if case .commit = result { update(result) }
                return
            }
            if case .track(let p) = result { schedule(p); return }
            // A finish supersedes any position still waiting for the next frame.
            pending = nil
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
