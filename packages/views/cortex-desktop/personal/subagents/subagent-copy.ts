import type { BuiltinAgentCatalogEntry } from "@cortex-work/core";

type AgentCopy = Readonly<{ name: string; description: string }>;

// Kun 的角色目录以稳定 id 作为契约，中文名称与说明只属于展示层。这里保持运行时英文
// name/description 不变，避免改动委派 prompt、日志和历史卡片，同时让中文设置页与参考界面一致。
const ZH_HANS_AGENT_COPY: Readonly<Record<string, AgentCopy>> = {
  general: { name: "通用代理", description: "全工具 · 多步骤任务，可改文件" },
  explore: { name: "探索代理", description: "只读 · 查找文件、搜索代码" },
  "component-designer": { name: "组件设计师", description: "聚焦交互组件原型" },
  "design-reviewer": { name: "设计审查", description: "视觉层级与可访问性 · 只读" },
  "over-engineering-reviewer": { name: "过度设计审查", description: "发现可删复杂度 · 只读" },
  "code-reviewer": { name: "代码审查专家", description: "五维审查 · 只读" },
  "test-engineer": { name: "测试工程师", description: "测试策略 · 可编写和运行测试" },
  "security-auditor": { name: "安全审计专家", description: "威胁与 OWASP 风险 · 只读" },
  "web-performance-auditor": { name: "Web 性能审计专家", description: "Core Web Vitals · 证据驱动" },
  "api-and-interface-design": { name: "API 与接口架构师", description: "稳定公共契约 · 兼容与校验" },
  "browser-testing-with-devtools": { name: "Web QA 规划师", description: "浏览器与无障碍验证计划 · 只读" },
  "ci-cd-and-automation": { name: "CI/CD 工程师", description: "流水线、门禁与可回滚发布" },
  "code-review-and-quality": { name: "代码质量审查", description: "正确性与架构多维审查 · 只读" },
  "code-simplification": { name: "代码简化工程师", description: "降低复杂度 · 保持行为不变" },
  "context-engineering": { name: "上下文工程师", description: "最小权威上下文包 · 只读" },
  "debugging-and-error-recovery": { name: "根因调试工程师", description: "复现、定位、修复与回归验证" },
  "deprecation-and-migration": { name: "迁移工程师", description: "分阶段兼容、数据迁移与回滚" },
  "documentation-and-adrs": { name: "文档与 ADR 工程师", description: "架构决策、运维指南与 API 文档" },
  "doubt-driven-development": { name: "质疑驱动审查", description: "挑战假设与设计 · 只读" },
  "frontend-ui-engineering": { name: "前端 UI 工程师", description: "可访问、响应式、产品级界面" },
  "git-workflow-and-versioning": { name: "Git 工作流工程师", description: "分支、原子提交与历史安全" },
  "idea-refine": { name: "创意打磨伙伴", description: "方案比较、MVP 边界与验证 · 只读" },
  "incremental-implementation": { name: "增量实现工程师", description: "薄切片、可构建、持续验证" },
  "interview-me": { name: "需求访谈官", description: "找缺口并产出高信息问题 · 只读" },
  "observability-and-instrumentation": { name: "可观测性工程师", description: "日志、指标、链路与告警" },
  "performance-optimization": { name: "性能优化工程师", description: "测瓶颈、优化主成本并验证收益" },
  "planning-and-task-breakdown": { name: "实现规划师", description: "依赖感知、可验收任务拆解 · 只读" },
  "security-and-hardening": { name: "安全加固工程师", description: "威胁建模与范围化安全修复" },
  "shipping-and-launch": { name: "发布就绪工程师", description: "上线决策、灰度与回滚计划 · 只读" },
  "source-driven-development": { name: "源码驱动研究员", description: "对照权威版本来源指导实现 · 只读" },
  "spec-driven-development": { name: "规格工程师", description: "场景、接口与验收标准 · 只读" },
  "test-driven-development": { name: "TDD 工程师", description: "红绿重构 · 行为驱动回归证明" },
  "using-agent-skills": { name: "工程工作流顾问", description: "映射最小合适代理序列 · 只读" },
  "write-outline-architect": { name: "大纲架构师", description: "结构、论证与章节推进 · 只读" },
  "write-draft-author": { name: "初稿作者", description: "长文初稿与聚焦段落写作" },
  "write-developmental-editor": { name: "发展编辑", description: "提升逻辑、结构与可读性" },
  "write-copy-editor": { name: "文案润色编辑", description: "语气、术语与语法一致性" },
  "write-fact-checker": { name: "事实核查员", description: "核对主张、数据与不确定性 · 只读" },
  "write-citation-researcher": { name: "引文研究员", description: "权威来源与可追溯引用 · 只读" },
  "design-product-planner": { name: "产品设计规划师", description: "方向、目标、流程与取舍 · 只读" },
  "design-ux-researcher": { name: "UX 研究员", description: "用户旅程与可用性研究 · 只读" },
  "design-screen-designer": { name: "页面设计师", description: "完整响应式页面与交互状态" },
  "design-system-architect": { name: "设计系统架构师", description: "语义令牌、组件与变体约束" },
  "design-code-binder": { name: "设计代码绑定师", description: "设计节点到源码与路由映射" },
  "design-handoff-specialist": { name: "设计交付专家", description: "DESIGN.md、实现说明与交付物" },
};

/** 返回当前中文界面使用的角色文案；未知或未来角色安全回退到目录自带英文。 */
export function getSubagentCopy(entry: BuiltinAgentCatalogEntry): AgentCopy {
  return ZH_HANS_AGENT_COPY[entry.id] ?? { name: entry.name, description: entry.description };
}
