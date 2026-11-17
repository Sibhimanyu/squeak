import Foundation

// DESIGN.md "Pond tab, dashboard and Thread tab": the Thread tab covers the one thread open in the centre, live: who is
// in it, what is running, and its controls. Pure view-model; the view draws it.

public struct ThreadGlance: Equatable, Sendable {
    public struct Person: Equatable, Sendable, Identifiable {
        public enum Role: String, Sendable { case owner, tookPart, watching }
        public var id: String
        public var name: String
        public var initial: String
        public var colourIndex: Int
        public var you: Bool
        public var role: Role
        public var typing: Bool
        /// "Owner", "Took part", "Watching", with ", typing" when they are.
        public var line: String
    }

    public struct Helper: Equatable, Sendable, Identifiable {
        public var id: String
        public var title: String
        public var isShell: Bool
        public var running: Bool
        public var status: String
    }

    public var people: [Person]
    /// "Claude · Opus 5", nil when the agent is unknown.
    public var agentLine: String?
    public var statusWord: String
    public var helpers: [Helper]
    public var runningHelpers: Int
    public var queued: [String]
    /// "35 files changed": one quiet line that opens Code, where the file detail lives. No file names, no +/- counts.
    public var changedLine: String?

    public static let queuedCap = 3

    public var hasRunning: Bool { runningHelpers > 0 || !queued.isEmpty }

    public static func build(
        agentName: String?, model: String?, state: SessionState, you: String,
        thread: PondThread?, members: [FlockMember] = [], presence: [PondPresenceEntry] = [], meId: String? = nil,
        helpers: [Duckling] = [], queued: [String] = [], files: [DaemonChanges.File] = []
    ) -> ThreadGlance {
        let threadId = thread?.id
        var people: [Person] = []
        func add(_ id: String, _ name: String, _ role: Person.Role, you isYou: Bool) {
            guard !people.contains(where: { $0.id == id }) else { return }
            let typing = threadId.map { t in presence.contains { $0.member == id && $0.isTyping(in: t) } } ?? false
            let shown = name.isEmpty ? "Someone" : name
            let word = role == .owner ? "Owner" : role == .tookPart ? "Took part" : "Watching"
            people.append(Person(id: id, name: shown, initial: String(shown.first.map { String($0).uppercased() } ?? "?"),
                                 colourIndex: PondPresence.colourIndex(for: shown), you: isYou, role: role, typing: typing,
                                 line: typing ? "\(word), typing" : word))
        }
        if let thread {
            func name(_ id: String, _ fallback: String) -> String { members.first { $0.id == id }?.name ?? fallback }
            add(thread.starter, name(thread.starter, thread.starterName), .owner, you: thread.starter == meId)
            for p in thread.participants.sorted(by: { ($0.lastAt ?? .distantPast) > ($1.lastAt ?? .distantPast) }) {
                add(p.memberId, name(p.memberId, p.name), .tookPart, you: p.memberId == meId)
            }
            for p in presence where p.online && p.viewing == thread.id {
                add(p.member, name(p.member, ""), .watching, you: p.member == meId)
            }
        } else {
            add("person:local", you.trimmingCharacters(in: .whitespaces).isEmpty ? "You" : you, .owner, you: true)
        }

        let agentLine = [agentName, model].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " \u{00B7} ")
        let rows = helpers.map { d in
            Helper(id: d.id, title: d.title.isEmpty ? (d.kind == .shell ? "Background command" : "Duckling") : d.title,
                   isShell: d.kind == .shell, running: d.status == .running,
                   status: d.status == .running ? "Running" : d.status == .done ? "Done" : d.status == .failed ? "Failed" : "Stopped")
        }.sorted { $0.running != $1.running ? $0.running : false }
        return ThreadGlance(
            people: people, agentLine: agentLine.isEmpty ? nil : agentLine, statusWord: PondSentence.stateWord(state),
            helpers: rows, runningHelpers: rows.filter(\.running).count, queued: Array(queued.prefix(queuedCap)),
            changedLine: files.isEmpty ? nil : "\(files.count) \(files.count == 1 ? "file" : "files") changed")
    }
}
