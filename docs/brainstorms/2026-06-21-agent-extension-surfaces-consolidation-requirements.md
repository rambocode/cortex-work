# 收敛 agent 能力扩展入口(MCP / Skills / pi 扩展)— 需求文档

- 日期:2026-06-21
- 范围层级:Deep — feature(信息架构/系统收敛,反转 M3-B 的「独立 Plugin 系统」形态)
- 状态:待规划(交接 ce-plan);**当前仅决策,未动手**
- 关联:M3-B Plugin 框架(`docs/plans/2026-06-21-007-feat-agent-cli-m3-plugin-framework-plan.md`,已实现于集成分支 `feat/agent-cli-m3-integration`,**尚未合并 master**);M2 MCP(已上线 master)

## 背景与问题

cortex 现在有多个「给 agent 加能力」的入口,用词互撞、心智混乱:

- 已上线(master):**MCP 服务**(M2,工具,跨 agent)/ **pi 插件 Skill**(指令,pi 专属,`--skill`)/ **pi 扩展市场**(工具·命令,pi 专属,`-e`)= **3 套**
- 集成分支未上线:**M3-B Plugin 框架**(指令,跨 agent,注入 appendSystemPrompt)= 想加的**第 4 套**

两条具体混乱轴:
- **「MCP」散在多处**:既有独立 MCP 卡片,plugin 又可能自带 MCP(open-design 旗舰即一个 MCP server)。
- **「插件/skill/扩展」是 3-4 套重叠系统**:都叫「插件」,却各有格式/UI/作用域/注入机制。其中 **pi 插件 Skill 与 M3-B Plugin 本质同一件事**(装 SKILL.md、注入 prose),只是一个 pi 专属、一个跨 agent。

底层其实是干净的 2×2,乱的是呈现:

| | 工具(可调用) | 指令(prose) |
| --- | --- | --- |
| **跨 agent** | MCP(M2) | Plugin(M3-B) |
| **仅 pi** | pi 扩展 | pi skill |

## 已确定的决策

1. **不把 M3-B 作为独立「Plugin」系统上线。** 把它的**跨 agent 注入能力**折进**现有 pi-skill 系统**,使「Skills」成为唯一的「指令」入口,且从 pi 专属升级为**跨 agent**。守住总数 3 套(避免 4),Skills 能力反而增强。
2. **复用 M3-B 的注入机制,弃掉其并行外壳。** 保留并复用 `apps/desktop/src/main/plugins/plugin-block.ts`(注入块渲染 + `selectInjectablePlugins`)与 `apps/desktop/src/main/ipc/cli.ts` 的注入钩子,把注入目标从「plugins.json 的独立清单」改为「现有 skill 系统中已启用的 skill」。弃用 M3-B 的 `manifest.ts` / `installer.ts` / `plugins-store.ts` / `ipc/plugins.ts` / `PluginSection.tsx`(现有 skill 系统已有扫描/状态/UI)。
3. **三套改名,消除撞词**:`MCP 服务` → **「MCP 工具(跨 agent)」**;`插件管理器`(pi skill)→ **「Skills(技能,跨 agent)」**;`扩展市场`(pi 扩展)→ **「pi 原生扩展(pi 专属)」**。「插件」一词不再同时指两套东西。
4. **组织原则(贯穿)**:**工具一律走 MCP(单一来源);Skills 只负责指令(prose),自身不另造工具机制。** 任何「需要工具」的扩展(含 open-design)都以 MCP 形式接入。
5. **MCP 与 pi 扩展不硬合**:二者在 2×2 里同属「工具」,但机制不同(MCP = 协议外挂 server;pi 扩展 = pi 进程内 JS 扩展 + 斜杠命令 + 审批钩子),硬合两边都残废。仅改名区分。

## 目标

- 用户心智里只剩三个清晰入口:**MCP 工具(跨 agent)/ Skills(指令,跨 agent)/ pi 原生扩展(pi 专属)**,无同名歧义。
- 「装一个 SKILL.md 给 agent 加指令」只有**一套** Skills 系统,对 claude/codex/pi 都生效(pi 走 `--skill`,claude/codex 走 appendSystemPrompt 注入,投递差异降为内部细节)。
- M3-B 的真实价值(跨 agent 注入 SKILL.md)保留;其作为独立系统的成本退掉。

## 非目标(本次不做)

- **不**废弃 pi 扩展市场、不把工具强行收敛到 MCP(那是把 3 套压到 2 套的「北极星」,涉及移除已上线功能,另行评估,见范围边界)。
- **不**新增第 5 个「统一层」盖在现有系统之上(会更乱)。收敛靠合并/减法,不靠再抽象一层。
- **不**改 MCP(M2)与 pi 扩展(已上线)的后端逻辑,只对它们改名/归位。

## 功能需求

- FR-1:**Skills 跨 agent 投递**。现有 skill 系统(`piSkills` 配置、`packages/views/.../PluginManager.tsx` 的 SkillPanel、`apps/desktop/src/main/skills/registry` 扫描、`packages/core/personal/messages.ts` 的 `resolveEnabledSkillPaths`)增加 claude/codex 分支:已启用 skill 对 pi 仍走 `--skill`;对 claude/codex 经 `plugin-block` 渲染注入 appendSystemPrompt(复用 M3-B 注入钩子)。
- FR-2:**下线 M3-B 独立系统**。集成分支合入 master 时,**不带入** M3-B 的 `Plugin` 卡片、`plugin:*` IPC、`plugins.json` 存储、installer/manifest;仅保留被 FR-1 复用的注入逻辑。
- FR-3:**三套改名**(决策 3)。仅 UI 文案 + 分区归位,后端不动。
- FR-4(可选,Skills 元数据):skill 可选声明适用 agent(类似 M3-B 的 `supportedAgents`),缺省全 agent;按当前会话 agent 过滤注入。
- FR-5(关联,独立小follow-up):**open-design 经 MCP 接入**——在 MCP 工具入口加一个 `od` 预设(`command: od, args: ["mcp","--daemon-url","http://127.0.0.1:7456"]`,端口可编辑)+ 文档。这是「工具走 MCP」原则的直接落地,与本次收敛同源但可独立做(M2 已验证支持 stdio command/args 注入,零核心改动)。

## 范围边界

### 暂缓(后续可做)
- **3 套 → 2 套**:废弃 pi 扩展市场、工具统一 MCP(北极星终态)。涉及移除已上线功能,且 pi 扩展有 MCP 顶不上的能力(斜杠命令/审批/ctx.ui),除非 pi 扩展用量很低否则不动。
- M3-B 已实现代码的处置(删除 vs 部分留存复用)由 ce-plan 按 FR-1/FR-2 细化。

### 不属于本次
- 把 cortex 改成 daemon(已多轮确认:对桌面交互形态是负债)。
- 重做 MCP / pi 扩展的后端机制。

## 关键风险与待定项

- R-1:Skills 跨 agent 注入与现有 globalInstruction / 内置 skill 注入**叠加不覆盖**(M3-B 已处理,折叠时须保持);pi 同一 SKILL.md 不要既 `--skill` 又进注入块(M3-B 已有去重,须随之迁移)。
- R-2:现有 pi-skill 的信任模型(`disabledSkills` / `trustedWorkspaceSkillDirs`)在跨 agent 注入下是否同样 gate?倾向复用同一启用/信任态。ce-plan 定。
- R-3:集成分支已含 M3-B + U7 + M3-A,FR-2「不带入 M3-B 独立系统」需要在合并策略上处理(挑拣保留注入逻辑、弃独立壳),不是简单整支合并。
- R-4:改名涉及 i18n / 现有用户认知迁移,属低风险但要一次性改齐。

## 交接 ce-plan

规划建议:先 FR-1 + FR-2(把 Skills 做成跨 agent、退掉 M3-B 独立壳)作为一个里程碑——这是减法主体;FR-3 改名随附;FR-4 可选;FR-5(od/MCP 预设)可作独立小 plan 随时做。合并策略(R-3)是 ce-plan 首步要定的:从集成分支抽取 `plugin-block` + cli.ts 注入钩子并入 skill 系统,丢弃 `plugins/{manifest,installer,plugins-store}`、`ipc/plugins.ts`、`PluginSection`。
