---
title: "pi in-process 迁移：文档改动点盘点（U8 执行清单）"
type: checklist
date: 2026-08-05
parent: docs/plans/2026-08-05-001-refactor-pi-inprocess-migration-plan.md
---

# pi in-process 迁移 · 文档改动点盘点

> **状态：已完成并由 gateway 方案收尾（见 2026-08-06-001）。**

> **本文件只做盘点，不改任何文档。** 文档的最终措辞取决于 U2–U7 落地后的真实形态（引擎层目录名、
> 开关是否已删、`resources/pi` 是否已删），提前改会写成猜测。本清单是 U8 的执行依据。
>
> **为什么必须有这份清单**：仓库 `CLAUDE.md` 强制规定「新增功能模块 / IPC 域时必须同步更新
> `docs/module-map.md`，缺更新视为该功能改动未完成」。本次迁移改的是**执行形态**（进程边界消失）
> 而非功能名词，最容易出现「代码全改完、module-map 还在指向已删除的文件」。
>
> **行号基准**：`refactor/pet-hermes-petdex` 分支 HEAD（`ceae10bb`）。改文档前请先用文中「现有原文」
> 的关键片段重新定位，不要盲信行号。

## 0. 盘点范围与判定

| 类别 | 处理方式 |
|---|---|
| **活文档**（`docs/module-map.md`、`CLAUDE.md`、`AGENTS.md`、`docs/lessons.md`） | **必须改**，列在下面第 1–4 节 |
| **历史计划 / 头脑风暴**（`docs/plans/*`、`docs/brainstorms/*`、`docs/ideation/*`、`docs/superpowers/*`） | **不改**。它们是带日期的历史记录，追改会破坏「当时是怎么想的」这一唯一价值。列在第 6 节仅供检索 |
| **CI / 脚本**（`.github/workflows/desktop-release.yml`、`scripts/*`） | 不属本清单（是 U7 的代码改动），但其中的**注释**同样描述二进制形态，见第 5 节 |

## 1. `docs/module-map.md`（最高优先级，共 9 处）

计划里点名的是第 44、48、50、55、117、127 行；实测**另有 3 处**（第 30–33、47、51 行）——其中
**第 51 行的 `providers/pi-native-auth.ts` 描述是最隐蔽的一处**，它写死了「pi 二进制的 `~/.pi/agent/auth.json`」
与「spawn 前按 expires 对齐」这两个只在二进制形态下成立的时序约定。

---

### 1.1 第 30–33 行 — 命名约定小节（**计划未点名**）

**现有原文**（节选）：
> `pi` 是**技术标识符**，继续用于 `AgentKind`、资源目录（`resources/pi/`）、IPC 契约、日志与本表的文件路径

**问题**：`resources/pi/` 在 U7 后不复存在。
**迁移后应改成**：把「资源目录（`resources/pi/`）」删掉或替换为「npm 包作用域（`@earendil-works/*`）」。
其余（`AgentKind`、IPC 契约、`openSettings("pi")`、`@cortex` mention）**完全不受迁移影响，不要动**。
**执行时机**：U7 之后（U7 前 `resources/pi` 仍在）。

---

### 1.2 第 44 行 — 「pi / codex 长驻会话」

**现有原文**：
```
| pi / codex 长驻会话 | — | — | `ipc/pi-session.ts`、`ipc/codex-ws-channel.ts` |
```

**问题**：`ipc/pi-session.ts` 仍在（R1 保证 IPC 契约不变），但它背后从「spawn `pi --mode rpc` +
`agents/pi-rpc.ts` 手抄协议」变成「in-process `createAgentSession`」。表里没有指向新引擎层目录，
按功能名词找过来的人会落进即将被删的 `pi-rpc.ts`。

**迁移后应改成**：main 列补上新引擎层，例如
`` `ipc/pi-session.ts`（IPC 契约不变）+ `agents/pi-inproc/`（in-process 引擎：session / events / tools / runtime）、`ipc/codex-ws-channel.ts` ``。
**注意**：U2–U6 期间引擎层与 `pi-rpc.ts` 由灰度开关并存，此行在**开关默认打开后**才改成单一指向；
并存期可先加一句「灰度开关见 `agents/pi-inproc/feature-flag.ts`」。

---

### 1.3 第 47 行 — vision 阻断（**计划未点名**）

**现有原文**（main 列）：
> `` `agents/pi.ts`（`@file` 图片参数,最终权威）``

**问题**：`agents/pi.ts` 是**单发路径**（`--mode json`）的 CLI 适配器，U5 会把它切到 in-process。
`@file` 这个 **CLI 语法**上的图片传参在 in-process 下不再是命令行参数。

**迁移后应改成**：待 U5 确定新的图片入参形态后，把「`@file` 图片参数」改为对应的 SDK 入参描述
（如「消息 attachments，最终权威」），文件指向随 U5 结果更新。
**风险**：这行是「最终权威」标注，写错会让后续排查 vision 问题的人找错地方。

---

### 1.4 第 48 行 — 自定义供应商在非聊天场景可用

**现有原文**（末段）：
> 打包态护栏 `scripts/verify-pi-ai-packaging.mjs`（pi-ai 是运行时动态 import、bundler 不打包,asar 缺依赖只在正式包暴露——dist:dir 后必跑）

**问题**：护栏的覆盖面在 R11 后扩大——不再只验 `pi-ai`，还要在 `dist:dir` 产物内实跑一次
**in-process agent loop**（`scripts/verify-pi-inprocess.mjs`）。而括号里的因果说明（「asar 缺依赖只在正式包暴露」）
现在同时适用于新放开的 5 个包（`pi-coding-agent` / `pi-agent-core` / `pi-tui` / `@silvia-odwyer` / `highlight.js`）。

**迁移后应改成**：护栏一项扩写为
「`scripts/verify-pi-ai-packaging.mjs` + `scripts/verify-pi-inprocess.mjs`（三包动态 import → 工具集构造 →
一轮真实 agent loop；pi 相关包全部走运行时动态 import、bundler 不打包，asar 缺任何一个都只在正式包暴露——`dist:dir` 后必跑）」。
**执行时机**：U0/U1 之后即可改（不必等 U7）。

---

### 1.5 第 50 行 — 自定义 Provider 接进 pi 聊天会话

**现有原文**：
```
| 自定义 Provider 接进 pi 聊天会话（用户 JSON → pi extension + Secret env 注入） | … |
`providers/custom-provider-runtime.ts`（**三段式解析 Catalog → 自定义 → 响亮失败**；
`${secret:NAME}` → `${CORTEX_PI_SECRET_<N>}` 占位 + spawn env 注入；`assertOneShotProviderSupported` 守卫单发路径）、
`ipc/pi-session.ts`、`ipc/cli.ts` 的 `spawnEnvFor` |
```

**问题**：**整行的机制描述全部作废**。R6 明确删除 `${secret:NAME}` → `${CORTEX_PI_SECRET_<N>}` 的占位链
与 spawn-env 注入，改为直接复用 `providers/pi-runtime.ts` 的 `createModels()` 喂给 `modelRuntime`；
`agents/pi-providers.ts`（生成 provider extension）整个删除。

**迁移后应改成**：
- 名词列：把「用户 JSON → pi extension + Secret env 注入」改为「用户 JSON → `modelRuntime` 注册（in-process，密钥只在内存）」。
- main 列：删掉 `${secret:}` 占位 / spawn env 注入 / `ipc/cli.ts` 的 `spawnEnvFor`，改为
  `` `providers/pi-runtime.ts` 的 `createModels()` ``+`` `providers/custom-provider-runtime.ts`（三段式解析保留）``。
- **新增一句收益说明**：密钥不再经环境变量跨进程传递，也不再烘焙进 `userData/pi-extensions/*.js`。
**执行时机**：U3-2 之后。

---

### 1.6 第 51 行 — Provider 凭据 / OAuth（**计划未点名，最隐蔽**）

**现有原文**（两处片段）：
> `` `providers/pi-native-auth.ts`（金库 ↔ pi 二进制 `~/.pi/agent/auth.json` 的 OAuth 双向同步:登录推送/注销清除/**spawn 前按 expires 对齐**,api_key 永不写入）``

> `` `providers/prefs.ts`（main-owned 的显示/隐藏 + baseUrl 覆盖，**同步读**供 `agents/pi-providers.ts` 在 **spawn 前**取用）``

**问题**：两处都把时序锚在「**spawn 前**」这个进程边界上，in-process 后**没有 spawn 这个时刻**了；
且 `agents/pi-providers.ts` 会被 U3-2 删除。「同步读」这个约束（因为 `buildArgs` 是同步的）在
in-process 下是否仍必要，需按 U3-2 实现回填。

**迁移后应改成**：
- `pi-native-auth.ts`：「pi 二进制 `~/.pi/agent/auth.json`」→「pi 的 `~/.pi/agent/auth.json`」
  （文件位置不变，但不再由二进制拥有）；「spawn 前按 expires 对齐」→「**建会话前**按 expires 对齐」。
- `prefs.ts`：`agents/pi-providers.ts` → 新引擎层的模型解析模块；「spawn 前取用」→「建会话前取用」，
  并复核「同步读」这条约束是否还成立（若可改异步，须显式说明，否则后人会以为它仍是硬约束）。
**执行时机**：U3-2 之后。

---

### 1.7 第 55 行 — 电脑操作 / Computer Use

**现有原文**（main 列节选）：
> `` `capabilities/computer-use/inject.ts`（五门控唯一决策点）、`install.ts`（首启后台 `pi install` 到 `~/.pi` + userData marker 幂等）``

**问题**：`pi install` 由 R8 改为 `DefaultPackageManager` 的**编程接口**（`install/installAndPersist/remove/…`），
不再 spawn 二进制跑子命令。「五门控」与「只在聊天路径注入」是**安全语义，一字不改**。

**迁移后应改成**：`install.ts` 的括号改为「首启后台经 `DefaultPackageManager` 安装 `pi-computer-use` 到 `~/.pi` + userData marker 幂等」。
**红线提醒（改文档时不得顺手弱化）**：`personal/permissionMode.ts` 那句「`gui_*` 写工具强制进审批集，
auto 档也强制开审批」必须原样保留——R4 明确该文件不改。
**执行时机**：U4 之后。

---

### 1.8 第 117 行 — IPC 域分组「会话与 Agent 执行」

**现有原文**（片段）：
> `` `cli.ts`（spawn/流式管线）… `pi-session.ts` / `pi-extensions-market.ts`（pi 长驻）``

**问题**：`cli.ts` 在 U5 后对 pi 不再走 spawn（claude/codex 仍走）；`pi-extensions-market.ts` 在 U4 后
改用 `DefaultPackageManager`。

**迁移后应改成**：`` `cli.ts`（spawn/流式管线，claude/codex；pi 走 in-process） ``，
`` `pi-extensions-market.ts`（扩展市场，经 `DefaultPackageManager`） ``。

---

### 1.9 第 127 行 — 非 ipc 功能目录段（**改动量最大的一处**）

**现有原文**（关键片段）：
> `agents/`（CLI 适配器）… 其中 `computer-use` 是唯一不走 MCP 的一个，**它以 pi extension 形式经 `-e` 注入**，
> 且**只在聊天 RPC 路径**生效；`automation` 与 `calendar` 同样**只在 pi RPC 聊天路径注入**
> （`ipc/pi-session.ts` 一处，`ipc/cli.ts` 刻意不接），因为它们的写工具必须逐次经用户确认，
> 而 claude 走 `--dangerously-skip-permissions`、codex 内置 server 被强制 `approve`、
> **pi 单发路径不写审批 extension**——那些路径上**兑现不了审批**；定时任务自身的执行路径
> `automation/runner.ts` 更是绝不注入…这条约束由 `capabilities/automation/inject-points.test.ts` 读源码守住

**问题**：三处机制表述作废（`-e` 注入、「RPC 路径」这个称呼、「不写审批 extension」），
但**三处约束语义全部不变**（R7）。

**迁移后应改成**（逐条）：
1. `agents/`（CLI 适配器）→ `agents/`（agent 适配：claude/codex 走 CLI spawn，pi 走 in-process 引擎 `agents/pi-inproc/`）。
2. 「以 pi extension 形式经 `-e` 注入」→「以原生 `customTools` / tool-call hook 形式注册」。
3. 「只在聊天 RPC 路径」→「只在聊天会话路径」（`ipc/pi-session.ts` 一处，`ipc/cli.ts` 刻意不接）。
   —— **不要改成「只在 in-process 路径」**，那会把 U5 之后同样 in-process 的单发路径误纳进来。
4. 「pi 单发路径不写审批 extension」→「pi 单发路径不注册审批 hook」。
5. **末句必须保留**：`inject-points.test.ts` 读源码守住这条约束。
   ⚠️ R7 要求迁移时**同步改该测试识别的符号**，否则它会「测试仍绿但守卫已架空」。
   改 module-map 时若发现该测试尚未同步，视为 U3-4 未完成，回退给实现。

---

## 2. `CLAUDE.md`（仓库根，2 段 + 1 处间接影响）

### 2.1 第 83 行 — Agent CLI 适配器段（计划点名）

**现有原文**（末两句）：
> `pi` 是由 `@earendil-works/pi-coding-agent` 经 bun `--compile` 打成的自包含单二进制
> （`scripts/build-pi-binary.mjs` → `resources/pi/pi`，`resolvePiBinary()` 定位），与其它 agent 一样用
> `child_process.spawn` 启动。（曾用 `utilityProcess.fork` 直跑 npm 包，因纯 ESM 依赖闭包在 asar 里
> 反复 `ERR_MODULE_NOT_FOUND` 而改为编译二进制。）

**迁移后应改成**：整两句重写为「pi **不走 CLI 适配器**，由主进程 in-process 调用
`@earendil-works/pi-coding-agent` 的 `createAgentSession()`（`agents/pi-inproc/`），进程边界不存在，
故没有 `buildArgs`/`parseLine`」。
**并且必须保留一句历史脉络**（改成三段式，否则后人会重蹈覆辙）：
「曾用 `utilityProcess.fork` 直跑 npm 包 → 因纯 ESM 闭包在 asar 里 `ERR_MODULE_NOT_FOUND` 改为 bun 编译二进制
→ 现改为主进程内动态 import；**成立的前提是 KTD1 的写法**（变量 specifier + `/* @vite-ignore */`，
让包不被 rollup 拉进 CJS chunk）与 `electron-builder.yml` 里 5 条排除的放开，二者缺一即回到当年的
`ERR_MODULE_NOT_FOUND`。」
**这句前提说明是本次文档改动里最有价值的一条**——去掉它，下一个做体积优化的人会把排除加回去。

### 2.2 第 85 行 — Computer Use 段（计划点名）

**现有原文**（首句）：
> 首启后台 `pi install` 到 `~/.pi`，注入决策集中在 `capabilities/computer-use/inject.ts` 的五门控，
> 且**只在聊天 RPC 路径**注入（单发路径无审批 UI）

**迁移后应改成**：`pi install` → 「经 `DefaultPackageManager` 安装」；「聊天 RPC 路径」→「聊天会话路径」。
**末句安全红线原样保留**（`gui_*` / `permissionMode.ts` / 「自动执行档也强制审批」）。

### 2.3 第 115 行 — 发版规范里的「双架构必须串行」（**计划未点名**）

**现有原文**：
> 阶段顺序不可调整：两架构必须串行（`resources/pi/` 是单一共享目录，重建即覆盖），且发布只在最后合并双架构清单后做一次

**问题**：括号里的**理由**随 `resources/pi` 删除而消失（U7 明确列出「解除双架构串行的约束说明」）。
但**结论未必随之改变**——`release:ui` 的阶段编排是否真能改成并行，U7 明确说「需单独评估，不在本 U 内顺手改」。

**迁移后应改成**：**只改理由、不改结论**，例如「两架构仍串行（`release:ui` 的阶段编排与断点续跑状态机
按串行设计；原先的 `resources/pi` 共享目录理由已随 pi in-process 化消失，是否可并行待单独评估）」。
⚠️ **不要**因为理由消失就直接删掉串行约束——「发布只在最后合并双架构清单后做一次」是 v0.1.27 事故的
独立教训，与 pi 无关。

---

## 3. `apps/desktop/AGENTS.md`（**计划未点名**）

**第 7 行现有原文**：
> Assets used by the packaged app belong in `assets/` or `resources/`. **The bundled `pi` binary is built into
> `resources/pi/` by `scripts/build-pi-binary.mjs`.** Build outputs are generated under `out/` and `dist/`…

**迁移后应改成**：删掉中间那句（U7 删除脚本与目录后它就是纯错误信息）。若要保留一句替代，写
「pi runs in-process from the `@earendil-works/*` packages in `node_modules`; nothing pi-related is staged into `resources/`.」
**注意**：本文件是**英文**，不要按中文优先规则翻译整篇。
**执行时机**：U7 之后（U7 前该句仍然正确）。

---

## 4. `docs/lessons.md`（**计划未点名，且是最重要的遗漏**）

这里有**三条连续的、专讲 pi 打包的经验条目**，其中第三条被明确标为「终极方案」——迁移后这个
「终极」判定被推翻。若不处理，下一个遇到 ESM 打包问题的人会照着它把 pi 改回二进制。

| 行 | 标题 | 迁移后处理 |
|---|---|---|
| 19 | `electron-builder 摊平 pnpm 多版本依赖 → 纯 ESM 第三方包命名导入崩溃` | **保留不动**（历史经验，本身仍成立） |
| 47 | `pi 在 unpacked、依赖闭包留 asar → ESM/CJS 都跨不过 asar 边界(必须全 unpack)` | **保留不动**，但第 76 行的转向注记要改（见下） |
| 80 | `终极方案:纯 ESM 复杂 CLI(如 pi)在 Electron 里改用 bun --compile 自包含二进制 + spawn` | **降级 + 追加第四条**（见下） |

**具体动作**：

1. **第 76 行**的转向注记现写「最终被下一条『bun 二进制』方案取代」，需改为「被『bun 二进制』方案取代，
   而 bun 二进制方案又被更后面的『in-process 库调用』取代——三条连读才是完整脉络」。
2. **第 80 行**标题里的「终极方案」必须去掉（改为「阶段性方案」或「历史方案」），并在条目开头加一行
   `> ⚠️ 已被下一条取代（pi 自 <版本> 起 in-process 化，本条作为历史经验保留）`。
3. **新增第四条经验**（本次迁移的真正沉淀），要点必须包含：
   - **翻案的关键差异**：当年失败的是「unpack 出来的 pi 从 `app.asar.unpacked` 往上找依赖，
     候选链不经过平行的 `app.asar`」；现在是**主进程自己**（在 asar 内）按包名 import，
     候选链天然落在同一棵 asar 树内——**不是同一个问题**。这一点不写清楚，后人只会记住「asar 里跑 pi 会炸」。
   - **成立前提**：KTD1 的变量 specifier + `/* @vite-ignore */`（写成字符串字面量会把整个 ESM 图
     静默打进 CJS chunk）；KTD2 接入层不得有 top-level await。
   - **隐藏依赖的教训**：`@silvia-odwyer`（photon）与 `highlight.js` 这两条排除，注释理由分别是
     「pi 二进制自带」和「纯 renderer 冗余」，**光看注释完全看不出它们是 pi 的运行时依赖**。
     判据应是「求一遍依赖闭包」而非「读排除项注释」。
   - **验证仍必须仓库外**（前三条共同的教训，本次不变）。
4. **第 110 行**那条「新增主进程依赖时务必核对 `files` 排除清单」与本次迁移**高度呼应**（zod 事故同型），
   建议在其「教训/排查套路」里补一句：**反向也成立——把某依赖从 renderer-only 改为主进程也用时，
   必须回查排除清单**（本次的 photon / highlight.js 正是此型）。

---

## 5. 非文档但含同类描述的注释（仅登记，由 U7 的代码改动顺带处理）

| 文件 | 位置 | 内容 |
|---|---|---|
| `apps/desktop/electron-builder.yml` | `files` 段开头、`highlight.js` 与 `@silvia-odwyer` 处、`asarUnpack` 前 | **U1 已改**（本次），说明由「二进制自带 / renderer 冗余」改为「主进程运行时依赖」 |
| `apps/desktop/electron-builder.yml` | `extraResources` 的 `resources/pi` 段 | **U1 已标注「迁移期保留，删除属 U7」** |
| `apps/desktop/electron-builder.yml` | `mac.target` 内，第 201 行（U1 改后行号） | 「禁止一次命令内产出双架构（`resources/pi` 是单一共享目录…）」——理由随 U7 消失，结论待评估，与 CLAUDE.md 第 115 行**必须同步改，别只改一处** |
| `.github/workflows/desktop-release.yml` | 第 7、129–134、182、276、300–303、456–459 行 | Setup bun（三处，固定 `1.3.11`）、`build:pi` 步骤、`--target bun-darwin-x64` 交叉编译说明。U7 删 `build:pi` 后 **bun 的三处 setup 也应一并删除**，否则留下无用的 CI 步骤与误导性注释 |
| `apps/desktop/package.json` | `dist*` / `prepackage:*` 脚本 | U7 清理 `build:pi` 步骤（计划已列） |

## 6. 不改的历史文档（仅供检索，勿追改）

以下文件含 pi 二进制 / extension / `resources/pi` 表述，均为带日期的历史记录：

- `docs/2026-07-30-pi-provider-capability-fix-plan.md`（provider catalog 与二进制同版本生成，R9 的前身）
- `docs/2026-07-30-pi-tui-provider-model-capabilities-research.md`
- `docs/2026-08-03-custom-provider-gateway-plan.md`
- `docs/brainstorms/2026-06-16-desktop-release-automation-requirements.md`
- `docs/brainstorms/2026-06-17-pi-install-extension-runtime-requirements.md`
- `docs/ideation/2026-06-17-pi-app-marketplace-ideation.html`
- `docs/superpowers/plans/2026-07-16-ai-slides.md`、`docs/superpowers/specs/2026-07-16-ai-slides-acceptance.md`
- `docs/plans/` 下 20+ 份 `*-pi-*` 计划（`2026-06-16-003-feat-pi-rpc-session-plan.md`、
  `2026-06-17-001-feat-pi-extension-customization-plan.md`、`2026-06-17-006-feat-pi-extension-marketplace-install-plan.md` 等）
- `apps/desktop/CHANGELOG.md` 历史版本段

## 7. U8 执行检查表

- [ ] `docs/module-map.md` 9 处（1.1–1.9）——**1.6 与 1.9 最易漏**
- [ ] `CLAUDE.md` 第 83、85 行；第 115 行「双架构串行」只改理由不改结论
- [ ] `apps/desktop/AGENTS.md` 第 7 行（英文）
- [ ] `docs/lessons.md`：第 76 行转向注记 + 第 80 条降级 + **新增第四条** + 第 110 条补反向教训
- [ ] `electron-builder.yml` 第 183 行附近的双架构注释与 CLAUDE.md 第 115 行**同步**
- [ ] `.github/workflows/desktop-release.yml` 三处 Setup bun 与 `build:pi` 注释一并清理
- [ ] 归档本文件与父计划
