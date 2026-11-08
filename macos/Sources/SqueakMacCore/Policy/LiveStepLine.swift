import Foundation

/// The live row in the chat's dock (DESIGN.md §8.10): `<step> · <elapsed>`, "Editing store.test.ts · 1m 12s",
/// "Thinking · 40s". The same string the phone shows. No model name, no "Claude is working".
public enum LiveStepLine {
    /// The newest step in plain words: a single edited file by name, else `ActivityPhrase`.
    public static func step(_ steps: [ActivityStep]) -> String {
        if let last = steps.last, last.kind == "tool" {
            let lower = last.text.lowercased()
            if lower.hasPrefix("edit") || lower.hasPrefix("write") {
                var files = Set<String>()
                for step in steps.reversed() {
                    guard step.kind == "tool" else { continue }
                    let l = step.text.lowercased()
                    guard l.hasPrefix("edit") || l.hasPrefix("write") else { break }
                    if let rest = step.text.split(separator: " ", maxSplits: 1).dropFirst().first {
                        files.insert((String(rest) as NSString).lastPathComponent)
                    }
                }
                if files.count == 1, let one = files.first, !one.isEmpty { return "Editing \(one)" }
            }
        }
        return ActivityPhrase.short(steps)
    }

    public static func line(steps: [ActivityStep], since: Date?, now: Date) -> String {
        let s = step(steps)
        guard let since else { return s }
        return "\(s) · \(ElapsedFormat.short(now.timeIntervalSince(since)))"
    }
}
