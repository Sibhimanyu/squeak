import Foundation
import SqueakCore

/// The words of Home's Mac status strip: awake, lid, power, or a Mac that is not answering. A pure function of
/// what the Mac already sends; nothing here decides anything, it only picks wording (shared with Settings through
/// `AwakeFormat` and `AppModel.awakeLeft`). nil means the strip stays hidden.
struct MacStrip: Equatable {
    enum Tone: Equatable { case awake, off, failed, silent }

    /// The awake session as the phone shows it (`AppModel.AwakeStatus` maps onto this).
    struct Awake: Equatable {
        var until: Date?
        var lid: String? = nil
        var safety: String? = nil
        var pending = false
    }

    var tone: Tone
    /// One or two short lines.
    var lines: [String]

    /// One VoiceOver sentence: the dot's meaning in words, then the lines.
    var spoken: String {
        let lead: String
        switch tone {
        case .awake: lead = "Mac awake"
        case .off: lead = "Mac"
        case .failed: lead = "Mac needs a look"
        case .silent: lead = "Mac not answering"
        }
        let body = lines.joined(separator: ". ")
        return body.hasPrefix(lead) ? body : "\(lead). \(body)"
    }

    static func compose(
        awake: Awake?, power: PhoneSnapshot.MacPower?, liveness: MacLiveness,
        sleepProblem: String? = nil, lastEnd: PhoneSnapshot.AwakeEnd? = nil, offered: Bool = true,
        hotspot: PhoneSnapshot.Hotspot? = nil, now: Date = Date(), locale: Locale = .current
    ) -> MacStrip? {
        // A Mac that stopped answering left its awake and battery readings behind: say so instead of them.
        if case .silent(let since) = liveness {
            let heard = "Last heard \(Age.sync(since, now: now))"
            if let advice = offlineAdvice(awake: awake != nil, hotspot: hotspot) {
                return MacStrip(tone: .silent, lines: ["Mac offline · \(heard.lowercased())", advice.long])
            }
            return MacStrip(tone: .silent, lines: ["Mac not answering", heard])
        }
        guard offered else { return nil }

        let lid = lidText(awake: awake, power: power)
        guard let awake else {
            // Off: nothing to say unless something is wrong, the lid is shut, or a safety rule just ended a session.
            if let sleepProblem { return MacStrip(tone: .failed, lines: ["Sleep is still turned off", sleepProblem]) }
            if let ended = AwakeFormat.ended(lastEnd, now: now) { return MacStrip(tone: .off, lines: [ended]) }
            if power?.lidClosed == true { return MacStrip(tone: .off, lines: ["Lid closed · Sleeps as usual"]) }
            return nil
        }

        let first: String
        if awake.pending {
            first = "Starting…"
        } else if let until = awake.until {
            let time = until.formatted(.dateTime.hour().minute().locale(locale))
            first = "Awake until \(time) · \(AwakeFormat.left(until, now: now)) left"
        } else {
            first = "Kept awake until you end it"
        }
        var second = [lid.text]
        if let p = powerText(awake: awake, power: power) { second.append(p) }
        return MacStrip(tone: lid.failed ? .failed : .awake, lines: [first, second.joined(separator: " · ")])
    }

    /// What to do about a Mac that stopped answering during an awake session. It is meant to stay awake, so
    /// the likely cause is its internet, and the hotspot is how it gets back: iOS advertises Personal Hotspot
    /// only while its screen is open, and no app may turn it on (src/fleet/hotspot.ts). nil without an awake
    /// session, where an asleep Mac is the usual reason. `short` is for the connection bar.
    static func offlineAdvice(awake: Bool, hotspot: PhoneSnapshot.Hotspot?) -> (short: String, long: String)? {
        guard awake else { return nil }
        guard let hotspot, hotspot.configured, hotspot.enabled else {
            return ("may have lost its internet",
                    "It may have lost its internet. Set up a hotspot in Squeak's Settings so it can get back on.")
        }
        if hotspot.onHotspot {
            return ("check your iPhone's hotspot",
                    "It was on your hotspot. Check Personal Hotspot is still on and this iPhone has signal.")
        }
        return ("open Personal Hotspot on this iPhone",
                "Open Settings › Personal Hotspot on this iPhone and stay a few seconds. Your Mac joins it by itself.")
    }

    private static func lidText(awake: Awake?, power: PhoneSnapshot.MacPower?) -> (text: String, failed: Bool) {
        switch awake?.lid {
        case "on": return ("Lid closed OK", false)
        case "starting": return ("Getting ready for a closed lid", false)
        case "failed": return ("Lid closed didn't turn on", true)
        default: return (power?.lidClosed == true ? "Lid closed" : "Lid open only", false)
        }
    }

    /// A safety rule's own sentence from the Mac ("Low Power Mode on · Battery at 38%") when one is acting,
    /// else the battery as Settings words it.
    private static func powerText(awake: Awake, power: PhoneSnapshot.MacPower?) -> String? {
        if let safety = awake.safety { return safety }
        guard let percent = power?.percent else { return nil }
        guard let onBattery = power?.onBattery else { return "\(percent)%" }
        return "\(percent)% \(onBattery ? "on battery" : "plugged in")"
    }
}
