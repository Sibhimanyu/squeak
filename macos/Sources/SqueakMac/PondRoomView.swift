import AppKit
import SqueakIcons
import SqueakMacCore
import SwiftUI

// The pond room (DESIGN.md §8.10, the centre): a group chat with the pond's ducks (people and ducks in one conversation,
// oldest to newest; the ducks working at the bottom; a composer that posts to the room or to one duck).

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
    /// What the person is attaching to the next message; survives leaving the room and coming back.
    @ObservationIgnored let tray = RoomAttachmentTray()
    /// The attachments of a message still on its way, kept so Retry sends them again.
    @ObservationIgnored private var outgoing: [String: [OutgoingAttachment]] = [:]

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
            case .job(let j): feed.upsert(job: j)
            case .thread(let t): feed.upsert(thread: t)
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
    func send(_ text: String, attachments: [OutgoingAttachment] = [], host: NativeHostClient) async {
        let clean = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !clean.isEmpty || !attachments.isEmpty else { return }
        let level: RoomLevel = .room
        let id = feed.addPending(
            text: clean, level: level, author: RoomAuthor(kind: .person, name: "You"), at: Int64(Date().timeIntervalSince1970 * 1000),
            attachments: attachments.map(\.placeholder))
        if !attachments.isEmpty { outgoing[id] = attachments }
        await deliver(pendingId: id, text: clean, level: level, host: host)
    }

    func retry(_ id: String, host: NativeHostClient) async {
        guard let row = feed.pendingRow(id), row.failed else { return }
        feed.retry(pendingId: id)
        await deliver(pendingId: id, text: row.post.text, level: row.post.level, host: host)
    }

    /// "Make this a job" on a person's message; a refusal shows inline under it.
    func makeJob(messageId: String, host: NativeHostClient) async {
        let key = "msg:" + messageId
        feed.clearJobLocal(key)
        do { feed.upsert(job: try await RoomClient(host: host).makeJob(project: projectId, messageId: messageId)) }
        catch { feed.failJob(key, message: RoomJobs.refusal(error)) }
    }

    /// Go, Not now, Start a new duck, Allow, No: shown at once, reconciled by the job the host answers with.
    func act(jobId: String, _ action: RoomJobAction, title: String? = nil, host: NativeHostClient) async {
        let place = feed.placeToSend(jobId: jobId, action: action)
        feed.beginJob(jobId, action: action, title: title)
        await perform(jobId, action, place: place, host: host)
    }

    /// "Change" on a job's place: nothing is sent until Go, Allow or Start.
    func choosePlace(jobId: String, _ place: RoomJobPlace) { feed.setJobPlace(jobId, place) }

    private func perform(_ id: String, _ action: RoomJobAction, place: RoomJobPlace?, host: NativeHostClient) async {
        do { feed.upsert(job: try await RoomClient(host: host).act(project: projectId, jobId: id, action: action, place: place)) }
        catch { feed.failJob(id, message: RoomJobs.refusal(error)) }
    }

    // MARK: Ducks

    /// Rename a duck or set its role (`PATCH .../duck`); the host's answer is what shows. Returns a refusal sentence.
    @discardableResult
    func edit(sessionId: String, name: RoomDuckField = .unchanged, role: RoomDuckField = .unchanged, host: NativeHostClient) async -> String? {
        do {
            let r = try await RoomClient(host: host).patchDuck(sessionId: sessionId, name: name, role: role)
            if var t = feed.threads.first(where: { $0.sessionId == sessionId }) {
                if name != .unchanged { t.name = r.name }
                if role != .unchanged { t.role = r.role }
                feed.upsert(thread: t)
            }
            return nil
        } catch { return RoomJobs.refusal(error) }
    }

    /// Put a duck on or off duty (`POST .../duty`): shown at once, put back if the host refuses.
    func setDuty(sessionId: String, on: Bool, host: NativeHostClient) async {
        let before = feed.threads.first { $0.sessionId == sessionId }
        if var t = before, t.onDuty != on { t.duty = on ? .on : .off; feed.upsert(thread: t) }
        do { try await RoomClient(host: host).setDuty(sessionId: sessionId, on: on) }
        catch { if let before { feed.upsert(thread: before) } }
    }

    private func deliver(pendingId: String, text: String, level: RoomLevel, host: NativeHostClient) async {
        do {
            let post = try await RoomClient(host: host).send(project: projectId, text: text, level: level, attachments: outgoing[pendingId] ?? [])
            outgoing[pendingId] = nil
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

/// The pond's room (draft A): header, one conversation, the ducks working, composer. The right zone holds the roster
/// (`RoomRightColumn`).
struct PondRoomView: View {
    let projectId: String
    /// The pond's directory key.
    var key: String?
    /// Room for the sidebar toggle when the sidebar is closed.
    var leadingInset: CGFloat = 0
    /// Room for the sidebar toggle when the sidebar is closed.

    @Environment(AppModel.self) private var model
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var atBottom = true
    @State private var unseen = 0
    @State private var ledger = RoomFadeLedger()
    @State private var openNote: String?

    private var room: PondRoomModel { PondRoomStore.shared.model(for: projectId) }

    var body: some View {
        let room = room
        let streams = RoomPlaces.streams(model.git.workspaces, projectId: projectId)
        let taken = model.git.workspaces.filter { $0.projectId == projectId }.map(\.branch)
            + (model.native.projects.first { $0.id == projectId }.map { [$0.defaultBranch] } ?? [])
        VStack(spacing: 0) {
            if let key { RoomHeader(key: key, ducks: RoomDucks.roster(room.feed.threads), open: openThread, leadingInset: leadingInset) }
            content(room)
        }
        .overlay(alignment: .top) {
            if let openNote {
                Text(verbatim: openNote).font(.system(size: 12)).foregroundStyle(Theme.ink)
                    .padding(.horizontal, 12).padding(.vertical, 6).background(Theme.surface, in: Capsule())
                    .padding(.top, Metrics.header + 8).transition(.opacity).accessibilityAddTraits(.isStaticText)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Theme.bg)
        // Files dropped anywhere in the room are attached to the next message.
        .dropDestination(for: URL.self) { urls, _ in room.tray.add(urls); return !urls.isEmpty }
        .task(id: projectId) { await room.run(host: model.nativeHost) }
        .environment(\.roomPlaceContext, RoomPlaceContext(streams: streams, taken: taken, choose: { id, p in room.choosePlace(jobId: id, p) }))
    }

    @ViewBuilder private func content(_ room: PondRoomModel) -> some View {
        switch room.phase {
        case .unavailable:
            Text("Update Squeak's host to use the room.").font(.system(size: 14)).foregroundStyle(Theme.muted)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        case .loading, .failed:
            Color.clear.frame(maxWidth: .infinity, maxHeight: .infinity)
        case .ready:
            let items = RoomMessages.build(feed: room.feed, owner: NSFullUserName(), filesFor: { model.changesStore(for: $0).changes?.files.count })
            let working = RoomMessages.working(feed: room.feed)
            VStack(spacing: 0) {
                conversation(room, items, working)
                column { RoomComposer(room: room, pondName: key.map { PondsModel.shared.name(key: $0) } ?? "the pond", send: sendTo) }
                    .padding(.bottom, Space.l).padding(.top, Space.s)
            }
        }
    }

    /// The centred reading column (740 at most).
    private func column<C: View>(@ViewBuilder _ c: () -> C) -> some View {
        c().padding(.horizontal, Metrics.readingInset).frame(maxWidth: 740 + 2 * Metrics.readingInset).frame(maxWidth: .infinity)
    }

    private func conversation(_ room: PondRoomModel, _ items: [RoomItem], _ working: [RoomWorkingLine]) -> some View {
        let count = items.count + working.count + items.reduce(0) { n, i in if case .group(let g) = i { n + g.messages.count } else { n } }
        return ScrollViewReader { proxy in
            ScrollView {
                // Eager, not lazy: every row of the newest window is laid out at once, so the bottom anchor is exact from the
                // first layout and the slide's picture of the Room shows real rows while the page is off screen.
                VStack(alignment: .leading, spacing: 12) {
                    if items.isEmpty && working.isEmpty {
                        Text("Say something to the room, or start a duck. What the ducks do shows up here.")
                            .font(.system(size: 13)).foregroundStyle(Theme.muted).frame(maxWidth: .infinity).padding(.vertical, Space.xl)
                    }
                    ForEach(items) { item in
                        RoomItemView(
                            item: item, ducks: room.feed.threads, ledger: ledger, open: openThread, openTarget: openTarget, answer: answer,
                            retry: { id in Task { await room.retry(id, host: model.nativeHost) } },
                            makeJob: { id in Task { await room.makeJob(messageId: id, host: model.nativeHost) } },
                            act: { jobId, a, title in Task { await room.act(jobId: jobId, a, title: title, host: model.nativeHost) } })
                    }
                    if !working.isEmpty {
                        VStack(alignment: .leading, spacing: 10) {
                            ForEach(working) { RoomWorkingRow(line: $0, open: openThread) }
                        }
                        .padding(.top, 2)
                    }
                    Color.clear.frame(height: 1).id("room-bottom")
                        .onAppear { atBottom = true; unseen = 0 }
                        .onDisappear { atBottom = false }
                }
                .padding(.horizontal, Metrics.readingInset).padding(.vertical, Space.m)
                .frame(maxWidth: 740 + 2 * Metrics.readingInset).frame(maxWidth: .infinity)
                .background(ScrollMemory(
                    id: "pond:\(key ?? projectId):room", fromBottom: true,
                    onNearTop: room.feed.hasMoreBefore ? { Task { await room.loadOlder(host: model.nativeHost) } } : nil))
            }
            .defaultScrollAnchor(.bottom)
            .scrollIndicators(.hidden)   // no scroll bar riding along in the Dashboard/Room slide
            .onAppear { ledger.freeze(items.map(\.id)) }
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

    private func session(_ id: String) -> HostSession? { model.pondDuckSession(id) }

    /// Opens the duck's tab; an off-duty duck goes back on duty. Closing the tab comes back to the room.
    private func openThread(_ sessionId: String) { openTarget(.duck(sessionId)) }

    /// A duck's tab, or its tab with its ducklings' tabs (`PondClick` decides which). When no chat is known for the duck
    /// a small note says so instead of nothing happening.
    private func openTarget(_ target: PondOpenTarget) {
        let threads = room.feed.threads
        let plan = PondOpenResolver.plan(target, known: model.allSessions.filter { $0.source == .squeak }.map { NativeAdapter.nativeId($0) ?? $0.key.hostSessionId },
                                         onDuty: { id in threads.first { $0.sessionId == id }?.onDuty })
        guard plan.sessionId != nil, model.openFromPond(target, pond: key, page: .room) else {
            let name = threads.first { $0.sessionId == target.duck }?.title
            openNote = PondOpenResolver.failureNote(name: name)
            Task { try? await Task.sleep(for: .seconds(4)); openNote = nil }
            return
        }
        openNote = nil
        if plan.putOnDuty, let id = plan.sessionId {
            Task { await room.setDuty(sessionId: id, on: true, host: model.nativeHost) }
        }
    }

    /// An answer to a needs-you card goes through the chat's own send path, marked as an answer (a letter is just the letter).
    private func answer(_ sessionId: String, _ text: String) {
        guard let s = session(sessionId) else { return }
        Task { _ = await model.send(text, to: s.key, answering: true) }
    }

    /// A sentence when the attachments could not be prepared (nothing was sent), else nil.
    private func sendTo(_ to: RoomAddressee, _ text: String, _ items: [OutgoingAttachment]) -> String? {
        atBottom = true
        switch to {
        case .thread(let id, _):
            guard let s = session(id) else { return nil }
            var words = text
            if !items.isEmpty {
                guard let folder = s.cwd, !folder.isEmpty else { return ImageAttachmentError.folderMissing.errorDescription }
                // A duck's own chat takes pictures and files the way its composer does: saved in its folder, named in the text.
                do {
                    let pictures = items.filter { $0.kind == .image }.map { PreparedImage(data: $0.data, ext: ImageAttachments.kind(of: $0.data) ?? "png") }
                    let imageRefs = try ImageAttachments.save(pictures, into: folder)
                    let fileRefs = try RoomAttachmentFiles.save(items.filter { $0.kind == .file }.map { ($0.name, $0.data) }, into: folder)
                    words = RoomAttachmentFiles.compose(text, imageRefs: imageRefs, fileRefs: fileRefs)
                } catch { return (error as? ImageAttachmentError)?.errorDescription ?? "Squeak couldn't save the attachments." }
            }
            Task { _ = await model.send(words, to: s.key) }
            if room.feed.threads.first(where: { $0.sessionId == id })?.onDuty == false {
                Task { await room.setDuty(sessionId: id, on: true, host: model.nativeHost) }
            }
        case .everyone, .person:
            Task { await room.send(RoomMention.roomText(text, to: to), attachments: items, host: model.nativeHost) }
        }
        return nil
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
