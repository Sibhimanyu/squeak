import AppKit
import SqueakIcons
import SqueakMacCore
import SwiftUI

// The pond room (DESIGN.md §8.10, the centre): a group chat for the project. Top, who is working now; middle, the
// feed (the person on the right, agents and Squeak on the left); bottom, a composer that posts to the room.

/// Which stream's pond room fills the centre. In memory only: choosing a chat, file or panel tab closes it.
@MainActor @Observable
final class RoomSelection {
    static let shared = RoomSelection()
    private(set) var projectId: String?

    func open(_ projectId: String) { self.projectId = projectId }
    func close() { if projectId != nil { projectId = nil } }
    func isOpen(_ projectId: String?) -> Bool { projectId != nil && self.projectId == projectId }
}

@MainActor @Observable
final class PondRoomModel {
    enum Phase: Equatable { case loading, ready, unavailable, failed }

    let projectId: String
    private(set) var feed = RoomFeed()
    private(set) var phase: Phase = .loading
    private(set) var loadingOlder = false
    var filter = RoomFilter()
    var rippleFilter: RoomRippleFilter = .all
    static let pageSize = 50

    @ObservationIgnored private var running = false

    init(projectId: String) { self.projectId = projectId }

    /// Reads the room, then follows its stream until the task is cancelled.
    func run(host: NativeHostClient) async {
        guard !running else { return }
        running = true
        defer { running = false }
        let client = RoomClient(host: host)
        await initialRead(client)
        guard phase == .ready || phase == .failed else { return }
        for await event in client.events(project: projectId) {
            switch event {
            case .hello(let latest): await react(feed.hello(latestSeq: latest), client)
            case .post(let p):
                var f = feed
                let effect = f.receive(p)
                feed = f
                await react(effect, client)
            case .turn(let t): feed.upsert(turn: t)
            case .reconnected: await catchUp(client)
            }
        }
    }

    private func initialRead(_ client: RoomClient) async {
        do {
            guard let page = try await client.page(project: projectId, limit: Self.pageSize) else { phase = .unavailable; return }
            var f = feed
            f.apply(page: page, pageSize: Self.pageSize)
            feed = f
            phase = .ready
        } catch {
            phase = .failed
            try? await Task.sleep(for: .seconds(3))
            if !Task.isCancelled { await initialRead(client) }
        }
    }

    private func react(_ effect: RoomFeedEffect, _ client: RoomClient) async {
        if case .refetch = effect { await catchUp(client) }
    }

    private func catchUp(_ client: RoomClient) async {
        guard feed.loaded else { await initialRead(client); return }
        guard let page = try? await client.page(project: projectId, since: feed.latestSeq) else { return }
        var f = feed
        f.apply(page: page)
        feed = f
    }

    func loadOlder(host: NativeHostClient) async {
        guard feed.hasMoreBefore, !loadingOlder, let before = feed.oldestSeq else { return }
        loadingOlder = true
        defer { loadingOlder = false }
        guard let page = try? await RoomClient(host: host).page(project: projectId, before: before, limit: Self.pageSize) else { return }
        var f = feed
        f.prepend(page: page, pageSize: Self.pageSize)
        feed = f
    }

    /// A message to the whole room (or to a person, whose name leads it).
    func send(_ text: String, host: NativeHostClient) async {
        let clean = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !clean.isEmpty else { return }
        let level: RoomLevel = .room
        let id = feed.addPending(
            text: clean, level: level, author: RoomAuthor(kind: .person, name: "You"), at: Int64(Date().timeIntervalSince1970 * 1000))
        await deliver(pendingId: id, text: clean, level: level, host: host)
    }

    func retry(_ id: String, host: NativeHostClient) async {
        guard let row = feed.pendingRow(id), row.failed else { return }
        feed.retry(pendingId: id)
        await deliver(pendingId: id, text: row.post.text, level: row.post.level, host: host)
    }

    private func deliver(pendingId: String, text: String, level: RoomLevel, host: NativeHostClient) async {
        do {
            let post = try await RoomClient(host: host).send(project: projectId, text: text, level: level)
            feed.reconcile(pendingId: pendingId, with: post)
        } catch {
            feed.markFailed(pendingId: pendingId)
        }
    }
}

/// One model per project, so leaving the room and coming back keeps what was read.
@MainActor
final class PondRoomStore {
    static let shared = PondRoomStore()
    private var models: [String: PondRoomModel] = [:]
    func model(for projectId: String) -> PondRoomModel {
        if let m = models[projectId] { return m }
        let m = PondRoomModel(projectId: projectId)
        models[projectId] = m
        return m
    }
}

// MARK: - View

/// The pond's landing view (the mock-ups: header, Now, Ripples, composer, inspector). `embedded` is the pinned tab inside
/// a chat's workbench: no header of its own (the chat's header is there) and no inspector.
struct PondRoomView: View {
    let projectId: String
    /// The pond's directory key (nil from the pinned tab, which has no pond page to switch to).
    var key: String?
    var embedded = false
    /// Room for the sidebar toggle when the sidebar is closed.
    var leadingInset: CGFloat = 0

    @Environment(AppModel.self) private var model
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var atBottom = true
    @State private var unseen = 0
    @State private var ledger = RoomFadeLedger()

    private var room: PondRoomModel { PondRoomStore.shared.model(for: projectId) }
    private var ponds: PondsModel { .shared }

    var body: some View {
        let room = room
        GeometryReader { geo in
            let showInspector = !embedded && key != nil && geo.size.width >= 1040
            HStack(spacing: 0) {
                VStack(spacing: 0) {
                    if !embedded, let key { RoomHeader(key: key, summary: RoomSummary.line(feed: room.feed), leadingInset: leadingInset) }
                    content(room)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                if showInspector, let key {
                    Rectangle().fill(Theme.line).frame(width: 1)
                    RoomInspector(key: key, today: RoomSummary.today(turns: room.feed.turns))
                        .frame(width: 300).frame(maxHeight: .infinity)
                }
            }
        }
        .background(Theme.bg)
        .task(id: projectId) { await room.run(host: model.nativeHost) }
    }

    @ViewBuilder private func content(_ room: PondRoomModel) -> some View {
        switch room.phase {
        case .unavailable:
            Text("Update Squeak's host to use the room.").font(.system(size: 14)).foregroundStyle(Theme.muted)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        case .loading, .failed:
            Color.clear.frame(maxWidth: .infinity, maxHeight: .infinity)
        case .ready:
            let unread = unreadThreads(room)
            let cards = RoomNow.cards(threads: room.feed.threads, unread: unread, filesFor: { model.changesStore(for: $0).changes?.files.count })
            let ripples = RoomRipples.build(feed: room.feed, filter: room.rippleFilter)
            VStack(spacing: 0) {
                column { RoomNowSection(cards: cards, key: key, open: openThread, answer: answer) }
                column { ripplesHeader(room) }
                ripplesFeed(room, ripples)
                column { RoomComposer(room: room, send: sendTo) }.padding(.bottom, Space.l).padding(.top, Space.s)
            }
        }
    }

    /// The centred reading column (760 at most, 32 from either edge).
    private func column<C: View>(@ViewBuilder _ c: () -> C) -> some View {
        c().padding(.horizontal, Metrics.readingInset).frame(maxWidth: Metrics.readingColumn + 2 * Metrics.readingInset).frame(maxWidth: .infinity)
    }

    private func ripplesHeader(_ room: PondRoomModel) -> some View {
        HStack {
            Text("Ripples").font(.system(size: 13, weight: .semibold)).foregroundStyle(Theme.muted).accessibilityAddTraits(.isHeader)
            Spacer()
            RoomSegmented(
                items: RoomRippleFilter.allCases, selection: Binding(get: { room.rippleFilter }, set: { room.rippleFilter = $0 }),
                title: \.title, height: 26)
        }
        .padding(.top, Space.m).padding(.bottom, Space.s)
    }

    private func ripplesFeed(_ room: PondRoomModel, _ ripples: [RoomRipple]) -> some View {
        let count = ripples.reduce(0) { $0 + RoomRippleView.weight($1) }
        return ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 0) {
                    if room.feed.hasMoreBefore {
                        Color.clear.frame(height: 1).onAppear { Task { await room.loadOlder(host: model.nativeHost) } }
                    }
                    if ripples.isEmpty {
                        Text(room.rippleFilter == .all ? "When threads in this pond start working, what they're on shows up here." : "Nothing here yet.")
                            .font(.system(size: 13)).foregroundStyle(Theme.muted).frame(maxWidth: .infinity).padding(.vertical, Space.xl)
                    }
                    ForEach(ripples) { ripple in
                        RoomRippleView(ripple: ripple, threads: room.feed.threads, ledger: ledger, open: openThread,
                            retry: { id in Task { await room.retry(id, host: model.nativeHost) } })
                    }
                    Color.clear.frame(height: 1).id("room-bottom")
                        .onAppear { atBottom = true; unseen = 0 }
                        .onDisappear { atBottom = false }
                }
                .padding(.horizontal, Metrics.readingInset).padding(.vertical, Space.s)
                .frame(maxWidth: Metrics.readingColumn + 2 * Metrics.readingInset).frame(maxWidth: .infinity)
            }
            .defaultScrollAnchor(.bottom)
            .onAppear { ledger.freeze(ripples.map(\.id)) }
            .onChange(of: count) { old, new in
                guard new > old else { return }
                if atBottom { proxy.scrollTo("room-bottom", anchor: .bottom) } else { unseen += new - old }
            }
            .overlay(alignment: .bottom) {
                if !atBottom && unseen > 0 {
                    Button {
                        unseen = 0
                        proxy.scrollTo("room-bottom", anchor: .bottom)
                    } label: {
                        Text("New activity").font(.system(size: 12, weight: .medium)).foregroundStyle(Theme.ink)
                            .padding(.horizontal, 12).frame(height: Metrics.pill + 4)
                            .background(Theme.surfaceRaised, in: Capsule()).overlay(Capsule().strokeBorder(Theme.lineStrong))
                    }
                    .buttonStyle(.plain).padding(.bottom, Space.s).transition(.opacity)
                    .accessibilityLabel("Scroll to new activity")
                }
            }
            .animation(reduceMotion ? nil : Motion.quick, value: unseen > 0)
        }
    }

    // MARK: Actions

    private func unreadThreads(_ room: PondRoomModel) -> Set<String> {
        var out = Set<String>()
        for t in room.feed.threads where t.state == .idle || t.state == .error {
            if let s = session(t.sessionId), model.mark(for: s)?.kind == .unread { out.insert(t.sessionId) }
        }
        return out
    }

    private func session(_ id: String) -> HostSession? {
        model.allSessions.first { $0.key.hostSessionId == id && $0.source == .squeak }
    }

    private func openThread(_ sessionId: String) {
        guard let s = session(sessionId) else { return }
        RoomSelection.shared.close()
        PondsModel.shared.route = nil
        model.select(s.key)
    }

    /// An answer to a needs-you card goes through the chat's own send path, marked as an answer (a letter is just the letter).
    private func answer(_ sessionId: String, _ text: String) {
        guard let s = session(sessionId) else { return }
        Task { _ = await model.send(text, to: s.key, answering: true) }
    }

    private func sendTo(_ to: RoomAddressee, _ text: String) {
        atBottom = true
        switch to {
        case .thread(let id, _):
            guard let s = session(id) else { return }
            Task { _ = await model.send(text, to: s.key) }
        case .everyone, .person:
            Task { await room.send(RoomMention.roomText(text, to: to), host: model.nativeHost) }
        }
    }
}

/// Remembers which rows were there at the first draw, so only rows that arrive later fade in (once).
@MainActor final class RoomFadeLedger {
    private var known: Set<String> = []
    private var frozen = false
    func freeze(_ ids: [String]) { guard !frozen else { return }; frozen = true; known.formUnion(ids) }
    /// True once for a row that was not in the first draw.
    func shouldFade(_ id: String) -> Bool { frozen && known.insert(id).inserted }
}

extension View {
    /// Reports the view's height (a background reader: `onGeometryChange` needs macOS 15).
    func onGeometryChangeCompat(_ report: @escaping (CGFloat) -> Void) -> some View {
        background(GeometryReader { g in Color.clear.onAppear { report(g.size.height) }.onChange(of: g.size.height) { _, h in report(h) } })
    }
}

// MARK: - The pinned tab

/// The first tab of a stream's strip: icon only, no close button, opens the pond room.
struct PondRoomTab: View {
    let selected: Bool
    let height: CGFloat
    let indicator: Namespace.ID
    let select: () -> Void

    var body: some View {
        Button(action: select) {
            Lucide(.messageSquareText, size: 14, color: selected ? Theme.ink : Theme.muted)
                .frame(width: 32, height: height).contentShape(Rectangle())
                .overlay(alignment: .bottom) {
                    if selected { Rectangle().fill(Theme.ink).frame(height: 2).matchedGeometryEffect(id: "tabIndicator", in: indicator) }
                }
        }
        .buttonStyle(.plain)
        .help("Pond room").accessibilityLabel("Pond room")
        .accessibilityAddTraits(selected ? .isSelected : [])
    }
}
