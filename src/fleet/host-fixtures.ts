import type { SourceRules } from "./types.js";

/** What a test host that behaves like Conductor declares (the add-on's observer declares the real one). */
const CONDUCTOR_RULES: SourceRules = {
  label: "Conductor",
  authoritative: { precedence: 10, graceMs: 30_000 },
  hostManagedLiveness: true,
  actionable: true,
};

interface HostLike {
  hostId?: string;
  conductorSessionId?: string | null;
  conductorWorkspaceId?: string | null;
  origin?: string;
  source?: string;
  rules?: SourceRules;
}

/** Test support: what the Conductor observer adds, derived from the legacy conductor* fields of a fixture. */
export function withConductorHost<T extends HostLike>(fixture: T): T {
  if (fixture.hostId) return fixture;
  if (!fixture.conductorSessionId && fixture.origin !== "conductor" && fixture.source !== "conductor") return fixture;
  return {
    ...fixture,
    hostId: "conductor",
    hostSessionId: fixture.conductorSessionId ?? null,
    hostWorkspaceId: fixture.conductorWorkspaceId ?? null,
    rules: CONDUCTOR_RULES,
  };
}
