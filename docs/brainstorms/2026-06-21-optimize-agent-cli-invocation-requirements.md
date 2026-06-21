# 借鉴 open-design 优化 codex / claude code 调用 — 需求文档

- 日期:2026-06-21
- 范围层级:Deep — feature(在既有 Electron 桌面壳内扩展调用层;M3 的 Plugin 框架部分偏产品形态)
- 状态:待规划(交接 ce-plan)
- 参考项目:`/Users/mike/source/ai/open-design`(下称 open-design,其 daemon 代码在 `apps/daemon`)

## 背景与问题

当前 agent CLI 调用层(`apps/desktop/src/main/agents/` + `apps/desktop/src/main/ipc/cli.ts`)是一套**最小可用**实现:每个 adapter 只有 `buildArgs` / `parseLine` 两个纯函数,公共 spawn 管线对三种 agent 通用。它能跑,但相比 open-design 这套已驱动 24+ 异构 CLI 的成熟实现,在**健壮性、可观测性、可扩展性**上有系统性缺口。

open-design 已经把这些问题解过一遍且有 file 级证据。本次目标是**借鉴其设计、补齐缺口**,而非照搬其 daemon 架构。

### 当前仓库现状(已核实,带 file:line)

调用层架构:`apps/desktop/src/main/agents/index.ts:9-26` 定义 `AgentAdapter` = `buildArgs(req)` + `parseLine(line)`;注册表写死字面量 `ADAPTERS = { claude, codex, pi }`(`index.ts:16-20`),`AgentKind` 只有三种(`apps/desktop/src/main/ipc/types.ts:4`)。

具体缺口:

- **prompt 只能走 argv**:`startAgentProcess` 的 stdio 把 stdin 设为 `ignore`(`apps/desktop/src/main/ipc/cli.ts:109-122`),prompt 一次性拼进命令行 → 长 prompt 有截断 / `E2BIG`(Linux ~128KB)/ `ENAMETOOLONG`(Windows ~32KB)风险。
- **MCP 写死清空**:claude `--strict-mcp-config --mcp-config '{"mcpServers":{}}'`(`apps/desktop/src/main/agents/claude.ts:44-46`);codex `-c mcp_servers={}`(`apps/desktop/src/main/agents/codex.ts:42`)。无按会话注入 MCP 的入口。
- **事件模型仅 4 类**:`CliStreamEvent = init | text | tool | result`(`apps/desktop/src/main/ipc/types.ts:366-370`)。无 usage/token/cost、无 thinking、无 tool 起止区分、无 turn 边界、无 retry。codex `turn.completed.usage` 与 claude `result` 的 usage **均被丢弃**(`codex.ts:80-82`、`claude.ts:102-110`)。
- **codex tool 名硬编码 `"Shell"`**(`codex.ts:73`),不区分实际工具类型。
- **主会话无超时**(`cli.ts:316-434` 内无 timer);仅 `cli:oneshot` 硬编码 60s(`cli.ts:491-494`)。
- **无安全重试**:`cli:start` / claude / codex 路径不感知不上报重试,主进程也不主动重试。仅 pi-rpc 长驻路径有 `auto_retry_start → retry`(`apps/desktop/src/main/ipc/pi-rpc.ts:111-113`)。
- **取消只到整进程级**:`proc.kill()` = SIGTERM + 3s 兜底 SIGKILL(`cli.ts:41-52`、`cli.ts:592-595`),无单 tool / 单轮中断,且非进程组(CLI 派生的子进程可能残留)。
- **并发无上限/排队**:`running = Map<runId, AgentProcess>`(`cli.ts:16`、`cli.ts:337`)。
- **会话恢复仅 `resumeSessionId`**:无 `--continue` 语义(`types.ts:292`、`claude.ts:61`、`codex.ts:52-53`);`session-trim.ts` 截断会话记忆为尽力而为、解析失败静默退化(`apps/desktop/src/main/ipc/session-trim.ts:140-146`);codex resume 分支不带 `--cd`(`codex.ts:53`)。
- **归一化不彻底**:图片处理 claude 拼 prompt 文本(`claude.ts:27-31`)vs codex 原生 `--image`(`codex.ts:50`);appendSystemPrompt claude 用原生 flag(`claude.ts:62`)而 codex 靠 `<user_request>` 包裹(`codex.ts:17-20`);错误来源三套并存(adapter `result.error` / stderr 尾窗 / spawn error)。

### open-design 的可借鉴点(参考实现,带 file:line)

> 路径均相对 open-design 仓库根。

- **声明式 adapter def + 公共管线**:`RuntimeAgentDef`(`apps/daemon/src/runtimes/types.ts:93-214`)用一个数据对象声明 `buildArgs`/`streamFormat`/`eventParser` + 一组能力位(`promptViaStdin`、`externalMcpInjection`、`resumesSessionViaCli`、`inactivityTimeoutMs`、`authProbe`…);注册在 `apps/daemon/src/runtimes/registry.ts:28`。
- **用户 JSON 不改代码加 agent**:`readLocalAgentProfileDefs()`(`apps/daemon/src/runtimes/local-profiles.ts:194`)运行时读 `~/.open-design/agents.local.json`,基于某个 base def 派生新 agent(覆盖 bin/args/env/models…)。
- **prompt 一律走 stdin**:绕开命令行长度限制;claude 用 `--input-format stream-json` 把 prompt 包成一行 JSONL 写入 stdin 且不关闭(`apps/daemon/src/server.ts:8845`、`:10078-10100`)。
- **统一富事件模型**:各家归一成 `status / text_delta / thinking_delta / tool_use / tool_result / usage / error / turn_end / raw`(`apps/daemon/src/runtimes/json-event-stream.ts`、`claude-stream.ts`);usage 归一成 `{input,output,thought,cached_read,cached_write}`(`json-event-stream.ts:20`)。
- **会话续接 + stable-prompt 哈希跳过**:`agent-session-resume.ts` 的 `resolveAgentResumeContext`(`:32`)落库 sessionId、`computeIncludeStable`(`:101`)系统块 hash 未变就不重发、`isClaudeResumeFailure`(`:110`)识别 resume 失败回退新建。
- **活跃度看门狗 + 分级进程组取消 + 副作用感知安全重试**:看门狗看 stdout/事件活跃度(`types.ts:188`),可被 def/env 覆盖;取消走 abort → 关 stdin → SIGTERM(宽限)→ SIGKILL(`runs.ts:332`),用 `process.kill(-pgid)` 杀整组(`runs.ts:281`);`decideSafeRunRetry`(`run-retry-policy.ts:79`)只对瞬态类别重试,**一旦已产生用户可见输出/工具调用/写过 artifact/被取消就抑制重试**(`:101-129`)。
- **声明式 MCP 注入(严格 gate)**:三策略 `claude-mcp-json` / `acp-merge` / `opencode-env-content`(`types.ts:135-160`);claude 路径往项目 cwd 写 `.mcp.json` 且绝不覆盖用户已有文件、禁用时清理 stale(`server.ts:8120-8158`)。
- **进程健壮性**:`shell:false`、非 Windows `detached:true` 建进程组、stderr 必须先挂监听否则 pipe 灌满死锁(`server.ts:9130`)、吞掉 stdin EPIPE(`server.ts:8961`)、PATH 前置 node bin + 追加用户工具链(`launch.ts:39`)。
- **第一方 Plugin 框架(B)**:canonical `PluginManifest`(`packages/contracts/src/plugins/manifest.ts:139-212`)= `SKILL.md` + `open-design.json` 清单;解析/适配运行时 `packages/plugin-runtime/`(含 claude-skill / claude-plugin 适配器);安装/市场/信任/应用 `apps/daemon/src/plugins/`(`installer.ts`、`marketplaces.ts`、`apply.ts`);prompt 注入块 `packages/contracts/src/prompts/plugin-block.ts:12`;web 市场 UI `apps/web/src/components/MarketplaceView.tsx`。

## 目标

- 把 codex / claude code 的调用层从「最小可用」升级到「健壮、可观测、可扩展」,直接对标 open-design 的成熟度。
- 让调用层在长 prompt、网络抖动、用户取消、子进程残留等真实场景下不再失败或失控。
- 把 usage/token/cost 等本被丢弃的信号采集起来,为后续计费/用量展示打底。
- 解禁并以声明式方式管理 MCP,让 codex/claude 能按会话使用 MCP server。
- 让「新增/改一个 agent」从改枚举+写两函数,降为改一份声明式 def、甚至用户 JSON 不改代码即可派生。
- 引入 open-design 的第一方 Plugin 框架(B),用统一清单管理 skills/扩展,提供安装与 prompt 注入(市场/GenUI 为后续)。

## 非目标(本次不做)

- **不**照搬 open-design 的 daemon 进程架构;沿用 cortex-work 的 Electron 主进程 + IPC 形态,只移植**设计与算法**。
- **不**移植 open-design 全部 24 个 agent def;只覆盖现有 claude / codex / pi,并把「加新 agent」的扩展点留好。
- **不**在 M1/M2 引入面向用户的插件市场 UI、信任分级、GenUI 表单、流水线 stages —— 这些归 M3 且部分可再延后。
- **不**改变现有 IPC 对渲染端的对外契约语义(事件模型只做**向后兼容的扩展**,不删字段)。
- **不**自建计费后端;M1 只负责**采集并透出** usage/cost,如何计费/展示是后续。

## 已确定的产品决策

1. **范围全要**:四大块(可靠性与进程管理 / 能力扩展 MCP+会话 / 可观测性 / 架构重构)+ A(Agent 适配器扩展层)+ B(完整 Plugin 框架)均在本需求总范围内。
2. **分期 foundation-first**:按依赖关系分三个里程碑(下文路线图),先做无 UI、低风险、解锁后续的管线硬化与可观测性。
3. **首期里程碑 = M1(管线硬化 + 可观测)**:用户明确选定为第一个可交付。
4. **移植设计而非架构**:open-design 是 Node daemon,cortex-work 是 Electron 主进程;落点须重新映射(见「架构映射」),不引入 daemon。
5. **事件模型只做向后兼容扩展**:`CliStreamEvent` 新增字段/事件类型,不破坏现有渲染端消费。

## 分期路线图

### M1 — 管线硬化 + 可观测性(首期,纯主进程,无 UI 破坏)

落点集中在 `apps/desktop/src/main/ipc/cli.ts` 与三个 adapter 的 `parseLine`。

- prompt 改走 stdin,绕开命令行长度限制。
- 富事件模型 + usage/cost 采集(向后兼容扩展)。
- 主会话活跃度看门狗 + 可配置超时。
- 副作用感知的安全重试(瞬态错误才重试,有可见输出/工具调用/写过文件就不重试)。
- 进程组取消(SIGTERM→SIGKILL,杀整组)+ stderr 先挂监听 + EPIPE 吞掉 + PATH 健壮化复核。

### M2 — 声明式 adapter + MCP 注入 + 会话续接(A 的核心)

- 把 `AgentAdapter` 演进为更声明式的 def(能力位 + 公共管线消费),保持 IPC 契约不变。
- 解禁 MCP,改为声明式注入(借 `claude-mcp-json` 思路,严格 gate 不覆盖用户文件)。
- 会话续接增强:`--continue` 语义 + stable-prompt 哈希跳过重发 + resume 失败回退新建。
- 归一化补齐:图片 / appendSystemPrompt / 错误来源统一。

### M3 — 扩展性与 Plugin 框架(A 的 JSON 扩展 + B)

- A:用户 JSON(对应 `local-profiles.ts`)不改代码派生/覆盖 agent。
- B 核心:`SKILL.md + 清单` 解析 + 安装 + prompt 注入块(对标 `plugin-runtime` + `plugin-block`)。
- B 产品形态(可再延后):市场 UI / 信任分级 / 能力门控 / 流水线 / GenUI。

## 功能需求

### M1

- FR-M1-1:prompt 通过 stdin 投递。spawn 的 stdin 由 `ignore` 改为 `pipe`;claude 走 stream-json 一行 JSONL 写入(参照其原生 input-format),codex 按其 exec 模式约束投递。命令行不再承载长 prompt。
- FR-M1-2:扩展 `CliStreamEvent`,新增至少 usage(input/output/cached/thought tokens + cost)、thinking、tool 起止与归一化 tool 名、turn 边界、retry。新增为**可选/新类型**,旧消费端不受影响。
- FR-M1-3:采集 usage/cost —— codex 读 `turn.completed.usage`、claude 读 `result` 帧的 usage 与 `total_cost_usd`,经事件透出(不再丢弃)。
- FR-M1-4:主会话引入活跃度看门狗与可配置 inactivity 超时;无活动超过阈值按失败处理并清理进程。阈值可被按 agent / 环境变量覆盖。
- FR-M1-5:副作用感知安全重试 —— 仅对瞬态类别(rate_limit 非硬配额、上游不可用、首 token 前的 timeout/空输出)重试;一旦已产生用户可见输出 / 工具调用 / 写过文件 / 被取消,则不重试。默认上限可配。
- FR-M1-6:取消升级为进程组级(非 Windows `detached` + `process.kill(-pgid)`),SIGTERM→宽限→SIGKILL;确保 CLI 派生子进程一并回收。
- FR-M1-7:进程健壮性复核 —— stderr 监听在消费 stdout 之前挂上、吞掉 stdin EPIPE、`shell:false`、PATH 前置/追加策略与 open-design 对齐。

### M2

- FR-M2-1:`AgentAdapter` 演进为声明式 def(能力位驱动公共管线),保持现有 IPC 请求/事件契约语义不变。
- FR-M2-2:MCP 声明式注入入口(按会话/全局),取代写死的 `mcp_servers={}` / 空 `--mcp-config`;严格 gate,绝不覆盖用户已有 MCP 配置文件,禁用时清理自写的 stale 文件。
- FR-M2-3:会话续接增强 —— 支持 `--continue` 语义、系统指令块 hash 未变则跳过重发、resume 失败自动回退新建。
- FR-M2-4:跨 agent 归一化补齐 —— 图片、appendSystemPrompt、错误来源在事件层统一表达。

### M3

- FR-M3-1:用户配置文件(对应 open-design `agents.local.json`)派生/覆盖 agent,不改代码即可加新 CLI。
- FR-M3-2:Plugin 清单解析 + 安装 + 已安装记录持久化(对标 `PluginManifest` + `plugins/installer`)。
- FR-M3-3:Plugin prompt 注入块(对标 `plugin-block`),把启用的 plugin 的 context/skills 注入系统提示。
- FR-M3-4(可延后):市场 UI / 信任分级 / 能力门控 / 流水线 / GenUI 表单。

## 范围边界

### 暂缓(后续可做)

- B 的市场 UI、信任分级、能力门控、流水线 stages、GenUI 表单(FR-M3-4)。
- 把 usage/cost 接到真实计费 / 用量展示面板。
- 移植 open-design 的其余 21 个 agent def。
- 单 tool / 单轮级中断(本次取消仍以进程组为粒度)。
- 并发上限 / 排队 / 优先级调度。

### 不属于本产品身份

- 把 cortex-work 改造成 Node daemon 架构。
- 做成与 open-design 完全等价的通用「24+ CLI 编排平台」;本产品聚焦自身桌面体验下的 codex/claude(+pi)。

## 架构映射(open-design daemon → cortex-work Electron)

| open-design(参考) | cortex-work(落点) |
| --- | --- |
| `apps/daemon/src/server.ts` spawn 段 | `apps/desktop/src/main/ipc/cli.ts` |
| `apps/daemon/src/runtimes/{registry,types,defs/*}` | `apps/desktop/src/main/agents/{index,claude,codex,pi}` |
| `runtimes/local-profiles.ts` | 新增:用户 agent 配置加载(主进程 fs) |
| `mcp-config.ts` + `externalMcpInjection` | 新增:MCP 注入(写 `.mcp.json` / `-c`),IPC 契约见 `types.ts` |
| `agent-session-resume.ts` | 增强现有 `apps/desktop/src/main/ipc/session-trim.ts` 思路 |
| `packages/contracts` + `packages/plugin-runtime` | 新增共享包(须遵守 `docs/floder.md` 的包硬边界) |
| `apps/web/.../MarketplaceView.tsx` | M3:`packages/views` 内市场视图(经 NavigationAdapter) |

## 关键风险与待定项

- **R-1(架构落差)**:open-design 在长驻 daemon 内做看门狗/进程组/重试;cortex-work 在 Electron 主进程内每会话 spawn。需确认主进程内做 `detached` 进程组 + `process.kill(-pgid)` 在 macOS 打包态(electron-builder)下行为正确。ce-plan 首步验证。
- **R-2(事件模型扩展的消费端)**:`CliStreamEvent` 扩展虽向后兼容,但 usage/thinking/turn 等新字段要被渲染端真正用上才产生价值;需盘点 `packages/core` / `packages/views` 里现有消费点,确认扩展不引发类型不匹配。
- **R-3(stdin 投递的 codex 约束)**:scout 注意到 codex exec 模式对 stdin 哨兵参数敏感(open-design 注释提到加 `-` 会 exit 2)。codex 经 stdin 投递 prompt 的确切形式需实测,可能 codex 仍保留 argv 而仅 claude 走 stdin。
- **R-4(MCP 解禁的取舍)**:停止写死清空后,需决定默认是「继承用户配置」还是「按会话显式注入」,以及是否给总开关 —— 与既有 cowart 画布需求(`docs/brainstorms/2026-06-21-cowart-codex-canvas-requirements.md` 的 FR-1/R-2)直接相关,两者应统一 MCP 策略,避免各改一处。
- **R-5(B 的包边界)**:Plugin 框架要新增类似 `contracts` / `plugin-runtime` 的共享包,必须落在 `packages/*` 且遵守硬边界(`core` 不依赖 react-dom、`ui` 不引 core、`views` 不引 next/react-router)。
- **R-6(范围体量)**:总范围极大,M2/M3 必须各自再拆 plan;M1 内部也建议按「stdin / 事件模型+usage / 看门狗+重试 / 取消+进程组」拆成可独立合并的小步。

## 依赖与假设

- 假设 open-design 仓库可作为长期参考随时查阅(本机路径 `/Users/mike/source/ai/open-design`);其设计为借鉴来源,非依赖。
- 假设现有渲染端对 `CliStreamEvent` 的消费是「按已知 type 分支」,新增 type/字段不会让其崩溃(R-2 需核实)。
- 假设 macOS 为首要打包目标(仓库现以 `dist:desktop` 打 macOS),进程组/信号方案优先保证 macOS 正确。
- 假设 pi 的独立 RPC 长驻路径(`pi-rpc.ts`)已有部分能力(retry 等),M1 以 claude/codex 对齐到 pi 已有水平、再统一抽象。

## 成功标准

- M1:超长 prompt(超过 argv 限制量级)能正常发起会话不截断;模拟网络瞬断后安全重试成功且不重复副作用;取消会话后无残留子进程;一次会话结束后能从事件里读到 usage(tokens)与 cost。
- M2:同一会话能注入并使用一个 MCP server;`--continue` 续接后系统块未变不重发整块、上下文连续;新增/改一个 adapter 只需改其声明式 def。
- M3:用户写一份 JSON 即可派生一个新 agent 并跑通;安装一个 SKILL.md plugin 后其指令被注入系统提示并生效。
- 全程:claude / codex / pi 现有行为在未启用新能力时与改动前一致(向后兼容)。

## 交接 ce-plan

规划建议:先做 M1,且 M1 内部按 FR 拆成可独立合并的小步;首步实测 R-1(Electron 主进程进程组取消)与 R-3(codex stdin 投递形式),它们决定 FR-M1-1/FR-M1-6 的具体形态。M2 的 MCP 策略须与 cowart 画布需求(R-4)对齐后再落 plan。M3 单独立 plan,B 的市场/GenUI 默认延后。
