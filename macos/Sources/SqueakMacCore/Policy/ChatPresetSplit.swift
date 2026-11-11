import CoreGraphics
import Foundation

/// The soft fade where the transcript meets the dock (DESIGN.md §8.10): its height, and the transcript's bottom
/// padding, which is never less than the fade so the last line stays fully readable at the end.
public enum DockFade {
    public static let height = CGFloat(Tokens.Workbench.dockFadeHeight)
    public static func bottomPadding(base: CGFloat) -> CGFloat { max(base, height + 8) }
}

/// What a preset picked in an existing chat did: the setup it applied and whether its split still has to reach the
/// agent (it rides in front of the NEXT message, once). Kept per chat across launches.
public struct ChatSplitRecord: Codable, Equatable, Sendable {
    public var preset: ChatPreset
    public var setup: ChatSetup
    /// True until the next message in the chat is sent.
    public var pending: Bool
    public init(preset: ChatPreset, setup: ChatSetup, pending: Bool = true) {
        self.preset = preset; self.setup = setup; self.pending = pending
    }
}

public struct ChatSplitStore: @unchecked Sendable {
    private let defaults: UserDefaults
    private static let key = "squeak.mac.chat.presetSplits"
    public init(defaults: UserDefaults = .standard) { self.defaults = defaults }

    private func all() -> [String: ChatSplitRecord] {
        defaults.data(forKey: Self.key).flatMap { try? JSONDecoder().decode([String: ChatSplitRecord].self, from: $0) } ?? [:]
    }
    private func write(_ value: [String: ChatSplitRecord]) { defaults.set(try? JSONEncoder().encode(value), forKey: Self.key) }

    public func record(for chat: String) -> ChatSplitRecord? { all()[chat] }

    /// A preset was picked: its split is pending for the next message.
    public func applied(_ preset: ChatPreset, setup: ChatSetup, chat: String) {
        var v = all(); v[chat] = ChatSplitRecord(preset: preset, setup: setup); write(v)
    }

    /// A message was sent in the chat: a pending split has now gone with it.
    public func messageSent(chat: String) {
        var v = all()
        guard var r = v[chat], r.pending else { return }
        r.pending = false; v[chat] = r; write(v)
    }
}

/// The presets section of an existing Claude chat's model menu.
public enum ChatPresetMenu {
    public enum Match: Equatable, Sendable { case preset(ChatPreset), custom, none }

    /// Which preset the chat is on. A preset was applied here and the model, thinking level and split still match
    /// it: that preset. Applied and since changed (by hand, or by editing the preset): Custom. Never applied: none
    /// (the plain model list carries the checkmark).
    public static func match(modelId: String?, level: String?, record: ChatSplitRecord?, agent: NewChatAgent, models: [DaemonChatModel], preferences: ChatPresetPreferences) -> Match {
        guard agent == .claude, let record else { return .none }
        for p in ChatPresets.available(agent: agent, models: models) {
            guard let setup = preferences.setup(for: p, agent: agent, models: models) else { continue }
            if setup.modelId == modelId, setup.level == level, record.setup == setup { return .preset(p) }
        }
        return .custom
    }

    /// "Opus 5.5 · Sonnet codes · Haiku runs": the planner's name, then who codes and who runs.
    public static func subtitle(_ setup: ChatSetup, models all: [DaemonChatModel]) -> String {
        let chat = ChatPresets.models(all, .claude).first { $0.id == setup.modelId }
        var parts = [chat.map { ChatPresets.shortName($0.label) } ?? "Claude"]
        if let c = setup.code { parts.append("\(ChatPresets.workerName(c)) codes") }
        if let r = setup.run { parts.append("\(ChatPresets.workerName(r)) runs") }
        if setup.planFirst { parts.append("asks first") }
        return parts.joined(separator: " · ")
    }
}
