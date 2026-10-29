import { DEFAULT_HANDS_APP, runHands, type HandsOutcome } from "./conductor-ui.js";

export type GrantLevel = "granted" | "denied" | "notDetermined" | "notRunning";

/** What Squeak Hands holds, as the Mac app's permission explainer reads it. */
export type HandsGrants =
  | { outdated: false; accessibility: boolean; location: GrantLevel; automationTerminal: GrantLevel }
  /** No Hands, or a build from before the `grants` mode: the Mac says "Update Squeak Hands". */
  | { outdated: true; missing?: true };

export type HandsRunner = (appPath: string, mode: string, request: unknown) => Promise<HandsOutcome>;

const CACHE_MS = 2_000;
const LEVELS: readonly string[] = ["granted", "denied", "notDetermined", "notRunning"];

function level(value: unknown): GrantLevel {
  return typeof value === "string" && LEVELS.includes(value) ? (value as GrantLevel) : "notDetermined";
}

/** Turns one run of Hands' `grants` mode into the answer. Anything without a boolean `accessibility` is an old build. */
export function interpretGrants(outcome: HandsOutcome): HandsGrants {
  if (outcome.status === "missing") {
    return { outdated: true, missing: true };
  }
  if (outcome.status !== "result" || typeof outcome.result.accessibility !== "boolean") {
    return { outdated: true };
  }
  return {
    outdated: false,
    accessibility: outcome.result.accessibility,
    location: level(outcome.result.location),
    automationTerminal: level(outcome.result.automationTerminal),
  };
}

/** Reads Hands' grants, at most one launch per 2 s however many windows poll. */
export class HandsGrantsReader {
  private cached: { at: number; value: HandsGrants } | null = null;
  private inflight: Promise<HandsGrants> | null = null;

  constructor(
    private readonly appPath: string = DEFAULT_HANDS_APP,
    private readonly runner: HandsRunner = (app, mode, request) => runHands(app, mode, request, 10_000),
    private readonly now: () => number = Date.now,
  ) {}

  async read(): Promise<HandsGrants> {
    if (this.cached && this.now() - this.cached.at < CACHE_MS) {
      return this.cached.value;
    }
    this.inflight ??= this.runner(this.appPath, "grants", {})
      .catch((): HandsOutcome => ({ status: "no-result", detail: "launch failed" }))
      .then((outcome) => {
        const value = interpretGrants(outcome);
        this.cached = { at: this.now(), value };
        return value;
      })
      .finally(() => {
        this.inflight = null;
      });
    return this.inflight;
  }
}
