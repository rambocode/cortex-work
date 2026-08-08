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

/** pi 模型的思考档能力子集（CatalogModel 兼容形状,只取过滤所需字段）。 */
export interface PiThinkingCapability {
  reasoning: boolean;
  thinkingLevelMap?: Record<string, string | null>;
}

/**
 * 该 pi 模型实际支持的思考档。规则逐条对齐 pi-ai 的 `getSupportedThinkingLevels`
 * （models.js,升级 pi 时复核）:reasoning=false 只有 off;map 里显式 null 的档剔除;
 * xhigh/max 必须显式映射才可用;未列出的档（undefined）视为支持。
 * 模型信息缺失（未认证/自定义未配能力）→ 返回全档,保守不过滤。
 *
 * 背景:deepseek-v4 系的 map 把 minimal/low/medium 全标 null,pi 会把这些档静默 clamp
 * 到 high——UI 若照旧展示 7 档,就会出现「选中显示"中"、实际发包 high」的漂移（实测）。
 */
export function piSupportedThinkingLevels(
  model: PiThinkingCapability | null | undefined,
): ThinkingLevel[] {
  if (!model) return [...PI_THINKING_LEVELS];
  if (!model.reasoning) return ["off"];
  return PI_THINKING_LEVELS.filter((level) => {
    const mapped = model.thinkingLevelMap?.[level];
    if (mapped === null) return false;
    if (level === "xhigh" || level === "max") return mapped !== undefined;
    return true;
  });
}

/**
 * 把任意档 clamp 成该模型的实际生效档,算法逐条对齐 pi-ai 的 `clampThinkingLevel`
 * （命中直返;否则从请求档先向上、再向下找最近可用档）。UI 用它显示「实际生效档」,
 * 保证与 pi 内部 clamp 结果一致,不再显示一个不会生效的档。
 */
export function clampPiThinkingLevel(
  model: PiThinkingCapability | null | undefined,
  level: ThinkingLevel,
): ThinkingLevel {
  const available = piSupportedThinkingLevels(model);
  if (available.includes(level)) return level;
  const requested = PI_THINKING_LEVELS.indexOf(level);
  if (requested === -1) return available[0] ?? "off";
  for (let i = requested; i < PI_THINKING_LEVELS.length; i += 1) {
    const candidate = PI_THINKING_LEVELS[i]!;
    if (available.includes(candidate)) return candidate;
  }
  for (let i = requested - 1; i >= 0; i -= 1) {
    const candidate = PI_THINKING_LEVELS[i]!;
    if (available.includes(candidate)) return candidate;
  }
  return available[0] ?? "off";
}
