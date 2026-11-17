import Foundation

/// The People page's presets and switches (docs/ponds.md, "Who can do what"). The host holds the truth; these only name it.
public enum PondPresets {
    public struct Preset: Sendable { public var key: String; public var title: String }
    public struct Switch: Sendable { public var key: String; public var title: String }

    /// The presets, worded for the mode: with own threads stashed (the default), a Collaborator starts threads on the owner's Mac.
    public static func presets(ownThreads: Bool) -> [Preset] {
        [
            Preset(key: "viewer", title: "Viewer: reads only"),
            Preset(key: "member", title: "Member: messages shared threads"),
            Preset(key: "collaborator", title: ownThreads ? "Collaborator: also runs their own agent" : "Collaborator: can start threads on the owner\u{2019}s Mac"),
        ]
    }

    public static func switches(ownThreads: Bool) -> [Switch] {
        [
            Switch(key: "see", title: "Can see threads"),
            Switch(key: "diffs", title: "Can see changes"),
            Switch(key: "message", title: "Can message"),
            Switch(key: "answer", title: "Can answer questions"),
            Switch(key: "start", title: ownThreads ? "Can start their own threads" : "Can start threads on the owner\u{2019}s Mac"),
        ]
    }

    public static let all: [Preset] = presets(ownThreads: true)
    public static let switches: [Switch] = switches(ownThreads: true)

    /// The preset a member matches, or "custom".
    public static func current(_ m: FlockMember) -> String {
        let c = m.caps ?? PondCaps()
        if m.role == .viewer { return "viewer" }
        if c.see, c.diffs, c.message, c.answer, c.start { return "collaborator" }
        if c.see, c.diffs, c.message, c.answer, !c.start { return "member" }
        return "custom"
    }

    public static func value(_ m: FlockMember, _ key: String) -> Bool {
        let c = m.caps ?? PondCaps()
        switch key {
        case "see": return c.see
        case "diffs": return c.diffs
        case "message": return c.message
        case "answer": return c.answer
        default: return c.start
        }
    }

    /// "Powered by Aarav\u{2019}s MacBook \u{00B7} Flotilla": the mark on a thread a member runs with their own agent on their own Mac.
    public static func poweredBy(nest: String?) -> String {
        let n = nest?.trimmingCharacters(in: .whitespaces) ?? ""
        return n.isEmpty ? "Powered by their Mac \u{00B7} Flotilla" : "Powered by \(n) \u{00B7} Flotilla"
    }
}
