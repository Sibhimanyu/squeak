import Foundation

// A Duck's Streams (ADR 0003): the branches it has joined, as the host sends them on a Duck and on a Room thread. Pure:
// the views draw the chips and the tooltip lines this returns, and decide nothing.

/// A Stream a Duck is in (`streams?: {workspaceId, branch, title?}[]`, join order).
public struct RoomStream: Sendable, Equatable, Decodable, Identifiable {
    public var workspaceId: String
    public var branch: String
    public var title: String?
    public var id: String { workspaceId }

    public init(workspaceId: String, branch: String, title: String? = nil) {
        self.workspaceId = workspaceId; self.branch = branch; self.title = title
    }

    private enum CodingKeys: String, CodingKey { case workspaceId, branch, title }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let id = try c.decode(String.self, forKey: .workspaceId)
        guard !id.isEmpty else { throw DecodingError.dataCorruptedError(forKey: .workspaceId, in: c, debugDescription: "workspaceId") }
        workspaceId = id
        branch = (try? c.decode(String.self, forKey: .branch)) ?? ""
        title = (try? c.decode(String.self, forKey: .title)).flatMap { $0.trimmingCharacters(in: .whitespaces).isEmpty ? nil : $0 }
    }
}

extension KeyedDecodingContainer {
    /// The host's `streams` list; an entry that does not decode is dropped, an absent list is none.
    func streams(forKey key: Key) -> [RoomStream] {
        ((try? decode([Failable<RoomStream>].self, forKey: key)) ?? []).compactMap(\.value)
    }
}

/// One chip in the Duck's top bar: a Stream's branch, or "Pond" for a Duck that is in none.
public struct DuckStreamChip: Sendable, Equatable, Identifiable {
    public var id: String
    /// The branch, or "Pond". Always drawn whole.
    public var label: String
    /// The Stream a click opens the Changes of; nil on the Pond chip (the Pond's own folder).
    public var workspaceId: String?
    public var isPond: Bool { workspaceId == nil }
}

public enum DuckStreams {
    public static let pondLabel = "Pond"

    /// One chip per Stream in join order (the label is the branch, else the Stream's title); a Duck in none gets the one Pond chip.
    public static func chips(_ streams: [RoomStream]) -> [DuckStreamChip] {
        guard !streams.isEmpty else { return [DuckStreamChip(id: "pond", label: pondLabel, workspaceId: nil)] }
        return streams.map { s in
            DuckStreamChip(id: s.workspaceId, label: s.branch.isEmpty ? (s.title ?? "Stream") : s.branch, workspaceId: s.workspaceId)
        }
    }

    /// The Duck circle's tooltip: "Pip · Working", then "In the Pond" or "In 2 Streams" with one bullet per branch.
    public static func tooltip(name: String, presenceLine: String, streams: [RoomStream]) -> String {
        let head = "\(name) \u{00B7} \(presenceLine)"
        guard !streams.isEmpty else { return "\(head)\nIn the Pond" }
        let lines = chips(streams).map { "\u{2022} \($0.label)" }
        return ([head, streams.count == 1 ? "In 1 Stream" : "In \(streams.count) Streams"] + lines).joined(separator: "\n")
    }

    /// The same on one line for VoiceOver: "Pip, Working, in feat/login and fix/b", or "in the Pond".
    public static func accessibilityLabel(name: String, presenceLine: String, streams: [RoomStream]) -> String {
        let labels = chips(streams).map(\.label)
        let where_ = streams.isEmpty ? "in the Pond" : "in " + (labels.count > 1 ? labels.dropLast().joined(separator: ", ") + " and " + labels[labels.count - 1] : labels[0])
        return "\(name), \(presenceLine), \(where_)"
    }

    /// What a chip's click does, for its help text.
    public static func chipHelp(_ chip: DuckStreamChip) -> String {
        chip.isPond ? "Show the changes in the Pond's own folder" : "Show the changes in \(chip.label)"
    }
}
