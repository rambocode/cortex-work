# pi 调用改造:从单发 CLI 升级到 RPC 长驻会话

- 日期：2026-06-16
- 范围：`apps/desktop`（仅 pi;claude/codex 维持现状不动）
- 目标读者：实现者
- 状态：待评审

## 0. 背景与目标

现状：Cortex Desktop 对 pi 走 `--mode json -p <prompt>` **单发模式**（`apps/desktop/src/main/agents/pi.ts` + `ipc/cli.ts`），每轮 spawn 一个一次性子进程，多轮靠 `--session` 冷启动重读会话文件，运行中只能 `SIGTERM` 杀。`CliStartRequest.effort`「pi 忽略」、编辑重发靠手写截断会话文件（`session-trim.ts`），都是这个模式的局限。

目标：把 pi 升级到 **RPC 长驻会话**（`pi --mode rpc`），解锁运行时控制能力，服务四类诉求：
1. **交互式产品**：边跑边引导 `steer`、优雅打断 `abort`、编辑分支 `fork`；
2. **自动化/批处理**：`prompt` → 等 `agent_end` → 取产物，程序化串多轮；
3. **深度定制**：自定义工具、工具确认 UI、自定义 provider/命令（pi extension 机制）；
4. **原型验证**：先用最小通道跑通，再迭代。

claude/codex 暂不动——它们没有对等 RPC 模式，继续走现有单发 `cli.ts` 管线。pi 单独长出一条 RPC 通道。

## 1. 选型结论：为何 RPC，而非进程内 SDK

pi 同一套运行时对外开三个口：进程内 SDK（`createAgentSession`）、RPC（`--mode rpc`）、单发 print（`--mode json -p`，现状）。

| 方案 | 能力 | 对 Cortex 的代价 | 结论 |
|---|---|---|---|
| 进程内 SDK `createAgentSession()` | 最全 | **致命**：需在主进程 `import` pi 的 ESM 闭包（minimatch/typebox/undici…），正是当年改 bun `--compile` 二进制要躲的 asar 依赖地狱 | ❌ 否决 |
| `utilityProcess.fork` 跑 SDK 脚本 | 全 | 等于自造一条比 RPC 更脆的进程通道，且 node 依赖解析问题仍在 | ❌ 否决 |
| **RPC `--mode rpc`** | ≈ SDK（steer/abort/fork/setModel/compact/extension UI 全覆盖） | **复用现有二进制**（`pi-locate.ts`/`build-pi-binary.mjs`），零依赖解析问题；进程隔离 = 崩溃隔离 | ✅ 选定 |
| 单发 print（现状） | 最弱 | 无运行时控制 | 仅保留给兜底 |

核心理由：RPC 在能力上对等进程内 SDK，但**继续 spawn 同一个 bun 二进制**，完全复用现有打包/定位/provider 注入资产，且保留 Electron 主进程的崩溃隔离。

## 2. 实测结论（已 spike 验证）

spawn `resources/pi/pi --mode rpc --no-extensions --no-skills`，结果：
- `get_state` 返回 `{sessionId, thinkingLevel, isStreaming, steeringMode, followUpMode, autoCompactionEnabled, messageCount, pendingMessageCount, sessionFile?, sessionName?}`，与 `rpc-types.d.ts:134-147` 逐字一致。
- **sessionId 经 `get_state` 主动获取**，启动不 emit init 事件。
- 冷启动到首响应 ≈ **600ms**；官方 `RpcClient.start()` 的 `sleep(100ms)`（`rpc-client.js:79`）不可靠 → 用 `get_state` 成功作就绪信号。
- 空配下 `get_available_models` = `[]`，证实 provider/model 靠启动参数注入。
- 进程长驻不自退，需显式 kill。

## 3. 架构设计

### 3.1 数据流总览

```
renderer ──pi:open/prompt/steer/abort/fork/setModel/compact/close──► main(ipc/pi-session.ts)
   ▲                                                                      │
   │                                                                      ▼
   │                                                             PiRpcSession(pi-rpc.ts)
   │                                                          spawn pi 二进制 --mode rpc
   │                                                            stdin(命令JSONL) │ stdout(事件+响应JSONL)
   └──pi:event(映射后事件) / pi:uiRequest──────────────────────────────────┘
```

一个「UI 会话」对应一个长驻 `PiRpcSession`（= 一个 pi 子进程）。

### 3.2 `PiRpcSession`（核心，新增 `main/agents/pi-rpc.ts`）

职责 = 复刻官方 `RpcClient` 协议逻辑，但 spawn 的是 bun 二进制（非 `node dist/cli.js`），并把就绪判定改稳。

- **spawn**：`startAgentProcess(resolvePiBinary(), rpcArgs, {cwd, env: spawnEnvFor})`，复用 `cli.ts` 现成函数与 env 注入。
- **行缓冲**：LF-only（`jsonl.d.ts` 要求只切 `\n`，payload 可能含 U+2028/U+2029）——现有 `cli.ts` 的 `buffer.indexOf("\n")` 已合规，照搬。
- **`send(command)`**：分配 `id=req_N`，`stdin.write(JSON+"\n")`，存 `pendingRequests: Map<id,{resolve,reject,timer}>`，30s 超时；stdout 读到 `{type:"response", id}` 命中 pending → resolve（参 `rpc-client.js:381-455`）。
- **stdout 路由**：`{type:"response", id∈pending}` → resolve 请求；`{type:"extension_ui_request"}` → 转 `pi:uiRequest` 给 renderer；其余 → 当 `AgentSessionEvent` 走事件映射（3.5）推 `pi:event`。
- **命令方法**：`prompt/steer/followUp/abort/setModel/setThinkingLevel/compact/setAutoCompaction/fork/clone/getForkMessages/newSession/switchSession/getState/getSessionStats/exportHtml/bash`。
- **就绪**：`start()` = spawn 后轮询 `getState()` 直到成功或超时（替代 sleep）。
- **关闭**：`stop()` = SIGTERM + 兜底 SIGKILL（复用 `killWithTimeout`）。

### 3.3 进程注册表与生命周期（`ipc/pi-session.ts`）

- `Map<uiSessionId, PiRpcSession>`。`pi:open` 建、`pi:close` 销。
- **崩溃恢复**：`onExit` 非预期退出 → 推 `pi:event {type:"crashed", error}` 给 renderer；可选自动重启：新 spawn 后 `switchSession(sessionFile)` 从 JSONL 恢复上下文（内存态丢失，文件态可恢复——双轨）。
- **空闲回收**：会话 N 分钟无活动 → `stop()`，下次命令惰性重启 + `switchSession`。
- **退出清理**：扩展 `killAllCli()` 或新增 `killAllPiSessions()`，在 app `before-quit` 调。

### 3.4 启动参数（复用现有注入）

`buildRpcArgs(req)`：`["--mode","rpc"]` + 现有 pi 单发相同的 provider/skill 注入——
- `req.useOwnSkills !== true` → `--no-skills`
- `req.piExtensionPath` → `-e <path> -a` + `--provider <id>`（`pi-providers.writePiExtension` + `CORTEX_PI_KEY` env，原样复用）
- `req.model` → `--model`
- **不再带** `-p`/`prompt`/`--session`（prompt 走 stdin `prompt` 命令；续会话走 `switchSession`）。

### 3.5 事件映射：`AgentSessionEvent` → 渲染层 `PiSessionEvent`

现有 `CliStreamEvent`（init/text/tool/result）太窄。RPC 给的是更细的 `AgentSessionEvent`（核心 `AgentEvent` + 会话层叠加，见 `pi-agent-core/types.d.ts:359-397`、`agent-session.d.ts:40-77`）。新增 `PiSessionEvent`：

| RPC 事件 | 取值 | → PiSessionEvent |
|---|---|---|
| `message_update` + `assistantMessageEvent.type==="text_delta"` | `.delta` | `{type:"text", delta}` |
| `message_update` + `..."thinking_delta"` | `.delta` | `{type:"reasoning", delta}`（新增，思考流） |
| `tool_execution_start` | `toolName,args,toolCallId` | `{type:"tool", phase:"start", ...}` |
| `tool_execution_end` | `result,isError,toolCallId` | `{type:"tool", phase:"end", isError, ...}` |
| `agent_end` | `willRetry` | `{type:"result", ok:!willRetry}`；最终文本 = `message_end` 累积或 `getLastAssistantText()` |
| `queue_update` | `steering[],followUp[]` | `{type:"queue", ...}`（交互产品展示待注入） |
| `compaction_start/end` | `reason,result` | `{type:"compaction", ...}` |
| `auto_retry_start/end` | `attempt,errorMessage` | `{type:"retry", ...}` |
| `session_info_changed` / `thinking_level_changed` | — | `{type:"state", ...}` |

错误：编码在 `message_*` 的 `AssistantMessage.stopReason==="error"|"aborted"` + `errorMessage`；命令级错误走 `{type:"response", success:false, error}`（被 `send` 的 reject 捕获）。

> 已实测（2026-06-16，deepseek-chat / openai-completions 生产同款链路）：真实事件序列为
> `message_start → message_update{start/text_start/text_delta/text_end} → tool_execution_start{toolName,toolCallId} → tool_execution_end{toolName,toolCallId,isError} → turn_end → message_end → agent_end{messages,willRetry:false}`。
> 验证点：`text_delta`/`tool_execution_*`/`agent_end{willRetry}` envelope 与源码契约吻合；`reasoning:false` 的 provider 确实无 `thinking_delta`；sessionId 经 `get_state` 取得，冷启动到就绪 ≈ 790ms（坐实「必须 get_state 探测就绪，不能 sleep 固定值」）。
> 唯一待补：工具调用参数的 `message_update/toolcall_*` 增量未实测到（参数过短或被环境干扰吞掉），实现时按源码契约处理。

### 3.6 IPC 契约（新增 `pi:*`，按现有 `cli:*` 的 preload/bridge 模式同步）

`ipcMain.handle`：`pi:open(req)→uiSessionId`、`pi:prompt`、`pi:steer`、`pi:abort`、`pi:followUp`、`pi:fork(entryId)`、`pi:getForkMessages`、`pi:setModel`、`pi:setThinking`、`pi:compact`、`pi:getState`、`pi:getStats`、`pi:close`、`pi:uiResponse`。
`sender.send`：`pi:event`（映射后事件流）、`pi:uiRequest`（extension UI 请求）。
同步点：`main/ipc/register.ts` 注册、`main/ipc/types.ts` 契约、`preload/index.ts` 经 `contextBridge` 暴露、`core/desktop/bridge.ts`+`types.ts` 镜像（若 pi 会话能力要进 `DesktopBridge` 供 core/views 调用）。

## 4. 深度定制接入点（pi extension 机制）

- **自定义工具**：extension `pi.registerTool(def)`，经 `-e` 加载（扩展现有 `writePiExtension`）。
- **工具确认 UI / 审批**：pi 无内置 per-call 审批；用 extension 拦 `tool_call` hook + `ctx.ui.confirm()` → RPC 发 `extension_ui_request{method:"confirm"}` → Cortex 渲染确认弹窗 → 回 `extension_ui_response`。`ctx.ui` 还支持 select/input/notify/setWidget。
- **自定义 provider/命令**：同 extension（`registerProvider` 现已用于注入 OpenAI 兼容端点；`registerCommand` 加斜杠命令）。

## 5. 改动面

| 文件 | 改动 |
|---|---|
| `main/agents/pi-rpc.ts` | 新增 `PiRpcSession` |
| `main/ipc/pi-session.ts` | 新增 registry + `pi:*` handler |
| `main/ipc/types.ts` | 新增 `PiSessionEvent`、`PiOpenRequest` 等 |
| `main/ipc/register.ts` | 注册 `pi-session` |
| `preload/index.ts` | 暴露 `window.desktopAPI.personal.pi*` |
| `main/agents/pi.ts` | 抽出 `buildRpcArgs`;`parseLine` 仅留给单发兜底（或废弃） |
| `core/desktop/{bridge,types}.ts` | 若 pi 会话进 bridge 则镜像 |
| renderer（views/core） | 接交互 UI + 事件渲染（阶段 2） |

## 6. 分阶段实施 + 工作量

| 阶段 | 内容 | 估时 |
|---|---|---|
| 0 spike | 真实 key 跑一轮 prompt，定稿事件 envelope；验证 `-e`/`--provider` 在 rpc 下生效 | 0.5d |
| 1 核心通道 | `PiRpcSession` + registry + 事件映射 + `pi:*` IPC + preload + 类型；单测覆盖 send/超时/行缓冲/映射 | 2–3d |
| 2 交互上渲染 | renderer 接 prompt/steer/abort/fork；事件渲染（text/reasoning/tool/状态） | 2–3d |
| 3 深度定制 | extension 确认 UI 闭环 + 自定义工具样例 | 2d |
| 4 健壮性 | 崩溃重启（switchSession 恢复）、空闲回收、多会话并发、退出清理 | 1–2d |

PoC 跑通（阶段 0–1）约 **3–4 人日**；产品化（到阶段 4）约 **8–12 人日**。

## 7. 风险与缓解

- 冷启动 ~600ms → 就绪用 `get_state` 探测，非固定 sleep；UI 显「启动中」。
- 长驻进程内存/泄漏、多会话多进程 → 空闲回收 + 上限。
- 崩溃丢内存态 → `switchSession(sessionFile)` 文件恢复双轨。
- pi 版本升级协议漂移 → pin 版本 + RPC 契约快照测试。
- 30s 请求超时对长跑工具偏短 → 命令级超时按类型区分（`prompt` 不设短超时，靠 `agent_end`/`abort`）。

## 8. 验证计划

- 单测：`send` id 关联与超时、LF-only 行缓冲（含 U+2028 payload）、事件映射表逐条、崩溃重启路径。
- 集成：真实 provider 跑 prompt→tool→agent_end；steer/abort/fork 行为；编辑重发用 `fork(entryId)` 替代 `session-trim`。
- 手动（用户）：交互 UI 的引导/打断/分支体验。
