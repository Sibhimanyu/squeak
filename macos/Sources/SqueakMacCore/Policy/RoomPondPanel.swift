import Foundation

// The Room's right side in the new layout (DESIGN.md "New layout"): the Pond panel. Who is present, which Ducks are
// working, which Tasks wait or are blocked, and a way to the Notebook. Only host values, grouped; no decisions here.

public struct RoomPondPanel: Equatable, Sendable {
    public struct Person: Equatable, Sendable, Identifiable {
        public var id: String
        public var name: String
        public var you: Bool
    }

    public var present: [Person]
    public var working: [RosterDuck]
    public var waiting: [RoomTask]
    public var blocked: [RoomTask]
    public var tasksOpen: Int { waiting.count + blocked.count }

    /// People who are online now (you first), Ducks at work, Tasks waiting and blocked (host order, oldest first).
    /// A Pond the host lists no members for (a folder only you use) still shows you.
    public static func build(members: [FlockMember], youName: String = "You", roster: DuckRoster, tasks: [RoomTask]) -> RoomPondPanel {
        var people = members.filter { $0.online || $0.you }
            .sorted { ($0.you ? 0 : 1, $0.name.lowercased()) < ($1.you ? 0 : 1, $1.name.lowercased()) }
            .map { Person(id: $0.id, name: $0.name, you: $0.you) }
        if members.isEmpty { people = [Person(id: "you", name: youName.isEmpty ? "You" : youName, you: true)] }
        return RoomPondPanel(
            present: people,
            working: roster.onDuty.filter { $0.presence == .working },
            waiting: tasks.filter { $0.state == .waiting },
            blocked: tasks.filter { $0.state == .blocked })
    }
}
