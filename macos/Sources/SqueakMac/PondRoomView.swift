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
    /// A Member's view of someone else's pond: `projectId` is the pond's id and the host answers from what the Owner's Mac published.
    let member: Bool
    private(set) var feed = RoomFeed()
    /// Member's view: the sentence shown while the Owner's Mac is not running; nil while it is.
    private(set) var ownerOffline: String?
    /// Member's view: false when the Owner turned messaging off for this person.
    private(set) var canPost = true
    private(set) var phase: Phase = .loading
    private(set) var loadingOlder = false
    var filter = RoomFilter()
    static let pageSize = 50

    var draft: String {
        didSet { ContainerDrafts.shared.set(draft, for: ContainerDrafts.room(projectId)) }
    }
    var reply: RoomReply?
    private(set) var replyFocusToken = 0

    @ObservationIgnored private var running = false
    /// What the person is attaching to the next message; survives leaving the room and coming back.
    @ObservationIgnored let tray = RoomAttachmentTray()
    /// The attachments of a message still on its way, kept so Retry sends them again.
    @ObservationIgnored private var outgoing: [String: [OutgoingAttachment]] = [:]

    init(projectId: String, member: Bool = false) {
        self.projectId = projectId
        self.member = member
        self.draft = ContainerDrafts.shared.draft(for: ContainerDrafts.room(projectId))
    }

    func beginReply(_ reply: RoomReply) {
        draft = reply.insertingMention(in: draft, replacing: self.reply)
        self.reply = reply
        replyFocusToken += 1
    }

    private func client(_ host: NativeHostClient) -> RoomClient { RoomClient(host: host, member: member) }

    /// What a Member sees when the Owner's Mac does not name itself (a stream frame without a sentence).
    static let ownerAwayLine = "The Owner\u{2019}s Mac is offline; Ducks will pick this up when it\u{2019}s back"

    /// Reads the room, then follows its stream until the task is cancelled.
    func run(host: NativeHostClient) async {
        guard !running else { return }
        running = true
        defer { running = false }
        let client = client(host)
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
            case .task(let j): feed.upsert(job: j)
            case .thread(let t): feed.upsert(thread: t)
            case .owner(let line): ownerOffline = line.map { $0.isEmpty ? Self.ownerAwayLine : $0 }
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
            if member { ownerOffline = page.ownerOffline; canPost = page.canPost }
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
        if member { ownerOffline = page.ownerOffline; canPost = page.canPost }
    }

    func loadOlder(host: NativeHostClient) async {
        guard feed.hasMoreBefore, !loadingOlder, let before = feed.oldestSeq else { return }
        loadingOlder = true
        defer { loadingOlder = false }
        guard let page = try? await client(host).page(project: projectId, before: before, limit: Self.pageSize) else { return }
        var f = feed
        f.prepend(page: page, pageSize: Self.pageSize)
        feed = f
    }

    /// A message to the whole room (or to a person, whose name leads it).
    func send(_ text: String, attachments: [OutgoingAttachment] = [], host: NativeHostClient) async {
        let clean = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !clean.isEmpty || !attachments.isEmpty else { return }
        let level: RoomLevel = .room
        guard !member || attachments.isEmpty else { return }
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

    /// "Make task" on a person's message; a refusal shows inline under it.
    func makeJob(messageId: String, host: NativeHostClient) async {
        let key = "msg:" + messageId
        feed.clearJobLocal(key)
        if member {
            // Queued for the Owner's Mac: the Task shows when it has made it (waiting for approval unless this Member may start).
            do {
                let queued = try await client(host).queueTask(pond: projectId, messageId: messageId)
                feed.queueJob(key)
                if queued.offline { ownerOffline = queued.line ?? Self.ownerAwayLine }
            } catch { feed.failJob(key, message: RoomTasks.refusal(error)) }
            return
        }
        do { feed.upsert(job: try await RoomClient(host: host).makeJob(project: projectId, messageId: messageId)) }
        catch { feed.failJob(key, message: RoomTasks.refusal(error)) }
    }

    /// A comment on a duck's plan card: the host delivers it to that duck at its next turn; it also shows in the Room.
    func comment(cardId: String, text: String, host: NativeHostClient) async {
        if member {
            // Queued for the Owner's Mac like any Member message; the reply shows when it has applied it.
            if let queued = try? await client(host).queue(pond: projectId, text: text, replyTo: cardId), queued.offline {
                ownerOffline = queued.line ?? Self.ownerAwayLine
            }
            return
        }
        if let post = try? await RoomClient(host: host).comment(project: projectId, on: cardId, text: text) {
            _ = feed.receive(post)
        }
    }

    /// Go, Not now, Start a new duck, Allow, No: shown at once, reconciled by the job the host answers with.
    func act(jobId: String, _ action: RoomTaskAction, title: String? = nil, host: NativeHostClient) async {
        let place = feed.placeToSend(jobId: jobId, action: action)
        let include = feed.includeToSend(taskId: jobId, action: action)
        feed.beginJob(jobId, action: action, title: title)
        await perform(jobId, action, place: place, include: include, host: host)
    }

    /// A Room message in or out of a Task's discussion: nothing is sent until Go, Allow or Start.
    func setIncluded(taskId: String, messageId: String, _ included: Bool) { feed.setIncluded(messageId, included, task: taskId) }

    /// "Change" on a Task's place: nothing is sent until Go, Allow or Start.
    func choosePlace(jobId: String, _ place: RoomTaskPlace) { feed.setJobPlace(jobId, place) }

    private func perform(_ id: String, _ action: RoomTaskAction, place: RoomTaskPlace?, include: [String]? = nil, host: NativeHostClient) async {
        do { feed.upsert(job: try await RoomClient(host: host).act(project: projectId, jobId: id, action: action, place: place, include: include)) }
        catch { feed.failJob(id, message: RoomTasks.refusal(error)) }
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
        } catch { return RoomTasks.refusal(error) }
    }

    /// Put a duck on or off duty (`POST .../duty`): shown at once, put back if the host refuses.
    func setDuty(sessionId: String, on: Bool, host: NativeHostClient) async {
        let before = feed.threads.first { $0.sessionId == sessionId }
        if var t = before, t.onDuty != on { t.duty = on ? .on : .off; feed.upsert(thread: t) }
        do { try await RoomClient(host: host).setDuty(sessionId: sessionId, on: on) }
        catch { if let before { feed.upsert(thread: before) } }
    }

    private func deliver(pendingId: String, text: String, level: RoomLevel, host: NativeHostClient) async {
        if member {
            // Queued for the Owner's Mac: the row stays pending until its post comes back through the stream (the feed matches it
            // by text), so a message sent while that Mac is away keeps reading as waiting.
            do {
                let queued = try await client(host).queue(pond: projectId, text: text)
                if queued.offline { ownerOffline = queued.line ?? Self.ownerAwayLine }
            } catch { feed.markFailed(pendingId: pendingId) }
            return
        }
        do {
            let post = try await client(host).send(project: projectId, text: text, level: level, attachments: outgoing[pendingId] ?? [])
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
    func model(for projectId: String, member: Bool = false) -> PondRoomModel {
        if let m = models[projectId] { return m }
        let m = PondRoomModel(projectId: projectId, member: member)
        models[projectId] = m
        return m
    }
}

// MARK: - View

/// The pond's room (draft A): header, one conversation, the ducks working, composer. The right zone holds the roster
/// (`RoomRightColumn`).
struct PondRoomView: View {
    let projectId: String
    /// A Member's view of the Owner's Room (the id is the pond's): read and post, nothing else.
    var member = false
    /// The pond's directory key.
    var key: String?
    /// Room for the sidebar toggle when the sidebar is closed.
    var leadingInset: CGFloat = 0
    /// False when the pond's one shared header is drawn above both pages (new layout): the page is then content only.
    var showsHeader = true

    @Environment(AppModel.self) private var model
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var atBottom = true
    @State private var unseen = 0
    @State private var ledger = RoomFadeLedger()
    @State private var openNote: String?

    private var room: PondRoomModel { PondRoomStore.shared.model(for: projectId, member: member) }

    /// Why a Member cannot post (the Owner turned messaging off, or the role only watches); nil when they can.
    private var postBlock: String? {
        guard member else { return nil }
        if case .disabled(let reason) = key.map({ PondsModel.shared.chrome(key: $0).composer }) ?? .full { return reason }
        return room.canPost ? nil : "The owner has turned off messaging for you in this pond."
    }

    var body: some View {
        let room = room
        let streams = RoomPlaces.streams(model.git.workspaces, projectId: projectId)
        let taken = model.git.workspaces.filter { $0.projectId == projectId }.map(\.branch)
            + (model.native.projects.first { $0.id == projectId }.map { [$0.defaultBranch] } ?? [])
        VStack(spacing: 0) {
            if showsHeader, let key { RoomHeader(key: key, ducks: RoomDucks.headerDucks(room.feed.threads), open: openThread, leadingInset: leadingInset) }
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
        .environment(\.roomPlaceContext, RoomPlaceContext(streams: streams, taken: taken, choose: { id, p in room.choosePlace(jobId: id, p) }, include: { id, m, on in room.setIncluded(taskId: id, messageId: m, on) }))
    }

    @ViewBuilder private func content(_ room: PondRoomModel) -> some View {
        switch room.phase {
        case .unavailable:
            Text("Update Squeak's host to use the room.").font(.system(size: 14)).foregroundStyle(Theme.muted)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        case .loading, .failed:
            Color.clear.frame(maxWidth: .infinity, maxHeight: .infinity)
        case .ready:
            let selfId = member ? key.flatMap { PondsModel.shared.detail(key: $0)?.me?.id } : nil
            let items = RoomFold.fold(RoomMessages.build(feed: room.feed, owner: NSFullUserName(), filesFor: { model.changesStore(for: $0).changes?.files.count }, memberView: member, selfId: selfId, canMakeMemberTask: room.canPost))
            let working = RoomMessages.working(feed: room.feed)
            VStack(spacing: 0) {
                conversation(room, items, working)
                    .environment(\.roomLatestTaskable, MakeTaskAffordance.latestPostId(in: items))
                if let key, !member { GitHubLineView(key: key, room: room) }
                if let line = room.ownerOffline {
                    // Said once, quietly, above the composer: nothing is lost, the Owner's Mac will pick it up.
                    column { Text(verbatim: line).font(.system(size: 12)).foregroundStyle(Theme.muted).frame(maxWidth: .infinity, alignment: .leading) }
                        .padding(.top, Space.s).accessibilityAddTraits(.isStaticText).accessibilityLabel(line)
                }
                column {
                    if let block = postBlock {
                        Text(verbatim: block).font(.system(size: 13)).foregroundStyle(Theme.muted).frame(maxWidth: .infinity, alignment: .leading)
                            .padding(14).background(Theme.surface, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                    } else {
                        RoomComposer(room: room, pondName: key.map { PondsModel.shared.name(key: $0) } ?? "the pond", send: sendTo)
                    }
                }
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
        let reply: ((RoomReply) -> Void)?
        if MacLayoutPreference.shared.isNew && postBlock == nil {
            reply = { excerpt in room.beginReply(excerpt) }
        } else {
            reply = nil
        }
        return ScrollViewReader { proxy in
            ScrollView {
                // Eager, not lazy: every row of the newest window is laid out at once, so the bottom anchor is exact from the
                // first layout and the slide's picture of the Room shows real rows while the page is off screen.
                VStack(alignment: .leading, spacing: RoomBubblePlan.betweenGroups) {
                    if items.isEmpty && working.isEmpty {
                        Text(verbatim: FirstPondJourney.emptyRoom)
                            .font(.system(size: 13)).foregroundStyle(Theme.muted).frame(maxWidth: .infinity).padding(.vertical, Space.xl)
                    }
                    ForEach(items) { item in
                        RoomItemView(
                            item: item, ducks: room.feed.threads, ledger: ledger, open: openThread, openTarget: openTarget, answer: answer,
                            retry: { id in Task { await room.retry(id, host: model.nativeHost) } },
                            makeJob: { id in Task { await room.makeJob(messageId: id, host: model.nativeHost) } },
                            reply: reply,
                            act: { jobId, a, title in Task { await room.act(jobId: jobId, a, title: title, host: model.nativeHost) } },
                            comment: { card, text in Task { await room.comment(cardId: card, text: text, host: model.nativeHost) } })
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
                .environment(\.roomMemberView, member)
                .environment(\.roomPondId, key.flatMap { PondsModel.shared.pond(key: $0)?.id })
                .environment(\.roomOpenCanvas, { card in
                    if let key { model.openCanvas(pond: key, path: card.openPath(memberView: member)) }
                })
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
            Task { _ = await model.send(words, to: s.key, fromRoom: true) }
            if room.feed.threads.first(where: { $0.sessionId == id })?.onDuty == false {
                Task { await room.setDuty(sessionId: id, on: true, host: model.nativeHost) }
            }
        case .everyone, .person:
            // A Member's message is words only for now: pictures and files stay on the Mac they were attached on.
            if member, !items.isEmpty { return "Pictures and files aren\u{2019}t shared with the Owner\u{2019}s Mac yet." }
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
