import type { AgentKind, ReasoningEffort, ThinkingLevel } from "./types";
import { PI_THINKING_LEVELS } from "./types";

export const DEFAULT_AGENT_THINKING = "default";

export type AgentThinkingValue = typeof DEFAULT_AGENT_THINKING | ReasoningEffort | ThinkingLevel;

export interface AgentThinkingOption {
  value: AgentThinkingValue;
  labelKey: string;
}

const REASONING_EFFORTS: ReasoningEffort[] = ["low", "medium", "high"];

export function agentThinkingOptions(agent: AgentKind): AgentThinkingOption[] {
  if (agent === "pi") {
    return PI_THINKING_LEVELS.map((value) => ({ value, labelKey: `composer.thinkingLevel.${value}` }));
  }
  return [
    { value: DEFAULT_AGENT_THINKING, labelKey: "composer.thinkingLevel.default" },
    ...REASONING_EFFORTS.map((value) => ({ value, labelKey: `composer.thinkingLevel.${value}` })),
  ];
}

export function effortFromThinkingValue(value: AgentThinkingValue): ReasoningEffort | undefined {
  return REASONING_EFFORTS.includes(value as ReasoningEffort) ? (value as ReasoningEffort) : undefined;
}

export function isCommonThinkingValue(value: AgentThinkingValue | undefined): value is ReasoningEffort {
  return REASONING_EFFORTS.includes(value as ReasoningEffort);
}

export function mapThinkingForAgent(agent: AgentKind, value: AgentThinkingValue | undefined): {
  effort?: ReasoningEffort;
  thinkingLevel?: ThinkingLevel;
} {
  if (agent === "pi") {
    return { effort: undefined, thinkingLevel: value === DEFAULT_AGENT_THINKING ? undefined : (value as ThinkingLevel | undefined) };
  }
  return { effort: effortFromThinkingValue(value ?? DEFAULT_AGENT_THINKING), thinkingLevel: undefined };
}

export function mapThinkingAcrossAgents(
  fromAgent: AgentKind,
  toAgent: AgentKind,
  value: AgentThinkingValue | undefined,
): { effort?: ReasoningEffort; thinkingLevel?: ThinkingLevel } {
  const common = isCommonThinkingValue(value) ? value : undefined;
  if (fromAgent === toAgent) return mapThinkingForAgent(toAgent, value);
  return mapThinkingForAgent(toAgent, common);
}
