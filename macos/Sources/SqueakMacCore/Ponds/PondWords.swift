import Foundation

// DESIGN.md §9: every project is a pond. "Pond" is the container the person works in (what the code called a
// project), "workspace" stays one git worktree. The words the app says for it live here so CI can pin them.

public enum PondWords {
    /// The sidebar's section.
    public static let sidebarHeader = "Ponds"
    /// The Create page's card, and the sidebar's tooltip.
    public static let newPond = "New pond"
    public static let openFolder = "Open a folder"
    public static let cloneRepository = "Clone a repository"
    /// The app menu's item.
    public static let openFolderAsPond = "Open folder as pond\u{2026}"
    public static let pickPond = "Pick a pond"
    public static let createHeader = "Start work, make a pond or join one."
    public static let createTooltip = "Start work, make a pond or join one"
    public static let noPonds = "No ponds yet. Add a folder to start."
    public static let loadingPonds = "Loading ponds\u{2026}"
    public static let openPondFirst = "Open a pond to see its worktrees."
    public static let makePondFirst = "Make a pond first, then start work in it."
    public static let noThreads = "No threads in this pond yet."
    public static let settings = "Pond settings"

    /// The one quiet line on a pond only this Mac can see.
    public static let onlyThisMac = "Only this Mac can see this pond until you invite someone."
    /// An invite needs a cloud store; there is nothing to publish to without one.
    public static let noCloud = "Set up a cloud store in Settings to invite people to a pond."
    public static let cantSignIn = "Squeak couldn\u{2019}t start sign-in. Check your cloud setup in Settings."

    public static func breadcrumb(_ pond: String) -> String { "Open \(pond)\u{2019}s dashboard" }
}

/// Joining a pond needs the Squeak account: the person's name there is the name the pond shows.
public enum PondJoinGate {
    public static let signInLine = "Sign in to Squeak to join a pond. Your name comes from your account."
    public static func needsSignIn(linked: Bool) -> Bool { !linked }
}

/// What the Invite button does first.
public enum PondInviteStart: Equatable, Sendable {
    /// No cloud store: say so in a plain sentence; there is nothing to start.
    case say(String)
    /// Signed out of the Squeak account: sign in, then continue to the invite.
    case signIn
    case invite

    public static func decide(cloud: Bool, linked: Bool) -> PondInviteStart {
        if !cloud { return .say(PondWords.noCloud) }
        return linked ? .invite : .signIn
    }
}

/// Every project is a pond: which of the sidebar's projects still have none on the host.
public enum LocalPondPlan {
    public struct Missing: Equatable, Sendable {
        public var name: String
        public var projectId: String?
        public var rootPath: String?
    }

    /// Project names (Conductor's, native, in any order) with no pond yet. Native projects carry their id and root, so
    /// the host ties the pond to the project; others are matched by name. A name appears once however often it is listed.
    public static func missing(names: [String], native: [NativeProject], ponds: [PondSummary]) -> [Missing] {
        var seen = Set<String>()
        var out: [Missing] = []
        for raw in names {
            let name = raw.trimmingCharacters(in: .whitespaces)
            guard !name.isEmpty, seen.insert(name.lowercased()).inserted else { continue }
            if PondLookup.pond(in: ponds, projectName: name, projects: native) != nil { continue }
            let project = NativeWorkspaceMaking.project(named: name, in: native)
            out.append(Missing(name: name, projectId: project?.id, rootPath: project?.rootPath))
        }
        return out
    }
}
