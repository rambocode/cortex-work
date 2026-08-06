---
title: "refactor: pi 由 bun 二进制迁移为 in-process 库调用（pi-agent-core + pi-coding-agent）"
type: refactor
date: 2026-08-05
---

# refactor: pi 由 bun 二进制迁移为 in-process 库调用

> **状态：已完成并由 gateway 方案收尾（见 2026-08-06-001）。**

> 三轮可行性验证已完成（详见 §Sources）。本计划只描述**如何落地**，不再论证可行性。

## Summary

把 pi 的执行形态从「`resources/pi` 的 bun 自包含二进制 + `spawn` + 手抄 JSONL/RPC 协议」换成「主进程内直接调用 `@earendil-works/pi-coding-agent` 的 SDK 层（`createAgentSession`）」。

`AgentSession` 就是当前 `pi --mode rpc` 底下的那个对象，其方法面**完整覆盖**现有 `PiRpcSession` 发出的全部 RPC 命令。因此这不是「重写 pi 集成」，而是**把进程边界删掉**：`pi-rpc.ts`（879 行手抄协议）+ `pi-rpc.test.ts`（1288 行协议断言）整体消失，换成直接方法调用；四个「生成 .js extension 文件并 `-e` 加载」的模块换成原生 hook / `customTools` 注册。

收益（均已实测量化）：
- 安装包 **净减约 66MB**（asar +18MB，`resources/pi` −84MB）。
- 删除 bun 编译链：`build-pi-binary.mjs`、双架构串行约束、二进制单独签名与公证。
- 协议漂移从「运行时静默卡住/丢事件」变成 **TS 编译期错误**；`docs` 里「升级 pi 必须重跑 .d.ts diff」的人工纪律消失。
- `pi-mcp-bridge.ts` / `pi-extensions.ts` 生成的扩展文件会把 **MCP 鉴权头与 stdio env 明文烘焙进 `userData/pi-extensions/*.js`**（现为 mode 0600）；in-process 后这些密钥只存在于内存，落盘面消失。
- 切「plan 只读档」不再需要重开会话（`setActiveToolsByName()` 是运行时方法），修掉一个用户可感知的痛点。

## Requirements

**引擎与会话**

- R1. 新增 in-process 引擎层，以 `createAgentSession()` 承载现有 `PiRpcSession` 的全部对外行为；`ipc/pi-session.ts` 的 IPC 契约（`main/ipc/types.ts` 中的 `PiSessionEvent` / `PiOpenRequest` / `PiUiRequest` 等）**保持不变**，渲染端零改动。
- R2. 现有 `mapPiEvent` 的事件映射语义逐条保留（含 `stopReason: error|aborted` 的错误路径与 `isIgnoredFrame` 忽略清单）——事件与 `AgentEvent` 同源，映射函数复用，只换输入来源。
- R3. 引擎层与 `pi-rpc.ts` **并存**，由单一开关切换，可随时回退到二进制路径。开关移除是最后一个阶段的独立动作。

**能力注入（extension → 原生）**

- R4. 工具执行审批（`pi-extensions.ts` 的 `renderApprovalExtension`）改用 `AgentSession` 的原生 tool-call hook。**红线不变**：`gui_*` 写工具在「自动执行」档仍强制进审批集（`core/personal/permissionMode.ts` 不动）。
- R5. MCP 桥（`pi-mcp-bridge.ts`）改为把发现到的 MCP 工具注册进 `customTools`；**仍走 MCP 客户端连服务器**，不把 12 个 capability server 内联化（见 §非目标）。鉴权头与 env 不再落盘。
- R6. 自定义 Provider（`pi-providers.ts` + `custom-provider-runtime.ts`）改为直接复用主进程已有的 `providers/pi-runtime.ts` 那份 `createModels()` 注册表，喂给 `modelRuntime`。`${secret:NAME}` → `${CORTEX_PI_SECRET_<N>}` 的占位/spawn-env 注入链路随之删除。
- R7. `capabilities/` 下现以 pi extension 形式注入的能力（computer-use / automation / calendar / knowledge）改为原生注册，且**注入门控与作用域一字不改**：computer-use 五门控、automation 与 calendar「只在聊天路径、绝不在 `automation/runner.ts` 注入」的约束继续由 `capabilities/automation/inject-points.test.ts` 守住（该测试读源码断言，迁移时须同步改其识别的符号）。

**包管理与安装**

- R8. `pi install`（computer-use 的 `pi-computer-use` 包安装、扩展市场 `ipc/pi-extensions-market.ts`）改用 `DefaultPackageManager` 的编程接口（`install/installAndPersist/remove/update/listConfiguredPackages`）。
- R9. `providers/catalog.ts` 改为从 npm 包读取 provider catalog，不再从二进制旁置目录读。

**打包与护栏**

- R10. `electron-builder.yml` 放开 **5 条**排除：`@earendil-works/pi-coding-agent`、`pi-agent-core`、`pi-tui`，外加 `@silvia-odwyer/**`（photon，pi-coding-agent 直接依赖）与 `highlight.js/**`。这两条隐藏项现以「纯 renderer 冗余」为由排除，漏放开即首次使用时 `ERR_MODULE_NOT_FOUND`。
- R11. 扩展 `scripts/verify-pi-ai-packaging.mjs` 为打包态护栏：在 `dist:dir` 产物内实跑一次 in-process agent loop，PASS 才算打包成功。此前该类事故（0.1.52/0.1.53「模型运行时不可用」）只在正式包暴露。

## Key Technical Decisions

- **KTD1｜动态 import + 变量 specifier 是强制写法。** 三个包是纯 ESM，主进程被 electron-vite 打成 CJS。必须沿用 `providers/pi-runtime.ts` 的写法：specifier 用数组 `join("/")` 拼、加 `/* @vite-ignore */`。已实测：这样写主 bundle 里 `pi-coding-agent` 字符串出现 **0 次**，包完全不被 rollup 拉进 CJS chunk。写成字符串字面量会静默把整个 ESM 图打进 CJS chunk——正是历史上那个坑。
- **KTD2｜接入层不得出现 top-level await。** rollup 对 CJS 输出直接拒绝（`Module format "cjs" does not support top-level await`）。构建期即失败，不会漏到运行时。
- **KTD3｜`createCodingTools(cwd)` 只给 `read/bash/edit/write` 四个。** `grep`/`find`/`ls` 必须各自单独构造，而 `PI_PLAN_TOOL_WHITELIST`（plan 只读档）正好依赖这三个。漏掉的表现是 plan 档工具「不存在」而非报错。
- **KTD4｜工具参数名以实测为准，逐个核对。** `pi-agent-core` 的 `read` 用 `path`，与 CLI 版的 `file_path` 不同。`toolDetail()` 现在取 `command ?? file_path ?? path ?? pattern ?? url` 恰好兼容，但其余消费点须逐个核。
- **KTD5｜失败仍然「静默」，错误路径必须显式测。** in-process 后没有进程退出码可依赖，`streamFn` 契约不符只会表现为 `stopReason: "error"` 而不抛异常（spike 中实测：返回裸 async generator 而非 `AssistantMessageEventStream` → `response.result is not a function` 被吞进 message_end）。这与「pi 失败仍 exit 0」是同一类陷阱，`mapPiEvent` 的错误分支测试不能省。
- **KTD6｜灰度开关贯穿全程。** 引擎层与 `pi-rpc.ts` 并存，`pi-session.ts` 按开关选路。每阶段可独立回退，避免核心聊天链路一次性切换。
- **KTD7｜单文件 1200 行上限。** 新引擎层按职责拆分（会话生命周期 / 事件映射 / 工具与能力注册 / 模型解析），不要复刻 `pi-rpc.ts` 的单文件结构。

## Scope Boundaries

### 非目标

- **不把 MCP capability server 内联化。** 现有 12 个 capability server（browser/slides/automation/calendar/knowledge/research/media-gen/loop-workflows/delegate/design-delegate/doc-extract/mcp-host）继续以 MCP 协议提供工具，只是桥接方式从「生成 extension 文件」变成「`customTools` 注册」。内联化是独立的后续优化，与本次迁移正交，混做会让爆炸半径不可控。
- **不改渲染端。** IPC 契约保持不变是 R1 的硬约束。
- **不改 `core/personal/permissionMode.ts`。** 审批集判定是安全红线，只换执行侧。
- **不动 claude / codex 适配器。** 它们仍走 `ipc/cli.ts` 的 spawn 管线。

### Deferred to Follow-Up Work

- MCP 工具内联化（省掉协议往返）。
- 用 `AgentHarness` 替代 `AgentSession` 以获得更细的控制粒度（当前 `AgentSession` 已够用，且更贴近 pi CLI 的既有语义）。
- `exportToHtml` / `exportToJsonl` / `getContextUsage` 等 in-process 后新可用的能力（本次不接，只记录）。

## Implementation Units

> 每个 U 独立可验收、可回退。U1–U2 是地基，U3–U6 是主体，U7–U8 是收尾。

### U0. 基线与护栏

把三轮 spike 固化成仓库内的自动化验证，先于任何业务改动落地。

- 将 `pi-inproc-probe.mjs` 的逻辑收编为 `scripts/verify-pi-inprocess.mjs`：三包 import → 工具集构造 → 一轮 agent loop（含 grep/bash 真执行）→ `createAgentSession` 构造。
- 接进 `scripts/verify-pi-ai-packaging.mjs` 的打包态检查（R11）。
- 新增 `agents/pi-events.contract.test.ts`：以 `AgentEvent` 的十类事件为输入断言 `mapPiEvent` 输出，覆盖 `stopReason: error|aborted` 与忽略清单（R2、KTD5）。

**验收**：`pnpm --filter @cortex-work/desktop test` 通过；`dist:dir` 后护栏脚本 PASS。

### U1. 打包配置放开

- `electron-builder.yml` 放开 5 条排除（R10），每条补注释说明「为何从 renderer 冗余变成主进程运行时依赖」。
- 更新该文件顶部关于「pi 走 extraResources 二进制、不必进 asar」的整段说明。

**验收**：`dist:dir` 产物内 `npx asar list` 可见三个包；U0 护栏在打包 app 内 PASS。

### U2. in-process 引擎层（与二进制并存）

新建 `main/agents/pi-inproc/`，按 KTD7 拆分：

- `runtime.ts` — 三包的 lazy 动态 import（KTD1）、单例缓存、加载失败的响亮错误。
- `session.ts` — `createAgentSession()` 封装，对外暴露与 `PiRpcSession` **同形状**的接口（`prompt/steer/followUp/abort/compact/setModel/setThinkingLevel/getState/…`），使 `pi-session.ts` 可无感切换。
- `events.ts` — 复用 `mapPiEvent`，把 `AgentSession.subscribe` 的事件喂进去。
- `tools.ts` — `createCodingTools(cwd)` + `createGrepTool/createFindTool/createLsTool` 补齐（KTD3）；plan 档白名单接 `setActiveToolsByName()`。
- `feature-flag.ts` — R3 的开关（默认关，走二进制）。

`buildRpcArgs()` 的每个 CLI flag 在此层有明确对应物，迁移时逐条核对：

| CLI flag | in-process 对应 |
|---|---|
| `--no-extensions` / `-e <path>` / `-a` | `customTools` 注册 + `bindExtensions`（信任门不再需要） |
| `--no-skills` / `--skill <p>` | `resources.skills` / `loadSkills()` |
| `--tools a,b,c` | `tools` 初值 + `setActiveToolsByName()`（运行时可改） |
| `--model` / `--provider` | `model` / `modelRuntime` |
| `--append-system-prompt` | `systemPrompt`（改值仍需 `reload()`，但无需重开进程） |
| `--thinking` | `thinkingLevel` / `setThinkingLevel()` |

**验收**：开关打开后，聊天、流式、工具调用、中断、压缩、切模型、切思考档全部与二进制路径行为一致；关闭开关立即回到旧路径。

### U3. 能力注入迁移（extension → 原生）

按风险从低到高逐个迁，每个独立可回退：

1. **审批 hook**（`pi-extensions.ts`）→ 原生 tool-call hook（R4）。红线不变。
2. **自定义 Provider**（`pi-providers.ts`、`custom-provider-runtime.ts`）→ 复用 `providers/pi-runtime.ts` 的 `createModels()`（R6）。同步删除 `${secret:}` 占位与 spawn-env 注入链路。
3. **MCP 桥**（`pi-mcp-bridge.ts`）→ `customTools` 注册（R5）。鉴权头/env 不再落盘，`userData/pi-extensions/` 的生成物随之减少。
4. **capabilities 注入**（computer-use / automation / calendar / knowledge）→ 原生注册（R7）。**同步修改 `capabilities/automation/inject-points.test.ts`** 使其识别新符号——该测试读源码守「绝不在无人值守路径注入」，改注入形态而不改它等于把守卫悄悄架空。

**验收**：每项迁移后，对应能力在开关两侧行为一致；`inject-points.test.ts` 仍然真实守住约束（可用「故意在 runner 里注入」验证它会失败）。

### U4. 包管理迁移

- computer-use 的 `install.ts`、`ipc/pi-extensions-market.ts` 改用 `DefaultPackageManager`（R8）。
- `providers/catalog.ts` 改从 npm 包读（R9），`scripts/build-pi-catalog.mjs` 的版本一致性校验相应调整。

**验收**：首启后台安装 `pi-computer-use` 成功；扩展市场列表/安装/卸载可用。

### U5. 单发路径

`agents/pi.ts`（`--mode json` 单发）与 `ipc/cli.ts` 的 pi 分支切到 in-process。注意单发路径**无审批 UI**，注入门控与现状保持一致（computer-use 只在聊天路径注入这条不变）。

**验收**：单发场景（ask / 快捷回复 / 日报等）行为不变。

### U6. 其余调用方

`ipc/orchestrate.ts`（子 agent 编排）与其它 `PiRpcSession` 使用者切到新引擎。这些路径并发起多个会话，重点验证并发与资源释放（in-process 后没有进程隔离，一个会话的异常不能拖垮其它会话）。

**验收**：多子 agent 编排、圆桌并发正常；异常会话不影响同批其它会话。

### U7. 删除二进制与构建链

开关默认打开、稳定运行一个版本后执行：

- 删 `agents/pi-rpc.ts`（879 行）+ `pi-rpc.test.ts`（1288 行）、`pi-locate.ts`、`pi-extensions.ts`、`pi-mcp-bridge.ts`、`pi-providers.ts` 及其测试。
- 删 `scripts/build-pi-binary.mjs`、`resources/pi/`、`electron-builder.yml` 的 `extraResources` pi 段。
- 清理 `package.json` 各 `dist*` / `prepackage:*` 脚本里的 `build:pi` 步骤。
- 解除「双架构必须串行」的约束说明（`resources/pi` 是单一共享目录这个理由随之消失）——但 `release:ui` 的阶段顺序改动需单独评估，不在本 U 内顺手改。

**验收**：`dist:dir` 产物不含 `Contents/Resources/pi`；包体较迁移前净减约 66MB；全量回归通过。

### U8. 文档与收尾

- **`docs/module-map.md` 必须同步**（CLAUDE.md 强制）：至少第 44、48、50、55、117、127 行涉及 pi RPC / extension 注入 / `resources/pi` 的表述全部改写。缺更新视为本次改动未完成。
- 更新 `CLAUDE.md` 中「pi 是 bun 编译二进制」「computer-use 以 extension 经 `-e` 注入」两段架构描述。
- 删除本计划中已完成项，归档。

## Risks & Dependencies

- **风险｜进程隔离消失（最高）。** 现在 pi 崩溃只死一个子进程；in-process 后未捕获异常会打到主进程。`installGlobalCrashGuards()` 已在，但需针对 agent loop 补足边界捕获，尤其 U6 的并发场景。这是本次迁移唯一**没有**被现有架构覆盖的新风险类别。
- **风险｜依赖闭包变大。** coding-agent 拉入 glob/minimatch/undici/jiti/photon-node/highlight.js。打包态已实测 PASS，但 `jiti`（运行时 TS 加载，扩展体系用）与 `photon-node`（native）在 asar 内的行为需在 U1 护栏中持续盯，不能只测一次。
- **风险｜TUI 代码进 asar。** coding-agent 的 import 链会带上 pi-tui/chalk/highlight.js，主进程用不到但躲不开（上游 `exports` 只有 `.` 和 `./rpc-entry`）。已计入 +18MB，可接受；若上游后续提供更细子路径可再优化。
- **依赖｜版本锁定。** 三包版本必须一致（现 0.82.1）。`scripts/build-pi-catalog.mjs` 已有一致性校验，U4 调整后须保留该校验。
- **依赖｜升级节奏。** 迁移后升级 pi 从「换二进制 + 手工 diff .d.ts」变成「bump 三个包 + 跑类型检查」，但**破坏性变更会变成编译错误而非运行时静默失败**——这是收益，也意味着升级不能再「先发布再观察」。

## Sources & Research

三轮验证均为本仓库实测，spike 脚本在会话 scratchpad：

1. **引擎层可行性**（`pi-core-spike.mjs`）：`Agent` + 自定义 `streamFn` 跑通「工具调用 → 真实 IO → 二轮回复」；`AgentEvent` 十类事件与 `pi-rpc.ts`/`pi.ts` 手抄镜像逐字段同源。
2. **双包协同**（`pi-core-spike2.mjs`）：pnpm 下 pi-coding-agent 与 apps/desktop 解析到**同一个** pi-agent-core 物理目录（单实例，无 typebox schema 互不认风险）；`createGrepTool/createLsTool` 真跑通；`createAgentSession` 在无 provider 凭据下构造成功。
3. **打包态**（`pi-inproc-probe.mjs`）：在 `dist/mac-arm64/Cortex.app` 内、经主进程真实 CJS bundle 上下文，三包按包名从 asar 解析成功，工具真执行，`createAgentSession` 构造成功。**历史上的 `ERR_MODULE_NOT_FOUND` 坑在本方案下不复现。**

实测体积：asar 142M（新增约 18M），`resources/pi` 84M 可删，净减约 66MB。
