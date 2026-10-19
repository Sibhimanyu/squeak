import Foundation

/// Where a session runs, for the sidebar's Sources filters. Derived from the provider string
/// (`conductor`, `<agent>-terminal`, `claude-desktop`, `codex-desktop` ...).
public enum SessionSource: String, CaseIterable, Hashable, Sendable {
    case conductor, terminal, claudeDesktop, codexApp, other

    public init(provider: String) {
        if provider == "conductor" { self = .conductor }
        else if provider.hasSuffix("-terminal") { self = .terminal }
        else if provider == "claude-desktop" || provider == "claude-cowork" { self = .claudeDesktop }
        else if provider == "codex-desktop" { self = .codexApp }
        else { self = .other }
    }

    public var title: String {
        switch self {
        case .conductor: "Conductor"
        case .terminal: "Terminal"
        case .claudeDesktop: "Claude Desktop"
        case .codexApp: "Codex app"
        case .other: "Other"
        }
    }

    /// Words for where a reply lands.
    public var replyDestination: String {
        switch self {
        case .conductor: "this Conductor chat"
        case .terminal: "this Terminal tab"
        case .claudeDesktop: "this Claude Desktop session"
        case .codexApp: "this Codex session"
        case .other: "this session"
        }
    }
}

public extension HostSession {
    var source: SessionSource { SessionSource(provider: key.provider) }
}

public extension ActivityPhrase {
    /// §8.2's third line while a session works: "running tests", "editing 2 files". Nil when the feed
    /// has no steps yet or the newest one is not recognised, so the row falls back to the state word.
    static func rowLine(_ steps: [ActivityStep]) -> String? {
        guard !steps.isEmpty else { return nil }
        let phrase = short(steps)
        guard phrase != "Working", let first = phrase.first else { return nil }
        return first.lowercased() + phrase.dropFirst()
    }
}

/// One short present-tense phrase for a working session's row ("Running tests", "Editing 2 files").
public enum ActivityPhrase {
    public static func short(_ steps: [ActivityStep]) -> String {
        guard let last = steps.last else { return "Working" }
        switch last.kind {
        case "thinking": return "Thinking"
        case "note", "text": return "Writing"
        case "background": return "Waiting on workers"
        default: break
        }
        let t = last.text
        let lower = t.lowercased()
        if lower.hasPrefix("edit") || lower.hasPrefix("write") {
            // Distinct files edited since the last step that was not an edit.
            var files = Set<String>()
            for step in steps.reversed() {
                guard step.kind == "tool" else { continue }
                let l = step.text.lowercased()
                guard l.hasPrefix("edit") || l.hasPrefix("write") else { break }
                files.insert(step.text.split(separator: " ", maxSplits: 1).dropFirst().first.map(String.init) ?? step.text)
            }
            return files.count <= 1 ? "Editing a file" : "Editing \(files.count) files"
        }
        if lower.hasPrefix("read") { return "Reading code" }
        if lower.hasPrefix("search") || lower.hasPrefix("find") { return "Searching code" }
        if lower.hasPrefix("run") || lower.hasPrefix("test") || lower.contains("test") {
            if lower.contains("test") || lower.contains("vitest") || lower.contains("pytest") || lower.contains("jest") { return "Running tests" }
            if lower.contains("build") || lower.contains("compile") || lower.contains("tsc") { return "Building" }
            if lower.contains("lint") { return "Linting" }
            if lower.contains("git ") { return "Checking git" }
            return "Running a command"
        }
        if lower.hasPrefix("fetch") || lower.contains("web") { return "Browsing the web" }
        if lower.hasPrefix("start") { return "Starting a helper" }
        if lower.hasPrefix("update the plan") { return "Planning" }
        return "Working"
    }
}
