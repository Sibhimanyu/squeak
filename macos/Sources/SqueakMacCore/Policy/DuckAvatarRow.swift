import Foundation

// The new layout's centre top (DESIGN.md "New layout"): a row of avatars instead of a tab strip. A "Room" avatar first,
// then the Pond's on-duty Ducks in roster order. A Duck opened while Off duty (from the roster or search) shows at the
// end of the row for as long as it is open; showing it never changes its duty. Pure: the view only draws, and every
// word and flag here comes from the host's roster.

/// What the centre shows now, as the row needs it.
public enum DuckRowPlace: Equatable, Sendable {
    /// The Room page.
    case room
    /// The Dashboard page: the row shows, nothing in it is selected.
    case dashboard
    /// A chat: its host session id and, when the host says so, the Duck it belongs to.
    case chat(sessionId: String?, duckId: String?)
}

public struct DuckRowAvatar: Equatable, Sendable, Identifiable {
    public var id: String
    public var name: String
    /// The Duck's colour seed (stable; the thread duck's FNV hash tints it).
    public var colourSeed: String
    public var agent: String?
    public var presence: RoomDuckPresence
    /// The host-worded status line ("Working \u{00B7} 3 of 5", "Idle \u{00B7} 2h ago").
    public var presenceLine: String
    /// The Duck's current chat: nil until it has had a Task (nothing to open).
    public var sessionId: String?
    public var onDuty: Bool { presence != .off }
    /// The working glyph shows only on a working Duck.
    public var showsWorkingGlyph: Bool { presence == .working }
    /// The amber triangle shows only on a Duck waiting on the person.
    public var needsYou: Bool { presence == .waiting }
    public var opensChat: Bool { sessionId != nil }
}

public enum DuckRowSelection: Equatable, Sendable {
    case none, room, duck(String)
}

public struct DuckRowModel: Equatable, Sendable {
    /// The Room avatar is always first and always there; these are the Ducks after it.
    public var ducks: [DuckRowAvatar]
    public var selection: DuckRowSelection
    public var selectedDuck: String? { if case .duck(let id) = selection { id } else { nil } }
    public var roomSelected: Bool { selection == .room }
}

public enum DuckAvatarRow {
    public static func build(roster: DuckRoster, place: DuckRowPlace) -> DuckRowModel {
        func avatar(_ d: RosterDuck) -> DuckRowAvatar {
            DuckRowAvatar(id: d.id, name: d.name, colourSeed: d.colourSeed, agent: d.agent, presence: d.presence, presenceLine: d.presenceLine, sessionId: d.sessionId)
        }
        var ducks = roster.onDuty.map(avatar)
        switch place {
        case .room: return DuckRowModel(ducks: ducks, selection: .room)
        case .dashboard: return DuckRowModel(ducks: ducks, selection: .none)
        case .chat(let sessionId, let duckId):
            let opened = (roster.onDuty + roster.offDuty).first { d in
                if let duckId, d.id == duckId { return true }
                if let sessionId, d.sessionId == sessionId { return true }
                return false
            }
            guard let opened else { return DuckRowModel(ducks: ducks, selection: .none) }
            if !ducks.contains(where: { $0.id == opened.id }) { ducks.append(avatar(opened)) }
            return DuckRowModel(ducks: ducks, selection: .duck(opened.id))
        }
    }
}
