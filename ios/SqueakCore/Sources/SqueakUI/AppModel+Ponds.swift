#if os(iOS)
import Foundation
import SqueakCore

/// The Ponds tab's data: the Mac's ponds with this phone's pending changes laid over them.
extension AppModel {
    /// Ponds and "Other" with hide/unhide applied.
    var pondBuilt: PondList.Built {
        let built = homeLists.built
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
        Task { try? await channel.touchPresence(watching: watching, recent: recent, calls: calls, pond: pond); await refresh() }
    }

    /// The open pond's whole thread list: the Mac writes it only while this pond is open here, so ask on open and read it
    /// as it changes (every few seconds; sooner while it has not come). An older Mac never writes one, and the page
    /// keeps today's list after a few tries.
    func watchPondThreads(_ id: String?) {
        pondThreadsTask?.cancel()
        pondThreadsTask = nil
        guard let id, !demo, let channel else { pondThreadsLoading = false; return }
        pondThreadsLoading = pondThreadsByPond[id] == nil
        pondThreadsTask = Task { @MainActor [weak self] in
            var misses = 0
            while !Task.isCancelled {
                if let doc = try? await channel.pondThreads(pondId: id), !Task.isCancelled {
                    if self?.pondThreadsByPond[id] != doc { self?.pondThreadsByPond[id] = doc }
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
