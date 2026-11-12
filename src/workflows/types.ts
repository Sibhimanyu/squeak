/**
 * Workflows, as core sees them: an agent session that is running a product with its own decision points waits on
 * the person for the product's own calls. Which product, what the calls are and how they are answered belong to the
 * add-on that provides it (addons/rasanai/); core only carries these opaque shapes through the fleet and the phone
 * view, marks the session as awaiting input, and hashes `revision` so a changed question republishes.
 */

/** What the fleet carries on a session whose workflow is waiting on the human. An add-on may add fields. */
export interface WorkflowStatus {
  /** The add-on's name for the product ("rasanai"). */
  provider: string;
  /** The product's project folder (the session's cwd). */
  projectDir: string;
  title: string | null;
  /** Changes whenever what is being asked changes; an answer names the revision it answers. */
  revision: string;
  /** When the human started being waited on (ISO). */
  since: string;
  /** One line for a card or a lock screen. */
  prompt: string;
}

/** Where a workflow stands, whether or not it waits on the human. Read-only; the add-on defines the rest. */
export interface WorkflowProgress {
  provider: string;
  [key: string]: unknown;
}
