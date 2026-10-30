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

    private static func rank(_ model: PhoneSnapshot.ChatModel) -> Int {
        let name = (model.id + " " + model.label).lowercased()
        if name.contains("fable") { return 0 }
        if name.contains("opus") { return 1 }
        return 2
    }

    /// The strongest model offered: Fable, then Opus, else the Mac's first.
    private static func strongest(_ list: [PhoneSnapshot.ChatModel]) -> PhoneSnapshot.ChatModel? {
        list.enumerated().min { (rank($0.element), $0.offset) < (rank($1.element), $1.offset) }?.element
    }

    /// A lighter planner for saving usage: a Sonnet, else the Mac's first model that is not the strongest.
    private static func lighter(_ list: [PhoneSnapshot.ChatModel]) -> PhoneSnapshot.ChatModel? {
        if let sonnet = list.first(where: { ($0.id + $0.label).lowercased().contains("sonnet") }) { return sonnet }
        let top = strongest(list)
        return list.first { $0.id != top?.id } ?? top
    }

    private static func worker(_ named: String, in workers: [PhoneSnapshot.SplitWorker]) -> String? {
        workers.first { ($0.id + " " + $0.label).lowercased().contains(named) }?.id
    }

    /// The setting a preset stands for, or nil when the Mac's lists cannot back it (`custom` is never derived).
    /// `shared` is the Mac's stored presets (the view's `presets`): a stored setup for this agent and preset
    /// replaces the built-in rule below once it is checked against the Mac's lists; absent, today's behaviour.
    public static func setup(for preset: ChatPreset, agent: NewChatAgent,
                             models all: [PhoneSnapshot.ChatModel], workers: [PhoneSnapshot.SplitWorker],
                             shared: ChatPresetsDocument? = nil) -> ChatSetup? {
        let builtIn = builtInSetup(for: preset, agent: agent, models: all, workers: workers)
        guard preset != .custom, let stored = shared?.setups[agent.rawValue]?[preset.rawValue] else { return builtIn }
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

    private static func builtInSetup(for preset: ChatPreset, agent: NewChatAgent,
                                     models all: [PhoneSnapshot.ChatModel], workers: [PhoneSnapshot.SplitWorker]) -> ChatSetup? {
        let list = models(all, agent)
        let delegates = agent == .claude
        switch preset {
        case .custom:
            return nil
        case .best:
            guard let top = strongest(list) else { return list.isEmpty && !delegates ? ChatSetup() : nil }
            let level = top.levels.contains("high") ? "high" : top.defaultLevel ?? top.levels.first
            return ChatSetup(modelId: top.id, level: level)
        case .balanced:
            guard delegates, let top = strongest(list), let coder = worker("sonnet", in: workers) else { return nil }
            return ChatSetup(modelId: top.id, level: top.defaultLevel ?? top.levels.first, code: coder)
        case .save:
            guard delegates, let planner = lighter(list), let coder = worker("sonnet", in: workers),
                  let runner = worker("haiku", in: workers) else { return nil }
            return ChatSetup(modelId: planner.id, level: planner.defaultLevel ?? planner.levels.first, code: coder, run: runner, planFirst: true)
        }
    }

    /// The presets worth showing: only those the Mac can back, and only when there is a choice.
    public static func available(agent: NewChatAgent, models: [PhoneSnapshot.ChatModel],
                                 workers: [PhoneSnapshot.SplitWorker], shared: ChatPresetsDocument? = nil) -> [ChatPreset] {
        let shown = [ChatPreset.best, .balanced, .save].filter {
            setup(for: $0, agent: agent, models: models, workers: workers, shared: shared) != nil
        }
        return shown.count > 1 ? shown : []
    }

    /// Which preset a setting is, or `custom` when it matches none: editing a detail turns the label
    /// into "Custom" without any other bookkeeping.
    public static func preset(of setup: ChatSetup, agent: NewChatAgent,
                              models: [PhoneSnapshot.ChatModel], workers: [PhoneSnapshot.SplitWorker],
                              shared: ChatPresetsDocument? = nil) -> ChatPreset {
        for candidate in [ChatPreset.best, .balanced, .save]
        where Self.setup(for: candidate, agent: agent, models: models, workers: workers, shared: shared) == setup {
            return candidate
        }
        return .custom
    }

    /// "Opus 5.5 · 1M" is "Opus 5.5": the context size is not what a person picks by.
    public static func shortName(_ label: String) -> String {
        label.components(separatedBy: " · ").first ?? label
    }

    public static func levelName(_ level: String) -> String {
        level == "xhigh" ? "extra high" : level
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
/// presets"). Only what a person changed: a name per preset id, and per agent and preset a whole setup that
/// replaces the built-in one. Absent from an older Mac, which keeps today's built-in presets and hides editing.
public struct ChatPresetsDocument: Codable, Equatable, Sendable {
    /// Preset id (`best`, `balanced`, `save`) to the custom name; shared by both agents.
    public var names: [String: String]
    /// Agent (`claude`, `codex`), then preset id, to a whole setup.
    public var setups: [String: [String: ChatSetup]]

    public init(names: [String: String] = [:], setups: [String: [String: ChatSetup]] = [:]) {
        self.names = names; self.setups = setups
    }

    private enum CodingKeys: String, CodingKey { case names, setups }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        names = (try? c.decodeIfPresent([String: String].self, forKey: .names)) ?? [:]
        setups = (try? c.decodeIfPresent([String: [String: ChatSetup]].self, forKey: .setups)) ?? [:]
    }
}

/// One change to the shared presets: exactly one request, as the Mac reads it.
public enum PresetsChange: Equatable, Sendable {
    /// A preset's whole setup for one agent (send all fields).
    case setup(agent: NewChatAgent, preset: ChatPreset, ChatSetup)
    /// A preset's name; nil, or the built-in title, removes it.
    case name(preset: ChatPreset, String?)
    /// Removes that agent's setup and the preset's name.
    case reset(agent: NewChatAgent, preset: ChatPreset)

    /// The in-flight identity of the edit, so a newer edit of the same thing replaces the older one on screen.
    public var key: String {
        switch self {
        case .setup(let agent, let preset, _), .reset(let agent, let preset): "\(agent.rawValue).\(preset.rawValue)"
        case .name(let preset, _): "name.\(preset.rawValue)"
        }
    }

    /// Puts the change into a document, as the Mac will once it has taken it.
    public func apply(to document: inout ChatPresetsDocument) {
        switch self {
        case .setup(let agent, let preset, let setup):
            document.setups[agent.rawValue, default: [:]][preset.rawValue] = setup
        case .name(let preset, let name):
            let clean = name.map { String($0.trimmingCharacters(in: .whitespacesAndNewlines).prefix(32)) }
            if let clean, !clean.isEmpty, clean != preset.title { document.names[preset.rawValue] = clean }
            else { document.names.removeValue(forKey: preset.rawValue) }
        case .reset(let agent, let preset):
            document.setups[agent.rawValue]?.removeValue(forKey: preset.rawValue)
            if document.setups[agent.rawValue]?.isEmpty == true { document.setups.removeValue(forKey: agent.rawValue) }
            document.names.removeValue(forKey: preset.rawValue)
        }
    }
}

/// A signed change to the shared new chat presets. Reaches no agent, so no Face ID. Exactly these keys:
/// `agent` only for `setup` and `reset`, never for `name`.
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
        case .setup(let agent, let preset, let setup):
            try c.encode(agent.rawValue, forKey: .agent)
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
        case .reset(let agent, let preset):
            try c.encode(agent.rawValue, forKey: .agent)
            try c.encode(preset.rawValue, forKey: .preset)
            try change.encode(true, forKey: .reset)
        }
    }
}
