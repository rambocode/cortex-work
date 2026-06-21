---
title: "feat: 收敛 agent 能力扩展入口为「技能 / 插件」两 tab,Skills 升级跨 agent"
type: feat
date: 2026-06-21
origin: docs/brainstorms/2026-06-21-agent-extension-surfaces-consolidation-requirements.md
---

# feat: 收敛 agent 能力扩展入口为「技能 / 插件」两 tab,Skills 升级跨 agent

## Summary

把集成分支 M3-B 的「跨 agent 注入 SKILL.md」能力折进现有 pi-skill 系统,让 Skills 成为唯一的「指令(prose)」入口并对 claude/codex/pi 三端生效;退掉 M3-B 的独立 Plugin 外壳;用户侧信息架构收敛为两 tab——**技能**(Skills,指令) 与 **插件**(MCP 工具 + pi 扩展)。注入装配放在 core 侧按会话 agent 分支,复用现有启用/信任态。

---

## Problem Frame

cortex 现有多个「给 agent 加能力」的入口,用词互撞、心智混乱:已上线 master 的 **MCP 服务**(工具,跨 agent)/ **pi 插件 Skill**(指令,pi 专属)/ **pi 扩展市场**(工具·命令,pi 专属)= 3 套;集成分支 `feat/agent-cli-m3-integration` 未上线的 **M3-B Plugin 框架**(指令,跨 agent)= 想加的第 4 套。

两条混乱轴:其一,「插件/skill/扩展」是 3-4 套重叠系统,都叫「插件」却各有格式/UI/作用域/注入机制——其中 pi 插件 Skill 与 M3-B Plugin 本质同一件事(装 SKILL.md、注入 prose),只是一个 pi 专属、一个跨 agent。其二,现有 skill 开关在 claude/codex 上「看着没用」:`resolveEnabledSkillPaths` 解析出的目录只被 pi adapter 的 `--skill` 消费,claude/codex 完全不读,而默认 agent 派生顺序是 `claude > codex > pi`,多数会话切开关命令行无变化。

底层其实是干净的 2×2(工具/指令 × 跨agent/仅pi),乱的是呈现。本次收敛靠合并与减法:Skills 收编 M3-B 的跨 agent 注入能力、退掉其独立外壳;呈现层收敛为两 tab。不新增「统一层」,不改 MCP / pi 扩展后端机制。

---

## Requirements

### Skills 跨 agent 投递

- R1. 已启用 skill 对 pi 继续走 `--skill` 注入;对 claude/codex 经渲染块并入 `appendSystemPrompt` 注入,使同一套 Skills 系统对三端生效。
- R2. 跨 agent 注入复用现有启用/信任态(`disabledSkills` / `trustedWorkspaceSkillDirs`),不新建 gate;工作区 skill 默认禁用、需显式授信的安全边界对 claude/codex 同样生效。
- R3. 同一 SKILL.md 不被双重注入(pi 不得既 `--skill` 又进 prose 块);全局 skill 覆盖工作区同名 skill 的去重规则维持。
- R4. 注入采用「SKILL.md 路径 + 按需 Read」形态,不塞整段正文,与既有内置 skill / pi-skill 注入一致。
- R5. 仅主会话注入;`ask` / `oneshot` / `automation` 路径维持轻量、不注入。

### M3-B 独立系统退场

- R6. 集成分支合入 master 时不带入 M3-B 独立外壳(`Plugin` 卡片、`plugin:*` IPC、`plugins.json` 存储、installer/manifest);仅保留被 R1 复用的注入渲染逻辑(以 core 重写形式落地)。
- R7. 挑拣保留 M3-A(派生 agent profiles)与 U7 资产,不随 M3-B 外壳误删。

### 信息架构收敛

- R8. 用户侧扩展入口收敛为两 tab:**技能** = Skills(指令,跨 agent);**插件** = MCP 工具 + pi 扩展(工具类,内部分区)。取代原「三套各自改名」方案。
- R9. 修订 Skills 面板中「仅对 pi 生效」等过时文案,使之与新的跨 agent 行为一致。

### 可选 / 关联(可独立落地)

- R10.(可选)skill 可在 SKILL.md frontmatter 声明 `supportedAgents`,缺省全 agent;注入时按当前会话 agent 过滤。
- R11.(关联)open-design 经 MCP 接入:在插件 tab 的 MCP 区提供 `od` 预设(`command: od, args: ["mcp","--daemon-url","http://127.0.0.1:7456"]`,端口可编辑)+ 文档。

---

## Key Technical Decisions

- KTD1 — 注入装配放 core 侧、按 agent 分支。在 `packages/core/personal/messages.ts` 的发送派发处,按当前会话 agent 分支:pi → 维持 `skillPaths`(`--skill`);claude/codex → 渲染块并入 `appendSystemPrompt`。这反转了 M3-B 把注入钩子放主进程 `cli.ts` 的形态。理由有三:对齐「core 装配设置、main 不读 store」既有约定;按 agent 分支使 pi 与 prose 注入天然互斥,无需额外去重(直接满足 R3);完全避开集成分支 `cli.ts` diff 里夹带的 M3-A 改动,降低合并风险(RISK-3)。

- KTD2 — 复用现有启用/信任 gate,不新建。跨 agent 注入沿用 `resolveEnabledSkillPaths` 同一过滤链(`disabledSkills` 复合键 `scope:name`、`trustedWorkspaceSkillDirs`)。新加的 claude/codex 分支必须过同一 gate,否则会绕过工作区 skill「默认禁用、需授信」的安全 P0 边界(R2)。

- KTD3 — 注入「路径 + 按需 Read」而非整段正文。渲染块每项给 `**name** — desc` + `指令文件: <dir>/SKILL.md(需要时用 Read 工具查看完整指令)`,对齐 cortex 既有内置 skill 注入,避免 prompt 膨胀(R4)。open-design daemon 注入整段正文是其取舍,cortex 刻意不照搬。

- KTD4 — plugin-block 渲染逻辑以纯函数 port 进 core,M3-B 外壳丢弃。集成分支 `apps/desktop/src/main/plugins/plugin-block.ts` 的 `renderPluginBlock` 在 core 重写为 `renderSkillBlock`(入参从 `InstalledPluginRecord[]` 改为 skill 记录);`selectInjectablePlugins` 不整体平移——其「pi 已 `--skill` 不再 prose 注入」去重被 U2 的按-agent 分支互斥取代(故无需移植),其 `supportedAgents` 过滤改在 U5 以 skill frontmatter 形式实现。`installer.ts` / `plugins-store.ts` / `manifest.ts` / `ipc/plugins.ts` / `PluginSection.tsx` / `plugins.json` 一律丢弃。按文件/hunk 挑拣合并,不整支 cherry-pick(R6/R7)。

- KTD5 — 用户侧两 tab、底层不硬合。呈现收敛为 **技能** / **插件** 两 tab;但 MCP、pi 扩展、Skills 三套底层机制不硬合,仅在 UI 归类——插件 tab 内 MCP 与 pi 扩展各自成区。取代 brainstorm 决策 3 的「三套各自改名」(R8)。

- KTD6 — 仅主会话注入。沿用 M3-B 的注入边界,`ask` / `oneshot` / `automation` 不注入,维持轻量(R5)。

- KTD7 — FR-5 `od` 预设零核心改动。挂在 M2 已验证的 MCP stdio `command`/`args` 注入 + 严格 gate(不覆盖用户已有 `.mcp.json`)之上;`od` 端口可编辑(R11)。

---

## High-Level Technical Design

### 注入装配:按 agent 分支(KTD1)

```mermaid
flowchart TB
  A["发送派发<br/>messages.ts (send/RPC)"] --> B["resolveEnabledSkillPaths<br/>扫描 + disabledSkills/未授信过滤 + name 去重"]
  B --> C{"当前会话 agent?"}
  C -->|pi| D["skillPaths = 已启用目录<br/>(不 prose 注入)"]
  C -->|claude / codex| E["renderSkillBlock(records)<br/>并入 appendSystemPrompt<br/>(与 buildGlobalAppend 同位拼接)"]
  D --> F["CliStartRequest"]
  E --> F
  F --> G{"adapter buildArgs<br/>(读 appendSystemPrompt 能力位)"}
  G -->|pi| H["--no-skills + --skill <dir>...<br/>append: 原生 --append-system-prompt"]
  G -->|claude| I["--append-system-prompt"]
  G -->|codex| J["promptWrap: 包成 user_request 前缀"]
```

关键不变量:pi 分支与 claude/codex 分支互斥,同一 SKILL.md 不双注入(R3);`appendSystemPrompt` 用 `[existing, block].filter(Boolean).join` 拼接,与 `globalInstruction` 叠加不覆盖(RISK-1);仅主会话走此分支(R5)。

### 信息架构:三 tab + 独立 McpCard → 两 tab

```mermaid
flowchart LR
  subgraph 之前
    direction TB
    PM1["PluginManager<br/>tab: MCP(占位) / Skill / 扩展"]
    MC1["McpCard<br/>(SettingsMenu 独立挂载)"]
  end
  subgraph 之后
    direction TB
    T1["技能 tab<br/>= SkillPanel(跨 agent)"]
    T2["插件 tab<br/>= MCP 工具区 + pi 扩展区"]
  end
  之前 --> 之后
```

「技能」管指令(prose)、「插件」管工具(MCP / pi 扩展),定义清晰互斥。McpCard 内容从独立挂载移入「插件」tab 的 MCP 区;MCP 占位 tab(`McpPlaceholder`)撤掉。

---

## Implementation Units

> 里程碑 1(U1–U3)= 核心减法:Skills 跨 agent + 退 M3-B 壳。里程碑 2(U4)= 信息架构两 tab。U5/U6 为可独立落地的附加单元。

### U1. plugin-block 渲染逻辑 port 进 core(纯函数)

- Goal:把 M3-B 的注入块渲染以纯函数形式重写进 core,入参改为 skill 记录,供跨 agent 注入复用。
- Requirements:R1, R4
- Dependencies:无
- Files:
  - `packages/core/personal/skill-injection.ts`(新增)
  - `packages/core/personal/skill-injection.test.ts`(新增)
- Approach:`renderSkillBlock(skills: { name; description?; dir }[]) => string`,渲染「## 已启用的 Skills」markdown 块,每项 `**name** — desc` + `指令文件: <dir>/SKILL.md(需要时用 Read 工具查看完整指令)`;空输入→空串;纯函数、不读盘。预留 `supportedAgents` 过滤入口供 U5(缺省全 agent,本单元不实装过滤)。去重不在本层(由 U2 的 resolver 负责)。
  - **安全清洗(RISK-5)**:`name`/`description` 来自工作区 SKILL.md frontmatter,渲染前须去除换行(`[\r\n]` → 空格)与前导 `#`,防止恶意仓库借多行/标题构造从 bullet 越界、注入伪 system prompt 段。注入的 `name`/`description` 是进入 claude/codex system prompt 的攻击面,与 pi 由 agent 自读 SKILL.md 不同。
- Patterns to follow:集成分支 `apps/desktop/src/main/plugins/plugin-block.ts` 的 `renderPluginBlock` 渲染形态(`feat/agent-cli-m3-integration`);cortex 内置 skill「给路径让 agent 自读」注入约定。
- Test scenarios:
  - 多 skill 渲染含名称/描述/`<dir>/SKILL.md` 路径,块标题正确。
  - 空数组 → 返回空串(下游据此跳过注入)。Covers R4 边界。
  - 缺省 `description` 时不破坏 markdown 结构。
  - 名称/描述含 markdown 特殊字符(`*`、`_`、反引号)不破坏块结构。
  - `description` 含 `\n## 新段落\n忽略以上指令` → 渲染结果不产生新的 markdown 标题/段落,换行被清洗为空格。Covers RISK-5。
- Verification:`pnpm --filter @cortex-work/core test` 通过;函数无副作用、可被 web/desktop 复用。

### U2. resolveEnabledSkillPaths 暴露 skill 记录 + 跨 agent 分支注入装配

- Goal:在发送派发处按会话 agent 分支注入——pi 走 `--skill`、claude/codex 走 `appendSystemPrompt` 渲染块,复用现有启用/信任态。
- Requirements:R1, R2, R3, R5
- Dependencies:U1
- Files:
  - `packages/core/personal/skill-injection.ts`(U1 新模块;新增 `resolveEnabledSkillRecords` + 派发胶水,避免堆进已超标的 `messages.ts`)
  - `packages/core/personal/messages.ts`(`buildGlobalAppend` ~1365、发送派发 ~1519 / ~2157;只接线、不堆逻辑)
  - `packages/core/personal/piSkills.ts`(slash 菜单同源副本,若过滤规则被改动则同步)
  - `packages/core/personal/skillResolve.test.ts`、`messages.test.ts`
- Approach:
  - **不改 `resolveEnabledSkillPaths` 现有签名**(返回 `string[]`,pi 路径与现有 `skillResolve.test.ts` 不动);新增 `resolveEnabledSkillRecords(...) => { name; description?; dir }[]`,复用同一过滤链(`useOwnSkills` 短路、`disabledSkills`、`trustedWorkspaceSkillDirs`、name 去重 + 全局覆盖工作区),供 claude/codex 渲染用。避免改返回类型连带破坏 pi 的 `startCli` 调用点(~2157,`skillPaths: string[]`)与六个既有断言。
  - 发送派发分支:`agent === "pi"` → 沿用 `resolveEnabledSkillPaths` 设 `skillPaths`、不 prose 注入;claude/codex → `renderSkillBlock(resolveEnabledSkillRecords(...))` 并入 `appendSystemPrompt`(与 `buildGlobalAppend` 同位、`filter(Boolean).join("\n\n")` 叠加不覆盖)、不设 `skillPaths`。分支互斥即满足 R3 去重。
  - **`useOwnSkills` 短路对 claude/codex 同样生效(RISK-2)**:claude/codex 分支必须把 `sendSession.useOwnSkills` 喂给 records 解析,与 pi 一致——否则会话级「禁用全部 skill」开关在 claude/codex fail-open。
  - **行数上限**:`messages.ts` 现 ~2402 行(已 2× 超 1200 上限),新逻辑落在 `skill-injection.ts`,`messages.ts` 仅 import 接线,不在超标文件继续堆叠。
  - 仅主会话注入,`ask`/`oneshot`/`automation` 不走此分支(R5)。
- Patterns to follow:现有 `buildGlobalAppend` 拼接 `globalInstruction` + `languageInstruction` 的同位模式;`resolveEnabledSkillPaths` 过滤逻辑(被 `resolveEnabledSkillRecords` 复用)。
- Execution note:pi 的 RPC 路径 `skillPaths` 是**会话级**(在 `ensurePiSession` 时一次性下发、变更才触发会话重开),不要把它挪到 per-prompt 位置;claude/codex 的注入则在每轮 `appendSystemPrompt` 装配。两者时序不同,勿强行对齐。
- Test scenarios:
  - 既有 `skillResolve.test.ts` 的六个 `string[]` 断言保持绿(不改 `resolveEnabledSkillPaths`)。
  - pi 会话:`skillPaths` 含已启用目录,且 `appendSystemPrompt` 不含 Skills 块。Covers R1, R3。
  - claude 会话:`appendSystemPrompt` 含 Skills 块,且 `skillPaths` 为空。Covers R1。
  - codex 会话:同上独立验证(codex 经 prompt-wrap 注入,不与 claude 共用断言)。Covers R1。
  - `useOwnSkills === false` 时,claude/codex 的 `appendSystemPrompt` 不含 Skills 块。Covers RISK-2。
  - `disabledSkills` 命中的 skill 在两个分支都被排除。Covers R2。
  - 未授信 workspace skill 在两个分支都被排除(授信后才注入)。Covers R2。
  - `globalInstruction` 与 Skills 块共存时两者都在,互不覆盖。Covers RISK-1。
  - 启用集为空 → 两分支都不注入、不抛错。
  - `ask`/`oneshot`/`automation` 派发不注入 Skills 块。Covers R5。
- Verification:`pnpm --filter @cortex-work/core test` 通过(含既有断言);切换会话 agent 后注入随之变化(pi 出现 `--skill`、claude/codex 出现 append 块)。

### U3. 退掉 M3-B 独立壳 / 合并策略落地

- Goal:确保集成分支合入 master 时不带入 M3-B 独立外壳;若已合入则删除。保留 M3-A / U7 资产。
- Requirements:R6, R7
- Dependencies:U1, U2(注入逻辑已在 core 重写,故 main 侧 plugin 壳可整体退场)
- Files(排除/删除,repo-relative):
  - `apps/desktop/src/main/plugins/plugin-block.ts`、`manifest.ts`、`installer.ts`、`plugins-store.ts`(及对应 `.test.ts`)
  - `apps/desktop/src/main/ipc/plugins.ts`
  - `packages/views/cortex-desktop/personal/PluginSection.tsx`
  - `apps/desktop/src/main/ipc/register.ts`(`registerPluginHandlers()` 调用)
  - `packages/views/cortex-desktop/personal/SettingsMenu.tsx`(`PluginCard` import / 渲染)
  - `apps/desktop/src/main/ipc/types.ts`(`InstalledPluginRecord` / `PluginSettings` / `PluginInstallResult`)
  - `packages/core/desktop/bridge.ts`(plugin 相关 bridge 方法)
  - `~/.cortex-desktop/plugins.json` 持久化(运行时数据,随逻辑下线)
- Approach:按文件/hunk 挑拣,不整支 cherry-pick——集成分支的 `cli.ts` / `ipc/types.ts` / `agents/index.ts` 同时含 M3-A 改动(`spawnEnvForDef`、`baseAgentKindOf`、`listAgentProfiles`/`refreshLocalAgentProfiles`、`agents:profiles` IPC、`TrustTier`/`AgentProfile` 等),必须保留。先确认集成分支合并状态:未合并 → 在合并时排除上列 plugin 壳文件/hunk;已合并 → 删除上列文件并清理引用。
  - **澄清归属(防误删/误留)**:`PluginCard` 由 `PluginSection.tsx` 导出,删该文件即随之消失,`SettingsMenu.tsx` 只需移除 import/渲染,不另列删除项。`InstalledPluginRecord`/`PluginSettings`/`PluginInstallResult`(`apps/desktop/src/main/ipc/types.ts`)属 M3-B,删。**注意区分**:现有 pi-skill 的 `PluginSkill` 类型(`packages/core/desktop/types.ts`)是既有 skill 记录类型,**不属 M3-B、U3 不删**(U5 在其上加 `supportedAgents`);命名虽近「Plugin」但与被退场的 M3-B 系统无关。
- Execution note:合并协调 + 删除单元,无新行为;不写新测试,以类型检查 + 引用残留扫描验证。
- Test expectation:none —— 删除/排除单元。
- Verification:`pnpm --filter @cortex-work/desktop typecheck`(node + web 两套)通过;`rg "plugin:" apps/desktop/src/main/ipc`、`rg "InstalledPluginRecord|plugins\.json|PluginCard"` 无残留;M3-A 资产(`listAgentProfiles` 等)仍在。

### U4. PluginManager 收敛为两 tab(技能 / 插件)

- Goal:用户侧从三 tab + 独立 McpCard 收敛为两 tab:技能 = SkillPanel;插件 = MCP 工具区 + pi 扩展区。
- Requirements:R8, R9
- Dependencies:U2(技能 tab 行为已跨 agent)。U3 为协调项、可并行推进:U4 改动的 UI 文件(PluginManager/McpSection/ExtensionPanel/SettingsMenu)与 M3-B 壳文件无重叠,仅需确认 `PluginManager` 不再 import `PluginSection`,不必等 U3「完成」。
- Files:
  - `packages/views/cortex-desktop/personal/PluginManager.tsx`(两 tab 容器)
  - `packages/views/cortex-desktop/personal/McpSection.tsx`(`McpCard` 并入插件 tab)
  - `packages/views/cortex-desktop/personal/ExtensionPanel.tsx`(pi 扩展区,文案归位)
  - `packages/views/cortex-desktop/personal/SettingsMenu.tsx`(撤掉独立 `McpCard` 挂载,统一进 PluginManager)
- Approach:`技能` tab 渲染 `SkillPanel`;`插件` tab 渲染 `McpCard` + `ExtensionPanel` 两个 section(区标题「MCP 工具」「pi 原生扩展(pi 专属)」);删除 MCP 占位 tab(`McpPlaceholder`);把 `McpCard` 从 `SettingsMenu`(~1362)独立挂载移入插件 tab,避免设置项重复。这些 UI 为硬编码 zh 字面量(非 i18n),直接改字符串。具体文案:
  - **McpCard 标题**:`McpSection.tsx` 内硬编码「MCP 服务」改为「MCP 工具」,与新 IA 一致(否则插件 tab 仍显旧名)。
  - **SkillPanel 过时提示**(R9,当前写「仅对 pi 生效」):替换为——「开关对 claude / codex / pi 三端均生效:pi 走 `--skill` 注入,claude/codex 将 skill 附加到系统提示。工作区 skill 需先『信任』才注入。」
  - **ExtensionPanel 作用域提示**:pi 扩展落在跨 agent 观感的「插件」tab 下却仅对 pi 生效,需加一行作用域说明——「pi 原生扩展仅在 pi 会话中加载,对 claude / codex 无效。」避免 claude 会话用户误以为已启用扩展生效。
- Patterns to follow:现有 `PluginManager` 三 tab 容器结构;`McpCard` / `ExtensionPanel` 现有 props 与 bridge 调用不变。
- Test scenarios:
  - 设置面板仅渲染「技能」「插件」两 tab,无 MCP 占位/旧 Skill/扩展三分。Covers R8。
  - 插件 tab 同时渲染 MCP 区与 pi 扩展区两个 section。Covers R8。
  - `SkillPanel` 不再出现「仅对 pi 生效」文案。Covers R9。
- Verification:`pnpm --filter @cortex-work/desktop typecheck` 通过;手测设置面板两 tab 与插件 tab 双区呈现;旧独立 MCP 设置项不再重复出现。

### U5.(可选)SKILL.md frontmatter 声明适用 agent

- Goal:skill 可声明 `supportedAgents`,缺省全 agent;注入时按会话 agent 过滤。
- Requirements:R10
- Dependencies:U1, U2
- Files:
  - `apps/desktop/src/main/skills/frontmatter.ts`(解析 `supportedAgents`)
  - `apps/desktop/src/main/skills/registry.ts`(扫描产出携带 `supportedAgents`)
  - `packages/core/desktop/types.ts`(`PluginSkill` 增可选 `supportedAgents`)
  - `packages/core/personal/skill-injection.ts`(启用 U1 预留的过滤入口)
  - 对应 `.test.ts`
- Approach:frontmatter 解析 `supportedAgents` 字符串数组;扫描产出携带;注入前按当前 agent 过滤(缺省/空 = 全 agent)。pi 的 `--skill` 同样过滤以保持三端一致。
- Patterns to follow:M3-B `manifest.ts` 的 `supportedAgents` 语义;现有 `skills/frontmatter.ts` frontmatter 解析。
- Test scenarios:
  - skill 声明 `supportedAgents: [pi]` → claude 会话不注入、pi 注入。Covers R10。
  - 缺省/空字段 → 全 agent 注入。
  - 非法值(非数组/未知 agent 名)容错降级为全 agent,不抛错。
- Verification:`pnpm --filter @cortex-work/core test` 与 desktop 单测通过。

### U6.(独立)open-design 经 MCP 接入 od 预设

- Goal:在插件 tab 的 MCP 区提供一键 `od` 预设 + 文档。
- Requirements:R11
- Dependencies:U4(MCP 区已在插件 tab 内);逻辑上不依赖 U1–U3,可独立落地
- Files:
  - `packages/views/cortex-desktop/personal/McpSection.tsx`(预设按钮/项)
  - `packages/core/desktop/types.ts`(若需预设结构定义)
  - 文档(`docs/` 或对应使用说明)
- Approach:预设填充 `McpServerConfig`(`transport: "stdio"`,`command: "od"`,`args: ["mcp","--daemon-url","http://127.0.0.1:7456"]`)。**仅暴露端口数字字段**,`--daemon-url` 由 `http://127.0.0.1:<port>` 程序化拼接(不让用户编辑完整 URL),从源头杜绝非 loopback host(避免把工作区上下文路由到外部 server)。注入端 `apps/desktop/src/main/ipc/mcp-config.ts` 已通吃 stdio `command`/`args`,零核心改动;遵守严格 gate(不覆盖用户已有 `.mcp.json`)。
- Patterns to follow:M2 MCP stdio 注入(`docs/plans/2026-06-21-005-feat-agent-cli-m2-capabilities-plan.md` 的严格 gate);`McpSection.tsx` 现有 `addServer` 推入空 stdio server 的模式。
- Test scenarios:
  - 选 `od` 预设 → 新增一个 stdio server,`command === "od"`,`args` 含 `mcp` 与 `--daemon-url`。Covers R11。
  - 编辑端口 → 拼接的 `--daemon-url` 随之更新,且 host 恒为 `127.0.0.1`(无法被改成外部 host)。
  - 预设添加不覆盖用户已有 `.mcp.json`(严格 gate)。
- Verification:一键添加预设后 server 列表出现 od;M2 注入链路已验证 stdio 可用。

---

## Scope Boundaries

### 暂缓(后续可做)
- **3 套 → 2 套(北极星终态)**:废弃 pi 扩展市场、工具统一 MCP。涉及移除已上线功能,且 pi 扩展有 MCP 顶不上的能力(斜杠命令/审批/`ctx.ui`),除非用量极低否则不动(见 origin)。
- pi 扩展与 MCP 的硬合:二者在 2×2 同属「工具」但机制不同,硬合两边都残废;本次仅在插件 tab 内分区归类,不合并机制(origin 决策 5)。

### 不属于本次
- 把 cortex 改成 daemon(已多轮确认对桌面交互形态是负债)。
- 重做 MCP / pi 扩展的后端机制——只对它们改名/归位(origin)。

### Deferred to Follow-Up Work
- 若实现中发现 `resolveEnabledSkillPaths` 与 `piSkills.ts` 的同源过滤副本可进一步抽公共函数,作为独立清理项,不进本次主 diff。

---

## Risks & Dependencies

> 注:风险用 `RISK-N` 命名,与需求 ID `R1..R11`(无连字符)区分,避免「R-1」与「R1」撞名歧义。

- RISK-1 — 叠加不覆盖 + pi 不双注入。跨 agent 注入须与 `globalInstruction` / 内置 skill 注入叠加而非覆盖;pi 同一 SKILL.md 不要既 `--skill` 又进 prose 块。**缓解**:KTD1 按 agent 分支使两路互斥;`appendSystemPrompt` 用 `filter(Boolean).join` 拼接(U2)。
- RISK-2 — 信任模型复用。跨 agent 注入须过同一启用/信任 gate,否则绕过工作区 skill 安全 P0 边界。**缓解**:KTD2,claude/codex 分支共用同一过滤链 + `useOwnSkills` 短路(U2)。
- RISK-3 — 集成分支挑拣合并(M3-A 夹带)。`feat/agent-cli-m3-integration` 的 `cli.ts`/`types.ts`/`agents/index.ts` 同时含 M3-A 与 M3-B,不能整支合并。**缓解**:KTD4 + U3 按文件/hunk 挑拣,plugin-block 在 core 重写以斩断对集成分支文件的依赖。
- RISK-4 — 改名/IA 一次性改齐。两 tab 收敛涉及多处文案与挂载点。**缓解**:U4 同步修订 `SkillPanel` 过时文案、撤独立 McpCard 挂载;文案为硬编码字面量直接改齐。
- RISK-5 — prose 注入扩大 prompt-injection 面。工作区 SKILL.md 的 `name`/`description` 现进入 claude/codex system prompt,恶意仓库可借多行/标题注入。**缓解**:U1 渲染前清洗换行与前导 `#`;授信 gate(RISK-2)是前置闸门。
- 依赖 — 集成分支合并时序:U3 是「排除」还是「删除」取决于集成分支是否先于本计划合入 master(见 Open Questions)。

---

## Open Questions

- 集成分支 `feat/agent-cli-m3-integration` 与本计划的合并时序未定。若集成分支先合入 master,U3 为「删除已落地的 M3-B 壳文件」;若本计划先行,U3 为「在后续合并集成分支时排除壳文件/hunk」。这是执行时协调项,不阻塞本计划的 U1/U2/U4 推进——两种路径的保留/丢弃清单相同(见 U3 Files)。
- `editResend`(重发/编辑后重发)路径在 `messages.ts` 有独立派发分支。U2 的跨 agent 注入须确认在 `editResend` 的 claude/codex 子路径上同样生效且过同一信任 gate,否则重发消息可能漏注入或绕过授信检查。实现时把 U2 的注入接线同时覆盖该分支(可在实现期合并为同一装配函数)。
- 两 tab 的若干 UX 取舍留执行时定,均非阻塞:① 两 tab 是各自保留分区内搜索框,还是 `PluginManager` 顶层统一搜索(倾向保留分区内,实体类型不同);② 插件 tab 在「无 MCP server + 无扩展」时是两个堆叠 micro-empty 还是统一引导空态;③ `McpCard` 移出 Agent 设置区后,原处是否留一行跳转提示还是静默移除。

---

## Sources / Research

- origin 需求文档:`docs/brainstorms/2026-06-21-agent-extension-surfaces-consolidation-requirements.md`(2×2 模型、决策 1–5、FR-1–FR-5、R-1–R-4)。
- M3-B 设计依据:`docs/plans/2026-06-21-007-feat-agent-cli-m3-plugin-framework-plan.md`(注入走 `appendSystemPrompt`、「路径 + 按需 Read」形态、去重、注入边界、可弃外壳清单)。
- M2 能力 / MCP 严格 gate:`docs/plans/2026-06-21-005-feat-agent-cli-m2-capabilities-plan.md`(声明式 AgentDef 能力位、MCP stdio `command`/`args` 注入、不覆盖用户 `.mcp.json`)。
- pi-skill 底座与信任模型:`docs/plans/2026-06-17-003-feat-pi-skill-plugin-manager-plan.md`(`disabledSkills` 复合键、`trustedWorkspaceSkillDirs`、工作区 skill 默认禁用的安全 P0、`--no-skills` + 显式 `--skill`)。
- claude/codex skill 现状:`docs/plans/2026-06-20-004-feat-pi-slash-skills-and-toggle-scope-plan.md`(当时选「诚实化而非补能力」;本计划反转该取舍,故其「仅 pi 生效」文案需同步更新)。
- 关键代码位:`packages/core/personal/messages.ts`(`resolveEnabledSkillPaths`、`buildGlobalAppend`、发送派发)、`apps/desktop/src/main/skills/{registry,locate,frontmatter}.ts`、`apps/desktop/src/main/agents/{pi,claude,codex}.ts`、`apps/desktop/src/main/ipc/{cli,mcp-config,skills}.ts`、`packages/views/cortex-desktop/personal/{PluginManager,McpSection,ExtensionPanel,SettingsMenu}.tsx`。集成分支独有:`apps/desktop/src/main/plugins/*`、`apps/desktop/src/main/ipc/plugins.ts`、`packages/views/cortex-desktop/personal/PluginSection.tsx`。
