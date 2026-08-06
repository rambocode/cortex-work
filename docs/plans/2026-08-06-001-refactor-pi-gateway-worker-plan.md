---
title: "refactor: pi 由主进程内联改为 gateway worker（保住进程隔离）"
type: refactor
date: 2026-08-06
origin: docs/plans/2026-08-05-001-refactor-pi-inprocess-migration-plan.md
---

# refactor: pi 由主进程内联改为 gateway worker

> 承接 origin 计划：那一轮把 pi 从「bun 二进制 + spawn」迁到「主进程 in-process」，
> 摆脱了编译链与手抄协议，但**丢掉了进程隔离**。本计划把执行体挪回独立进程，
> 两份收益都拿到。origin 的能力模块与契约**绝大部分原样复用**。

## Summary

pi 的 `AgentSession` 从主进程挪进 `utilityProcess` worker，主进程经 JSONL 协议与之通信。

**为什么值得再动一次**：in-process 方案下 agent loop、工具执行（`bash`/`grep`/`read`）、MCP 客户端
全部跑在 Electron 主进程的事件循环上，而主进程还要负责窗口、IPC、托盘、热键。主进程一卡整个 UI 就卡，
编排场景（三段 × 多链路并发）尤其危险。旧的 binary 方案没有这个问题——它的代价只是 bun 编译链，
而那个代价可以用 npm 包 + worker 消掉。

**地基已实测**（2026-08-06，打包态 `dist:dir`）：worker 落在 `app.asar.unpacked/out/worker/`，
用**裸包名** `import("@earendil-works/pi-coding-agent")` 成功解析到 asar 内的包，工具真实执行、
`createAgentSession` 构造成功。不需要 unpack 三包，不需要绝对路径 hack。

## 三种形态的收益对照

| | binary（迁移前） | in-process（已实现） | gateway（本计划） |
|---|---|---|---|
| 摆脱 bun 编译链 | ❌ | ✅ | ✅ |
| 摆脱手抄 CLI 协议 | ❌ | ✅ | ✅ |
| 崩溃隔离 | ✅ | ❌ | ✅ |
| **性能隔离（事件循环）** | ✅ | ❌ | ✅ |
| 内存隔离 | ✅ | ❌ | ✅ |
| 包体 −66MB | ❌ | ✅ | ✅ |
| 扩展与主进程同权 | 否 | **是** | 否 |

最后一行是 in-process 引入、gateway 消掉的一条安全回退：磁盘 extension 在主进程里能
`require("electron")` 摸到 app/session/safeStorage。gateway 下它们回到子进程，只剩文件系统与网络。

## Requirements

- R1. `PiSessionEngine` 契约**不变**。`ipc/pi-session.ts` 与 `ipc/orchestrate.ts` 的选路代码**一行不改**——
  gateway 客户端是该接口的第三个实现（前两个是 `PiRpcSession` / `PiInProcSession`）。
- R2. IPC 契约（`PiSessionEvent` / `PiOpenRequest` / `PiUiRequest`）不变，渲染端零改动。
- R3. 灰度开关沿用 `CORTEX_PI_INPROC` 的选路点，扩成三值：`binary`（默认）/ `inproc` / `gateway`。
- R4. 能力模块（MCP 桥、审批 hook、Computer Use、Provider 解析）**复用 origin 的实现**，
  只改「在哪个进程里跑」与「依赖怎么拿到」。
- R5. worker 崩溃只影响该会话：主进程侧要能感知、上报 `crashed`、清理注册表，与 binary 路径同义。

## Key Technical Decisions

- **KTD1｜凭据经 RPC 回主进程取，不常驻 worker。**
  `safeStorage` 是主进程 API，worker 拿不到。故 worker 侧给 pi 的 `ModelRuntime.create({ credentials })`
  注入一个 **RPC-backed `CredentialStore`**：pi 要用时才回主进程要，主进程解密后经协议返回。
  密钥因此只在「请求那一刻」跨进程存在一次，不落盘、不在 worker 常驻——比 binary 路径
  （烘焙进 `.js` 文件 + spawn env）严格更好。
- **KTD2｜传输抄 `research/worker/transport.ts`，不新造。**
  实测约束（已写在那个文件头）：`utilityProcess` 的 **stdin 必须是 `ignore`**，配别的值子进程直接
  起不来且表现为「code=0、无任何输出」。协议走 `child.postMessage(line)` ⇄ `process.parentPort.postMessage(line)`，
  一行 JSONL 进、一行 JSONL 出。stderr 进 2KB 尾环供崩溃诊断。
- **KTD3｜入口定位抄 `research/worker/entry-resolver.ts`。**
  打包态**优先 `app.asar.unpacked`**，给 asar 内路径会静默失败。`asarUnpack` 已含 `out/worker/**`。
- **KTD4｜worker 产物不 bundle 三包。**
  与 research worker 的「全部 bundle」策略相反：三包是纯 ESM，bundle 进 CJS 就是历史上那个坑。
  必须 external + 运行时裸包名动态 import（地基探针已证可行）。
- **KTD5｜审批与 UI 请求走同一条协议回主进程。**
  worker 侧的审批 hook 拿不到 UI，`ctx.ui.confirm` 转成一条 RPC 回主进程 → `emitUiRequest` →
  渲染端 → 回写 → RPC 应答。`PiUiRequest` 契约不变。
  ⚠️ 安全红线不变：`gui_*` 写工具在「自动执行」档仍强制进审批集；无 UI 出口时的语义仍是
  「放行 + 留痕」（见 origin 的 native-hooks，那条判据是照抄旧路径推导出来的，不要再翻）。
- **KTD6｜MCP server 由 worker 侧连。**
  `collectBridgeServers` 仍在主进程算（它依赖 `getPersistedState`），结果经 open 参数传给 worker；
  stdio server 由 worker `spawn`，http server（主进程内的 capability host）由 worker 用 URL 连。
  这样 MCP 客户端的开销也离开主进程。

## Scope Boundaries

### 非目标
- 不改渲染端、不改 `PiSessionEngine` 契约、不改 `permissionMode.ts`。
- 不动 claude / codex 适配器。
- **不删 in-process 实现**：三条路径并存一段时间，gateway 稳定后再决定删哪条（很可能删 in-process，
  保留 binary 作为最后退路直到 gateway 跑过一个版本）。

### Deferred
- 单发路径（`agents/pi.ts` 的 oneshot）与编排是否也走 gateway——先让长驻会话跑通。
- worker 复用（多会话共享一个 worker vs 每会话一个）：**首版每会话一个**，简单且隔离最彻底；
  若实测进程开销不可接受再谈池化。

## Implementation Units

### U1. 传输与协议
`src/main/agents/pi-gateway/transport.ts`（抄 research worker）+ `protocol.ts`（method/事件定义）。
协议面直接照 `PiSessionEngine` 的方法列表一一对应，加上三类反向调用：`ui.request`（审批/askquestion）、
`credentials.get`（KTD1）、`event`（事件流）。

### U2. worker host
`src/worker/pi-host/`：持有 `AgentSession`，把 RPC method 落到会话方法上；
能力组装（MCP / 审批 hook / Computer Use / Provider）在这一侧完成，复用 origin 的模块。
构建配置 `electron.pi-host.config.ts`（KTD4：三包 external）。

### U3. 主进程客户端
`src/main/agents/pi-gateway/client.ts`：实现 `PiSessionEngine`，方法转 RPC、事件转 `onEvent`；
反向调用落到 `emitUiRequest` 与 safeStorage 解密。worker 退出 → 上报 `crashed`（R5）。

### U4. 选路扩成三值
`feature-flag.ts` 的 `PiEngineChoice` 加 `gateway`；`pi-session.ts` / `orchestrate.ts` 的构造分支
加一路——**其余代码不动**（R1 的意义就在这里）。

### U5. 打包与护栏
`asarUnpack` 已含 `out/worker/**`，无需新增；`scripts/verify-pi-inprocess.mjs` 增加 gateway 形态的
打包态验证（fork worker 跑一轮）。

## Risks

- **协议表面积**：`PiSessionEngine` 有 18 个方法，逐个转 RPC 是机械但容易漏的活。缓解：客户端 stub
  用统一的 `call(method, params)` 收口，加一条「接口方法数 === 协议 method 数」的编译期/单测断言。
- **事件顺序**：事件经 `postMessage` 跨进程后仍需保序。`postMessage` 本身保序，但要确保 worker 侧
  不并发 emit（`AgentSession.subscribe` 回调是串行的，照原样转发即可）。
- **worker 启动开销**：每会话一个进程。binary 路径本来也是每会话一个进程，故不是回退；
  但 in-process 曾省掉这一步，对比时要诚实计入。

## Sources

地基验证（2026-08-06 实测，打包 app 内）：worker 在 `app.asar.unpacked/out/worker/`，
裸包名解析 asar 内三包成功（144 导出）、`grep` 真实执行、`createAgentSession` 构造成功。
过程中踩到三个「同症状不同因」的坑，均已写进本计划 KTD2/KTD3：
`stdio:"inherit"` 非法、entry 必须指向 unpacked、开发机 dev 实例持有单实例锁。
