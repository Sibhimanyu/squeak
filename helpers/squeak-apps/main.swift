// squeak-apps: the Mac's apps, for the phone's Mac controls page (src/fleet/mac-controls.ts).
//
//   squeak-apps running       JSON: the apps with a Dock icon now, which one is in front
//   squeak-apps installed     JSON: the apps in the Applications folders
//   squeak-apps quit <id>     asks a running app to quit, as the Dock's Quit does (it may ask to save)
//
// No permission is needed for any of it: NSWorkspace lists apps, and NSRunningApplication.terminate()
// is the polite quit, not a kill. It takes nothing else.
import AppKit

func emit(_ value: Any) {
    let data = try! JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data("\n".utf8))
}

let args = CommandLine.arguments
switch (args.count, args.count > 1 ? args[1] : "") {
case (2, "running"):
    let apps = NSWorkspace.shared.runningApplications.filter { $0.activationPolicy == .regular && $0.bundleIdentifier != nil }
    emit(apps.map { ["id": $0.bundleIdentifier!, "name": $0.localizedName ?? $0.bundleIdentifier!, "active": $0.isActive] })
case (2, "installed"):
    let home = FileManager.default.homeDirectoryForCurrentUser.path
    let folders = ["/Applications", "/Applications/Utilities", "/System/Applications", "/System/Applications/Utilities", "\(home)/Applications"]
    var seen = Set<String>()
    var apps: [[String: String]] = []
    for folder in folders {
        for entry in (try? FileManager.default.contentsOfDirectory(atPath: folder)) ?? [] where entry.hasSuffix(".app") {
            guard let bundle = Bundle(path: "\(folder)/\(entry)"), let id = bundle.bundleIdentifier, !seen.contains(id) else { continue }
            let info = bundle.infoDictionary ?? [:]
            // Agents and background tools have no window to open.
            if (info["LSUIElement"] as? Bool) == true || (info["LSBackgroundOnly"] as? Bool) == true { continue }
            let name = (info["CFBundleDisplayName"] as? String) ?? (info["CFBundleName"] as? String) ?? String(entry.dropLast(4))
            seen.insert(id)
            apps.append(["id": id, "name": name])
        }
    }
    emit(apps.sorted { $0["name"]!.localizedCaseInsensitiveCompare($1["name"]!) == .orderedAscending })
case (3, "quit"):
    guard let app = NSWorkspace.shared.runningApplications.first(where: { $0.bundleIdentifier == args[2] && $0.activationPolicy == .regular }) else {
        emit(["ok": false, "error": "not-running"]); exit(3)
    }
    emit(["ok": app.terminate()])
default:
    FileHandle.standardError.write(Data("usage: squeak-apps running|installed|quit <bundle id>\n".utf8))
    exit(64)
}
