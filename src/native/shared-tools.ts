import { AgentTools, type AgentToolDeps } from "./agent-tools.js";
import { Placement } from "./placement.js";
import type { WorkspaceManager } from "./workspaces.js";
import { WorkspaceSources } from "./workspace-sources.js";

/**
 * The sources, Placement and agent tools the session host shares with the server and Flotilla. One Placement serves
 * both the server and the agents' branch tools (branch_off, join_branch): without it those tools refuse.
 */
export function createSharedTools(
  deps: Omit<AgentToolDeps, "placement" | "workspaces"> & { workspaces: WorkspaceManager },
): {
  sources: WorkspaceSources;
  placement: Placement;
  tools: AgentTools;
} {
  const sources = new WorkspaceSources({ store: deps.store, workspaces: deps.workspaces });
  const placement = new Placement({ store: deps.store, workspaces: deps.workspaces, sources });
  return { sources, placement, tools: new AgentTools({ ...deps, placement }) };
}
