import Foundation

/// A join request waiting on an owner, as the New pond page, the sidebar and the notification read it. Pure: the host's
/// pond list (`status`: pending, active, denied) is the only truth.
public enum PondJoinWaiting {
    public static let waitingNote = "Waiting for approval"
    public static let declinedNote = "Your request was declined"

    /// The pond id inside an invite code (`squeak-pond:<base64url json>` or the link's fragment); nil when it is not one.
    public static func pondId(inInvite code: String) -> String? {
        var raw = code.trimmingCharacters(in: .whitespacesAndNewlines)
        if let hash = raw.firstIndex(of: "#") { raw = String(raw[raw.index(after: hash)...]) }
        if raw.hasPrefix("squeak-pond:") { raw.removeFirst("squeak-pond:".count) }
        var b64 = raw.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        while b64.count % 4 != 0 { b64 += "=" }
        guard let data = Data(base64Encoded: b64),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let id = json["p"] as? String, !id.isEmpty else { return nil }
        return id
    }

    /// The pending request this invite already made, if any: re-opening Join with it shows the waiting card instead of
    /// sending another request.
    public static func pending(forInvite code: String, in ponds: [PondSummary]) -> PondSummary? {
        guard let id = pondId(inInvite: code) else { return nil }
        return ponds.first { $0.id == id && $0.isWaiting }
    }

    /// The sidebar's greyed rows: requests still waiting and ones the owner declined.
    public static func rows(_ ponds: [PondSummary]) -> [PondSummary] { ponds.filter(PondStates.isGreyedRow) }

    public static func rowTitle(_ pond: PondSummary) -> String {
        pond.isWaiting || pond.isDeclined ? "\(pond.name) \u{00B7} \(pond.isDeclined ? declinedNote : waitingNote)" : PondStates.rowTitle(pond)
    }

    /// "Asked to join as a viewer".
    public static func asked(_ pond: PondSummary) -> String {
        let role = pond.requestedRole ?? .member
        return "Asked to join as \(role == .owner ? "an" : "a") \(role.word.lowercased())"
    }

    /// Ponds that were waiting in `old` and are active in `new` (the notifications now come from `PondNotes.joiner`).
    public static func approved(old: [PondSummary], new: [PondSummary]) -> [PondSummary] {
        let waiting = Set(old.filter(\.isWaiting).map(\.id))
        return new.filter { waiting.contains($0.id) && $0.status == "active" }
    }
}
