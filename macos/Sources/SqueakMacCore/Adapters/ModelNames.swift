import Foundation

/// The one place a raw model id becomes a name a person reads on the Mac. It follows the daemon's
/// `modelLabel` (`src/fleet/chat-models.ts`), which names every model in `/control/models`: Conductor
/// aliases (`opus-5-5-1m`), the claude CLI's catalog ids (`claude-opus-5-5[1m]`) and Codex ids
/// (`gpt-6.1-sol`) read "Opus 5.5 · 1M" and "GPT 6.1 Sol". An unknown id has its dashes turned into
/// spaces and is capitalised; brackets never show. Effort ("Medium") is a separate label.
public enum ModelNames {
    public static func display(_ id: String) -> String {
        var text = id.trimmingCharacters(in: .whitespaces).lowercased()
        var bracketContext: String?
        if text.hasSuffix("]"), let open = text.lastIndex(of: "[") {
            let inner = text[text.index(after: open)..<text.index(before: text.endIndex)]
            if inner.count >= 2, inner.hasSuffix("m"), inner.dropLast().allSatisfy(\.isNumber) {
                bracketContext = inner.uppercased()
                text = String(text[..<open])
            }
        }
        text = String(text.map { $0 == "[" || $0 == "]" ? " " : $0 })
        if text.hasPrefix("claude-") { text.removeFirst("claude-".count) }
        if let r = text.range(of: #"-\d{8}$"#, options: .regularExpression) { text.removeSubrange(r) }
        var parts = text.split(whereSeparator: { "-_ ".contains($0) }).map(String.init)
        var context = bracketContext
        if context == nil, parts.last == "1m" { context = "1M"; parts.removeLast() }
        var name: [String] = [], version: [String] = []
        for word in parts {
            if word.allSatisfy({ $0.isNumber || $0 == "." }), word.first?.isNumber == true, word.last?.isNumber == true {
                version.append(word)
            } else {
                name.append(word == "gpt" ? "GPT" : word.prefix(1).uppercased() + word.dropFirst())
            }
        }
        let base = (Array(name.prefix(1)) + [version.joined(separator: ".")] + Array(name.dropFirst())).filter { !$0.isEmpty }
            .joined(separator: " ")
        let label = context.map { "\(base) · \($0)" } ?? base
        return label.isEmpty ? id : label
    }

    /// The catalog entry a chat's stored model is: its own id, else the one the daemon names the same.
    public static func match(_ raw: String?, in choices: [DaemonChatModel]) -> DaemonChatModel? {
        guard let raw, !raw.isEmpty else { return nil }
        if let exact = choices.first(where: { $0.id == raw }) { return exact }
        let shown = display(raw)
        return choices.first { display($0.id) == shown }
    }

    /// What a chat's model reads as: the catalog's label when it lists it, else the formatted id.
    public static func label(_ raw: String?, in choices: [DaemonChatModel]) -> String {
        guard let raw, !raw.isEmpty else { return "" }
        return match(raw, in: choices)?.label ?? display(raw)
    }

    /// The composer picker's label: the model's name, then the effort when it has one ("Opus 5.5 · 1M · Medium").
    public static func composerLabel(model raw: String?, effort: String?, in choices: [DaemonChatModel]) -> String {
        [label(raw, in: choices), effort.map(DaemonChatModel.levelName) ?? ""].filter { !$0.isEmpty }.joined(separator: " · ")
    }
}
