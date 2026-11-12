/** The work between two messages of a chat, for the phone's "Worked · N steps" row. A host reads it from its own rows. */

export const WORK_STEP_CHARS = 200;
export const WORK_STEPS_MAX = 200;

export interface WorkStep {
  kind: "tool" | "thinking";
  text: string;
}

export interface WorkSteps {
  steps: WorkStep[];
  /** Steps past the first `WORK_STEPS_MAX`, left out. */
  more: number;
}
