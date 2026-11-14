import { logger } from "../utils/logger.js";

export interface StopStep {
  name: string;
  run: () => Promise<unknown> | unknown;
}

/**
 * Runs each shutdown step in order. A step that throws or hangs is logged with its name and the rest still run:
 * the steps that undo a lid/heat/awake change must not be skipped because an earlier one failed. `totalMs` bounds
 * the whole shutdown (launchd SIGKILLs after its own grace) and `stepMs` one step; steps left when the budget is
 * gone are logged as skipped. Returns the names of the steps that did not finish cleanly.
 */
export async function runStopSteps(
  steps: StopStep[],
  options: { stepMs?: number; totalMs?: number; log?: Pick<typeof logger, "warn"> } = {},
): Promise<string[]> {
  const stepMs = options.stepMs ?? 5000;
  const totalMs = options.totalMs ?? 15_000;
  const log = options.log ?? logger;
  const deadline = Date.now() + totalMs;
  const failed: string[] = [];
  for (const step of steps) {
    const left = deadline - Date.now();
    if (left <= 0) {
      log.warn(`shutdown: skipped "${step.name}" (shutdown budget of ${totalMs} ms used up)`);
      failed.push(step.name);
      continue;
    }
    const limit = Math.min(stepMs, left);
    let timer: NodeJS.Timeout | undefined;
    try {
      const outcome = await Promise.race([
        Promise.resolve()
          .then(step.run)
          .then(() => "ok" as const),
        new Promise<"timeout">((resolve) => {
          timer = setTimeout(() => resolve("timeout"), limit);
        }),
      ]);
      if (outcome === "timeout") {
        log.warn(`shutdown: "${step.name}" did not finish within ${limit} ms; moving on`);
        failed.push(step.name);
      }
    } catch (error) {
      log.warn(`shutdown: "${step.name}" failed`, { error: error instanceof Error ? error.message : String(error) });
      failed.push(step.name);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  return failed;
}
