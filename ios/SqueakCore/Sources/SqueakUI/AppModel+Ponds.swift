#if os(iOS)
import Foundation
import SqueakCore

/// The Ponds tab's data: the Mac's ponds with this phone's pending changes laid over them.
extension AppModel {
    /// Ponds and "Other" with hide/unhide applied.
    var pondBuilt: PondList.Built {
        var built = homeLists.built
        if !pondsLeft.isEmpty { built = PondList.Built(ponds: built.ponds.filter { !pondsLeft.contains($0.id) }, other: built.other) }
        let local = pondHiddenLocal
        guard !local.isEmpty else { return built }
        func apply(_ item: PondItem) -> PondItem {
            guard let hidden = local[item.id], hidden != item.meta.hidden else { return item }
            var meta = item.meta
            meta.hidden = hidden
            return PondItem(id: item.id, name: item.name, pond: item.pond, sessions: item.sessions, meta: meta)
        }
        return PondList.Built(ponds: built.ponds.map(apply), other: built.other)
    }

    /// A pond by its id, exactly.
    func pondItem(_ id: String) -> PondItem? { pondBuilt.item(id) }

    var pondOrderMode: PondOrderMode { pondOrderLocal ?? phoneOrderMode }

    func setPondHidden(_ id: String, _ hidden: Bool) {
        pondHiddenLocal[id] = hidden
        sendPondHidden(id, hidden)
    }

    /// Whether this pond is someone else's, with no code in it (the Mac says so; an older Mac says nothing, so never).
    func isRemotePond(_ id: String?) -> Bool {
        guard let id else { return false }
        return pondItem(id)?.pond?.isRemote == true
    }

    /// Whether a chat may show changes: its pond is not remote, and the Mac allows it.
    /// Ducks own their branch: the Mac says so, and only then does the phone show ducks by branch.
    var ducksMode: Bool { DuckPhone.enabled(snapshot) }

    /// A pond's ducks as rows: the phone's own chats of the pond, plus the pond's whole list when the Mac sent it. A remote
    /// pond shows no branch labels (no code there).
    func duckRows(_ item: PondItem) -> [DuckPhone.Row] {
        var sessions = item.sessions
        let have = Set(sessions.map(\.key))
        if let doc = pondThreads(item.id) { sessions += doc.threads.filter { !have.contains($0.key) }.map(\.asSession) }
        return DuckPhone.rows(sessions, showsCode: !item.remote)
    }

    /// Moves a duck to a place (the duck's menu: Branch off, Work with…, Move to main). The Mac starts the duck's chat there;
    /// the list follows on the next view. A refusal says why.
    func moveDuck(_ session: PhoneSnapshot.Session, to place: DuckPlace, message: String? = nil) {
        duckMoveProblem = nil
        guard let duckId = session.duckId, !ducksMoving.contains(duckId) else { return }
        guard !demo, let channel else { duckMoveProblem = "Not connected to your Mac."; return }
        ducksMoving.insert(duckId)
        Task {
            let result = try? await channel.sendPond(.duckPlace(duckId: duckId, place: place, message: message), signer: signer)
            ducksMoving.remove(duckId)
            if result?.sent == true {
                Haptics.play(.confirmed)
                await refresh()
            } else {
                Haptics.play(.refused)
                duckMoveProblem = result?.reason ?? "Your Mac didn't answer in time."
            }
        }
    }

    /// What a duck's menu offers (Branch off, Work with…, Move to main), from its pond's ducks. Nothing when the flag is off.
    func duckMoves(for session: PhoneSnapshot.Session) -> DuckPhone.Moves {
        guard ducksMode, let id = session.pond?.id, let item = pondItem(id) else { return .none }
        return DuckPhone.moves(for: session, among: duckRows(item), remote: item.remote)
    }

    /// The header for a duck's chat (branch chip, read-only, PR), or nil with the flag off or for a chat with no duck.
    func duckHeader(for session: PhoneSnapshot.Session) -> DuckPhone.Header? {
        guard ducksMode, session.duckId != nil else { return nil }
        return DuckPhone.header(session, remote: isRemotePond(session.pond?.id))
    }

    func canDiff(_ session: PhoneSnapshot.Session) -> Bool {
        session.can(.diff) && !isRemotePond(session.pond?.id)
    }

    /// Leaves a pond someone else owns. It leaves the list at once; the Mac forgets it and tells the owner, and the
    /// phone's other devices of this account follow when the owner's Mac has removed the account.
    func leavePond(_ id: String) {
        pondLeaveProblem = nil
        guard !demo, let channel else { pondLeaveProblem = "Not connected to your Mac."; return }
        pondsLeft.insert(id)
        Task {
            let result = try? await channel.sendPond(.leave(pondId: id), signer: signer)
            if result?.sent == true {
                await refresh()
                pondsLeft.remove(id)
            } else {
                pondsLeft.remove(id)
                pondLeaveProblem = result?.reason ?? "Your Mac didn't answer in time."
            }
        }
    }

    func setPondOrder(_ mode: PondOrderMode) {
        pondOrderLocal = mode
        sendPondOrder(mode)
    }
}

/// The phone channel's `pond` command and the Mac's `ponds2` fields.
extension AppModel {
    /// The Mac's own order (`pondOrder`), when it sent one.
    var phoneOrderMode: PondOrderMode {
        guard let order = snapshot?.pondOrder, order.isManual else { return .newest }
        return .manual(order.ids)
    }

    /// The open pond's id for presence.
    var presencePond: String? { openPondId }

    func openPond(_ id: String?, if current: String? = nil) {
        if let current, openPondId != current { return }
        guard openPondId != id else { return }
        openPondId = id
        watchPondThreads(id)
        guard !demo, let channel else { return }
        let watching = presenceWatching, recent = recentAsk, calls = callsOpen, pond = presencePond
        Task { try? await channel.touchPresence(watching: watching, recent: recent, calls: calls, pond: pond, flock: presenceFlock, room: presenceRoom); await refresh() }
    }

    /// The open pond's whole thread list: the Mac writes it only while this pond is open here, so ask on open and read it
    /// as it changes (every few seconds; sooner while it has not come). An older Mac never writes one, and the page
    /// keeps today's list after a few tries.
    func watchPondThreads(_ id: String?) {
        pondThreadsTask?.cancel()
        pondThreadsTask = nil
        guard let id, !demo, let channel else { pondThreadsLoading = false; return }
        perf.begin(.openPond, id)
        if pondThreadsByPond[id] == nil, let held = pondThreadsStore?.load(id) { pondThreadsByPond[id] = held }
        pondThreadsLoading = pondThreadsByPond[id] == nil
        if !pondThreadsLoading { perf.end(.openPond, id, cached: true) }
        pondThreadsTask = Task { @MainActor [weak self] in
            var misses = 0
            while !Task.isCancelled {
                if let doc = try? await channel.pondThreads(pondId: id), !Task.isCancelled {
                    if self?.pondThreadsByPond[id] != doc { self?.pondThreadsByPond[id] = doc }
                    self?.pondThreadsStore?.record(doc, for: id)
                    self?.perf.end(.openPond, id)
                    self?.pondThreadsLoading = false
                    misses = 0
                } else {
                    misses += 1
                    if misses >= 5 { self?.pondThreadsLoading = false }
                }
                let wait: UInt64 = self?.pondThreadsByPond[id] == nil ? 2_000_000_000 : 5_000_000_000
                try? await Task.sleep(nanoseconds: wait)
            }
        }
    }

    /// The whole list of a pond, when the Mac has sent one.
    func pondThreads(_ id: String) -> PondThreads? { pondThreadsByPond[id] }

    /// A bare session for an older thread that only the pond's list carries, so it opens like a Recent chat.
    func pondThreadSession(_ key: String) -> PhoneSnapshot.Session? {
        for doc in pondThreadsByPond.values {
            if let thread = doc.threads.first(where: { $0.key == key }) { return thread.asSession }
        }
        return nil
    }

    func pondDetail(_ id: String) -> PondDetailInfo? {
        guard let detail = snapshot?.pondDetail, detail.id == id else { return nil }
        return PondDetailInfo(
            invites: (detail.invites ?? []).map { .init(label: $0.label, expiresAt: $0.expiresAt) },
            waiting: (detail.waiting ?? []).map(\.name),
            ripples: (detail.ripples ?? []).map { .init(text: $0.text, at: $0.at, who: $0.who) })
    }

    /// The member's thread open on screen, for presence: the Mac then publishes its rows.
    var presenceFlock: String? { openFlockId }

    /// Opens (or, with nil, leaves) a pond member's thread: presence names it so the Mac writes its rows, which are read
    /// while it stays open (sooner while the first has not come). An older Mac never writes one; the page then says so.
    func openFlock(_ id: String?) {
        guard openFlockId != id else { return }
        openFlockId = id
        flockTask?.cancel()
        flockTask = nil
        guard !demo, let channel else { return }
        let watching = presenceWatching, recent = recentAsk, calls = callsOpen, pond = presencePond
        Task { try? await channel.touchPresence(watching: watching, recent: recent, calls: calls, pond: pond, flock: id, room: presenceRoom) }
        guard let id else { return }
        flockLoaded = flockDocs[id] != nil
        flockTask = Task { @MainActor [weak self] in
            var misses = 0
            while !Task.isCancelled {
                if let doc = try? await channel.flockThread(id), !Task.isCancelled {
                    if self?.flockDocs[id] != doc { self?.flockDocs[id] = doc }
                    self?.flockLoaded = true
                    misses = 0
                } else {
                    misses += 1
                    if misses >= 8 { self?.flockLoaded = true }
                }
                let wait: UInt64 = self?.flockDocs[id] == nil ? 1_500_000_000 : 2_500_000_000
                try? await Task.sleep(nanoseconds: wait)
            }
        }
    }

    func flockDoc(_ id: String) -> FlockThreadDoc? { flockDocs[id] }

    /// Sends a message into a member's thread through the pond. Returns nil when the Mac took it, else the reason.
    func sendFlockMessage(pondId: String, threadId: String, text: String) async -> String? {
        if demo { return "Not available in the demo." }
        guard let channel else { return "Not connected to your Mac." }
        let result = try? await channel.sendPond(.message(pondId: pondId, threadId: threadId, text: text), signer: signer)
        guard let result else { return "Your Mac didn't answer in time." }
        return result.sent ? nil : (result.reason ?? "The Mac didn't take that message.")
    }

    /// The pond whose Room is open on screen, for presence: the Mac then publishes its rows.
    var presenceRoom: String? { openRoomId }

    /// Opens (or, with nil, leaves) a pond's Room: presence names it so the Mac writes the Room, which is read while it
    /// stays open (sooner while the first has not come). An older Mac never writes one; the page then says so.
    func openRoom(_ id: String?) {
        guard openRoomId != id else { return }
        openRoomId = id
        roomTask?.cancel()
        roomTask = nil
        guard !demo, let channel else { return }
        let watching = presenceWatching, recent = recentAsk, calls = callsOpen, pond = presencePond, flock = presenceFlock
        Task { try? await channel.touchPresence(watching: watching, recent: recent, calls: calls, pond: pond, flock: flock, room: id) }
        guard let id else { return }
        roomLoaded = roomDocs[id] != nil
        roomTask = Task { @MainActor [weak self] in
            var misses = 0
            while !Task.isCancelled {
                if let doc = try? await channel.pondRoom(pondId: id), !Task.isCancelled {
                    if self?.roomDocs[id] != doc { self?.roomDocs[id] = doc }
                    self?.roomLoaded = true
                    misses = 0
                } else {
                    misses += 1
                    if misses >= 8 { self?.roomLoaded = true }
                }
                let wait: UInt64 = self?.roomDocs[id] == nil ? 1_500_000_000 : 2_000_000_000
                try? await Task.sleep(nanoseconds: wait)
            }
        }
    }

    func roomDoc(_ id: String) -> PondRoomDoc? { roomDocs[id] }

    /// What this person sent that the Room has not shown back, newest last.
    func roomSent(_ id: String) -> [PondRoomPending] { PondRoomFeed.remaining(roomPending[id] ?? [], in: roomDocs[id]) }

    /// Posts a message into the Room. It shows at once as sent and stays until the Room shows it back; a refusal marks it
    /// failed with the Mac's sentence. Returns the pending id, or nil for an empty message.
    @discardableResult
    func postToRoom(pondId: String, text: String) -> String? {
        let text = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return nil }
        roomCounter += 1
        let id = "local-\(roomCounter)"
        roomPending[pondId, default: []].append(PondRoomPending(id: id, text: text, at: Int64(Date().timeIntervalSince1970 * 1000)))
        sendRoomPost(pondId: pondId, id: id, text: text)
        return id
    }

    func retryRoomPost(pondId: String, id: String) {
        guard let i = roomPending[pondId]?.firstIndex(where: { $0.id == id }), let text = roomPending[pondId]?[i].text else { return }
        roomPending[pondId]?[i].failed = nil
        sendRoomPost(pondId: pondId, id: id, text: text)
    }

    func dismissRoomPost(pondId: String, id: String) { roomPending[pondId]?.removeAll { $0.id == id } }

    private func sendRoomPost(pondId: String, id: String, text: String) {
        func fail(_ reason: String) {
            if let i = roomPending[pondId]?.firstIndex(where: { $0.id == id }) { roomPending[pondId]?[i].failed = reason }
            Haptics.play(.refused)
        }
        if demo { fail("Not available in the demo."); return }
        guard let channel else { fail("Not connected to your Mac."); return }
        Task {
            let result = try? await channel.sendPond(.roomPost(pondId: pondId, text: text), signer: signer)
            guard let result else { fail("Your Mac didn't answer in time."); return }
            if result.sent { Haptics.play(.confirmed) } else { fail(result.reason ?? "The Mac didn't take that message.") }
        }
    }

    /// Make task on a Room message, or Drop on a Task. Returns nil when the Mac took it, else its sentence.
    func roomAction(pondId: String, _ change: Channel.PondChange) async -> String? {
        if demo { return "Not available in the demo." }
        guard let channel else { return "Not connected to your Mac." }
        let result = try? await channel.sendPond(change, signer: signer)
        guard let result else { return "Your Mac didn't answer in time." }
        Haptics.play(result.sent ? .confirmed : .refused)
        return result.sent ? nil : (result.reason ?? "The Mac didn't take that.")
    }

    func sendPondHidden(_ id: String, _ hidden: Bool) {
        sendPond(.hide(pondId: id, hidden: hidden)) { [weak self] ok in if ok { self?.pondHiddenLocal[id] = nil } }
    }

    func sendPondOrder(_ mode: PondOrderMode) {
        switch mode {
        case .newest: sendPond(.orderNewest) { [weak self] ok in if ok { self?.pondOrderLocal = nil } }
        case .manual(let ids):
            sendPond(.orderManual(ids: ids)) { [weak self] ok in if ok { self?.pondOrderLocal = nil } }
        }
    }

    private func sendPond(_ change: Channel.PondChange, done: @escaping @MainActor (Bool) -> Void) {
        if demo { return }
        guard let channel else { return }
        Task {
            let result = try? await channel.sendPond(change, signer: signer)
            let ok = result?.sent == true
            if ok { await refresh() }
            done(ok)
        }
    }
}

#endif

/// What the Mac sends about the pond whose dashboard is open.
struct PondDetailInfo: Equatable {
    struct Invite: Equatable { let label: String; let expiresAt: String? }
    struct Ripple: Equatable, Identifiable { var id: String { "\(at)-\(text)" }; let text: String; let at: String; let who: String? }
    var invites: [Invite] = []
    var waiting: [String] = []
    var ripples: [Ripple] = []
}
