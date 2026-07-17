// Kun @shared/app-settings(-types/-design) 的 compat 垫层：
// - DesignSettings 类型本体在 ../../desktop/design-types（与主进程双镜像），此处仅换名再导出
//   为 Kun 命名（DesignSettingsV1），使移植代码零改动。
// - 归一化/默认值逻辑照搬 Kun app-settings-design.ts（上限常量与枚举全保留）。
// - AppSettingsV1/ApprovalPolicy/SandboxMode 为最小结构版：design 树只把它们当类型透传。
import type {
  DesignSettings,
  DesignSystemPreset,
} from "../../desktop/design-types";
import type { AgentKind, DerivedAgentMeta, ProviderSettings } from "../../desktop/types";

export type { DesignSystemPreset };
// Kun 命名兼容别名（移植代码里以 DesignSettingsV1 引用）。
export type DesignSettingsV1 = DesignSettings;
export type DesignSettingsPatchV1 = Partial<DesignSettingsV1>;

// 最小 AppSettingsV1：design 树只读取 .design 分片（其余字段 Kun 专属，不移植）。
export type AppSettingsV1 = { design: DesignSettingsV1 } & Record<string, unknown>;

// 与 Kun kun/src/contracts/policy.ts 的枚举值保持一致（agent-types 的类型字段引用）。
export type ApprovalPolicy = "always" | "on-request" | "untrusted" | "never" | "auto" | "suggest";
export type SandboxMode = "read-only" | "workspace-write" | "danger-full-access" | "external-sandbox";

export const DESIGN_SYSTEM_PRESETS: readonly DesignSystemPreset[] = [
  "none",
  "shadcn",
  "radix",
  "material",
  "ios",
  "fluent",
  "ant",
  "chakra",
  "carbon",
  "polaris",
  "bootstrap",
  "geist",
  "brutalism",
  "editorial",
];

const DESIGN_TYPES = ["", "brand", "product"] as const;
const DESIGN_VIEWPORTS = ["mobile", "tablet", "desktop"] as const;
const DESIGN_CANVAS_VIEWS = ["preview", "code"] as const;
const DESIGN_BACKGROUNDS = ["light", "dark"] as const;
const DESIGN_RADII = ["", "sharp", "soft", "rounded", "pill"] as const;
const DESIGN_DENSITIES = ["", "compact", "cozy", "spacious"] as const;
const DESIGN_FONT_STYLES = ["", "system", "geometric", "humanist", "serif", "mono"] as const;

// 各字段的输入上限（防脏数据落盘；与 Kun 保持一致）。
const MAX_TONE_CHIPS = 12;
const MAX_TONE_LENGTH = 32;
const MAX_BRAND_COLOR_LENGTH = 32;
const MAX_GUIDELINES_LENGTH = 4000;
const MAX_PROMPT_LENGTH = 6000;
const MAX_STACK_HINT_LENGTH = 200;
const MAX_MODEL_LENGTH = 128;
const MAX_EFFORT_LENGTH = 32;
const MAX_PATH_LENGTH = 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : fallback;
}

function trimmedString(value: unknown, max: number): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

// 自由文本：保留内部排版，只截断长度。
function cappedString(value: unknown, max: number): string {
  return typeof value === "string" ? value.slice(0, max) : "";
}

function asBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

// tone chips：去重 + 截长 + 上限个数。
function normalizeTone(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") continue;
    const trimmed = entry.trim().slice(0, MAX_TONE_LENGTH);
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
    if (out.length >= MAX_TONE_CHIPS) break;
  }
  return out;
}

function normalizeDesignSystemPreset(value: unknown): DesignSystemPreset {
  return oneOf(value, DESIGN_SYSTEM_PRESETS, "none");
}

// 工厂默认（与主进程侧 hydrate 回落约定一致）。
export function defaultDesignSettings(): DesignSettingsV1 {
  return {
    defaultWorkspaceRoot: "",
    brandColor: "",
    tone: [],
    designSystemPreset: "none",
    designType: "",
    designGuidelines: "",
    radius: "",
    density: "",
    fontStyle: "",
    agent: "",
    derivedAgentId: "",
    model: "",
    providerId: "",
    reasoningEffort: "",
    generationPrompt: "",
    implementStackHint: "",
    injectIntoCode: true,
    publishDesignSystem: true,
    defaultViewport: "desktop",
    defaultCanvasView: "preview",
    canvasBackground: "light",
    liveRefresh: true,
    deviceFrame: true,
  };
}

// 任意来源（旧档/用户输入）归一化为合法 DesignSettings。
export function normalizeDesignSettings(input: DesignSettingsPatchV1 | undefined): DesignSettingsV1 {
  const source = isRecord(input) ? (input as DesignSettingsPatchV1) : {};
  return {
    defaultWorkspaceRoot: trimmedString(source.defaultWorkspaceRoot, MAX_PATH_LENGTH),
    brandColor: trimmedString(source.brandColor, MAX_BRAND_COLOR_LENGTH),
    tone: normalizeTone(source.tone),
    designSystemPreset: normalizeDesignSystemPreset(source.designSystemPreset),
    designType: oneOf(source.designType, DESIGN_TYPES, ""),
    designGuidelines: cappedString(source.designGuidelines, MAX_GUIDELINES_LENGTH),
    radius: oneOf(source.radius, DESIGN_RADII, ""),
    density: oneOf(source.density, DESIGN_DENSITIES, ""),
    fontStyle: oneOf(source.fontStyle, DESIGN_FONT_STYLES, ""),
    // agent 只接受内置三种 + "" (跟随系统默认);脏值/未知一律回 ""。
    agent: oneOf(source.agent, ["", "claude", "codex", "pi"], ""),
    // 派生 id 是自由字符串(agents.local.json 用户自定义);沿用 model 的长度上限截断。
    derivedAgentId: trimmedString(source.derivedAgentId, MAX_MODEL_LENGTH),
    model: trimmedString(source.model, MAX_MODEL_LENGTH),
    providerId: trimmedString(source.providerId, MAX_MODEL_LENGTH),
    reasoningEffort: trimmedString(source.reasoningEffort, MAX_EFFORT_LENGTH),
    generationPrompt: cappedString(source.generationPrompt, MAX_PROMPT_LENGTH),
    implementStackHint: trimmedString(source.implementStackHint, MAX_STACK_HINT_LENGTH),
    injectIntoCode: asBoolean(source.injectIntoCode, true),
    publishDesignSystem: asBoolean(source.publishDesignSystem, true),
    defaultViewport: oneOf(source.defaultViewport, DESIGN_VIEWPORTS, "desktop"),
    defaultCanvasView: oneOf(source.defaultCanvasView, DESIGN_CANVAS_VIEWS, "preview"),
    canvasBackground: oneOf(source.canvasBackground, DESIGN_BACKGROUNDS, "light"),
    liveRefresh: asBoolean(source.liveRefresh, true),
    deviceFrame: asBoolean(source.deviceFrame, true),
  };
}

export function mergeDesignSettings(
  current: DesignSettingsV1,
  patch: DesignSettingsPatchV1 | undefined,
): DesignSettingsV1 {
  if (!patch) return normalizeDesignSettings(current);
  return normalizeDesignSettings({ ...current, ...patch });
}

// 设计助手栏切 agent 时的联动 patch —— 与个人会话的 buildAgentSwitchPatch(agentMeta.ts)同构,
// 只是落在 DesignSettings 而非 SessionMeta(设计回合无会话续接槽,故不带 agentSessionIds/thinking)。
//
// 为什么 pi 必须配齐 provider+model、其余必须清空:sendDesignMessage 的配对逻辑读
// designSettings.model/.providerId。pi 走用户供应商端点,缺 model 会回落到内置默认
// openai-codex(常 deactivated)→ LLM 调用直接失败、一个文件都不写;claude/codex 用各自 CLI
// 自带鉴权、不挂 provider,若残留上一次 pi 的模型名(如某供应商模型 id)传给 claude 会因未知
// 模型瞬间退出。故切到 pi 时配齐、切到其余时把 model+providerId 清空,根除跨 agent 残留。
export function buildDesignAgentSwitchPatch(
  agent: AgentKind,
  providerSettings: ProviderSettings,
  derived?: DerivedAgentMeta,
): Partial<DesignSettings> {
  // session.agent 始终存内置 base;派生只在 derivedAgentId 记录。
  const base = derived?.base ?? agent;
  if (base === "pi") {
    const piDefaultProvider = providerSettings.providers.find(
      (p) => p.id === providerSettings.defaultProviderId,
    );
    return {
      agent: base,
      derivedAgentId: derived?.id ?? "",
      providerId: providerSettings.defaultProviderId ?? "",
      // 默认模型 > 默认供应商首个模型 > 空(空时 sendDesignMessage 再兜底到启用供应商首模型)。
      model: providerSettings.defaultModel ?? piDefaultProvider?.models[0]?.id ?? "",
    };
  }
  // claude/codex:清空 provider+model,避免上一次 pi 的模型名残留导致目标 agent 瞬退。
  return {
    agent: base,
    derivedAgentId: derived?.id ?? "",
    providerId: "",
    model: "",
  };
}
