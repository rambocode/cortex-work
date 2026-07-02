// 阶段模板纯逻辑（参照 IFocus 阶段模板设置页）：内置模板常量 + 合并展示 + 模板→项目阶段实例化。
// 内置模板刻意**不落盘**：随 App 升级演进、带锁语义只靠 builtin 标志；自定义模板才进 tasks.json。
// 创建项目时 instantiateStages 把模板阶段名**复制**成项目自持的 ProjectStage，与模板解耦
// （改/删模板不影响已建项目）。纯函数无 IO，表驱动单测见 stageTemplates.test.ts。

import type { ProjectStage, StageTemplate } from "../desktop/tasks-types";

// 内置模板 id 前缀：与自定义模板（tpl-<时间>-…）区分，防 id 撞车 + 供 isBuiltinTemplateId 判定。
export const BUILTIN_TEMPLATE_ID_PREFIX = "tpl-builtin-";

// 内置阶段模板（对齐 IFocus 内置集）。冻结防止消费端误改常量。
export const BUILTIN_STAGE_TEMPLATES: readonly StageTemplate[] = Object.freeze([
  {
    id: `${BUILTIN_TEMPLATE_ID_PREFIX}software`,
    name: "软件项目",
    description: "完整软件开发生命周期",
    stages: ["客户洽谈", "需求调研", "规划", "执行/开发", "测试", "交付", "验收", "结项"],
    builtin: true,
  },
  {
    id: `${BUILTIN_TEMPLATE_ID_PREFIX}marketing`,
    name: "营销活动",
    description: "营销推广全流程",
    stages: ["策划", "执行", "跟踪", "复盘"],
    builtin: true,
  },
  {
    id: `${BUILTIN_TEMPLATE_ID_PREFIX}product`,
    name: "产品设计",
    description: "产品从调研到发布",
    stages: ["调研", "设计", "开发", "发布"],
    builtin: true,
  },
  {
    id: `${BUILTIN_TEMPLATE_ID_PREFIX}content`,
    name: "内容创作",
    description: "内容生产流程",
    stages: ["选题", "创作", "审核", "发布"],
    builtin: true,
  },
  {
    id: `${BUILTIN_TEMPLATE_ID_PREFIX}simple`,
    name: "简单项目",
    description: "适用于小型任务",
    stages: ["待办"],
    builtin: true,
  },
  {
    id: `${BUILTIN_TEMPLATE_ID_PREFIX}none`,
    name: "无阶段",
    description: "不使用阶段",
    stages: [],
    builtin: true,
  },
]);

export function isBuiltinTemplateId(id: string): boolean {
  return id.startsWith(BUILTIN_TEMPLATE_ID_PREFIX);
}

// 合并内置 + 自定义供渲染（内置在前）。自定义里若混入内置 id（不应发生）按 id 去重丢弃，防重复展示。
export function mergeTemplates(custom: StageTemplate[]): StageTemplate[] {
  const seen = new Set(BUILTIN_STAGE_TEMPLATES.map((t) => t.id));
  const out: StageTemplate[] = [...BUILTIN_STAGE_TEMPLATES];
  for (const t of custom) {
    if (seen.has(t.id)) continue;
    seen.add(t.id);
    out.push(t);
  }
  return out;
}

// 模板阶段名 → 项目阶段实例。全部初始 not-started（用户手动推进，对齐 IFocus）；
// order 用数组下标（项目内自持的小数组，无需 fractional index）。
// id 由调用方注入生成器（main 侧 newTaskId 风格 / 测试注入确定值）。
export function instantiateStages(names: string[], newId: () => string): ProjectStage[] {
  return names
    .map((n) => n.trim())
    .filter((n) => n.length > 0)
    .map((name, i) => ({ id: newId(), name, status: "not-started" as const, order: i }));
}

// 模板输入校验：名称必填；阶段名去空白后不得有空项（空列表合法 = 无阶段模板）。
// 返回错误文案（zh-Hans）或 null（合法），供表单即时提示。
export function validateStageTemplateInput(input: { name: string; stages: string[] }): string | null {
  if (!input.name.trim()) return "模板名称不能为空";
  if (input.stages.some((s) => !s.trim())) return "阶段名不能为空";
  return null;
}
