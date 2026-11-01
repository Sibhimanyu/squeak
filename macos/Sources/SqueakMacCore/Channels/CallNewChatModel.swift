import Foundation

/// The model preset a chat started from a phone call uses (`newChatModel` in `GET /control/voice`). nil = the
/// workspace's usual model. The daemon owns validation (`src/voice/settings.ts`); this shapes the pick and the request.
public struct CallNewChatModel: Sendable, Equatable, Decodable {
    public var id: String
    public var level: String?
    public init(id: String, level: String? = nil) { self.id = id; self.level = level }

    /// The body of `POST /control/voice` for a pick; nil picks "the workspace's usual model" (`"newChatModel": null`).
    public static func requestBody(_ pick: CallNewChatModel?) -> Data {
        var inner: Any = NSNull()
        if let pick {
            var d: [String: Any] = ["id": pick.id]
            if let level = pick.level { d["level"] = level }
            inner = d
        }
        return (try? JSONSerialization.data(withJSONObject: ["newChatModel": inner])) ?? Data("{}".utf8)
    }

    /// The pick after choosing a model in the picker: its default level when it has levels, none otherwise.
    /// An id the list does not hold returns nil (the usual model).
    public static func choosing(_ id: String?, in models: [DaemonChatModel]) -> CallNewChatModel? {
        guard let id, let m = models.first(where: { $0.id == id }) else { return nil }
        return CallNewChatModel(id: id, level: m.levels.isEmpty ? nil : (m.defaultLevel.flatMap { m.levels.contains($0) ? $0 : nil } ?? m.levels.first))
    }

    /// The same model at another level; ignored when the model has no such level.
    public func with(level: String, in models: [DaemonChatModel]) -> CallNewChatModel {
        guard let m = models.first(where: { $0.id == id }), m.levels.contains(level) else { return self }
        return CallNewChatModel(id: id, level: level)
    }

    /// The pick as the picker should show it: a model the list no longer has, or a level it lacks, is repaired
    /// (a vanished model reads as the usual one).
    public func resolved(in models: [DaemonChatModel]) -> CallNewChatModel? {
        guard let m = models.first(where: { $0.id == id }) else { return nil }
        if m.levels.isEmpty { return CallNewChatModel(id: id) }
        if let level, m.levels.contains(level) { return self }
        return Self.choosing(id, in: models)
    }

    /// "Opus 5.5", "Opus 5.5 · High"; "Workspace's usual model" for none.
    public static func summary(_ pick: CallNewChatModel?, in models: [DaemonChatModel]) -> String {
        guard let pick, let m = models.first(where: { $0.id == pick.id }) else { return "Workspace's usual model" }
        guard let level = pick.level, m.levels.contains(level) else { return m.label }
        return "\(m.label) · \(DaemonChatModel.levelName(level))"
    }
}
