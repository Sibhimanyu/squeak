import { detectProvider, type Availability, type BinaryLocator, type CommandRunner } from "./detect.js";
import type { CapabilityMatrix } from "./matrix.js";
import { PROVIDER_SPECS, type Implementation, type ProviderSpec } from "./providers.js";
import type { AgentProvider } from "../core/types.js";

export interface ProviderDiagnostic {
  provider: AgentProvider;
  label: string;
  implementation: Implementation;
  /** `not-applicable` for providers the user configures (custom command, ACP): there is nothing to probe. */
  availability: Availability | "not-applicable";
  version?: string;
  executable?: string;
  capabilities: CapabilityMatrix;
  /** One fixed sentence, or absent when nothing is wrong. */
  problem?: string;
}

export interface DiagnoseDeps {
  run: CommandRunner;
  locate?: BinaryLocator;
  specs?: readonly ProviderSpec[];
}

/** One row per provider, for a settings screen. A not-implemented provider is reported as such, installed or not. */
export async function diagnoseProviders(deps: DiagnoseDeps): Promise<ProviderDiagnostic[]> {
  const rows: ProviderDiagnostic[] = [];
  for (const spec of deps.specs ?? PROVIDER_SPECS) {
    const base = {
      provider: spec.provider,
      label: spec.label,
      implementation: spec.implementation,
      capabilities: spec.capabilities,
    };
    if (!spec.command) {
      rows.push({
        ...base,
        availability: "not-applicable",
        ...(spec.implementation === "not-implemented" ? { problem: `${spec.label} is not supported yet.` } : {}),
      });
      continue;
    }
    const d = await detectProvider(spec, deps.run, deps.locate);
    const problem =
      d.problem ?? (spec.implementation === "not-implemented" ? `${spec.label} is not supported yet.` : undefined);
    rows.push({
      ...base,
      availability: d.status,
      ...(d.version ? { version: d.version } : {}),
      ...(d.executable ? { executable: d.executable } : {}),
      ...(problem ? { problem } : {}),
    });
  }
  return rows;
}
