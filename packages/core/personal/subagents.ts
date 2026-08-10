export type BuiltinAgentCatalogEntry = {
  id: string
  name: string
  description: string
  color: string
  toolPolicy: 'readOnly' | 'inherit'
  /** Stable product taxonomy used by catalog browsing and filtering. */
  category: BuiltinAgentCategory
  /** Product family: the original catalog or a mode-specific expansion. */
  family: BuiltinAgentFamily
  /** Default product surfaces where this agent participates in routing. */
  surfaces: readonly ('shared' | 'code' | 'write' | 'design')[]
  /** Surface assignment restored when an opt-in extension agent is enabled. */
  recommendedSurfaces: readonly ('shared' | 'code' | 'write' | 'design')[]
  /** Stable bilingual retrieval facets; never executed as instructions. */
  routingTerms: readonly string[]
}

export type BuiltinAgentFamily = 'base' | 'skill' | 'write' | 'design'

export type BuiltinAgentCategory =
  | 'development'
  | 'review'
  | 'quality'
  | 'planning'
  | 'operations'
  | 'research'

export type SubagentSurface = 'shared' | 'code' | 'write' | 'design'

export type CustomSubagentProfile = {
  id: string
  enabled: boolean
  name: string
  description?: string
  color?: string
  agent?: string
  model?: string
  effort?: string
  systemPrompt?: string
  toolPolicy: 'readOnly' | 'inherit'
  surfaces: SubagentSurface[]
}

export type AutomaticSubagentRoleId = 'compaction' | 'codeReview' | 'title' | 'summary'

export type AutomaticSubagentRoleOverride = {
  agent?: 'claude' | 'codex' | 'pi'
  model?: string
  providerId?: string
  effort?: 'low' | 'medium' | 'high'
}

/**
 * Canonical display, policy, and retrieval metadata for every built-in agent.
 * Runtime profiles and the Electron GUI both consume this table so changing a
 * model override in settings cannot silently replace an agent's real policy.
 */
const BUILTIN_AGENT_CATALOG_BASE = [
  {
    id: 'general', name: 'General Agent', color: '#3b82d8', toolPolicy: 'inherit', category: 'development',
    description: 'Handles broad implementation and multi-step work when no narrower specialist fits.',
    routingTerms: ['general', 'implementation', 'multi-step', '通用', '实现', '多步骤']
  },
  {
    id: 'explore', name: 'Repository Explorer', color: '#1d9e75', toolPolicy: 'readOnly', category: 'research',
    description: 'Locates files, symbols, ownership, and code paths without modifying the workspace.',
    routingTerms: ['explore', 'search', 'find', 'repository', '定位', '搜索', '查找', '代码路径']
  },
  {
    id: 'component-designer', name: 'Component Designer', color: '#7f77dd', toolPolicy: 'inherit', category: 'development',
    description: 'Builds one focused interactive component prototype.',
    routingTerms: ['component', 'prototype', 'ui', 'interaction', '组件', '原型', '交互']
  },
  {
    id: 'design-reviewer', name: 'Design Reviewer', color: '#7f77dd', toolPolicy: 'readOnly', category: 'review',
    description: 'Reviews visual hierarchy, typography, spacing, motion, accessibility, and interaction quality.',
    routingTerms: ['design review', 'visual', 'ux', 'accessibility', '设计审查', '视觉', '可访问性']
  },
  {
    id: 'over-engineering-reviewer', name: 'Over-Engineering Reviewer', color: '#e8943a', toolPolicy: 'readOnly', category: 'review',
    description: 'Finds removable complexity, speculative abstractions, and simpler native alternatives.',
    routingTerms: ['over-engineering', 'yagni', 'complexity', 'simplify', '过度设计', '复杂度', '简化']
  },
  {
    id: 'code-reviewer', name: 'Code Reviewer', color: '#2563eb', toolPolicy: 'readOnly', category: 'review',
    description: 'Reviews scoped changes for correctness, regressions, maintainability, and merge readiness.',
    routingTerms: ['code review', 'diff', 'regression', 'merge', '代码审查', '评审', '回归']
  },
  {
    id: 'test-engineer', name: 'Test Engineer', color: '#10b981', toolPolicy: 'inherit', category: 'quality',
    description: 'Designs and implements focused unit, integration, and regression tests.',
    routingTerms: ['test', 'testing', 'unit', 'integration', 'regression', '测试', '单测', '回归测试']
  },
  {
    id: 'security-auditor', name: 'Security Auditor', color: '#dc2626', toolPolicy: 'readOnly', category: 'review',
    description: 'Performs an OWASP-aligned audit of trust boundaries and vulnerabilities without modifying code.',
    routingTerms: ['security audit', 'vulnerability', 'authentication', 'authorization', 'threat', '安全审计', '漏洞', '鉴权', '认证', '授权']
  },
  {
    id: 'web-performance-auditor', name: 'Web Performance Auditor', color: '#f59e0b', toolPolicy: 'readOnly', category: 'quality',
    description: 'Audits Core Web Vitals, loading, rendering, bundles, and network performance.',
    routingTerms: ['web performance audit', 'lcp', 'inp', 'cls', 'lighthouse', 'bundle', '网页性能审计', '首屏', '包体积']
  },
  {
    id: 'api-and-interface-design', name: 'API & Interface Architect', color: '#3b82d8', toolPolicy: 'inherit', category: 'development',
    description: 'Designs stable public contracts, compatibility, validation, pagination, and errors.',
    routingTerms: ['api', 'interface', 'contract', 'schema', 'compatibility', '接口', '契约', '兼容']
  },
  {
    id: 'browser-testing-with-devtools', name: 'Web QA Planner', color: '#1d9e75', toolPolicy: 'readOnly', category: 'quality',
    description: 'Read-only Web QA planner for browser, accessibility, responsive, console, network, and screenshot verification scripts.',
    routingTerms: ['browser qa plan', 'devtools', 'responsive', 'console', 'network', '浏览器测试计划', '响应式', '控制台']
  },
  {
    id: 'ci-cd-and-automation', name: 'CI/CD Engineer', color: '#e8943a', toolPolicy: 'inherit', category: 'operations',
    description: 'Builds deterministic pipelines, quality gates, caching, releases, and rollback-safe deployments.',
    routingTerms: ['ci', 'cd', 'pipeline', 'automation', 'github actions', '流水线', '持续集成', '自动化']
  },
  {
    id: 'code-review-and-quality', name: 'Code Quality Reviewer', color: '#2563eb', toolPolicy: 'readOnly', category: 'review',
    description: 'Performs read-only multi-axis correctness, architecture, security, performance, and test review.',
    routingTerms: ['quality review', 'architecture review', 'maintainability', '代码质量', '架构审查', '可维护性']
  },
  {
    id: 'code-simplification', name: 'Code Simplification Engineer', color: '#7f77dd', toolPolicy: 'inherit', category: 'development',
    description: 'Reduces unnecessary complexity while preserving behavior.',
    routingTerms: ['simplify code', 'refactor', 'remove abstraction', '简化代码', '重构', '删除抽象']
  },
  {
    id: 'context-engineering', name: 'Context Engineer', color: '#1d9e75', toolPolicy: 'readOnly', category: 'planning',
    description: 'Builds a minimal authoritative context pack with files, contracts, tests, and data flow.',
    routingTerms: ['context', 'data flow', 'dependencies', 'authoritative files', '上下文', '数据流', '依赖关系']
  },
  {
    id: 'debugging-and-error-recovery', name: 'Root Cause Debugger', color: '#d85a30', toolPolicy: 'inherit', category: 'development',
    description: 'Reproduces, localizes, fixes, and regression-tests failures systematically.',
    routingTerms: ['debug', 'root cause', 'timeout', 'intermittent', 'error recovery', '排查', '调试', '根因', '超时', '偶发']
  },
  {
    id: 'deprecation-and-migration', name: 'Migration Engineer', color: '#e8943a', toolPolicy: 'inherit', category: 'operations',
    description: 'Plans and implements staged compatibility, data migration, telemetry, and rollback.',
    routingTerms: ['migration', 'deprecation', 'compatibility', 'rollback', '迁移', '废弃', '兼容', '回滚']
  },
  {
    id: 'documentation-and-adrs', name: 'Documentation & ADR Engineer', color: '#3b82d8', toolPolicy: 'inherit', category: 'research',
    description: 'Writes accurate architecture decisions, operational guides, and API documentation.',
    routingTerms: ['documentation', 'adr', 'decision record', 'guide', '文档', '架构决策', '说明']
  },
  {
    id: 'doubt-driven-development', name: 'Doubt-Driven Reviewer', color: '#d4537e', toolPolicy: 'readOnly', category: 'review',
    description: 'Challenges assumptions and designs with fresh-context adversarial evidence.',
    routingTerms: ['challenge assumptions', 'adversarial review', 'counterexample', '质疑', '反例', '假设']
  },
  {
    id: 'frontend-ui-engineering', name: 'Frontend UI Engineer', color: '#7f77dd', toolPolicy: 'inherit', category: 'development',
    description: 'Builds accessible, responsive, product-quality interfaces and validates interactions.',
    routingTerms: ['frontend', 'ui', 'react', 'css', 'accessibility', 'responsive', '前端', '界面', '响应式']
  },
  {
    id: 'git-workflow-and-versioning', name: 'Git Workflow Engineer', color: '#e8943a', toolPolicy: 'inherit', category: 'operations',
    description: 'Handles scoped branches, atomic commits, versioning, conflicts, and history safety.',
    routingTerms: ['git', 'branch', 'commit', 'version', 'conflict', '分支', '提交', '版本', '冲突']
  },
  {
    id: 'idea-refine', name: 'Idea Refinement Partner', color: '#d4537e', toolPolicy: 'readOnly', category: 'planning',
    description: 'Turns raw ideas into compared options, MVP boundaries, risks, and validation experiments.',
    routingTerms: ['idea', 'brainstorm', 'mvp', 'options', '创意', '想法', '方案比较', '最小产品']
  },
  {
    id: 'incremental-implementation', name: 'Incremental Implementation Engineer', color: '#10b981', toolPolicy: 'inherit', category: 'development',
    description: 'Delivers thin, buildable, continuously verified vertical slices.',
    routingTerms: ['incremental implementation', 'vertical slice', 'small steps', '增量实现', '垂直切片', '小步']
  },
  {
    id: 'interview-me', name: 'Requirements Interviewer', color: '#3b82d8', toolPolicy: 'readOnly', category: 'planning',
    description: 'Finds requirement gaps and produces prioritized high-information questions for the parent.',
    routingTerms: ['requirements interview', 'clarify', 'questions', '需求访谈', '澄清', '提问']
  },
  {
    id: 'observability-and-instrumentation', name: 'Observability Engineer', color: '#1d9e75', toolPolicy: 'inherit', category: 'operations',
    description: 'Designs structured logs, metrics, traces, SLOs, dashboards, and actionable alerts.',
    routingTerms: ['observability', 'logging', 'metrics', 'tracing', 'slo', '监控', '日志', '指标', '链路']
  },
  {
    id: 'performance-optimization', name: 'Performance Engineer', color: '#f59e0b', toolPolicy: 'inherit', category: 'quality',
    description: 'Measures bottlenecks, optimizes dominant costs, and proves before/after impact.',
    routingTerms: ['performance optimization', 'lcp', 'bundle size', 'latency', 'profiling', '性能优化', '包体积', '延迟']
  },
  {
    id: 'planning-and-task-breakdown', name: 'Implementation Planner', color: '#7f77dd', toolPolicy: 'readOnly', category: 'planning',
    description: 'Produces dependency-aware, acceptance-driven, verifiable implementation tasks.',
    routingTerms: ['planning', 'task breakdown', 'parallel tasks', 'dependencies', '计划', '任务拆解', '拆分', '并行任务']
  },
  {
    id: 'security-and-hardening', name: 'Security Hardening Engineer', color: '#dc2626', toolPolicy: 'inherit', category: 'development',
    description: 'Threat-models and implements scoped security controls with regression evidence.',
    routingTerms: ['security fix', 'hardening', 'authentication', 'authorization', 'vulnerability remediation', '安全修复', '安全加固', '鉴权', '漏洞修复']
  },
  {
    id: 'shipping-and-launch', name: 'Release Readiness Engineer', color: '#e8943a', toolPolicy: 'readOnly', category: 'operations',
    description: 'Makes evidence-based go/no-go, rollout, monitoring, and rollback plans.',
    routingTerms: ['release readiness', 'launch', 'rollout', 'go no-go', '发布准备', '上线', '灰度', '回滚']
  },
  {
    id: 'source-driven-development', name: 'Source-Driven Researcher', color: '#3b82d8', toolPolicy: 'readOnly', category: 'research',
    description: 'Grounds implementation guidance in authoritative version-matched sources.',
    routingTerms: ['official documentation', 'primary source', 'version', 'source research', '官方文档', '权威来源', '版本核对']
  },
  {
    id: 'spec-driven-development', name: 'Specification Engineer', color: '#d4537e', toolPolicy: 'readOnly', category: 'planning',
    description: 'Creates explicit scenarios, interfaces, acceptance criteria, non-goals, and open questions.',
    routingTerms: ['specification', 'acceptance criteria', 'scenarios', 'requirements', '规格', '验收标准', '场景']
  },
  {
    id: 'test-driven-development', name: 'TDD Engineer', color: '#10b981', toolPolicy: 'inherit', category: 'development',
    description: 'Runs red-green-refactor with behavior-focused regression proof.',
    routingTerms: ['tdd', 'red green refactor', 'test first', '测试驱动', '红绿重构', '先写测试']
  },
  {
    id: 'using-agent-skills', name: 'Engineering Workflow Advisor', color: '#7f77dd', toolPolicy: 'readOnly', category: 'planning',
    description: 'Maps work to the smallest suitable standalone agent sequence or a missing-role brief.',
    routingTerms: ['agent workflow', 'choose agent', 'delegation plan', '代理选择', '工作流', '派发']
  },
  {
    id: 'write-outline-architect', name: 'Outline Architect', color: '#3b82d8', toolPolicy: 'readOnly', category: 'planning',
    description: 'Structures outlines, arguments, sections, and narrative progression before drafting.',
    routingTerms: ['outline', 'structure', 'argument', '章节', '大纲', '结构', '论证']
  },
  {
    id: 'write-draft-author', name: 'Draft Author', color: '#10b981', toolPolicy: 'inherit', category: 'development',
    description: 'Writes grounded long-form drafts and completes focused sections in the requested format.',
    routingTerms: ['draft', 'long form', 'chapter', 'article', '初稿', '长文', '章节', '文章']
  },
  {
    id: 'write-developmental-editor', name: 'Developmental Editor', color: '#7f77dd', toolPolicy: 'inherit', category: 'quality',
    description: 'Improves document-level logic, structure, pacing, and reader comprehension.',
    routingTerms: ['developmental edit', 'structure edit', 'pacing', '逻辑编辑', '结构调整', '叙事节奏']
  },
  {
    id: 'write-copy-editor', name: 'Copy Editor', color: '#d4537e', toolPolicy: 'inherit', category: 'quality',
    description: 'Polishes language, tone, terminology, grammar, and consistency while preserving meaning.',
    routingTerms: ['copy edit', 'polish', 'tone', 'grammar', '润色', '语气', '术语', '语法']
  },
  {
    id: 'write-fact-checker', name: 'Fact Checker', color: '#dc2626', toolPolicy: 'readOnly', category: 'review',
    description: 'Checks claims, figures, dates, and uncertainty against available evidence.',
    routingTerms: ['fact check', 'verify claim', 'numbers', '事实核查', '数据核对', '真实性']
  },
  {
    id: 'write-citation-researcher', name: 'Citation Researcher', color: '#1d9e75', toolPolicy: 'readOnly', category: 'research',
    description: 'Finds authoritative sources and prepares traceable citation evidence.',
    routingTerms: ['citation', 'source', 'bibliography', 'reference', '引用', '来源', '参考文献']
  },
  {
    id: 'design-product-planner', name: 'Product Design Planner', color: '#3b82d8', toolPolicy: 'readOnly', category: 'planning',
    description: 'Defines product directions, user goals, key flows, screens, and design tradeoffs.',
    routingTerms: ['product design', 'direction', 'user goals', 'screen plan', '产品设计', '用户目标', '页面规划']
  },
  {
    id: 'design-ux-researcher', name: 'UX Researcher', color: '#1d9e75', toolPolicy: 'readOnly', category: 'research',
    description: 'Analyzes user journeys, usability risks, evidence gaps, and research questions.',
    routingTerms: ['ux research', 'user journey', 'usability', '用户研究', '用户旅程', '可用性']
  },
  {
    id: 'design-screen-designer', name: 'Screen Designer', color: '#7f77dd', toolPolicy: 'inherit', category: 'development',
    description: 'Creates complete responsive screens with states, hierarchy, and interaction behavior.',
    routingTerms: ['screen design', 'responsive layout', 'interaction states', '页面设计', '响应式布局', '交互状态']
  },
  {
    id: 'design-system-architect', name: 'Design System Architect', color: '#d4537e', toolPolicy: 'inherit', category: 'development',
    description: 'Defines semantic tokens, reusable components, variants, states, and design constraints.',
    routingTerms: ['design system', 'tokens', 'components', 'variants', '设计系统', '设计令牌', '组件变体']
  },
  {
    id: 'design-code-binder', name: 'Design Code Binder', color: '#e8943a', toolPolicy: 'inherit', category: 'development',
    description: 'Maps design nodes to routes, source files, components, and stable implementation anchors.',
    routingTerms: ['code binding', 'design graph', 'source mapping', '代码绑定', '设计节点', '源码映射']
  },
  {
    id: 'design-handoff-specialist', name: 'Design Handoff Specialist', color: '#10b981', toolPolicy: 'inherit', category: 'operations',
    description: 'Produces DESIGN.md decisions, implementation notes, assets, and verifiable handoff material.',
    routingTerms: ['design handoff', 'design md', 'implementation notes', '设计交付', '实现说明', '设计文档']
  }
] as const

const SHARED_AGENT_IDS = new Set([
  'general',
  'explore',
  'context-engineering',
  'idea-refine',
  'interview-me',
  'planning-and-task-breakdown',
  'source-driven-development',
  'spec-driven-development',
  'using-agent-skills'
])

const CODE_DESIGN_AGENT_IDS = new Set([
  'component-designer',
  'design-reviewer',
  'frontend-ui-engineering',
  'browser-testing-with-devtools',
  'web-performance-auditor'
])

const WRITE_AGENT_IDS = new Set([
  'write-outline-architect',
  'write-draft-author',
  'write-developmental-editor',
  'write-copy-editor',
  'write-fact-checker',
  'write-citation-researcher'
])

const DESIGN_AGENT_IDS = new Set([
  'design-product-planner',
  'design-ux-researcher',
  'design-screen-designer',
  'design-system-architect',
  'design-code-binder',
  'design-handoff-specialist'
])

// These are the original localized roles that form Kun's small, stable core.
// Everything imported from agent-skills or added for Write/Design is opt-in.
const BASE_AGENT_IDS = new Set([
  'general',
  'explore',
  'design-reviewer',
  'over-engineering-reviewer',
  'code-reviewer',
  'test-engineer',
  'security-auditor',
  'web-performance-auditor'
])

function defaultFamily(id: string): BuiltinAgentFamily {
  if (BASE_AGENT_IDS.has(id)) return 'base'
  if (WRITE_AGENT_IDS.has(id)) return 'write'
  if (DESIGN_AGENT_IDS.has(id)) return 'design'
  return 'skill'
}

function recommendedSurfaces(id: string): BuiltinAgentCatalogEntry['surfaces'] {
  if (SHARED_AGENT_IDS.has(id)) return ['shared']
  if (CODE_DESIGN_AGENT_IDS.has(id)) return ['code', 'design']
  if (id === 'documentation-and-adrs') return ['code', 'write']
  if (WRITE_AGENT_IDS.has(id)) return ['write']
  if (DESIGN_AGENT_IDS.has(id)) return ['design']
  return ['code']
}

function defaultSurfaces(id: string): BuiltinAgentCatalogEntry['surfaces'] {
  return BASE_AGENT_IDS.has(id) ? recommendedSurfaces(id) : []
}

export const BUILTIN_AGENT_CATALOG: readonly BuiltinAgentCatalogEntry[] =
  BUILTIN_AGENT_CATALOG_BASE.map((entry) => ({
    ...entry,
    family: defaultFamily(entry.id),
    surfaces: defaultSurfaces(entry.id),
    recommendedSurfaces: recommendedSurfaces(entry.id)
  }))

export const BUILTIN_AGENT_CATALOG_BY_ID: Readonly<Record<string, BuiltinAgentCatalogEntry>> =
  Object.fromEntries(BUILTIN_AGENT_CATALOG.map((entry) => [entry.id, entry]))

/**
 * 用户对单个内置子代理的覆盖配置。
 *
 * 目录元数据始终由代码提供，设置只保存差异，避免升级目录后把旧名称、描述和策略永久固化。
 * `agent` 为空表示跟随主会话的底层 Agent；`model`/`effort` 为空表示跟随所选 Agent 的默认值。
 */
export type SubagentProfileOverride = {
  enabled?: boolean
  agent?: string
  model?: string
  effort?: string
  systemPrompt?: string
  /** 缺省使用内置目录场景；shared 表示所有场景可用。 */
  surfaces?: SubagentSurface[]
}

/**
 * 子代理运行策略与目录设置。基础代理始终可委派；扩展代理需先打开总开关，再逐个启用。
 * 是否实际委派、选择哪些角色以及调用多少次由主 Agent 每轮自行判断；这里的数值只提供
 * 资源护栏，不把产品决策硬编码成固定编排流程。
 */
export type SubagentSettings = {
  useExistingAgents: boolean
  maxParallel: number
  maxChildRuns: number
  extensionAgentsEnabled: boolean
  profiles: Record<string, SubagentProfileOverride>
  customProfiles: CustomSubagentProfile[]
  automaticRoles: Partial<Record<AutomaticSubagentRoleId, AutomaticSubagentRoleOverride>>
}

export const SUBAGENT_MAX_PARALLEL_RANGE = { min: 1, max: 256 } as const
export const SUBAGENT_MAX_CHILD_RUNS_RANGE = { min: 1, max: 10_000 } as const

export const DEFAULT_SUBAGENT_SETTINGS: SubagentSettings = {
  useExistingAgents: true,
  maxParallel: 256,
  maxChildRuns: 25,
  extensionAgentsEnabled: false,
  profiles: {},
  customProfiles: [],
  // 保留 Cortex 既有的轻量标题生成默认值；用户可在设置页改为其它 Agent / 模型。
  automaticRoles: { title: { agent: 'claude', model: 'haiku' } }
}

function normalizeInteger(
  value: unknown,
  fallback: number,
  range: { readonly min: number; readonly max: number }
): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(range.max, Math.max(range.min, Math.floor(value)))
}

const SUBAGENT_SURFACES = new Set<SubagentSurface>(['shared', 'code', 'write', 'design'])
const AUTOMATIC_ROLE_IDS = new Set<AutomaticSubagentRoleId>(['compaction', 'codeReview', 'title', 'summary'])

function cleanOptionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const cleaned = value.trim()
  return cleaned || undefined
}

/** 场景列表去重并收敛；shared 是通配场景，出现后不再保留其它冗余值。 */
export function normalizeSubagentSurfaces(value: unknown, fallback: readonly SubagentSurface[]): SubagentSurface[] {
  const surfaces = Array.isArray(value)
    ? [...new Set(value.filter((entry): entry is SubagentSurface => SUBAGENT_SURFACES.has(entry as SubagentSurface)))]
    : [...fallback]
  return surfaces.includes('shared') ? ['shared'] : surfaces
}

function normalizeCustomProfiles(value: unknown): CustomSubagentProfile[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  const result: CustomSubagentProfile[] = []
  for (const candidate of value) {
    if (!candidate || typeof candidate !== 'object') continue
    const raw = candidate as Partial<CustomSubagentProfile>
    const id = cleanOptionalString(raw.id)?.toLowerCase()
    const name = cleanOptionalString(raw.name)
    // 自定义角色 id 不能覆盖内置策略；无名称的草稿也不进入运行时目录。
    // 严格字符集还保证 ask_<id> 归一化后不会让两个角色碰撞到同一个 delegate 工具名。
    if (!id || !/^[a-z0-9][a-z0-9_-]{0,127}$/.test(id) || !name || seen.has(id) || BUILTIN_AGENT_CATALOG_BY_ID[id]) continue
    seen.add(id)
    const color = cleanOptionalString(raw.color)
    result.push({
      id,
      name,
      enabled: raw.enabled !== false,
      toolPolicy: raw.toolPolicy === 'inherit' ? 'inherit' : 'readOnly',
      surfaces: normalizeSubagentSurfaces(raw.surfaces, ['shared']),
      ...(cleanOptionalString(raw.description) ? { description: cleanOptionalString(raw.description) } : {}),
      ...(color && /^#[0-9a-f]{6}$/i.test(color) ? { color } : {}),
      ...(cleanOptionalString(raw.agent) ? { agent: cleanOptionalString(raw.agent) } : {}),
      ...(cleanOptionalString(raw.model) ? { model: cleanOptionalString(raw.model) } : {}),
      ...(cleanOptionalString(raw.effort) ? { effort: cleanOptionalString(raw.effort) } : {}),
      ...(cleanOptionalString(raw.systemPrompt) ? { systemPrompt: cleanOptionalString(raw.systemPrompt) } : {})
    })
  }
  return result
}

function normalizeAutomaticRoles(value: unknown): SubagentSettings['automaticRoles'] {
  if (!value || typeof value !== 'object') return {}
  const result: SubagentSettings['automaticRoles'] = {}
  for (const [id, candidate] of Object.entries(value)) {
    if (!AUTOMATIC_ROLE_IDS.has(id as AutomaticSubagentRoleId) || !candidate || typeof candidate !== 'object') continue
    const raw = candidate as AutomaticSubagentRoleOverride
    const agent = raw.agent === 'claude' || raw.agent === 'codex' || raw.agent === 'pi' ? raw.agent : undefined
    const effort = raw.effort === 'low' || raw.effort === 'medium' || raw.effort === 'high'
      ? raw.effort
      : undefined
    result[id as AutomaticSubagentRoleId] = {
      ...(agent ? { agent } : {}),
      ...(cleanOptionalString(raw.model) ? { model: cleanOptionalString(raw.model) } : {}),
      ...(cleanOptionalString(raw.providerId) ? { providerId: cleanOptionalString(raw.providerId) } : {}),
      ...(effort ? { effort } : {})
    }
  }
  return result
}

/**
 * 旧存档可能缺字段、含非法数值或含已移除角色；这里统一收敛持久化边界。
 * 未知 profile 键仍保留，便于未来目录恢复；运行上限则必须落入 Kun 同口径的安全范围。
 */
export function normalizeSubagentSettings(
  value: Partial<SubagentSettings> | undefined
): SubagentSettings {
  return {
    ...DEFAULT_SUBAGENT_SETTINGS,
    ...value,
    maxParallel: normalizeInteger(
      value?.maxParallel,
      DEFAULT_SUBAGENT_SETTINGS.maxParallel,
      SUBAGENT_MAX_PARALLEL_RANGE
    ),
    maxChildRuns: normalizeInteger(
      value?.maxChildRuns,
      DEFAULT_SUBAGENT_SETTINGS.maxChildRuns,
      SUBAGENT_MAX_CHILD_RUNS_RANGE
    ),
    profiles: value?.profiles && typeof value.profiles === 'object' ? value.profiles : {},
    customProfiles: normalizeCustomProfiles(value?.customProfiles),
    automaticRoles: {
      ...DEFAULT_SUBAGENT_SETTINGS.automaticRoles,
      ...normalizeAutomaticRoles(value?.automaticRoles)
    }
  }
}

/** 判断角色是否在当前产品场景可用；shared 是跨场景通配值。 */
export function subagentAvailableOnSurface(
  surfaces: readonly SubagentSurface[],
  surface: Exclude<SubagentSurface, 'shared'>
): boolean {
  return surfaces.includes('shared') || surfaces.includes(surface)
}

/**
 * 返回当前可委派的目录项。基础代理不可被整体关闭；扩展代理必须同时满足总开关与逐项启用。
 */
export function enabledSubagentCatalog(
  value: Partial<SubagentSettings> | undefined
): BuiltinAgentCatalogEntry[] {
  const settings = normalizeSubagentSettings(value)
  return BUILTIN_AGENT_CATALOG.filter((entry) => {
    if (entry.family === 'base') return true
    return settings.extensionAgentsEnabled && settings.profiles[entry.id]?.enabled === true
  })
}
