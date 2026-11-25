import { AgentTools, type AgentToolDeps } from "./agent-tools.js";
import { Placement } from "./placement.js";
import type { WorkspaceManager } from "./workspaces.js";
import { WorkspaceSources } from "./workspace-sources.js";

/**
 * The sources, Placement and agent tools the session host shares with the server and Flotilla. One Placement serves
 * both the server and the agents' branch tools (streams, open_stream, leave_stream): without it those tools refuse.
 */
export function createSharedTools(
  deps: Omit<AgentToolDeps, "placement" | "workspaces"> & {
    workspaces: WorkspaceManager;
    /** Already built by the caller (main.ts, which the chat starter needs too); made here when absent. */
    sources?: WorkspaceSources;
    placement?: Placement;
  },
): {
  sources: WorkspaceSources;
  placement: Placement;
  tools: AgentTools;
} {
  const sources = deps.sources ?? new WorkspaceSources({ store: deps.store, workspaces: deps.workspaces });
  const placement = deps.placement ?? new Placement({ store: deps.store, workspaces: deps.workspaces, sources });
  const toolDeps: Record<string, unknown> = { ...deps };
  delete toolDeps.sources;
  return { sources, placement, tools: new AgentTools({ ...(toolDeps as typeof deps), placement }) };
}
