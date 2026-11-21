import Foundation

/// The Code panel's sub-tab (All files, Changes, Review) remembered once per workspace. Stored in UserDefaults as a
/// small JSON map under `defaultsKey`; a workspace with nothing stored (or no workspace) reads the global
/// `fallbackKey` value, the old single setting. Pure so CI can test the map; `read`/`write` are the thin defaults edge.
public struct InspectorTabMemory: Codable, Equatable, Sendable {
    public static let defaultsKey = "inspectorTabByWorkspace"
    public static let fallbackKey = "inspectorTab"
    public static let cap = 200

    public private(set) var tabs: [String: String] = [:]
    /// Oldest first, so the cap drops the least recently set.
    private var order: [String] = []

    public init() {}

    public func tab(for workspace: String?) -> String? { workspace.flatMap { tabs[$0] } }

    public mutating func set(_ raw: String, for workspace: String) {
        order.removeAll { $0 == workspace }
        order.append(workspace)
        tabs[workspace] = raw
        while order.count > Self.cap { tabs[order.removeFirst()] = nil }
    }

    public static func decode(_ json: String) -> InspectorTabMemory {
        guard let d = json.data(using: .utf8), let m = try? JSONDecoder().decode(InspectorTabMemory.self, from: d) else { return InspectorTabMemory() }
        return m
    }

    public var json: String {
        guard let d = try? JSONEncoder().encode(self) else { return "" }
        return String(decoding: d, as: UTF8.self)
    }

    /// The raw tab for `workspace`: its own, else `fallback` (the global default).
    public static func resolve(_ json: String, workspace: String?, fallback: String) -> String {
        decode(json).tab(for: workspace) ?? fallback
    }

    public static func read(workspace: String?, defaults: UserDefaults = .standard) -> String {
        resolve(defaults.string(forKey: defaultsKey) ?? "", workspace: workspace,
                fallback: defaults.string(forKey: fallbackKey) ?? InspectorTab.changes.rawValue)
    }

    /// Remembers `raw` for `workspace`; with no workspace it sets the global default.
    public static func write(_ raw: String, workspace: String?, defaults: UserDefaults = .standard) {
        guard let workspace else { defaults.set(raw, forKey: fallbackKey); return }
        var m = decode(defaults.string(forKey: defaultsKey) ?? "")
        m.set(raw, for: workspace)
        defaults.set(m.json, forKey: defaultsKey)
    }
}
