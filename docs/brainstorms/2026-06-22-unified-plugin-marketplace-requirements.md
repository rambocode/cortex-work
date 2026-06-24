---
date: 2026-06-22
topic: unified-plugin-marketplace
---

# 统一插件市场:采用 Claude Code 插件市场标准 — 需求文档

## Summary

cortex 采用 **Claude Code 插件市场标准**(Codex / Claude / Cursor 共享的同一套规范)作为统一扩展模型:git 安装的插件包,呈现为「插件 / 应用 / MCP / 技能 / 市场」多面,一键启用,支持浏览 / 安装 / 升级,三方经 git URL 接入,内置几个默认插件。插件装进共享标准目录 `~/.agents/plugins/`,与 Codex 互通。codex 会话原生使用插件;claude / pi 经现有跨 agent 注入复用插件中可移植的 skill / MCP 部分。

## Problem Frame

cortex 此前有多套互不相通的「给 agent 加能力」入口(MCP、pi skill、pi 扩展),以及一套自造的 M3-B 插件格式。上一轮收敛(`docs/brainstorms/2026-06-21-agent-extension-surfaces-consolidation-requirements.md`)走的是「减法 + 自造两 tab」路线。

但市面已存在一套**通用插件市场规范**——Claude Code 的 `.claude-plugin/marketplace.json` + 插件包格式,Codex 与 Cursor 都消费同一套,主流插件(Spreadsheets / PDF / Browser / Computer Use 等,开发者多为 OpenAI)都以此分发。继续自造格式 = 重复发明轮子,且无法复用这个既有生态。

本需求把方向改为:**不发明轮子,直接采用这套通用规范**,让 cortex 成为该生态的一等消费方。用户得到「类似 Codex」的统一扩展 + 市场体验:浏览、一键启用、装三方、升级。上一轮的自造两 tab / od 预设 UI 让位于此;但其跨 agent 注入核心(本会话已建的 `skill-injection.ts`)被保留复用,正是它让 Codex 插件的 skill 部分在 claude / pi 上「尽力而为」生效。

## Key Decisions

- **采用共享标准,不自造格式。** 以 Claude Code 插件市场规范为 cortex 的统一扩展格式;插件包结构(`.claude-plugin/` / `.codex-plugin/` manifest + `skills/` + `agents/`)、市场索引(`marketplace.json`)、安装来源记录(git URL + revision)一律沿用。
- **共享标准目录,与 Codex 互通。** 插件读写与 Codex / Claude / Cursor 同一套磁盘位置(`~/.agents/plugins/` 索引 + 共享 marketplaces 目录)。在 cortex 装的插件,codex 也可见;反之亦然。
- **enable / trust 作 cortex 本地叠加层。** 规范本身无「启用 / 信任」概念;cortex 在共享安装状态之上叠加自己的 opt-in 启用集 + 信任门(沿用现有 skill / 扩展的信任模型),作为增值,不写回共享标准的语义。
- **codex 原生完整,claude / pi 尽力而为。** 插件对 codex 会话完整生效;对 claude / pi 只复用可移植部分(`skills/` 经现有 SKILL.md 解析 + 跨 agent 注入;MCP 经 MCP 通道)。codex-runtime 专属能力(Computer Use、交互式 Spreadsheets 等)在 claude / pi 不可用,UI 如实标注。
- **取代上一轮自造方案。** 五面 + 市场取代刚发的「技能 / 插件」两 tab 与 od 预设 UI;跨 agent 注入核心(`skill-injection.ts`)保留。

## Requirements

### 规范采用与互通

- R1. cortex 解析 Claude Code 插件市场规范:`marketplace.json`(顶层索引 + 插件包内的注册表入口)与插件 manifest(`.codex-plugin/plugin.json` 优先,回退 `.claude-plugin/plugin.json`),读取 name / version / description / category / capabilities / skills 等字段。
- R2. 插件读写共享标准目录(`~/.agents/plugins/` 索引 + 共享 marketplaces 目录),与 Codex / Claude / Cursor 同位互通;cortex 安装的插件登记进共享索引,codex 可见。
- R3. 复用现有 SKILL.md 解析(`apps/desktop/src/main/skills/`):插件包 `skills/<name>/SKILL.md` 结构与 cortex 现有 skill 一致,直接服用,无需转换。

### 市场生命周期(浏览 / 安装 / 升级)

- R4. 浏览:从市场(git 仓库注册表 / 已订阅 marketplace)列出可用插件,展示其 manifest 元数据(名称、描述、开发者、类别、版本、能力)。
- R5. 安装:经 git URL 安装三方插件——clone 插件仓库 → 解析其 `marketplace.json` 的 `plugins[]` → 落盘到共享目录 → 记录安装来源(`source_type: git` + git URL + revision SHA)。
- R6. 升级:基于已记录的 git URL + revision,检查远端是否有新版本并执行升级(re-fetch + 比较 SHA);UI 提供「升级」入口。
- R7. 一键启用 / 禁用:用户对已安装插件直接启用 / 禁用(cortex 本地 opt-in 启用集),无需手动改配置。

### 呈现(五面)

- R8. 扩展入口呈现为多面:**插件**(已装插件包,带启用开关与详情)、**技能**(插件内 skills 与既有 skill)、**MCP**(MCP server 配置面,独立通道)、**应用**(按插件能力元数据过滤出的视图)、**市场**(浏览 / 安装 / 升级)。
- R9. 插件详情页展示规范里的富元数据:displayName、描述、开发者、类别、版本、能力(capabilities)、默认提示词(defaultPrompt)、隐私 / 条款链接(如有);提供「在对话中试用」式入口(注入该插件后发默认提示词)。

### 跨 agent 行为

- R10. 已启用插件对 codex 会话原生完整生效。
- R11. 对 claude / pi:复用插件可移植部分——`skills/` 经现有跨 agent 注入(`skill-injection.ts`),MCP 经 MCP 通道;codex 专属 runtime 能力不可用且 UI 标注。
- R12. 跨 agent 注入沿用现有启用 / 信任 gate(`disabledSkills` / `trustedWorkspaceSkillDirs` 同源),不绕过安全边界。

### 信任与安全

- R13. 从 git 安装三方插件视为引入外部指令 / 代码:安装后**默认未授信 / 未启用**,需用户显式启用;cortex 信任门覆盖市场插件(沿用现有信任模型,按来源指派信任层)。
- R14. 安装落盘遵守现有安全约束(拒符号链接、大小上限等,沿用 M3-B installer 的 safeCopyTree 思路)。

### 默认插件

- R15. cortex 内置几个默认插件(具体清单待定,见 Outstanding Questions),首启即可用,作为「直接启用即可」的初始体验。

## Key Flows

- F1. 安装三方插件
  - **Trigger:** 用户在「市场」面粘贴 git URL 或选中可用插件点「安装」。
  - **Actors:** 用户、cortex 主进程、git 远端、共享标准目录。
  - **Steps:** clone 仓库 → 解析 `marketplace.json` 的 `plugins[]` → 落盘到共享目录(安全约束)→ 写安装来源记录(git URL + revision)→ 登记进共享索引 → 默认未授信 / 未启用。
  - **Covered by:** R5, R13, R14。

- F2. 启用并使用插件
  - **Trigger:** 用户在「插件」面对已装插件打开启用开关(必要时先授信)。
  - **Steps:** cortex 写本地 opt-in 启用集 → 下一轮会话:codex 原生加载;claude / pi 经跨 agent 注入复用其 skill / MCP 部分。
  - **Covered by:** R7, R10, R11, R12, R13。

- F3. 升级插件
  - **Trigger:** 用户点「升级」,或系统检查到新版本。
  - **Steps:** 据安装来源(git URL + revision)re-fetch → 比较远端 HEAD 与已记录 SHA → 有新版本则更新落盘并刷新 manifest / 启用状态。
  - **Covered by:** R6。

## Scope Boundaries

### 暂缓(后续可做)
- 插件的**创作 / 发布**(作者端工具链):cortex v1 只做消费方,不做插件打包 / 发布。
- cortex 自有的**远端策展市场注册表**:复用既有 git 生态,不自建中心化市场后端。
- 让 codex-runtime 专属能力(Computer Use 等)在 claude / pi 上工作:明确「尽力而为」,不移植不可移植的部分。

### 不属于本产品身份(定位决策)
- 自造 cortex 私有插件格式:已被「采用共享标准」取代,不再走。
- 上一轮的两 tab 自造 IA / od 预设 UI:让位于五面 + 市场(其跨 agent 注入核心保留复用,非废弃)。

## Dependencies / Assumptions

- 共享标准目录的真实形态(已 scout 验证,见 Sources):`~/.agents/plugins/marketplace.json`(本地索引)、`~/.codex/.tmp/marketplaces/<name>/`(git clone 缓存 + `.codex-marketplace-install.json` 升级源)、插件包多 manifest(`.codex-plugin/` / `.claude-plugin/` / `.cursor-plugin/`)。
- **假设(待规划核实)**:规范由 Anthropic / OpenAI 外部演进,cortex 作消费方需容忍字段增删;读取策略优先 `.codex-plugin/plugin.json`(字段最全,含 `interface` 与 `skills`)。
- **假设**:规范里插件 manifest **不含 MCP 声明**(scout 证实),故「MCP」面仍是 cortex 独立配置通道,不由插件安装喂入;与 codex 的 MCP 配置互通方式待规划细化。
- **假设**:「应用(apps)」在规范里无独立类型(类型靠目录约定),cortex 的「应用」面更可能是按能力元数据过滤的视图而非另一套机制。
- 复用资产:现有 `skills/` 解析(`frontmatter.ts` / `registry.ts`)、跨 agent 注入(`packages/core/personal/skill-injection.ts`)、M3-B 的 installer / plugins-store 思路(原子写 / 信任门 / safeCopyTree,见集成分支)。

## Outstanding Questions

### Resolve Before Planning
- 共享目录的**写入归属 / 并发**:cortex 与 codex 同写 `~/.agents/plugins/` 时如何避免互相破坏(谁拥有索引、写锁 / 原子写策略)。这影响 R2 / R5 的安全性,规划首步需定。

### Deferred to Planning
- 默认内置哪几个插件(R15 的具体清单)。
- 升级检查的触发时机与频率(手动 / 启动时 / 后台轮询)。
- 「应用」面的确切判定规则(用哪些 capability / category 字段过滤)。
- claude / pi 复用插件 MCP 部分的具体接线(经现有 `mcp-config.ts` 还是新增桥接)。

## Sources / Research

- 格式 grounding(本机真实文件,scout 验证):`~/.agents/plugins/marketplace.json`(顶层本地索引:`name` / `interface.displayName` / `plugins[]{name, source{source,path}, policy{installation,authentication}, category}`);`~/.codex/.tmp/marketplaces/compound-engineering-plugin/.claude-plugin/marketplace.json`(注册表入口:`owner` / `metadata.version` / `plugins[]{name, description, author, homepage, tags, source}`);`.codex-marketplace-install.json`(升级源:`source_type` / `source`(git URL)/ `revision`(SHA));插件 manifest `.codex-plugin/plugin.json`(`name` / `version` / `skills: "./skills/"` / `interface{displayName, category, capabilities, defaultPrompt, screenshots}`)。
- cortex 现有机制对照:skill 系统(`apps/desktop/src/main/skills/registry.ts`、`frontmatter.ts`,目录扫描 + SKILL.md frontmatter)、MCP(`apps/desktop/src/main/ipc/mcp-config.ts`、`McpSettings`)、pi 扩展(`packages/core/personal/`,`InstalledExtensionRecord`)。
- M3-B 自造插件格式(集成分支 `feat/agent-cli-m3-integration`):`apps/desktop/src/main/plugins/{manifest,installer,plugins-store}.ts`、`~/.cortex-desktop/plugins.json`、`renderPluginBlock` 注入——其 installer / store / 注入模式可复用,格式让位于共享标准。
- 上一轮收敛需求(被本需求取代方向):`docs/brainstorms/2026-06-21-agent-extension-surfaces-consolidation-requirements.md`;其跨 agent 注入成果 `packages/core/personal/skill-injection.ts` 保留复用。
- 直接可复用结论:Codex 插件 `skills/<name>/SKILL.md` 结构与 cortex 现有 skill 完全一致 → frontmatter 解析直接服用;`renderPluginBlock` / `skill-injection` 的「给路径让 agent 自读」注入可直接用于插件技能。
