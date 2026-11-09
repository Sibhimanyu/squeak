import type { AgentProvider } from "../core/types.js";
import { NO_CAPABILITIES, type CapabilityMatrix } from "./matrix.js";

export type Implementation = "implemented" | "not-implemented";

export interface ProviderSpec {
  provider: AgentProvider;
  label: string;
  /** Executable looked up and probed; absent for providers configured by the user (ACP, custom). */
  command?: string;
  versionFlag?: string;
  /** Oldest version this adapter is known to work with. */
  minVersion?: string;
  implementation: Implementation;
  capabilities: CapabilityMatrix;
}

const M = (over: Partial<CapabilityMatrix>): CapabilityMatrix => ({ ...NO_CAPABILITIES, ...over });

export const CLAUDE_MATRIX = M({
  launch: true,
  resume: true,
  attach: true,
  messages: true,
  questions: true,
  permissions: true,
  toolEvents: true,
  fileEvents: true,
  stop: true,
});

// Codex's runner answers approvals but refuses every other server request (user input), so questions stay false.
export const CODEX_MATRIX = M({
  launch: true,
  resume: true,
  attach: true,
  messages: true,
  permissions: true,
  toolEvents: true,
  fileEvents: true,
  stop: true,
});

export const CUSTOM_MATRIX = M({ launch: true, messages: true, stop: true });

/**
 * The floors are conservative: below them the stream-json / app-server shapes this repo's fixtures came from
 * are untested, so the report says unsupported instead of breaking later.
 */
export const PROVIDER_SPECS: readonly ProviderSpec[] = [
  {
    provider: "claudeCode",
    label: "Claude Code",
    command: "claude",
    versionFlag: "--version",
    minVersion: "2.0.0",
    implementation: "implemented",
    capabilities: CLAUDE_MATRIX,
  },
  {
    provider: "codex",
    label: "Codex",
    command: "codex",
    versionFlag: "--version",
    minVersion: "0.100.0",
    implementation: "implemented",
    capabilities: CODEX_MATRIX,
  },
  {
    provider: "openCode",
    label: "OpenCode",
    command: "opencode",
    versionFlag: "--version",
    implementation: "not-implemented",
    capabilities: NO_CAPABILITIES,
  },
  {
    provider: "gemini",
    label: "Gemini CLI",
    command: "gemini",
    versionFlag: "--version",
    implementation: "not-implemented",
    capabilities: NO_CAPABILITIES,
  },
  { provider: "acp", label: "ACP agent", implementation: "not-implemented", capabilities: NO_CAPABILITIES },
  { provider: "shell", label: "Custom command", implementation: "implemented", capabilities: CUSTOM_MATRIX },
];

export function specFor(provider: AgentProvider): ProviderSpec | undefined {
  return PROVIDER_SPECS.find((s) => s.provider === provider);
}
