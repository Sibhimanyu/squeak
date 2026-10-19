import Foundation

/// Question tools: the agent asks the human something and stops until they
/// answer. A question, not a permission approval — the tool_use is written
/// before the prompt appears, so a pending one is readable from a file.
/// Port of `src/fleet/pending-question.ts`.
enum PendingQuestion {
    static let tools: Set<String> = ["mcp__conductor__AskUserQuestion", "AskUserQuestion", "ExitPlanMode"]
    static let planDetail = "has a plan for you to review"

    /// The newest question-tool call in a Conductor assistant envelope
    /// (`{"type":"assistant","message":{"content":[…]}}`), or nil. Malformed
    /// JSON is nil.
    static func call(inEnvelope json: String) -> (id: String, detail: String)? {
        guard let data = json.data(using: .utf8),
              let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let message = root["message"] as? [String: Any],
              let blocks = message["content"] as? [Any]
        else { return nil }
        for raw in blocks.reversed() {
            guard let block = raw as? [String: Any], block["type"] as? String == "tool_use",
                  let name = block["name"] as? String, let id = block["id"] as? String, tools.contains(name)
            else { continue }
            return (id, detail(name: name, input: block["input"]))
        }
        return nil
    }

    static func detail(name: String, input: Any?) -> String {
        if name == "ExitPlanMode" { return planDetail }
        guard let questions = (input as? [String: Any])?["questions"] as? [Any],
              let first = questions.first as? [String: Any],
              let question = (first["question"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines),
              !question.isEmpty
        else { return "has a question for you" }
        let labels: [String] = ((first["options"] as? [Any]) ?? []).compactMap { option in
            if let s = option as? String, !s.isEmpty { return s }
            if let o = option as? [String: Any], let l = o["label"] as? String, !l.isEmpty { return l }
            return nil
        }
        let text = labels.isEmpty ? question : "\(question) [\(labels.joined(separator: " / "))]"
        let flat = text.split(whereSeparator: \.isWhitespace).joined(separator: " ")
        return flat.count <= 180 ? flat : String(flat.prefix(179)) + "…"
    }

    /// Every `tool_use_id` in the (possibly truncated) start of a user row.
    static func toolUseIds(in text: String) -> [String] {
        var ids: [String] = []
        var rest = Substring(text)
        let marker = #""tool_use_id":""#
        while let range = rest.range(of: marker) {
            rest = rest[range.upperBound...]
            if let end = rest.firstIndex(of: "\"") { ids.append(String(rest[..<end])) }
        }
        return ids
    }
}
