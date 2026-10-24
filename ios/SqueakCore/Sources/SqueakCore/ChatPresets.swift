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
    public static func setup(for preset: ChatPreset, agent: NewChatAgent,
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
                                 workers: [PhoneSnapshot.SplitWorker]) -> [ChatPreset] {
        let shown = [ChatPreset.best, .balanced, .save].filter { setup(for: $0, agent: agent, models: models, workers: workers) != nil }
        return shown.count > 1 ? shown : []
    }

    /// Which preset a setting is, or `custom` when it matches none: editing a detail turns the label
    /// into "Custom" without any other bookkeeping.
    public static func preset(of setup: ChatSetup, agent: NewChatAgent,
                              models: [PhoneSnapshot.ChatModel], workers: [PhoneSnapshot.SplitWorker]) -> ChatPreset {
        for candidate in [ChatPreset.best, .balanced, .save]
        where Self.setup(for: candidate, agent: agent, models: models, workers: workers) == setup {
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
                        workers: [PhoneSnapshot.SplitWorker]) -> ChatSetup {
        let list = all.filter { $0.agent == agent.rawValue }
        let fallback = ChatPresets.setup(for: .best, agent: agent, models: all, workers: workers)
            ?? ChatSetup(modelId: list.first?.id, level: list.first?.defaultLevel ?? list.first?.levels.first)
        guard let saved = self.all()[agent.rawValue] else { return fallback }
        if saved.preset != .custom {
            return ChatPresets.setup(for: saved.preset, agent: agent, models: all, workers: workers) ?? fallback
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
