# 用 utilityProcess.fork 重写 pi 子进程启动，消除 macOS Dock 闪现

> 状态：实现 + 自动化测试完成，待用户 dev/打包验证
> 创建：2026-06-13

## 背景与目标

**现象**：每次运行 pi agent（对话、自动生成会话标题、日报等）时，macOS Dock 会闪现一个图标 / 一个窗口一闪而过，随即消失。

**根因**（已诊断确认）：
- pi 不是常驻进程，cortex 每次用到都新起一个子进程跑完即退（`apps/desktop/src/main/ipc/cli.ts` 的 `cli:start` / `cli:oneshot`）。
- 子进程命令是 `process.execPath + dist/cli.js`，即直接执行 **Electron 主二进制**，靠 `ELECTRON_RUN_AS_NODE=1` 当 Node 用（`cli.ts:52`）。之所以不用系统 node，是因为 pi 要求 Node ≥ 22.19.0，而系统 node 是 v20.19.5；只能借 Electron 39 内置的 Node v22.22.1。
- 被执行的二进制是 `node_modules/electron/dist/Electron.app` 这个 **GUI 应用包**主程序，其 `Info.plist` 没有 `LSUIElement` 标记 → 即便走 Node 模式，macOS 仍会在进程启动瞬间把它当 app 注册，于是 Dock 闪现。

**目标**：把 pi 的子进程启动从 `child_process.spawn(Electron 二进制)` 改为 Electron 的 **`utilityProcess.fork()`**——同样用 Electron 内置 Node（dev/打包都零外部依赖），但它是无 GUI 的 Node 宿主，不创建 `NSApplication`、不上 Dock。claude/codex 是真正的外部 CLI，**保持 `child_process.spawn` 不变**。

## 关键技术约束（来自 Electron 39.8.10 官方类型 + 文档核对，硬限制标 ⚠️）

1. ✅ **ESM 入口可行**：Electron 28+ utilityProcess 改用 Node ESM loader（PR #40047）。pi 包 `type:module`、`bin.pi=dist/cli.js`、exports 仅 `import` 条件 → cli.js 会被当 ESM 加载，无需 `--experimental-*`。
2. ⚠️ **stdio**：必须显式设 `stdio: "pipe"`（= `["ignore","pipe","pipe"]`），否则 `child.stdout/stderr` 为 `null`。**stdin 只能 `ignore`**（我们本就 ignore）。
3. ⚠️ **无 `'close'` 事件**：只有 `'exit'(code:number)`、`'spawn'()`、`'error'(FatalError…)`（仅 V8 致命错误，**不报启动失败**）。启动失败（缺模块等）表现为「秒退 + 非 0 code」，真因只在 stderr。
4. ⚠️ **`kill()` 无参数**，固定发 SIGTERM。SIGKILL 兜底需 `process.kill(child.pid, "SIGKILL")`（退出后 pid 变 undefined，调用前判空）。
5. ⚠️ **`env` 传入即完全替换**（非合并）→ 必须 `{ ...process.env, ... }`（现有 `buildEnv()` 已 spread，满足）；**不要设 `ELECTRON_RUN_AS_NODE`**（utilityProcess 不需要，且可能干扰）。
6. ✅ **时机**：必须 app ready 后调用；在 `ipcMain.handle` 回调里调用天然满足。
7. ⚠️ **stdout / exit 时序**：utilityProcess `exit` 时 stdout 可能尚未 flush 完（退出后 stdout 变 null）。不能像现在的 `on('close')` 那样假设「close 时 stdout 已读完」。收尾须以 **stdout 流 `'end'` + 进程 `'exit'` 都到达** 为准。

## 设计：抽一个最小的 `AgentProcess` 句柄，spawn 点按 agent 分流

`cli.ts` 现有 2 处启动（`cli:start`、`cli:oneshot`）+ 2 处终止（`cli:kill`、`killAllCli`）都直接操作 `ChildProcess`。引入一个统一句柄屏蔽 `child_process` 与 `utilityProcess` 的差异，避免到处 `if (agent==="pi")`：

```ts
interface AgentProcess {
  pid: number | undefined;
  stdout: NodeJS.ReadableStream | null;
  stderr: NodeJS.ReadableStream | null;
  onExit(cb: (code: number | null) => void): void; // 统一 close/exit；含 stdout 'end' 协调
  onError(cb: (err: Error) => void): void;          // child_process 的 error；utility 下 no-op
  kill(): void;                                      // 优雅终止 + 3s 超时强杀
}

function startAgentProcess(
  agent: string, cmd: string, args: string[],
  opts: { cwd?: string; env: NodeJS.ProcessEnv },
): AgentProcess
```

- **agent === "pi"**：`modulePath = args[0]`（cli.js）、`childArgs = args.slice(1)`；`utilityProcess.fork(modulePath, childArgs, { cwd, env, stdio: "pipe", serviceName: "pi-agent" })`。`onExit` 协调 stdout `'end'` + 进程 `'exit'`；`kill()` 用 `child.kill()` + 3s 后 `process.kill(pid,'SIGKILL')`。
- **其它（claude/codex）**：`spawn(cmd, args, { cwd, env, stdio:["ignore","pipe","pipe"] })`；`onExit` 绑 `'close'`、`onError` 绑 `'error'`、`kill()` 用 `'SIGTERM'`→3s→`'SIGKILL'`，与现状完全一致。

**为何保留 `buildArgs` 返回 `cmd:process.execPath`**：pi.test.ts 断言 `cmd===process.execPath`、`args[0]===cli.js`。保持 `pi.ts` 的 `buildArgs` 原样、仅在 cli.ts 分流时取 `args[0]` 作 modulePath → 测试不破坏，改动面最小。

## 任务清单

### A. 改造 `apps/desktop/src/main/ipc/cli.ts`
- [x] 引入 `utilityProcess`、`type UtilityProcess`（electron），`process.kill` 兜底（`killWithTimeout`）。
- [x] 新增 `startAgentProcess()` 工厂 + `AgentProcess` 句柄（`wrapChild`/`wrapUtility`），封装两类进程差异（含 stdout `'end'`/`'close'` + `'exit'` 收尾协调）。
- [x] `running: Map<string, ChildProcess>` → `Map<string, AgentProcess>`。
- [x] `cli:start` 改用工厂；`stdout`/`stderr` 按行解析逻辑沿用（buffer 切行），收尾改走 `onExit`。
- [x] `cli:oneshot` 改用工厂；`on('close')`/`on('error')`→`onExit`/`onError`；超时强杀 `kill("SIGKILL")`→`AgentProcess.kill()`。
- [x] `cli:kill` / `killAllCli` 改用 `AgentProcess.kill()`。
- [x] `spawnEnvFor`：pi 分支**移除** `ELECTRON_RUN_AS_NODE`（改为防御性 `delete`），保留 `PI_KEY_ENV` 注入。

### B. 注释/文档同步
- [x] `pi-locate.ts`、`pi.ts` 顶部注释更新为「utilityProcess.fork」。`resolvePiCliEntry()` 逻辑（含 asar→unpacked 切换）**不变**，仍作 modulePath。

### C. 测试（自动化，我负责）
- [x] `pi.test.ts` 维持通过（buildArgs/parseLine 未改，15 用例全绿）。
- [x] 新增 `cli.test.ts`（`vi.mock("electron")` + `vi.mock("child_process")`）：分流（pi→fork、claude/codex→spawn）、env 无 `ELECTRON_RUN_AS_NODE`、stdio=pipe、args[0] 作 modulePath、收尾协调（防丢末行）、kill。
- [x] `pnpm vitest run` 全绿（106）+ `pnpm typecheck`（node+web）+ `pnpm lint`（exit 0）。

### D. 验证（需用户参与的部分）
- [ ] **dev 态**（用户手动验证 UI）：`pnpm dev` 跑一次 pi 对话 + 触发一次标题/日报 oneshot → 确认 (a) 功能与流式输出正常、(b) **Dock 不再闪现**、(c) kill/中断正常。
- [ ] **打包态**（关键风险，见下）：`pnpm dist` 出包运行 pi 完整回路，确认 asar 内依赖能被 utilityProcess 加载、无「秒退」。

## 风险与缓解

1. ⚠️ **打包态 asar 依赖加载（最高风险）**：当前 `electron-builder.yml` 只 unpack 了 pi 包本体（`@earendil-works/**`），pi 的运行时依赖（undici/jiti 等）**留在 asar**，现状靠「ELECTRON_RUN_AS_NODE 模式的 asar 感知 fs」加载并已实测通过。**utilityProcess 是否同样具备 asar-fs 补丁，必须打包态实测**。
   - 缓解：若打包后 pi 秒退（stderr 报 `Cannot find module`），把 pi 依赖树一并 `asarUnpack`。注意 electron-builder 会拍平 pnpm 的 node_modules（产物无 `.pnpm` 目录），glob 用 `**/node_modules/<dep>/**` 形式。
2. ⚠️ **stdout 丢尾行**：exit 早于 stdout flush → 末行（含 `message_end` 这条携带最终结果/错误的事件）可能丢失。缓解：`onExit` 必须等 stdout `'end'`，并在 end 时冲刷 buffer 残行。新增单测覆盖「无换行结尾的末行仍被解析」。
3. **claude/codex 回归**：分流逻辑若写错可能影响外部 CLI。缓解：claude/codex 分支保持 `spawn` + `close`/`error`/信号 kill 与现状逐行等价；单测覆盖分流。
4. **kill 语义弱化**：pi 的 `kill()` 只能 SIGTERM（+pid SIGKILL 兜底），无法像现在对 ChildProcess 直接 SIGKILL。pi 正常会响应 SIGTERM，影响可忽略。

## 回滚方案
改动集中在 `cli.ts`（+ 两处注释）。如打包态验证失败且 unpack 依赖也无法解决，`git revert` 单个提交即可回到 `spawn(Electron)` 现状（功能正常、仅 Dock 闪现）。

## 执行结果

**改动文件**（`git diff --stat`：3 改 + 1 新增测试）：
- `apps/desktop/src/main/ipc/cli.ts`（+154/-34 的主体）：新增 `AgentProcess` 接口、`killWithTimeout`、`wrapChild`、`wrapUtility`、`startAgentProcess`；4 处 handler（start/oneshot/kill/killAll）改用统一句柄；`spawnEnvFor` 去掉 `ELECTRON_RUN_AS_NODE`。
- `apps/desktop/src/main/agents/pi-locate.ts`、`pi.ts`：注释同步。
- `apps/desktop/src/main/ipc/cli.test.ts`（新增）：9 个分流/收尾/env 用例。

**实现期发现并修复的缺陷**：`wrapUtility.finalize()` 初版在 `exitCb` 尚未注册时即把 `fired` 置位，导致「收尾信号先于 onExit 注册到达」时无法补发回调。修正为 `finalize` 须等 `exitCb` 存在才触发（`|| !exitCb`）。已被 `cli.test.ts` 的「补发」用例锁定。生产路径（先 `startAgentProcess` 再同步 `onExit`）本不触发，但边界更健壮。

**自动化验证**：
- `pnpm vitest run` → 12 文件 / 106 用例全绿（含新增 9 个 cli 用例、pi 的 15 个）。
- `pnpm typecheck`（node + web）→ 无错误。
- `pnpm lint` → exit 0。

**遗留 / 待用户验证**（见任务 D）：
1. **dev 态**：`pnpm dev` 跑 pi 对话 + 标题/日报 oneshot → 确认功能与流式正常、**Dock 不再闪现**、kill/中断正常。
2. **打包态（关键风险）**：`pnpm dist` 出包跑 pi 完整回路，确认 utilityProcess 能加载 asar 内的 pi 依赖（undici/jiti 等）。若秒退且 stderr 报 `Cannot find module`，按「风险 1」缓解：把 pi 依赖树一并 `asarUnpack`。
