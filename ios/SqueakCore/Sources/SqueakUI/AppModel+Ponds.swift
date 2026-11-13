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
        return PondList.Built(ponds: built.ponds.map(apply), other: built.other.map(apply))
    }

    /// A pond by its id; a stand-in pond ("name:repo"), or a name, also finds it.
    func pondItem(_ id: String) -> PondItem? {
        let built = pondBuilt
        return built.item(id) ?? built.item(PondList.namePrefix + id) ?? (built.ponds + built.other).first { $0.name == id }
    }

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

    /// The open pond's id for presence (a stand-in pond has none on the Mac).
    var presencePond: String? {
        guard let id = openPondId, !id.hasPrefix(PondList.namePrefix) else { return nil }
        return id
    }

    func openPond(_ id: String?, if current: String? = nil) {
        if let current, openPondId != current { return }
        guard openPondId != id else { return }
        openPondId = id
        guard !demo, let channel else { return }
        let watching = presenceWatching, recent = recentAsk, calls = callsOpen, pond = presencePond
        Task { try? await channel.touchPresence(watching: watching, recent: recent, calls: calls, pond: pond); await refresh() }
    }

    func pondDetail(_ id: String) -> PondDetailInfo? {
        guard let detail = snapshot?.pondDetail, detail.id == id else { return nil }
        return PondDetailInfo(
            invites: (detail.invites ?? []).map { .init(label: $0.label, expiresAt: $0.expiresAt) },
            waiting: (detail.waiting ?? []).map(\.name),
            ripples: (detail.ripples ?? []).map { .init(text: $0.text, at: $0.at, who: $0.who) })
    }

    func sendPondHidden(_ id: String, _ hidden: Bool) {
        // A stand-in pond (no Mac pond) is only a note on this phone.
        guard !id.hasPrefix(PondList.namePrefix) else { return }
        sendPond(.hide(pondId: id, hidden: hidden)) { [weak self] ok in if ok { self?.pondHiddenLocal[id] = nil } }
    }

    func sendPondOrder(_ mode: PondOrderMode) {
        switch mode {
        case .newest: sendPond(.orderNewest) { [weak self] ok in if ok { self?.pondOrderLocal = nil } }
        case .manual(let ids):
            let keys = ids.filter { !$0.hasPrefix(PondList.namePrefix) }
            sendPond(.orderManual(ids: keys)) { [weak self] ok in if ok { self?.pondOrderLocal = nil } }
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
