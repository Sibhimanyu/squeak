import Foundation

/// What a new chat will run with: the chat's model and thinking level, who codes and who runs
/// commands (nil: the chat's own model), and whether it waits for a go. Exactly what the phone sends.
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

    /// Everything a preset sets except which model leads: a preset applies to whichever model leads the thread.
    public func sameSettings(as other: ChatSetup) -> Bool {
        level == other.level && code == other.code && run == other.run && planFirst == other.planFirst
    }
}

/// The three one-tap ways to start a chat; `custom` is anything else.
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

/// Preset to settings, worked out from the models and workers the Mac listed and nothing else: a
/// preset the Mac cannot honour is not offered. Pure, so `swift test` covers it.
public enum ChatPresets {
    /// The models for one agent, in the order the Mac listed them (favourites first).
    private static func models(_ all: [PhoneSnapshot.ChatModel], _ agent: NewChatAgent) -> [PhoneSnapshot.ChatModel] {
        all.filter { $0.agent == agent.rawValue }
    }

    private static func worker(_ named: String, in workers: [PhoneSnapshot.SplitWorker]) -> String? {
        workers.first { ($0.id + " " + $0.label).lowercased().contains(named) }?.id
    }

    /// The setting a preset stands for, or nil when it has none (`custom` is never derived, and Codex has no
    /// presets: it keeps its plain model picker). `shared` is the Mac's resolved presets (the view's `presets`):
    /// a setup there is checked against the Mac's lists and used; absent or unusable, the built-in rule below
    /// (the same one the daemon's `builtinPresets` follows) stands.
    public static func setup(for preset: ChatPreset, agent: NewChatAgent,
                             models all: [PhoneSnapshot.ChatModel], workers: [PhoneSnapshot.SplitWorker],
                             shared: ChatPresetsDocument? = nil) -> ChatSetup? {
        guard agent == .claude, preset != .custom else { return nil }
        let builtIn = builtInSetup(for: preset, models: all, workers: workers)
        guard let stored = shared?.presets[preset.rawValue] else { return builtIn }
        return sanitised(stored, agent: agent, models: all, workers: workers) ?? builtIn
    }

    /// A stored setup kept on what the Mac lists now, as the Mac app does: an unlisted model is not usable (nil,
    /// so the built-in stands), a level the model does not take becomes its default, an unlisted worker goes,
    /// Codex never delegates, and plan first needs a worker.
    public static func sanitised(_ stored: ChatSetup, agent: NewChatAgent,
                          models all: [PhoneSnapshot.ChatModel], workers: [PhoneSnapshot.SplitWorker]) -> ChatSetup? {
        guard let id = stored.modelId, let chat = models(all, agent).first(where: { $0.id == id }) else { return nil }
        var setup = stored
        if let level = setup.level, !chat.levels.contains(level) { setup.level = chat.defaultLevel ?? chat.levels.first }
        if setup.level == nil, !chat.levels.isEmpty { setup.level = chat.defaultLevel ?? chat.levels.first }
        if chat.levels.isEmpty { setup.level = nil }
        if agent != .claude {
            setup.code = nil; setup.run = nil
        }
        if let code = setup.code, !workers.contains(where: { $0.id == code }) { setup.code = nil }
        if let run = setup.run, !workers.contains(where: { $0.id == run }) { setup.run = nil }
        if setup.code == nil && setup.run == nil { setup.planFirst = false }
        return setup
    }

    /// The name a preset goes by: the Mac's saved one, else its built-in title.
    public static func name(of preset: ChatPreset, shared: ChatPresetsDocument?) -> String {
        guard preset != .custom,
              let saved = shared?.names[preset.rawValue]?.trimmingCharacters(in: .whitespacesAndNewlines), !saved.isEmpty
        else { return preset.title }
        return saved
    }

    private static func family(_ model: PhoneSnapshot.ChatModel, _ name: String) -> Bool {
        (model.id + " " + model.label).lowercased().contains(name)
    }

    private static func pick(_ list: [PhoneSnapshot.ChatModel], _ families: [String], preferLong: Bool) -> PhoneSnapshot.ChatModel? {
        for name in families {
            let found = list.filter { family($0, name) }
            if found.isEmpty { continue }
            return found.first { family($0, "1m") == preferLong } ?? found[0]
        }
        return list.first
    }

    private static func level(_ model: PhoneSnapshot.ChatModel, _ want: String) -> String? {
        if model.levels.isEmpty { return nil }
        return model.levels.contains(want) ? want : (model.defaultLevel ?? model.levels[0])
    }

    /// Best = Opus (1M when offered) plans, Opus codes, Sonnet runs, high; Balanced = Opus plans, Sonnet codes,
    /// Haiku runs, medium; Save usage = Sonnet plans, Haiku codes and runs, low. A family the Mac does not list
    /// falls to the nearest one it does; a worker it does not list is "same model".
    private static func builtInSetup(for preset: ChatPreset, models all: [PhoneSnapshot.ChatModel],
                                     workers: [PhoneSnapshot.SplitWorker]) -> ChatSetup? {
        let list = models(all, .claude)
        let plan: (families: [String], long: Bool, level: String, code: String, run: String)
        switch preset {
        case .custom: return nil
        case .best: plan = (["opus", "fable"], true, "high", "opus", "sonnet")
        case .balanced: plan = (["opus", "fable"], false, "medium", "sonnet", "haiku")
        case .save: plan = (["sonnet", "haiku"], false, "low", "haiku", "haiku")
        }
        guard let planner = pick(list, plan.families, preferLong: plan.long) else { return nil }
        let code = worker(plan.code, in: workers), run = worker(plan.run, in: workers)
        return ChatSetup(modelId: planner.id, level: level(planner, plan.level), code: code, run: run, planFirst: false)
    }

    /// The presets worth showing: all three for Claude (the Mac backs them from its own lists), none for Codex.
    public static func available(agent: NewChatAgent, models: [PhoneSnapshot.ChatModel],
                                 workers: [PhoneSnapshot.SplitWorker], shared: ChatPresetsDocument? = nil) -> [ChatPreset] {
        [ChatPreset.best, .balanced, .save].filter {
            setup(for: $0, agent: agent, models: models, workers: workers, shared: shared) != nil
        }
    }

    /// Which preset a setting is, or `custom` when it matches none: editing a detail turns the label
    /// into "Custom" without any other bookkeeping.
    public static func preset(of setup: ChatSetup, agent: NewChatAgent,
                              models: [PhoneSnapshot.ChatModel], workers: [PhoneSnapshot.SplitWorker],
                              shared: ChatPresetsDocument? = nil) -> ChatPreset {
        let all = [ChatPreset.best, .balanced, .save].compactMap { candidate in
            Self.setup(for: candidate, agent: agent, models: models, workers: workers, shared: shared).map { (candidate, $0) }
        }
        // The exact setup first; else the same settings under another leading model (a preset applies to any).
        if let exact = all.first(where: { $0.1 == setup }) { return exact.0 }
        if let same = all.first(where: { $0.1.sameSettings(as: setup) }) { return same.0 }
        return .custom
    }

    /// "Opus 5.5 · 1M" is "Opus 5.5": the context size is not what a person picks by.
    public static func shortName(_ label: String) -> String {
        label.components(separatedBy: " · ").first ?? label
    }

    public static func levelName(_ level: String) -> String {
        level == "xhigh" ? "extra high" : level
    }

    /// One line saying what a setup does, from the resolved setup and the lists the Mac sent:
    /// "Opus 5.5 leads · Sonnet codes · Haiku runs commands · medium effort · asks before changes".
    public static func description(of setup: ChatSetup, agent: NewChatAgent,
                                   models all: [PhoneSnapshot.ChatModel], workers: [PhoneSnapshot.SplitWorker]) -> String {
        let chat = models(all, agent).first { $0.id == setup.modelId }
        let name = chat.map { shortName($0.label) } ?? (agent == .claude ? "Claude" : "Codex")
        func workerName(_ id: String) -> String { workers.first { $0.id == id }.map { shortName($0.label) } ?? id }
        var parts = ["\(name) leads"]
        if let code = setup.code { parts.append("\(workerName(code)) codes") }
        if let run = setup.run { parts.append("\(workerName(run)) runs commands") }
        if let level = setup.level { parts.append("\(levelName(level)) effort") }
        if setup.planFirst { parts.append("asks before changes") }
        return parts.joined(separator: " · ")
    }

    /// The setup in plain words: "Opus 5.5 plans · Sonnet codes · asks before changes".
    public static func summary(of setup: ChatSetup, agent: NewChatAgent,
                               models all: [PhoneSnapshot.ChatModel], workers: [PhoneSnapshot.SplitWorker]) -> String {
        let chat = models(all, agent).first { $0.id == setup.modelId }
        let name = chat.map { shortName($0.label) } ?? (agent == .claude ? "Claude" : "Codex")
        func workerName(_ id: String) -> String { workers.first { $0.id == id }.map { shortName($0.label) } ?? id }
        var parts: [String] = []
        let delegated = setup.code != nil || setup.run != nil
        if delegated {
            parts.append("\(name) plans")
            if let code = setup.code { parts.append("\(workerName(code)) codes") }
            if let run = setup.run { parts.append("\(workerName(run)) runs tests") }
        } else {
            parts.append(name)
            if let chat, !chat.levels.isEmpty, let level = setup.level { parts.append("\(levelName(level)) thinking") }
        }
        if setup.planFirst { parts.append("asks before changes") }
        return parts.joined(separator: " · ")
    }
}

/// The last choice, kept across launches (per agent, since each agent has its own models). A preset is
/// stored by name and worked out again from the Mac's current lists; a custom setup is stored whole.
public struct ChatChoiceStore {
    private let defaults: UserDefaults
    private let key = "squeak.newchat.choice"
    private let workspaceKey = "squeak.newchat.workspace"

    public init(defaults: UserDefaults = .standard) { self.defaults = defaults }

    private struct Saved: Codable { var preset: ChatPreset; var setup: ChatSetup? }

    private func all() -> [String: Saved] {
        (defaults.data(forKey: key)).flatMap { try? JSONDecoder().decode([String: Saved].self, from: $0) } ?? [:]
    }

    public func save(_ setup: ChatSetup, preset: ChatPreset, agent: NewChatAgent) {
        var saved = all()
        saved[agent.rawValue] = Saved(preset: preset, setup: preset == .custom ? setup : nil)
        defaults.set(try? JSONEncoder().encode(saved), forKey: key)
    }

    /// What to start from: the remembered preset or custom setup, kept on what the Mac offers now; else Best.
    public func restore(agent: NewChatAgent, models all: [PhoneSnapshot.ChatModel],
                        workers: [PhoneSnapshot.SplitWorker], shared: ChatPresetsDocument? = nil) -> ChatSetup {
        let list = all.filter { $0.agent == agent.rawValue }
        let fallback = ChatPresets.setup(for: .best, agent: agent, models: all, workers: workers, shared: shared)
            ?? ChatSetup(modelId: list.first?.id, level: list.first?.defaultLevel ?? list.first?.levels.first)
        guard let saved = self.all()[agent.rawValue] else { return fallback }
        if saved.preset != .custom {
            return ChatPresets.setup(for: saved.preset, agent: agent, models: all, workers: workers, shared: shared) ?? fallback
        }
        guard var setup = saved.setup, let chat = list.first(where: { $0.id == setup.modelId }) else { return fallback }
        if let level = setup.level, !chat.levels.contains(level) { setup.level = chat.defaultLevel ?? chat.levels.first }
        if agent != .claude || workers.isEmpty { setup.code = nil; setup.run = nil }
        if let code = setup.code, !workers.contains(where: { $0.id == code }) { setup.code = nil }
        if let run = setup.run, !workers.contains(where: { $0.id == run }) { setup.run = nil }
        return setup
    }

    public var lastWorkspace: String? {
        get { defaults.string(forKey: workspaceKey) }
        nonmutating set { defaults.set(newValue, forKey: workspaceKey) }
    }
}

/// The shared new chat presets as the Mac's phone view carries them (`presets`; docs/remote-channel.md, "New chat
/// presets"): three presets for Claude threads, each mixing models by role (the thread's model plans, `code` and
/// `run` name the subagent models), and a custom name per preset id. The Mac sends them resolved (its built-in
/// defaults with edits laid over); an older Mac sends only `setups.claude`, which is read when `presets` is absent.
/// The whole key is absent from a Mac older than the editor: built-in presets, no editor.
public struct ChatPresetsDocument: Codable, Equatable, Sendable {
    /// Preset id (`best`, `balanced`, `save`) to the custom name.
    public var names: [String: String]
    /// Preset id to a whole setup.
    public var presets: [String: ChatSetup]

    public init(names: [String: String] = [:], presets: [String: ChatSetup] = [:]) {
        self.names = names; self.presets = presets
    }

    private enum CodingKeys: String, CodingKey { case names, presets, setups }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        names = (try? c.decodeIfPresent([String: String].self, forKey: .names)) ?? [:]
        if let shared = try? c.decodeIfPresent([String: ChatSetup].self, forKey: .presets) {
            presets = shared
        } else {
            let old = (try? c.decodeIfPresent([String: [String: ChatSetup]].self, forKey: .setups)) ?? [:]
            presets = old["claude"] ?? [:]
        }
    }

    /// Only the shared shape: the phone never writes this document back to a Mac.
    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(names, forKey: .names)
        try c.encode(presets, forKey: .presets)
    }
}

/// One change to the shared presets: exactly one request, as the Mac reads it.
public enum PresetsChange: Equatable, Sendable {
    /// A preset's whole setup (send all fields).
    case setup(preset: ChatPreset, ChatSetup)
    /// A preset's name; nil, or the built-in title, removes it.
    case name(preset: ChatPreset, String?)
    /// Removes the preset's setup and name: back to the built-in one.
    case reset(preset: ChatPreset)

    /// The in-flight identity of the edit, so a newer edit of the same thing replaces the older one on screen.
    public var key: String {
        switch self {
        case .setup(let preset, _), .reset(let preset): "setup.\(preset.rawValue)"
        case .name(let preset, _): "name.\(preset.rawValue)"
        }
    }

    /// Puts the change into a document, as the Mac will once it has taken it. A reset drops the stored setup:
    /// the built-in one stands again.
    public func apply(to document: inout ChatPresetsDocument) {
        switch self {
        case .setup(let preset, let setup):
            document.presets[preset.rawValue] = setup
        case .name(let preset, let name):
            let clean = name.map { String($0.trimmingCharacters(in: .whitespacesAndNewlines).prefix(32)) }
            if let clean, !clean.isEmpty, clean != preset.title { document.names[preset.rawValue] = clean }
            else { document.names.removeValue(forKey: preset.rawValue) }
        case .reset(let preset):
            document.presets.removeValue(forKey: preset.rawValue)
            document.names.removeValue(forKey: preset.rawValue)
        }
    }
}

/// A signed change to the shared new chat presets. Reaches no agent, so no Face ID. Exactly these keys:
/// `agent` (always "claude", which a Mac from before the shared presets requires) only for `setup` and
/// `reset`, never for `name`.
public struct PresetsCommand: Encodable, Equatable, Sendable {
    public let v: Int
    public let kind: String
    public let request: PresetsChange
    public let nonce: String
    /// Epoch milliseconds.
    public let expiresAt: Int64

    private enum CodingKeys: String, CodingKey { case v, kind, agent, preset, change, nonce, expiresAt }
    private enum SetupKeys: String, CodingKey { case modelId, level, code, run, planFirst }
    private enum ChangeKeys: String, CodingKey { case setup, name, reset }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(v, forKey: .v)
        try c.encode(kind, forKey: .kind)
        try c.encode(nonce, forKey: .nonce)
        try c.encode(expiresAt, forKey: .expiresAt)
        var change = c.nestedContainer(keyedBy: ChangeKeys.self, forKey: .change)
        switch request {
        case .setup(let preset, let setup):
            try c.encode("claude", forKey: .agent)
            try c.encode(preset.rawValue, forKey: .preset)
            var s = change.nestedContainer(keyedBy: SetupKeys.self, forKey: .setup)
            // `modelId` is required by the Mac; the rest are explicit nulls when unset.
            try s.encode(setup.modelId ?? "", forKey: .modelId)
            if let level = setup.level { try s.encode(level, forKey: .level) } else { try s.encodeNil(forKey: .level) }
            if let code = setup.code { try s.encode(code, forKey: .code) } else { try s.encodeNil(forKey: .code) }
            if let run = setup.run { try s.encode(run, forKey: .run) } else { try s.encodeNil(forKey: .run) }
            try s.encode(setup.planFirst, forKey: .planFirst)
        case .name(let preset, let name):
            try c.encode(preset.rawValue, forKey: .preset)
            if let name { try change.encode(name, forKey: .name) } else { try change.encodeNil(forKey: .name) }
        case .reset(let preset):
            try c.encode("claude", forKey: .agent)
            try c.encode(preset.rawValue, forKey: .preset)
            try change.encode(true, forKey: .reset)
        }
    }
}
