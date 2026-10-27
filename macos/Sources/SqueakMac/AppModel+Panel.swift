import Foundation
import SqueakMacCore

/// What the menu-bar panel's Mac strip says, read from state the model already holds.
extension AppModel {
    /// "Awake until 6:30 PM", "Awake · Low Power Mode" or nil when the Mac is not being kept awake.
    var panelAwakeLine: String? {
        guard let awake else { return nil }
        var line = AwakeFormat.headline(awake).replacingOccurrences(of: "On until", with: "Awake until")
        if line.hasPrefix("On ") { line = "Awake " + line.dropFirst(3) }
        if let safety = awake.safety { line += " · \(safety)" } else if awake.lowPower { line += " · Low Power Mode" }
        if awake.lid { line += " · lid closed OK" }
        return line
    }

    /// One line for plan usage: "Claude 5h 58% · 7d 90% · Codex 70%" (percent left); nil before any reading.
    var panelUsageLine: String? {
        guard let usage else { return nil }
        func short(_ w: UsageWindow) -> String {
            UsageFormat.left(w.usedPercent, resetsAt: w.resetsAt).replacingOccurrences(of: " left", with: "")
        }
        var parts: [String] = []
        if let c = usage.claude {
            var s = "Claude"
            if let w = c.fiveHour { s += " 5h " + short(w) }
            if let w = c.longWindow { s += " · 7d " + short(w) }
            parts.append(s)
        }
        if let x = usage.codex, let w = x.fiveHour ?? x.longWindow {
            parts.append("Codex " + short(w))
        }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }

    /// Opens the Usage screen in the conversation window. Only navigation: nothing is fetched or sent.
    func openUsage() {
        navFilter = .usage
        showConversationWindow()
    }
}
