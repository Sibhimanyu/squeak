import Foundation

/// The `/` list on the New duck page: the skills and commands of the chosen model's agent in the folder the duck
/// will start in, the same list a running chat of that agent offers.
public enum NewDuckSlash {
    /// Claude: the host's list (on disk, plugins included), the local scan when the host gave nothing. Codex has no
    /// host list, so it gets the local scan, exactly as its running chat does.
    public static func list(agent: NewChatAgent, cwd: String?, home: String = NSHomeDirectory(),
                            host: () async -> [SlashCommand]) async -> [SlashCommand] {
        let custom = SlashCommands.custom(cwd: cwd, home: home)
        guard agent == .claude else { return custom }
        let onDisk = await host()
        return onDisk.isEmpty ? custom : SlashCommands.combined(host: onDisk, fromInit: [])
    }

    /// Changes with the agent or the folder, so the picker drops its cached list when the model chip or place changes.
    public static func identity(agent: NewChatAgent, folder: String?) -> String {
        "new-duck|" + agent.rawValue + "|" + (folder ?? "")
    }
}

/// Where the New duck page's block sits in the space below the bar: centred, nudged a little above true centre.
public enum NewDuckLayout {
    /// Of the free space, the share above the block (0.5 is true centre); 0.42 puts the middle a touch high.
    public static let above = 0.42

    /// The block's top edge inside a viewport of `viewport` points. Never negative: a block as tall as the viewport or
    /// taller starts at the top and scrolls.
    public static func top(viewport: Double, content: Double) -> Double {
        max(0, (viewport - content) * above)
    }

    /// The scrolled content's height: the viewport when the block fits, else the block.
    public static func height(viewport: Double, content: Double) -> Double { max(viewport, content) }
}
