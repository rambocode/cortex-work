// 后台结构化建议引擎（「不重」引擎，见计划 U6）：把捕获的自然语言标题交给后台 summary 模型
// 解析出 due/defer/tags/project 的**非破坏性建议**。复用 completeWithSummaryModel（与日报/归档同一
// 后台模型），可注入 complete 便于单测（照 taskArchive.ts 范式）。触发时机在主窗口（KTD3）——本文件
// 只提供引擎，触发/single-flight/落地由 TasksView 侧编排（U9）。
// 建议永远是「建议」：解析出错/离线一律返回空建议、绝不抛错阻断捕获（AE2）；模型输出不可信，
// parseStructureResult 对任何垃圾输入都稳健返回，只接受合法字段。

import type { DesktopBridge } from "../desktop/bridge";
import { completeWithSummaryModel } from "./timeline";
import { normalizeTag } from "./tasks";

// 结构化建议（瞬态、渲染端、不持久化；KTD3）。全部可选——抽不出就省略。
export interface StructureSuggestion {
  dueDate?: string; // YYYY-MM-DD 本地日历日
  deferDate?: string; // YYYY-MM-DD
  tags?: string[]; // 已规范化 + 去重
  projectName?: string; // 若标题明显归属某项目，给名字（UI 决定匹配已有 or 新建）
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// 校验为真实本地日历日（不止格式：经 Date round-trip 排除 2026-13-40 / 2026-02-30 等）。
function isValidCalendarDay(s: string): boolean {
  if (!DATE_RE.test(s)) return false;
  const [y, m, d] = s.split("-").map(Number) as [number, number, number];
  const dt = new Date(y, m - 1, d);
  return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d;
}

// 构造解析 prompt。today 传本地日历日，供模型把「周五前/明天/下周三」等相对表述换算成具体日期。
export function buildStructurePrompt(title: string, today: string): string {
  return [
    `你是任务解析助手。今天是 ${today}（本地日历日，YYYY-MM-DD）。`,
    "从下面这条任务标题中抽取结构化字段，只输出一个 JSON 对象，不要任何解释或 markdown 围栏。",
    "字段（全部可选，抽不出就省略该键）：",
    "- dueDate: 截止日期 YYYY-MM-DD（把相对表述按今天换算成具体日期）",
    "- deferDate: 最早开始日期 YYYY-MM-DD",
    "- tags: 情境/标签字符串数组（如 @email、@电话、#工作）",
    "- projectName: 若标题明显归属某项目/领域，给项目名",
    `任务标题：${title}`,
    "只输出 JSON：",
  ].join("\n");
}

// 从模型返回中提取 JSON 对象子串（容忍围栏/前后散文）：取第一个 { 到最后一个 }。
function extractJsonObject(raw: string): string | null {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  return raw.slice(start, end + 1);
}

// 稳健解析模型输出为建议：只接受合法字段，任何异常/垃圾返回空建议（{}），绝不抛。
export function parseStructureResult(raw: string): StructureSuggestion {
  const json = extractJsonObject(raw);
  if (!json) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== "object") return {};
  const p = parsed as Record<string, unknown>;
  const out: StructureSuggestion = {};
  if (typeof p.dueDate === "string" && isValidCalendarDay(p.dueDate)) out.dueDate = p.dueDate;
  if (typeof p.deferDate === "string" && isValidCalendarDay(p.deferDate)) out.deferDate = p.deferDate;
  if (Array.isArray(p.tags)) {
    const tags = Array.from(
      new Set(
        p.tags
          .filter((t): t is string => typeof t === "string")
          .map((t) => normalizeTag(t))
          .filter((t): t is string => !!t),
      ),
    );
    if (tags.length) out.tags = tags;
  }
  if (typeof p.projectName === "string" && p.projectName.trim()) out.projectName = p.projectName.trim();
  return out;
}

// 结构化一条任务标题。complete 可注入（缺省用后台 summary 模型）。
// 离线/模型不可用/出错 → 返回空建议、不抛（AE2：捕获流不被结构化阻断）。
export async function structureTask(
  bridge: DesktopBridge,
  title: string,
  deps: { today: string; complete?: (bridge: DesktopBridge, prompt: string) => Promise<string> },
): Promise<StructureSuggestion> {
  const complete = deps.complete ?? completeWithSummaryModel;
  try {
    const raw = await complete(bridge, buildStructurePrompt(title, deps.today));
    return parseStructureResult(raw);
  } catch {
    return {};
  }
}
