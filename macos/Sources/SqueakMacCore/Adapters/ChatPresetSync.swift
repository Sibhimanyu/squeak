import Foundation

/// The daemon's `GET /control/presets`: only what a person changed. Absent entries are the built-in rule.
/// `names` are shared by both agents; `setups["claude"]["best"]` is one agent's preset.
public struct DaemonChatPresets: Codable, Equatable, Sendable {
    public var names: [String: String]
    public var setups: [String: [String: ChatSetup]]
    public init(names: [String: String] = [:], setups: [String: [String: ChatSetup]] = [:]) {
        self.names = names; self.setups = setups
    }
    enum CodingKeys: String, CodingKey { case names, setups }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        names = (try? c.decode([String: String].self, forKey: .names)) ?? [:]
        // One unreadable setup must not hide the rest.
        struct Failable: Decodable { let value: ChatSetup?; init(from d: Decoder) throws { value = try? ChatSetup(from: d) } }
        let raw = (try? c.decode([String: [String: Failable]].self, forKey: .setups)) ?? [:]
        setups = raw.mapValues { $0.compactMapValues(\.value) }
    }
}

public enum ChatPresetOutcome: Equatable, Sendable {
    case saved(DaemonChatPresets?)
    /// The daemon read it and said no (400): retrying it would only fail again.
    case refused
    /// A daemon without the route.
    case outdated
}

/// The request bodies the daemon's `POST /control/presets` takes: one change, exactly these keys.
public enum ChatPresetRequest {
    static func data(_ object: [String: Any]) -> Data? { try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]) }

    public static func name(_ preset: ChatPreset, _ name: String?) -> Data? {
        data(["preset": preset.rawValue, "change": ["name": (name as Any?) ?? NSNull()]])
    }
    public static func reset(_ preset: ChatPreset, _ agent: NewChatAgent) -> Data? {
        data(["agent": agent.rawValue, "preset": preset.rawValue, "change": ["reset": true]])
    }
    public static func setup(_ preset: ChatPreset, _ agent: NewChatAgent, _ setup: ChatSetup) -> Data? {
        guard let modelId = setup.modelId else { return nil }
        func orNull(_ v: String?) -> Any { v ?? NSNull() }
        let body: [String: Any] = [
            "modelId": modelId, "level": orNull(setup.level), "code": orNull(setup.code),
            "run": orNull(setup.run), "planFirst": setup.planFirst,
        ]
        return data(["agent": agent.rawValue, "preset": preset.rawValue, "change": ["setup": body]])
    }
}

/// Keeps the Mac's copy of the presets and the daemon's document the same: queued changes go first, a copy
/// made before the daemon held presets is handed over once, then the copy is replaced by the daemon's.
public enum ChatPresetSync {
    public enum Result: Equatable, Sendable {
        /// The copy now matches the daemon.
        case synced
        /// Daemon down, an older daemon or no token: the copy stands as it is, queued changes are kept.
        case unavailable
    }

    public static func sync(client: DaemonClient, defaults: UserDefaults = .standard) async -> Result {
        let prefs = ChatPresetPreferences(defaults: defaults)
        do {
            guard var doc = try await client.chatPresets() else { return .unavailable }
            if !defaults.bool(forKey: ChatPresetPreferences.migratedKey) {
                // Customised presets from before the daemon held them: hand over what it does not have yet.
                let queued = migrationRequests(local: prefs.value(), daemon: doc)
                prefs.setPending(queued + prefs.pending())
                defaults.set(true, forKey: ChatPresetPreferences.migratedKey)
            }
            var pending = prefs.pending()
            while let next = pending.first {
                switch try await client.changeChatPreset(next) {
                case .saved(let after): if let after { doc = after }
                case .refused: break // never sendable: drop it, the daemon's document wins below
                case .outdated: return .unavailable
                }
                pending.removeFirst()
                prefs.setPending(pending)
            }
            var saved = ChatPresetPreferences.Saved()
            saved.names = doc.names
            for (agent, presets) in doc.setups { for (preset, setup) in presets { saved.setups["\(agent).\(preset)"] = setup } }
            prefs.store(saved)
            return .synced
        } catch {
            return .unavailable
        }
    }

    /// What the local copy holds that the daemon's document lacks, as requests. Nothing local is dropped.
    static func migrationRequests(local: ChatPresetPreferences.Saved, daemon: DaemonChatPresets) -> [Data] {
        var out: [Data] = []
        for (key, title) in local.names.sorted(by: { $0.key < $1.key }) {
            guard let preset = ChatPreset(rawValue: key), preset != .custom, daemon.names[key] == nil else { continue }
            if let request = ChatPresetRequest.name(preset, title) { out.append(request) }
        }
        for (key, setup) in local.setups.sorted(by: { $0.key < $1.key }) {
            let parts = key.split(separator: ".").map(String.init)
            guard parts.count == 2, let agent = NewChatAgent(rawValue: parts[0]), let preset = ChatPreset(rawValue: parts[1]),
                  preset != .custom, daemon.setups[agent.rawValue]?[preset.rawValue] == nil,
                  let request = ChatPresetRequest.setup(preset, agent, setup) else { continue }
            out.append(request)
        }
        return out
    }
}
