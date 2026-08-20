# Pi 延迟工具加载

## 背景

普通 Cortex 会话会把 agent-browser、浏览器控制、自动化、日历、知识库、媒体、工作流、delegate、用户 MCP 和市场扩展统一注册进 Pi。旧行为把全部已注册工具同时设为 active，provider 的首个请求因此携带全部工具 schema；空会话输入一条短消息也可能达到约 41K input token。

本模块把“工具已注册”和“本次请求需暴露”拆开：能力仍在会话建立时完成握手、注册和安全校验，但首轮只发送高频核心工具与一个小型 `tool_search`。模型需要其它能力时，在同一 agent turn 内搜索并激活匹配工具。它只控制 schema 预算；工具执行后的大结果由 `tool-context.ts` 在下一次 provider request 前单独投影，两者不可互相替代。

该变化对用户透明，没有新增设置或操作步骤，因此不另建用户帮助页。

## 领域概念

- **registered tools**：会话可用的完整工具目录。MCP `tools/list`、Cortex 原生工具和磁盘 extension 仍全部进入该目录。
- **active tools**：当前 provider request 真正携带 schema 的工具集合。
- **deferred tools**：已注册但当前未 active 的工具，可由 `tool_search` 激活。
- **tool context projection**：工具结果的模型可见副本。它不修改 AgentSession、会话 JSONL、运行事件或过程归档，只在总 context 超预算时压缩成功结果、去重 read，并可把完整正文放到 `0600` 的会话级临时文件。
- **required bridge**：显式 delegate / artifact bridge 声明的强接入契约。它要求握手和业务工具完整，但不要求普通父聊天把整套 schema 放进首轮 active 集。

## 核心规则

1. 普通父聊天启用延迟加载；artifact 与 child 会话的工具面本来就小，保持 eager。
2. 默认首轮 active 集为 `read`、`bash`、`edit`、`write`、`todo_write`、`askquestion`、`tool_search` 与 `explore_agent`。不存在的名字会被忽略。系统提示会明确要求代码探索先调用 `explore_agent`，因此这一项必须首轮可用；其余 delegate、agent-browser、automation 等仍延迟加载。
3. plan 模式以原 `toolWhitelist` 为物理准入名单。`tool_search` 可以出现，但只能激活白名单内工具，不能恢复 `write`、`bash` 或 `gui_*`。
4. 工具审批仍在 extension-level `tool_call` hook 执行。延迟激活只改变 schema 何时发给模型，不改变审批、MCP 调用、超时、取消或资源回收。
5. MCP 工具不得占用 `tool_search`。该名字与 Pi 内建工具一样进入保留名集合，否则恶意或误配置的 MCP 可以覆盖唯一发现入口。
6. `tool_search` 串行执行。同一 assistant message 内的多次搜索必须在前一次 active 集上累加，不能用旧快照互相覆盖。
7. schema 延迟加载和结果投影分别保护“工具定义”和“工具输出”两类预算。预算内结果逐字不变；预算外优先压缩旧成功结果，错误、最新结果和图片块的保留优先级更高。

## 业务流程

```mermaid
flowchart TD
  A[preparePiOpenRequest] --> B[收集并验证全部 MCP / extension]
  B --> C[worker 注册完整工具目录]
  C --> D[session_start 收窄 active tools]
  D --> E[首个 provider request\n核心 schema + tool_search + explore_agent]
  E -->|现有工具足够| I[直接调用工具]
  E -->|缺少能力| F[模型调用 tool_search]
  F --> G[搜索 name / description / parameter schema]
  G --> H[setActiveTools + addedToolNames]
  H --> I[同一 agent turn 调用新增工具]
  I --> J[审批 hook / MCP 执行 / 结果回流]
```

支持原生 deferred tools 的 Anthropic、OpenAI Responses / Codex Responses 与 Kimi 会从 `addedToolNames` 生成 provider 原生引用或加载块；其它 provider 在同一 agent turn 的下一次模型调用收到新增工具的完整 schema。两类 provider 都保留参数校验和原生函数调用质量。

## 关键实现

- `apps/desktop/src/main/ipc/pi-session.ts`：在主进程权威边界设置 `deferNonCoreTools`，并删除 renderer 伪造值。
- `apps/desktop/src/worker/pi-host/capabilities.ts`：组装首轮常驻名单；`explore_agent` 因系统提示直接要求调用而常驻，其余 required bridge 工具继续延迟，plan 白名单原样下传。
- `apps/desktop/src/main/agents/pi-inproc/deferred-tools.ts`：延迟目录深模块，负责搜索、排序、激活、并发语义与 `addedToolNames`。
- `apps/desktop/src/main/agents/pi-inproc/tool-context.ts`：context hook 的深模块，负责模型上下文估算、工具结果投影、会话级全文临时文件和退出/过期清理。
- `apps/desktop/src/main/agents/pi-inproc/native-hooks.ts`：只在 gateway 长驻会话注册投影 extension，并记录无正文的 projection report。
- `@earendil-works/* 0.84.2`：使用 registry 发布版本，任何 checkout/CI 都可由 lockfile 安装。
- `patches/@earendil-works__pi-agent-core@0.84.2.patch`：让 `shouldStopAfterTurn` 可返回
  `{reason:"context-checkpoint"}`，并把 reason 带进 `agent_end`。
- `patches/@earendil-works__pi-coding-agent@0.84.2.patch`：让 checkpoint `agent_end` 以
  `willRetry=true` 进入自动 compaction + continue；同时让带 `code=PI_CONTEXT_BLOCKED` 的 context
  hook 错误越过 extension 的常规 fail-open 边界，阻止超预算 provider request。
- 两份 patch 的删除条件：上游发布同时包含结构化 turn guard、checkpoint 自动续接和
  `isContextBlockError` 的版本。升级后必须删除 patch 并重跑完整 runtime/打包护栏。
- `apps/desktop/src/main/agents/pi-inproc/session.ts`：按当前模型安装 guard；切模型、fork、switch、
  new session 后都重建。事件泵再对 checkpoint `agent_end` 做幂等装饰，避免未来上游行为漂移。
- `apps/desktop/src/main/agents/pi-mcp-inproc.ts`：把 `tool_search` 加入 MCP 保留名。

## 验证

专项验证覆盖以下不变量：

- 大型已注册目录不会进入首轮 context，首轮 schema 大小与 deferred 工具数量无关。
- 真实 Pi agent loop 首次只看到核心工具；`tool_search` 后的下一次 provider request 出现新增完整 schema，并能在同一回合执行该工具。
- plan 白名单同时约束初始 active 集和搜索结果。
- required delegate 必须接入成功；`explore_agent` 首轮直接可调用，其余协作者仍可经 `tool_search` 在同一回合激活。
- renderer 不能关闭普通父聊天的优化，也不能给 artifact / child 强行开启。
- 结果投影发生时不记录命令、路径或正文；临时全文不进入 Git、用户文档目录或应用日志。
- 投影后仍超预算时，context extension 抛出受控 `PI_CONTEXT_BLOCKED`；仓内最小 pnpm patch 在
  `convertToLlm` 前透传该错误，禁止 provider request 退化为 `max_tokens=1`。
- `pnpm install --frozen-lockfile` 必须在没有 sibling `pi-local` 目录的隔离 worktree 中成功。

常用命令：

```bash
pnpm --filter @cortex-work/desktop exec vitest run \
  src/main/agents/pi-inproc/deferred-tools.test.ts \
  src/main/agents/pi-inproc/deferred-tools.integration.test.ts \
  src/worker/pi-host/capabilities.test.ts \
  src/main/ipc/pi-session.test.ts
pnpm --filter @cortex-work/desktop typecheck
```
