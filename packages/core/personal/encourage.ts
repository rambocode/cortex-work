// 落地页激励问候语的「每日 LLM 增强」数据层。
// 设了可用「默认 agent」(generalSettings.defaultAgent,经 resolveDefaultAgent 解析)时,
// 每天首次进入用该 agent 生成一条更个性化的激励文案,按天缓存落盘(经 store 持久化,
// 跨重启复用、跨天失效)。生成失败 / web 端无 bridge / 未配默认 agent → 返回 null,
// 由 LandingHero 回退静态文案池(encouragements.ts)。
//
// prompt 仅含「时段 + 泛主题激励」基调,不读取任何个人数据(零隐私顾虑)。
// 复用 completeWithSummaryModel(timeline.ts)的 oneshotCli 补全范式。

import { useQuery } from "@tanstack/react-query";
import type { DesktopBridge } from "../desktop/bridge";
import type { DailyEncouragement } from "../desktop/types";
import { DEFAULT_MODEL } from "../desktop/types";
import { useDesktopBridge } from "../provider";
import { resolveDefaultAgent, usePersonalStore } from "../store/personal";
import { dayKey } from "./timeline";

export const encourageKeys = {
  daily: (day: string) => ["personal", "encouragement", day] as const,
};

// 按「默认 agent」补全一段文本。仿 completeWithSummaryModel,但 agent 取 resolveDefaultAgent,
// model 取该 agent 默认（pi 走配置的供应商）。
export async function completeWithDefaultAgent(bridge: DesktopBridge, prompt: string): Promise<string> {
  const state = usePersonalStore.getState();
  const agent = resolveDefaultAgent(state);
  if (agent === "pi") {
    const ps = state.providerSettings;
    const p = ps.providers.find((x) => x.enabled && x.id === ps.defaultProviderId) ?? ps.providers.find((x) => x.enabled);
    const provider = p
      ? { id: p.id, baseUrl: p.baseUrl, apiKey: p.apiKey, models: p.models.map((m) => ({ id: m.id, name: m.label })) }
      : undefined;
    return bridge.oneshotCli({ prompt, agent: "pi", model: ps.defaultModel ?? p?.models[0]?.id, provider });
  }
  return bridge.oneshotCli({ prompt, agent, model: DEFAULT_MODEL[agent] });
}

function timePhrase(hour: number): string {
  if (hour < 5) return "深夜";
  if (hour < 9) return "清晨";
  if (hour < 12) return "上午";
  if (hour < 14) return "中午";
  if (hour < 18) return "下午";
  return "晚上";
}

export function buildEncouragePrompt(now: Date): string {
  const when = timePhrase(now.getHours());
  return [
    `现在是${when}。请为一款桌面应用的首页,写一句温暖、真诚、给人力量的激励问候语。`,
    `读者多为 30–50 岁的专业人士,同时承受家庭与工作的压力,可能有些焦虑。`,
    `语气像一位懂他们的朋友:笃定、温和、不说教、不喊空洞口号,贴合当前「${when}」的时段感。`,
    `不要使用任何个人信息或姓名。用简体中文。`,
    `严格只输出两行,格式如下,不要额外解释、不要 markdown、不要引号:`,
    `标题：<不超过16个字的短句>`,
    `副标题：<不超过30个字的一句话>`,
  ].join("\n");
}

function clip(s: string, max: number): string {
  const t = s.replace(/^["「『]|["」』]$/g, "").trim();
  return t.length > max ? t.slice(0, max) : t;
}

// 宽松解析:按「标题/副标题」前缀取两行;失败返回 null（保持静态兜底）。
export function parseEncouragement(raw: string): { title: string; sub: string } | null {
  const text = raw.trim();
  const title = text.match(/标题\s*[:：]\s*(.+)/)?.[1]?.trim();
  const sub = text.match(/副标题\s*[:：]\s*(.+)/)?.[1]?.trim();
  if (title && sub) return { title: clip(title, 24), sub: clip(sub, 40) };
  return null;
}

// 每日激励文案的 LLM 增强结果（按天缓存命中或本次生成）。
// 返回 null 表示暂无 LLM 文案（生成中 / 失败 / 无 bridge / 未配默认 agent）,
// 调用方应回退到静态文案池。
export function useDailyEncouragement(): DailyEncouragement | null {
  const bridge = useDesktopBridge();
  const cached = usePersonalStore((s) => s.dailyEncouragement);
  const setDaily = usePersonalStore((s) => s.setDailyEncouragement);
  // 仅当用户显式设置了「默认 agent」才启用 LLM 增强（opt-in,避免对未配置用户自动消耗 token）。
  // 未设置时始终回退静态文案池。
  const optedIn = usePersonalStore((s) => !!s.generalSettings.defaultAgent);
  const day = dayKey(Date.now());
  const currentSlot = timePhrase(new Date().getHours());
  // 缓存同时校验「天」和「时段」：时段切换后重新生成，避免深夜文案全天显示
  const hasCache = cached?.day === day && cached?.slot === currentSlot;

  const { data } = useQuery({
    queryKey: [...encourageKeys.daily(day), currentSlot],
    enabled: !!bridge && optedIn && !hasCache,
    staleTime: Infinity,
    gcTime: Infinity,
    retry: false,
    queryFn: async (): Promise<DailyEncouragement | null> => {
      try {
        const text = await completeWithDefaultAgent(bridge!, buildEncouragePrompt(new Date()));
        const parsed = parseEncouragement(text);
        if (!parsed) return null;
        const value: DailyEncouragement = { day, slot: currentSlot, ...parsed };
        setDaily(value); // 成功才落盘;失败保持静态兜底（与「报错不落盘」约定一致）。
        return value;
      } catch {
        return null;
      }
    },
  });

  if (hasCache) return cached;
  return data ?? null;
}
