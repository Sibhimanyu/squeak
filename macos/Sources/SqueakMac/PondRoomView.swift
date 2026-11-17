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

struct PondRoomView: View {
    let projectId: String
    @Environment(AppModel.self) private var model
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var atBottom = true
    @State private var unseen = 0
    @State private var draft = ""
    @State private var contentHeight: CGFloat = 0

    private var room: PondRoomModel { PondRoomStore.shared.model(for: projectId) }

    var body: some View {
        let room = room
        VStack(spacing: 0) {
            WorkingNowStrip(threads: RoomPresentation.workingNow(room.feed.threads), recent: RoomPresentation.recent(room.feed.threads), open: openThread)
            content(room)
            composer(room).padding(.horizontal, Space.l).padding(.bottom, Space.l).padding(.top, Space.s)
                .frame(maxWidth: Metrics.readingColumn)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
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
            let groups = RoomGrouping.groups(room.feed.rows, filter: room.filter)
            if groups.isEmpty && room.feed.threads.isEmpty {
                Text("When threads in this pond start working, what they're on shows up here.")
                    .font(.system(size: 14)).foregroundStyle(Theme.muted).multilineTextAlignment(.center)
                    .padding(Space.xl).frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if groups.isEmpty {
                Color.clear.frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                feedView(room, groups)
            }
        }
    }

    private func feedView(_ room: PondRoomModel, _ groups: [RoomGroup]) -> some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: Space.l) {
                    if room.feed.hasMoreBefore {
                        Color.clear.frame(height: 1).onAppear { Task { await room.loadOlder(host: model.nativeHost) } }
                    }
                    ForEach(groups) { group in
                        RoomGroupView(group: group, threads: room.feed.threads, retry: { id in Task { await room.retry(id, host: model.nativeHost) } })
                    }
                    Color.clear.frame(height: 1).id("room-bottom")
                        .onAppear { atBottom = true; unseen = 0 }
                        .onDisappear { atBottom = false }
                }
                .padding(.horizontal, Space.l).padding(.vertical, Space.m)
                .frame(maxWidth: Metrics.readingColumn).frame(maxWidth: .infinity)
            }
            .defaultScrollAnchor(.bottom)
            .onChange(of: room.feed.rows.last?.id) { old, new in
                guard old != nil, new != nil else { return }
                if atBottom { proxy.scrollTo("room-bottom", anchor: .bottom) } else { unseen += 1 }
            }
            .overlay(alignment: .bottom) {
                if !atBottom && unseen > 0 {
                    Button {
                        unseen = 0
                        proxy.scrollTo("room-bottom", anchor: .bottom)
                    } label: {
                        Text("New activity").font(.system(size: 12, weight: .medium)).foregroundStyle(Theme.ink)
                            .padding(.horizontal, 12).frame(height: Metrics.pill)
                            .background(Theme.surfaceRaised, in: Capsule()).overlay(Capsule().strokeBorder(Theme.lineStrong))
                    }
                    .buttonStyle(.plain).padding(.bottom, Space.s).transition(.opacity)
                    .accessibilityLabel("Scroll to new activity")
                }
            }
            .animation(reduceMotion ? nil : Motion.quick, value: unseen > 0)
            .overlay(alignment: .topTrailing) { agentTalkToggle(room).padding(Space.s) }
        }
    }

    private func agentTalkToggle(_ room: PondRoomModel) -> some View {
        Button {
            var f = room.filter
            f.showAgentTalk.toggle()
            room.filter = f
        } label: {
            Text(room.filter.showAgentTalk ? "Hide agent talk" : "Show agent talk").font(.system(size: 12))
                .foregroundStyle(Theme.muted).padding(.horizontal, 8).frame(height: Metrics.pill)
                .background(Theme.bg.opacity(0.9), in: Capsule())
        }
        .buttonStyle(.plain).accessibilityLabel(room.filter.showAgentTalk ? "Hide agent talk" : "Show agent talk")
    }

    private func composer(_ room: PondRoomModel) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            ComposerField(
                text: $draft, sendKey: .returnSends, placeholder: "Message the pond",
                onSend: send, onContentHeight: { contentHeight = $0 }
            )
            .frame(height: min(max(contentHeight, 36), 140))
        }
        .padding(.horizontal, 14).padding(.vertical, 8)
        .background(Theme.surface, in: RoundedRectangle(cornerRadius: Radius.card, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: Radius.card, style: .continuous).strokeBorder(Theme.line))
    }

    private func send() {
        let text = draft
        guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        draft = ""
        atBottom = true
        Task { await room.send(text, host: model.nativeHost) }
    }

    private func openThread(_ sessionId: String) {
        guard let s = model.allSessions.first(where: { $0.key.hostSessionId == sessionId && $0.source == .squeak }) else { return }
        RoomSelection.shared.close()
        model.select(s.key)
    }
}

// MARK: - Working now

private struct WorkingNowStrip: View {
    let threads: [RoomThread]
    let recent: [RoomThread]
    let open: (String) -> Void

    var body: some View {
        if !threads.isEmpty || !recent.isEmpty {
            VStack(spacing: 0) {
                if !threads.isEmpty {
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: Space.s) {
                            ForEach(threads) { t in chip(t) }
                        }
                        .padding(.horizontal, Space.l).padding(.vertical, Space.s)
                    }
                }
                if !recent.isEmpty { recentList }
                Rectangle().fill(Theme.line).frame(height: 1)
            }
        }
    }

    /// Quiet list of threads that are not working: title, and how their last turn ended. Tap opens the thread.
    private var recentList: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text("Recent").font(.system(size: 12, weight: .medium)).foregroundStyle(Theme.muted)
                .padding(.bottom, 2)
            ForEach(recent.prefix(6)) { t in
                Button { open(t.sessionId) } label: {
                    HStack(spacing: Space.s) {
                        Text(verbatim: t.title).font(.system(size: 13)).foregroundStyle(Theme.ink).lineLimit(1)
                        Spacer(minLength: Space.s)
                        Text(verbatim: RoomPresentation.recentLine(t, now: Date())).font(.system(size: 12))
                            .foregroundStyle(Theme.muted).lineLimit(1)
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .help("Open \(t.title)")
            }
        }
        .padding(.horizontal, Space.l).padding(.vertical, Space.s)
        .frame(maxWidth: Metrics.readingColumn, alignment: .leading).frame(maxWidth: .infinity)
    }

    private func chip(_ t: RoomThread) -> some View {
        Button { open(t.sessionId) } label: {
            HStack(spacing: 8) {
                ChatMarkGlyph(mark: ChatMark(t.state == .waiting ? .waiting : .working, waiting: .answer))
                VStack(alignment: .leading, spacing: 1) {
                    Text(verbatim: t.title).font(.system(size: 13, weight: .medium)).foregroundStyle(Theme.ink).lineLimit(1)
                    Text(verbatim: RoomPresentation.chipLine(t)).font(.system(size: 12)).foregroundStyle(Theme.muted).lineLimit(1)
                }
            }
            .padding(.horizontal, 10).padding(.vertical, 6).frame(maxWidth: 260, alignment: .leading)
            .background(Theme.surface, in: RoundedRectangle(cornerRadius: Radius.control, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: Radius.control, style: .continuous).strokeBorder(Theme.line))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("\(t.title), \(RoomPresentation.chipLine(t))")
        .help("Open \(t.title)")
    }
}

// MARK: - Feed rows

private struct RoomGroupView: View {
    let group: RoomGroup
    let threads: [RoomThread]
    let retry: (String) -> Void

    var body: some View {
        let author = group.author
        let right = RoomPresentation.alignsRight(author)
        let agentLevel = group.rows[0].post.level == .agents
        HStack(alignment: .top, spacing: 10) {
            if right { Spacer(minLength: 60) } else { RoomAvatar(author: author, agent: threads.first { $0.sessionId == group.rows[0].post.sessionId }?.agent) }
            VStack(alignment: right ? .trailing : .leading, spacing: 4) {
                if !right {
                    Text(verbatim: RoomPresentation.authorName(author)).font(.system(size: 12, weight: .medium)).foregroundStyle(Theme.muted)
                }
                ForEach(group.rows) { row in RoomPostView(row: row, threads: threads, right: right, retry: retry) }
            }
            .padding(.leading, agentLevel ? Space.l : 0)
            if !right { Spacer(minLength: 60) }
        }
        .opacity(agentLevel ? 0.7 : 1)
    }
}

private struct RoomPostView: View {
    let row: RoomRow
    let threads: [RoomThread]
    let right: Bool
    let retry: (String) -> Void

    var body: some View {
        let post = row.post
        let label = RoomPresentation.kindLabel(post)
        let to = RoomPresentation.recipient(post, threads: threads)
        VStack(alignment: right ? .trailing : .leading, spacing: 2) {
            if label != nil || to != nil {
                HStack(spacing: 6) {
                    if let label { Text(verbatim: label.text).foregroundStyle(label.attention ? Theme.warning : Theme.muted) }
                    if let to { Text(verbatim: to).foregroundStyle(Theme.muted) }
                }
                .font(.system(size: 11))
            }
            Text(verbatim: post.text).font(.system(size: 14)).foregroundStyle(Theme.ink).textSelection(.enabled)
                .multilineTextAlignment(right ? .trailing : .leading)
                .padding(.horizontal, right ? 12 : 0).padding(.vertical, right ? 8 : 0)
                .background(right ? AnyShapeStyle(Theme.selected) : AnyShapeStyle(.clear), in: RoundedRectangle(cornerRadius: Radius.card, style: .continuous))
                .opacity(row.pending ? 0.6 : 1)
            if row.failed {
                Button("Not sent. Retry") { retry(row.id) }.buttonStyle(.plain).font(.system(size: 11)).foregroundStyle(Theme.negative)
            } else if !row.pending, post.at > 0 {
                Text(verbatim: RoomPresentation.relativeTime(at: post.at, now: Date())).font(.system(size: 11)).foregroundStyle(Theme.subtle)
            }
        }
    }
}

private struct RoomAvatar: View {
    let author: RoomAuthor
    let agent: String?
    private let size: CGFloat = 24

    var body: some View {
        Group {
            switch author.kind {
            case .squeak: DuckMark(width: size)
            case .agent:
                if let mark = AgentMark(agent: agent ?? author.name.lowercased(), size: size - 4) { mark } else { initials }
            case .person: initials
            }
        }
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }

    private var initials: some View {
        Text(verbatim: RoomPresentation.initials(RoomPresentation.authorName(author))).font(.system(size: 10, weight: .semibold))
            .foregroundStyle(Theme.ink).frame(width: size, height: size)
            .background(Theme.selectedStrong, in: Circle())
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
