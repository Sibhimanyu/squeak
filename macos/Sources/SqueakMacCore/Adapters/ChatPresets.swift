import Foundation

/// How a new chat splits its work: the chat's model plans, a worker codes, a worker runs commands, and
/// plan first holds every change until the person says go. The daemon's `split` body, keys omitted when default.
public struct WorkSplit: Codable, Equatable, Sendable {
    public var code: String?
    public var run: String?
    public var planFirst: Bool?
    public init(code: String? = nil, run: String? = nil, planFirst: Bool? = nil) {
        self.code = code; self.run = run; self.planFirst = planFirst
    }
    public var isEmpty: Bool { code == nil && run == nil && planFirst != true }

    /// The host's `split` body for `POST /native/sessions`.
    var nativeJSON: NativeJSON {
        var o: [String: NativeJSON] = [:]
        if let code { o["code"] = .string(code) }
        if let run { o["run"] = .string(run) }
        if planFirst == true { o["planFirst"] = .bool(true) }
        return .object(o)
    }

    var json: [String: any Sendable] {
        var o: [String: any Sendable] = [:]
        if let code { o["code"] = code }
        if let run { o["run"] = run }
        if planFirst == true { o["planFirst"] = true }
        return o
    }
}

/// A model that can do a chat's coding or command running. The Mac has no route listing them, so the
/// daemon's fixed set (`SPLIT_WORKERS`) is spelled here; "Same model" is nil, not a worker.
public struct ChatWorker: Equatable, Sendable, Identifiable {
    public var id: String
    public var label: String
    public static let all: [ChatWorker] = [
        ChatWorker(id: "sonnet", label: "Sonnet"), ChatWorker(id: "haiku", label: "Haiku"),
        ChatWorker(id: "opus", label: "Opus"), ChatWorker(id: "fable", label: "Fable"),
    ]
}

/// What a new chat will run with, exactly what is sent.
public struct ChatSetup: Equatable, Codable, Sendable {
    public var modelId: String?
    public var level: String?
    public var code: String?
    public var run: String?
    public var planFirst: Bool

    public init(modelId: String? = nil, level: String? = nil, code: String? = nil, run: String? = nil, planFirst: Bool = false) {
        self.modelId = modelId; self.level = level; self.code = code; self.run = run; self.planFirst = planFirst
    }

    public var split: WorkSplit { WorkSplit(code: code, run: run, planFirst: planFirst ? true : nil) }
}

public enum ChatPreset: String, Codable, CaseIterable, Sendable {
    case best, balanced, save, custom

    public var title: String {
        switch self {
        case .best: "Best"
        case .balanced: "Balanced"
        case .save: "Save usage"
        case .custom: "Custom"
        }
    }
}

/// Editable preset labels and setups. The three presets are shared and belong to Claude threads (a Codex thread
/// has the plain model picker). Missing or stale choices fall back to the built-in preset after being checked
/// against the daemon's current model list.
///
/// The daemon owns the settings (`GET/POST /control/presets`, shared with the phone and the web). What is in
/// `UserDefaults` here is the Mac's copy of the daemon's document, so the sheets read synchronously and the
/// app still works, with the built-in defaults, while the daemon is down. A change is applied to the copy at
/// once and queued as a request for the daemon; `ChatPresetSync` sends the queue and refreshes the copy.
public struct ChatPresetPreferences: Equatable, @unchecked Sendable {
    private let defaults: UserDefaults
    static let key = "squeak.mac.newchat.presets"
    static let pendingKey = "squeak.mac.newchat.presets.pending"
    static let migratedKey = "squeak.mac.newchat.presets.migrated"
    /// Called after a change is queued, so the app can send it now.
    nonisolated(unsafe) public static var onChange: (@Sendable () -> Void)?
    struct Saved: Codable { var names: [String: String] = [:]; var setups: [String: ChatSetup] = [:] }
    public init(defaults: UserDefaults = .standard) { self.defaults = defaults }
    func value() -> Saved { defaults.data(forKey: Self.key).flatMap { try? JSONDecoder().decode(Saved.self, from: $0) } ?? Saved() }
    func store(_ value: Saved) { defaults.set(try? JSONEncoder().encode(value), forKey: Self.key) }
    func pending() -> [Data] { (defaults.array(forKey: Self.pendingKey) as? [Data]) ?? [] }
    func setPending(_ list: [Data]) { defaults.set(list, forKey: Self.pendingKey) }
    func enqueue(_ request: Data?) {
        guard let request else { return }
        setPending(pending() + [request])
        Self.onChange?()
    }
    public func title(for preset: ChatPreset) -> String { value().names[preset.rawValue]?.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty ?? preset.title }
    public func setTitle(_ title: String, for preset: ChatPreset) {
        guard preset != .custom else { return }; var saved = value()
        let clean = String(title.trimmingCharacters(in: .whitespacesAndNewlines).prefix(32))
        if clean.isEmpty || clean == preset.title { saved.names.removeValue(forKey: preset.rawValue) } else { saved.names[preset.rawValue] = clean }
        store(saved)
        enqueue(ChatPresetRequest.name(preset, clean.isEmpty || clean == preset.title ? nil : clean))
    }
    public func setup(for preset: ChatPreset, agent: NewChatAgent, models: [DaemonChatModel]) -> ChatSetup? {
        guard preset != .custom, agent == .claude else { return nil }
        let builtIn = ChatPresets.setup(for: preset, agent: agent, models: models)
        let chosen = value().setups["\(agent.rawValue).\(preset.rawValue)"] ?? builtIn
        guard let chosen else { return nil }
        let safe = ChatPresets.sanitised(chosen, agent: agent, models: models)
        return safe.modelId == nil ? builtIn : safe
    }
    public func setSetup(_ setup: ChatSetup, for preset: ChatPreset, agent: NewChatAgent, models: [DaemonChatModel]) {
        guard preset != .custom, agent == .claude else { return }; var saved = value()
        let safe = ChatPresets.sanitised(setup, agent: agent, models: models)
        saved.setups["\(agent.rawValue).\(preset.rawValue)"] = safe
        store(saved)
        // A setup with no model cannot be stored on the daemon, which needs one.
        if safe.modelId != nil { enqueue(ChatPresetRequest.setup(preset, agent, safe)) }
    }
    public func restoreDefaults(for preset: ChatPreset, agent: NewChatAgent) {
        guard preset != .custom, agent == .claude else { return }; var saved = value()
        saved.names.removeValue(forKey: preset.rawValue)
        saved.setups.removeValue(forKey: "\(agent.rawValue).\(preset.rawValue)")
        store(saved)
        enqueue(ChatPresetRequest.reset(preset, agent))
    }
}

private extension String { var nilIfEmpty: String? { isEmpty ? nil : self } }

/// Preset to settings, worked out only from the models the daemon listed: a preset it cannot back is not offered.
public enum ChatPresets {
    public static func models(_ all: [DaemonChatModel], _ agent: NewChatAgent) -> [DaemonChatModel] {
        all.filter { $0.agent == agent.rawValue }
    }

    private static func has(_ m: DaemonChatModel, _ family: String) -> Bool { (m.id + " " + m.label).lowercased().contains(family) }
    private static func isLong(_ m: DaemonChatModel) -> Bool { (m.id + " " + m.label).lowercased().contains("1m") }

    /// The first family listed (1M or not as asked), else whatever is first: mirrors the daemon's `builtinPresets`.
    private static func pick(_ list: [DaemonChatModel], _ families: [String], preferLong: Bool) -> DaemonChatModel? {
        for family in families {
            let found = list.filter { has($0, family) }
            if let m = found.first(where: { isLong($0) == preferLong }) ?? found.first { return m }
        }
        return list.first
    }

    private static func level(_ m: DaemonChatModel, _ want: String) -> String? {
        m.levels.isEmpty ? nil : (m.levels.contains(want) ? want : (m.defaultLevel ?? m.levels.first))
    }

    /// The built-in presets (the daemon sends its own resolved ones; this is for a daemon that is down or older):
    /// Best = Opus (1M if listed) plans, Opus codes, Sonnet runs, high. Balanced = Opus plans, Sonnet codes, Haiku
    /// runs, medium. Save usage = Sonnet plans, Haiku codes and runs, low. Claude only: Codex has none.
    public static func setup(for preset: ChatPreset, agent: NewChatAgent, models all: [DaemonChatModel]) -> ChatSetup? {
        guard agent == .claude, preset != .custom else { return nil }
        let list = models(all, agent)
        let families = preset == .save ? ["sonnet", "haiku"] : ["opus", "fable"]
        guard let planner = pick(list, families, preferLong: preset == .best) else { return nil }
        switch preset {
        case .best: return ChatSetup(modelId: planner.id, level: level(planner, "high"), code: "opus", run: "sonnet")
        case .balanced: return ChatSetup(modelId: planner.id, level: level(planner, "medium"), code: "sonnet", run: "haiku")
        default: return ChatSetup(modelId: planner.id, level: level(planner, "low"), code: "haiku", run: "haiku")
        }
    }

    /// The presets to show: all three for Claude when the list backs them, none for Codex.
    public static func available(agent: NewChatAgent, models: [DaemonChatModel]) -> [ChatPreset] {
        [ChatPreset.best, .balanced, .save].filter { setup(for: $0, agent: agent, models: models) != nil }
    }

    /// The preset a setting is, or `custom` once edited away.
    public static func preset(of setup: ChatSetup, agent: NewChatAgent, models: [DaemonChatModel]) -> ChatPreset {
        for c in [ChatPreset.best, .balanced, .save] where Self.setup(for: c, agent: agent, models: models) == setup { return c }
        return .custom
    }

    /// "Opus 5.5 · 1M" is "Opus 5.5".
    public static func shortName(_ label: String) -> String { label.components(separatedBy: " · ").first ?? label }

    public static func workerName(_ id: String) -> String { ChatWorker.all.first { $0.id == id }?.label ?? id }

    /// "Opus 5.5 plans · Sonnet codes · asks before changes".
    public static func summary(of setup: ChatSetup, agent: NewChatAgent, models all: [DaemonChatModel]) -> String {
        let chat = models(all, agent).first { $0.id == setup.modelId }
        let name = chat.map { shortName($0.label) } ?? (agent == .claude ? "Claude" : "Codex")
        var parts: [String] = []
        if setup.code != nil || setup.run != nil {
            parts.append("\(name) plans")
            if let c = setup.code { parts.append("\(workerName(c)) codes") }
            if let r = setup.run { parts.append("\(workerName(r)) runs tests") }
        } else {
            parts.append(name)
            if let chat, !chat.levels.isEmpty, let l = setup.level {
                parts.append("\(l == "xhigh" ? "extra high" : l) thinking")
            }
        }
        if setup.planFirst { parts.append("asks before changes") }
        return parts.joined(separator: " · ")
    }

    /// The start with the model and level the daemon lists, so a stale pick is never sent.
    public static func sanitised(_ setup: ChatSetup, agent: NewChatAgent, models all: [DaemonChatModel]) -> ChatSetup {
        var s = setup
        let list = models(all, agent)
        guard let chat = list.first(where: { $0.id == s.modelId }) else {
            s.modelId = nil; s.level = nil
            if agent != .claude { s.code = nil; s.run = nil; s.planFirst = false }
            return s
        }
        if chat.levels.isEmpty { s.level = nil }
        else if s.level == nil || !chat.levels.contains(s.level!) { s.level = chat.defaultLevel ?? chat.levels.first }
        if agent != .claude { s.code = nil; s.run = nil; s.planFirst = false }
        else {
            let workerIDs = Set(ChatWorker.all.map(\.id))
            if let code = s.code, !workerIDs.contains(code) { s.code = nil }
            if let run = s.run, !workerIDs.contains(run) { s.run = nil }
            if s.code == nil && s.run == nil { s.planFirst = false }
        }
        return s
    }
}

/// The last choice per agent, kept across launches. A preset is stored by name and worked out again
/// from the daemon's current models; a custom setup is stored whole.
public struct ChatChoiceStore: Equatable, @unchecked Sendable {
    private let defaults: UserDefaults
    private let key = "squeak.mac.newchat.choice"

    public init(defaults: UserDefaults = .standard) { self.defaults = defaults }
    public var preferences: ChatPresetPreferences { ChatPresetPreferences(defaults: defaults) }

    private struct Saved: Codable { var preset: ChatPreset; var setup: ChatSetup? }

    private func all() -> [String: Saved] {
        defaults.data(forKey: key).flatMap { try? JSONDecoder().decode([String: Saved].self, from: $0) } ?? [:]
    }

    public func save(_ setup: ChatSetup, preset: ChatPreset, agent: NewChatAgent) {
        var saved = all()
        saved[agent.rawValue] = Saved(preset: preset, setup: preset == .custom ? setup : nil)
        defaults.set(try? JSONEncoder().encode(saved), forKey: key)
    }

    public func restore(agent: NewChatAgent, models: [DaemonChatModel]) -> ChatSetup {
        let list = ChatPresets.models(models, agent)
        let fallback = ChatPresets.setup(for: .best, agent: agent, models: models)
            ?? ChatSetup(modelId: list.first?.id, level: list.first?.defaultLevel ?? list.first?.levels.first)
        guard let saved = all()[agent.rawValue] else { return fallback }
        if saved.preset != .custom { return preferences.setup(for: saved.preset, agent: agent, models: models) ?? fallback }
        guard let setup = saved.setup, list.contains(where: { $0.id == setup.modelId }) else { return fallback }
        return ChatPresets.sanitised(setup, agent: agent, models: models)
    }
}
