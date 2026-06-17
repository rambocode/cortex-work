---
date: 2026-06-17
type: feat
origin: docs/brainstorms/2026-06-17-pi-install-extension-runtime-requirements.md
---

# feat: 用 pi 原生 `pi install` 实现扩展市场安装机制

## Summary

在 `apps/desktop` 新增一条扩展安装机制：把 pi 二进制的 `install`/`list`/`remove` 当惰性下载运行时，市场负责策展、信任与 UI。范围限**扩展**（npm/git 包），技能保留既有 download 路径。装上≠启用——`pi install` 只下载入库，用户显式 trust+enable 后才经 `-e` 注入、靠 `extensionFingerprint` 漂移在下一轮会话生效；UI 是启用集唯一真相源，pi 自己的 `settings.json` 仅作库存来源。一条自建 importer 回退（R8）保留为应急契约，由前置验证结论触发才实现。

## Problem Frame

用户想「通过应用市场安装工具」。pi 的「工具」即扩展（`registerTool`/`registerCommand`，经 `package.json` 的 `pi.extensions` 声明），而扩展在本仓库当前**完全没有分发通道**——是 `apps/desktop/src/main/agents/pi-extensions.ts` 里写死模板、本地代码生成、写到固定文件名的 0600 JS（`writeExtension`，`pi-extensions.ts:161`）。技能有 `<name>/SKILL.md` 目录分发雏形（`apps/desktop/src/main/skills/download.ts` 存根 + Go importer 蓝本），扩展一条都没有。

pi 官方提供 `pi install npm:/git:` 与 `settings.json` 的 `packages[]`，且本地 spike（pi 0.79.2）已确认：`pi install` 不跑生命周期脚本、本地源不解析依赖、落盘 `~/.pi/agent/settings.json`（`-l` 则 `.pi/settings.json`）、`pi list`/`pi config` 原生分离装与启用（见 origin: `docs/brainstorms/2026-06-17-pi-install-extension-runtime-requirements.md` Sources）。借力它即可省掉自建下载/依赖/校验栈，但必须不破坏本仓库「UI 为启用集唯一真相源 + 默认拒绝信任」的底色——`apps/desktop/src/main/agents/pi.ts:57` 起的 `--no-extensions --no-skills` 基线正是该底色。

---

## Requirements

承接 origin 的 R1–R8（见 origin 文档），本计划落点：

- R1. 安装经 `spawn(pi, ["install", <ref>])` 完成，宿主进程不 import pi 模块（沿用 `resolvePiBinary` + `spawn` 进程隔离）。→ U4
- R2. 安装产物入「已装库存」，与「已启用集」是两个独立状态；安装不使任何扩展进入启用集。→ U2, U5
- R3. 用户显式 trust+enable 后扩展才经 `-e` 注入；启用集真相源是宿主 UI/配置，非 pi 的 `settings.json`。→ U2, U5, U6
- R4. 启用/禁用须使 `extensionFingerprint` 漂移，触发会话 close-and-reopen 生效。→ U3, U5
- R5. `spawn pi install` 之前展示来源/版本确认门；拒绝则不安装。→ U6
- R6. 主信任门在启用/加载时刻（启用即 `-e` 注入即首次执行代码）；不依赖 `--ignore-scripts`（0.79.2 无此 flag、且安装不跑脚本）。→ U5, U6
- R7. 已装扩展记 version/source/installedAt/origin 溯源，`pi list` 为数据起点。→ U2, U4
- R8. 若前置验证不利（远程安装行为或共存不可接受），回退自建 importer（复用 `server/internal/handler/skill.go` 蓝本）。→ U1 触发，见 Scope Boundaries

---

## Key Technical Decisions

- **借力 pi install，不自建下载运行时。** 已完成的**本地 spike** 确认 0.79.2 提供 `install/remove/update/list/config`，安装在 pi 自己进程内完成（`resolvePiBinary`，`apps/desktop/src/main/agents/pi-locate.ts:11`），与现有 `--mode json/rpc` 的 spawn 模型同构。仅当 U1 **联网/key 前置验证**不利才触发 R8。（注意区分：本地 spike 已完成；U1 是尚待做的联网验证。）**借 vs 自建的总成本**：借力省掉下载/依赖/校验栈，但引入 pin 0.79.2 的 CLI 行为契约、`pi list` stdout 解析脆弱性、双源对账、`-a` 整批信任不透明等长期维护负担——U1 是把这笔账做实的门，而非默认借力更省。
- **库存层不另存第二真相源，每次以 `pi list` 重建。** 对齐技能侧「每次重扫文件系统、无缓存」的做法（`apps/desktop/src/main/skills/registry.ts:scanRoot`）。UI 只额外持久化「启用集 + 信任 + 溯源」，按扩展唯一键（`源类型+包名`，非仅包名）关联；`pi list` 里消失的项在 UI 标「已失踪」而非静默移除启用记录。(C3)
- **扩展注入用独立的 `extensionPaths` 字段，并显式纳入 `extensionFingerprint`。** 不复用 `skillPaths`。`extensionFingerprint`（`packages/core/personal/pi-session.ts:86`）当前 hash `skillPaths`(已排序)/provider/审批开关等；新增 `extensionPaths`(排序后)进同一摘要，否则禁用静默不生效（该函数注释警告的「裸奔」）。(C6, R4)
- **启用集解析的 `-e` 路径是注入的唯一来源；绝不信任 pi 的 settings 自动发现。** 与 `apps/desktop/src/main/agents/pi.ts:57` 的 `--no-extensions` 基线一致——已装但未启用的扩展即便在 pi settings 里，也不得被加载。(C4, R3/R6)
- **`-a` 是会话级「信任全部」开关，不是逐扩展信任；UI 信任门是唯一的逐扩展强制点。** 代码实证（`pi-rpc.ts:208-211`：对整个 `-e` 集合循环 push 后只 push 一次 `-a`；`pi.ts:67`）：一旦任一扩展进入 `-e` 集，`-a` 即 blanket-trust 同会话所有 `-e`（含 provider/askquestion/sample 扩展）。因此 R6 的「逐扩展信任门」只能由**宿主 UI 在『进入启用集』这一刻**强制；pi 层不提供逐扩展信任粒度。威胁模型据此陈述：被启用的市场扩展与内置扩展同处一个已 `-a` 的进程，同名工具冲突（C8 延后）可在该已信任进程内 shadow 受信工具。U1 须确认 0.79.2 是否支持逐 `-e` 信任；若否，R6=UI 门为唯一边界这一事实须在实现与文案中显式承认，不得呈现为 pi 层逐扩展信任。
- **v1 仅用户级安装，数据模型 scope-aware 以便无损扩到项目级。** `pi install -l`（项目级 `.pi/settings.json`）引入工作区信任攻击面（对照 `packages/core/desktop/types.ts:395` 技能侧的命名威胁）。v1 只做用户级（默认可信），但启用/信任集用复合键 `${scope}:${ref}` 记录、装配按当前 `projectPath` 过滤，使后续加项目级（默认不授信）不破坏数据结构。(C7)
- **安装是可失败异步事务，失败不写 UI 库存、并对账 settings。** spawn 非零退出或 stderr 即判失败；失败后调一次 `pi list` 校对，若 pi 半写入则 `pi remove` 回滚或标「待清理」。同一扩展安装在途去重、不同扩展安装串行化（回避并发写 `settings.json` 竞争）。(C1, C5)
- **卸载正在启用的扩展先自动禁用再 `pi remove`。** 移出启用集 → 指纹漂移 → 下一轮以不含该 `-e` 的新指纹冷重开；活跃会话当前轮不受影响。(C2)
- **启用/禁用只改持久启用集、不主动重开（惰性 debounce）。** `ensurePiSession`（`packages/core/personal/pi-session.ts:145`）在下次 send 时比对指纹一次性重开；连续启停只在下一轮 send 重开一次，免抖动。(C9)

---

## High-Level Technical Design

扩展生命周期状态机（库存层 + 启用层正交）：

```mermaid
stateDiagram-v2
  [*] --> NotInstalled
  NotInstalled --> Installing: 点安装 + 来源确认门(R5)
  Installing --> InstalledDisabled: spawn 成功, pi list 可见(R2)
  Installing --> NotInstalled: 失败(网络/鉴权/404/配额/磁盘/超时), 不写库存(C1)
  InstalledDisabled --> Enabled: trust+enable 信任门(R6) → 指纹漂移
  Enabled --> InstalledDisabled: 禁用 → 指纹漂移(R4/C6)
  InstalledDisabled --> NotInstalled: pi remove
  Enabled --> NotInstalled: 卸载 = 先自动禁用 → pi remove(C2)
  InstalledDisabled --> Missing: pi list 不再可见(外部删除/损坏, C3/C10)
  Missing --> InstalledDisabled: 重新可见
```

安装 → 生效的数据流（注意「装上」与「生效」之间隔着一次会话冷重开）：

```mermaid
flowchart TB
  A[市场点安装 ref] --> B{来源确认门 R5}
  B -->|取消| Z[终止, 零写入]
  B -->|确认| C[spawn pi install ref]
  C -->|失败| D[判失败 + pi list 对账 + 回滚]
  C -->|成功| E[pi list 重建库存, 标 已装未启用]
  E --> F{用户 trust+enable}
  F -->|确认 R6| G[写 UI 启用集 + 记溯源]
  G --> H[extensionFingerprint 漂移]
  H --> I[下一轮 send: ensurePiSession 比对 → 冷重开 + -e 注入, switchSession 恢复]
```

---

## Implementation Units

### U1. 前置验证（gating，可触发 R8）

- **Goal**：用真实网络/key 实测两条 origin Deferred-to-Planning 假设，决定继续 pi-install 路径还是触发 R8。
- **Requirements**：R8 的判据；origin 的两条 Deferred-to-Planning。
- **Dependencies**：无。**必须先于 U2–U7**。
- **Files**：无源码改动（验证活动，结论写回 origin/本计划的 Open Questions）。
- **Approach**：在隔离 HOME（`export HOME=$(mktemp -d)`，对齐已记录的 spike 方法）逐项实测：①`pi install npm:<真实已发布扩展>` 与 `git:<repo>`，观察是否拉运行时依赖、依赖阶段是否跑 postinstall、远程包缓存落盘何处（注意远程安装会执行第三方代码，挑可信源）；②用真实 key 起一个 `--no-extensions` 会话，逐字确认已装包不被自动加载（这是「装≠启用」的命门，见下安全门）；③`pi list`（及 `pi list --json` 若存在）的输出形态：是否机器可读，是否携带 R7 溯源字段（version/source/installedAt/origin）——若不携带，溯源须在安装时捕获并持久化（见 U2）；④`-a` 是否支持逐 `-e` 信任，还是只能整批 trust-all（决定 R6/U6 信任门的真实粒度）；⑤pi 对坏/损坏 `-e` 是 fail-soft（仅该扩展失效）还是 fail-hard（拖垮整会话），以及失败发生在 spawn 期还是注册 hook 期（决定 U7 形态，见 MEMORY `pi-ctxui-session-start-deadlock` 的 hook 期死锁先例）；⑥离线（`--offline`/`PI_OFFLINE=1`）与鉴权失败时 `pi install` 的降级是否可恢复（origin 第三条 Deferred 假设）。
- **Execution note**：这是 gating 验证单元，不写产品代码。**R8 触发条件（任一硬性不满足即停止 U2–U7、改走 R8）**：远程安装在依赖阶段执行不可信脚本，或 `--no-extensions` 未真正抑制 install 写入的 `packages[]` 自动发现（命门：若不抑制，则每次成功安装都在下一轮自动加载未信任代码，「装≠启用」整体崩塌）。检查 ④⑤⑥ 是塑形后续单元的输入而非 R8 触发器：④定 R6/U6 信任门粒度文案、⑤定 U7 形态、⑥决定离线降级是否纳入 v1。
- **Test expectation: none** — 验证活动，结论为继续/回退的决策门。
- **Verification**：两条假设各得明确「成立/不成立」结论并记入 Open Questions；据此给出「继续 / R8」决定。

### U2. 扩展安装数据模型与启用集（types + store + 契约字段）

- **Goal**：定义已装扩展的库存项与持久化的启用/信任/溯源结构，并在请求契约里加 `extensionPaths`。
- **Requirements**：R2, R3, R7。
- **Dependencies**：U1（结论为「继续」）。
- **Files**：`packages/core/desktop/types.ts`（新增 `InstalledExtension` 库存类型 + `PiExtensionSettings` 启用/信任/溯源，镜像 `PiSkillSettings` 风格，`types.ts:397`/`412` 旁；`PiOpenRequest`/`CliStartRequest` 加内部填充字段 `extensionPaths?: string[]`）、`apps/desktop/src/main/ipc/types.ts`（同字段镜像，`types.ts:331` 的 `extraExtensionPaths` 旁）、`packages/core/store/personal.ts`（新增 setters：`toggleExtension(scope, ref, enabled)`/`trustExtension(scope, ref)`，复合键 `${scope}:${ref}`，沿用 `togglePiSkill` 的 `disabled`-集模式 `store/personal.ts:409`；`DEFAULT_PI_EXTENSIONS`）、`packages/core/desktop/types.ts` 的 `GeneralSettings` 加 `piExtensions?`。
- **Approach**：**存在性/库存清单**由 `pi list` 每次重建（U4 提供），不另存；但**溯源字段（version/source/installedAt/origin）是安装时数据，无状态的 `pi list` 重扫未必能重建**（取决于 U1 ③）——故 enabled/trusted/溯源在安装成功时按 `${scope}:${ref}` 持久化到 store，与 `pi list` 的存在性按同键关联。唯一键 `ref = 源类型+包名`（npm:foo 与 git:foo 视为两项）。**为 R8 留后路**：库存项以抽象 id 建模（不直接绑死 pi 的 ref 语法），使后端换成自建 importer 时数据结构可复用（见 R8 框定）。
- **Patterns to follow**：`PiSkillSettings` + `DEFAULT_PI_SKILLS`（`packages/core/desktop/types.ts:397`/`412`）；store setter 整体写回 `generalSettings.piExtensions` 的模式（`store/personal.ts:409-454`）。
- **Test scenarios**：
  - Covers R3. `toggleExtension("global","npm:foo",true)` 后启用集含该键；再 `false` 后移除。
  - 复合键隔离：`npm:foo` 与 `git:foo` 互不影响。
  - `DEFAULT_PI_EXTENSIONS` 缺省合并：load 时 `{...DEFAULT, ...persisted}` 不丢字段。
  - 溯源字段（version/source/installedAt/origin）随启用记录持久化与读回。
- **Verification**：类型通过 `pnpm --filter @cortex-work/core typecheck`；store 单测覆盖上述场景。

### U3. extensionFingerprint 纳入 extensionPaths + 装配层解析

- **Goal**：让启用集的变化驱动会话重开；禁用真正生效（防裸奔）。
- **Requirements**：R3, R4, R6。
- **Dependencies**：U2。
- **Files**：`packages/core/personal/pi-session.ts`（`extensionFingerprint`，`pi-session.ts:86`：把已解析的 `extensionPaths`(完整解析路径、排序)纳入摘要 JSON）、`packages/core/personal/messages.ts`（`resolveEnabledSkillPaths` 旁新增 `resolveEnabledExtensionPaths`，按启用集 + 信任 + 当前 `projectPath` 过滤产出 `-e` 路径，`messages.ts:960`）、`apps/desktop/src/main/agents/pi-rpc.ts`（`buildRpcArgs:208` 把 `extensionPaths` 折进既有 `exts` 数组的 `-e` 循环）、`apps/desktop/src/main/agents/pi.ts`（`buildArgs:66` **当前只处理单个 `piExtensionPath`、完全不处理 `extraExtensionPaths`**——单发 CLI 路径若不补，市场扩展会被静默丢弃；须同样折入 `extensionPaths`）。
- **Approach**：注入的 `-e` 路径**只**来自启用集解析；pi settings 的自动发现不参与（与 `--no-extensions` 基线一致）。摘要里 keyed 的是**完整解析路径字符串**（不止存在与否），使 `pi update`（C8 延后）改变安装路径时指纹漂移、强制重开。**决定并统一解析归属**：`extensionPaths` 与 `extraExtensionPaths` 同属「主进程生成、装配期合并」还是「core 解析」——`extraExtensionPaths` 现由主进程 `ipc/pi-session.ts:78-86` 生成，`skillPaths` 由 core 解析；新字段不要再开第三个装配站点，明确归一处。`-a` 仍是整批一次（见 KTD）。
- **Patterns to follow**：`skillPaths` 在指纹里的排序处理（`pi-session.ts:86-112` 注释「已在装配层排序，此处再排序一次」）；`resolveEnabledSkillPaths` 的 workspace 过滤。
- **Test scenarios**：
  - Covers R4. 启用集增删一个扩展 → `extensionFingerprint` 输出变化。
  - 顺序无关：同一组 `extensionPaths` 不同顺序 → 指纹相同。
  - Covers R6（防裸奔）：禁用一个先前启用的扩展 → 指纹漂移（断言其 `-e` 不再出现在解析结果）。
  - 运行时态不入指纹：仅改 model/thinkingLevel 不致漂移（沿用现注释约定 `pi-session.ts:83-85`）。
  - 解析只取启用集：库存里未启用项不出现在 `resolveEnabledExtensionPaths` 结果。
- **Verification**：core 单测；`pnpm --filter @cortex-work/core test`。

### U4. pi 安装/列举/卸载 IPC + 四层契约联动

- **Goal**：主进程提供 install/list/remove 三动作，含失败回滚与在途去重；并跨四层暴露给渲染层。
- **Requirements**：R1, R7。
- **Dependencies**：U2。
- **Files**：新增 `apps/desktop/src/main/ipc/pi-extensions-market.ts`（handlers `pi-ext:install`/`pi-ext:list`/`pi-ext:remove`，`spawn(resolvePiBinary(), ["install"|"list"|"remove", ...])`，解析 stdout/退出码）、`apps/desktop/src/main/ipc/register.ts`（import + 在 `registerIpcHandlers` 注册，`register.ts:22-41`）、`apps/desktop/src/main/ipc/types.ts`（请求/响应类型）、`packages/core/desktop/types.ts`（镜像）、`packages/core/desktop/bridge.ts`（`DesktopBridge` 新增可选 `piExtInstall?`/`piExtList?`/`piExtRemove?`，`bridge.ts:253` 旁）、`apps/desktop/src/preload/index.ts`（暴露到 `window.desktopAPI.personal`）。
- **Approach**：`pi-ext:list` 解析 `pi list` 输出为 `InstalledExtension[]`（库存重建的唯一来源，C3）。`pi-ext:install` 串行化队列 + 同 ref 在途去重（对照 `pi-session.ts` 的 `opening` Promise 去重，C5）；失败（非零退出/stderr）不写库存、调一次 `pi list` 对账、半写入则 `pi remove` 回滚（C1）。env 复用 `spawnEnvFor`/`buildEnv`（`apps/desktop/src/main/ipc/cli.ts:109`），注意 HOME 继承 `process.env.HOME`——校验它与 pi 读 `~/.pi/agent/settings.json` 的路径一致（C7 串场防护）。v1 不传 `-l`（用户级）。
- **Patterns to follow**：`registerSkillsHandlers` 注册模式；`download.ts` 存根头注释的接入路径；`spawnPiRpc` 的 spawn + env 注入（`pi-rpc.ts:245`）；白名单/路径安全三件套（`skills.ts:39-43`）。
- **Test scenarios**：
  - Covers R1. install 成功 → 解析出库存项 + 写 pi settings；`pi-ext:list` 重建可见。
  - Covers R7. 库存项带 version/source/installedAt/origin。
  - 安装失败矩阵（C1）：网络断 / 401 / 404 不存在 ref / 配额限流 / 磁盘满 / spawn 超时被杀 —— 各断言不写 UI 库存、`pi list` 对账无半写入、可重试。
  - 在途去重（C5）：同 ref 重复点装只跑一次。
  - 串行化（C5）：并发装不同 ref 不并发写 `settings.json`。
  - remove：`pi-ext:remove` 后 `pi list` 不再含该项。
- **Verification**：主进程单测（注入 fake spawn，对照 `pi-rpc.ts` 的 `RpcTransport` 可注入测试模式）；`pnpm --filter @cortex-work/desktop typecheck`（node + web 两套）。

### U5. 安装/启用/禁用/卸载流程编排（core）

- **Goal**：把 IPC 动作与启用集/信任/指纹串成完整状态机，含库存对账、信任门、级联卸载、惰性重开。
- **Requirements**：R2, R3, R4, R6。
- **Dependencies**：U2, U3, U4。
- **Files**：`packages/core/personal/`（新增扩展市场的 hooks/编排，按仓库约定：服务端态走 React Query、客户端态走 Zustand store；库存查询用 `bridge.piExtList`，key 含 wsId）、`packages/core/store/personal.ts`（启用/禁用/信任 action 复用 U2 setters）。
- **Approach**：安装成功 → 触发库存查询失效重建（C3，以 `pi list` 为准）。启用 = 过信任门(R6) → 写启用集 + 记溯源 → 不主动重开（惰性，C9）。禁用 = 移出启用集（指纹下一轮漂移）。卸载 = 若在启用集先自动禁用，再 `pi-ext:remove`（C2）。`pi list` 失踪项标「已失踪」不删启用记录（C3）。
- **Patterns to follow**：仓库状态约定（`CLAUDE.md`：服务端态 React Query、query key 含 `wsId`；WebSocket 仅触发失效）；`resolveEnabledSkillPaths` 的启用集→注入路径流。
- **Test scenarios**：
  - Covers R2. 安装成功后库存标「已装未启用」，启用集不含它。
  - Covers R3/R6. 未过信任门的扩展绝不进启用集、绝不出现在 `-e` 解析。
  - 卸载在用扩展（C2）：活跃会话当前轮工具仍可用；自动禁用 → 下一轮重开后该扩展消失且会话不崩。
  - 双源对账（C3）：外部改 `settings.json` 后重建库存，失踪项标态而非误删启用记录。
  - 连续启用 3 个（C9）：下一轮 send 只重开一次、注入全部 3 个。
- **Verification**：core 单测覆盖状态迁移；`pnpm --filter @cortex-work/core test`。

### U6. 管理 UI：已装列表 + 按 ref 安装 + 来源/信任门 + 启停/卸载

- **Goal**：给用户一个管理已装扩展、按 ref 安装、并经两道门确认的界面。**不含**远程浏览/发现目录（见 Scope Boundaries）。
- **Requirements**：R5, R6, R3。
- **Dependencies**：U4, U5。
- **Files**：`packages/views/cortex-desktop/personal/PluginManager.tsx`（IA 决定：扩展是与 MCP/Skill **并列的第三个 tab**，`Tab` 类型扩为 `"mcp"|"skill"|"extension"`，语义独立：npm/git 包 vs SKILL.md 目录 vs MCP；MCP 占位不动）、新增 `ExtensionPanel.tsx`（复用四态加载 + 搜索 + 派生计算 `PluginManager.tsx:130`）。
- **Approach**：已装列表来自 `bridge.piExtList`（库存）叠加启用/信任/溯源态（对照 `SkillPanel` 的 `decorated` 派生 `PluginManager.tsx:130-143`）。列表排序建议：启用态优先，再 `installedAt`。「已装未启用」与「已启用」需明确视觉区分（不只按钮文案）。
  - **来源确认门（R5）**：安装发生在 `pi list` 之前，门内**只能展示从 ref 字符串解析出的信息**（源类型 npm/git、包名、ref 里显式写的 `@version`/`#tag`，否则标「latest/默认分支」），并明确文案「即将从 X 下载并执行第三方代码」——它是「执行前告知门」，非「已核实元数据展示」。若 U1 测得远程安装在依赖阶段会跑脚本，文案须升级为「确认即允许安装时执行代码」。
  - **信任门（R6）**：这是产品里唯一「执行第三方代码」的安全决策点，**不得照抄 SkillPanel 的无信息『信任并启用』按钮**。门内须呈现：ref + 解析出的安装来源、本地 `-e` 落盘路径、溯源（installedAt/origin）、明确文案「启用后该扩展代码将在每轮会话中执行」。
  - **安装失败/重试（映射 U4 失败矩阵）**：失败以 inline 反馈（输入框下方/卡片旁，非整面 error 态——整面会清掉已装列表）呈现可读分类（网络/鉴权/不存在/磁盘/超时）+ 重试入口。安装中：按钮置「安装中」+ 去重（C5）。
  - **「下一轮生效」过渡态**：启用后当前会话不变、须下一轮 send 才生效（惰性，C9）——这是本产品最反直觉处，须给可见徽标（如「下一轮对话生效」），强于现有 SkillPanel 的单行静态 hint。
  - **卸载确认**：卸载不可逆（恢复要重走 install+信任门），须确认；当扩展在启用集时文案说明「将先停用并于下一轮会话移除」（C2）。remove 失败亦需反馈。
  - **空态二分**：`noBridge`（web 壳降级）与「bridge 可用但无已装扩展」是两态；后者引导「在上方输入 npm:包名 或 git:仓库 安装」。
  - **已失踪项（C3）**：`pi list` 不含的启用记录标「已失踪」并给可执行操作（「重新安装」复用 install 流 / 「移除记录」清启用+溯源），不做成死胡同。
- **Patterns to follow**：`SkillPanel` 的 `LoadState` 四态 + `noBridge`/「未发现」双空态（`PluginManager.tsx:16-18,372,388`）；分段 tab 切换（`PluginManager.tsx:41-56`）；`bridge.createSkill`/`openSkillDir` 的可选桥调用模式。
- **Test scenarios**：
  - Covers R5. 点安装先弹来源确认门，展示 ref 解析信息 + 执行代码告知；取消 → 不调 install、零写入（AE2）。
  - Covers R6. 启用前弹信任门并展示落盘路径/来源/执行告知；未确认不进启用集。
  - 安装失败反馈（U4 矩阵）：模拟各失败分类 → inline 可读错误 + 可重试，已装列表不被清空。
  - 「下一轮生效」态：启用一项 → 当前轮列表显「下一轮生效」徽标。
  - 卸载确认：卸载在启用集的项 → 弹确认并说明先停用；取消则不动。
  - 安装中态（C5）：进行时按钮置「安装中」，重复点不重复触发。
  - 已失踪项（C3）：`pi list` 不含的启用记录显示「已失踪」+「重新安装/移除记录」操作。
  - 空态二分：无 bridge → `noBridge`；有 bridge 无扩展 → 引导安装文案。
- **Verification**：Testing Library + jsdom 组件测试；用户手动验证 UI 交互（信任门/安装中/失踪态）。

### U7. 坏 `-e` 隔离与加载失败容错

- **Goal**：单个已装扩展的 `-e` 路径失效（外部删除/损坏）不应拖垮整个 pi 会话。
- **Requirements**：R3（健壮性）；C10。
- **Dependencies**：U3（注入字段就位即可独立做坏 `-e` 剔除）。其中「UI 标失效态」一小段需 U6 的态展示，可并入 U6 或作 U7 尾随子项——核心剔除逻辑不依赖 U5 编排，故 U7 可与 U5 并行。
- **Execution gate（依赖 U1 ⑤ 结论）**：
  - 若 pi **fail-soft**（单个坏 `-e` 不拖垮会话）→ U7 降级为**仅 UI 标失效态**，删去主进程注入前的存在性预校验（无失败模式可防）。
  - 若 pi **fail-hard**（整批/会话被拖垮）→ 实现完整宿主侧预校验。且注意：存在性 ≠ 可加载——坏 `-e` 可能是路径存在但 JS 损坏、`pi.extensions` 指向缺失子文件、注册 hook 抛错或死锁（MEMORY `pi-ctxui-session-start-deadlock` 的 hook 期死锁先例）。fail-hard 且批量作用时，仅存在性校验不足，须**逐扩展隔离探测后再提交批次**，或在检测到启动失败时剔除问题 `-e` 并重开的恢复路径。
- **Files**：`apps/desktop/src/main/agents/pi.ts`（`-e` 注入，`pi.ts:66`）、`apps/desktop/src/main/agents/pi-rpc.ts`（`buildRpcArgs` 的 `-e` 拼接，`pi-rpc.ts:208`）、`apps/desktop/src/main/ipc/pi-session.ts`（open 流程 ready 失败路径，`pi-session.ts:74`）。
- **Approach**：注入前对每个 `-e` 路径做**存在性 + 路径收敛**校验（复用 U4 已引的 `skills.ts:39-43` 路径安全三件套，把路径限定在预期的 pi 扩展库存根下——防被篡改的 `pi list`/settings 把 `-e` 指向任意位置，C3 已承认 settings 可被外部改），失效/越界的剔除并在 UI 标失效，其余照常注入。
- **Patterns to follow**：`pi-session.ts` 恢复路径对坏 sessionFile 的 best-effort 容错；`skills.ts:39-43` 的 `expandTilde→resolve→isInside` 路径白名单。
- **Test scenarios**：
  - Covers C10. 启用集含一个引用已删目录的扩展 → 注入前剔除该 `-e`、其余注入、会话正常起、该扩展标失效。
  - 路径越界：`pi list`/settings 被篡改指向库存根之外 → 该 `-e` 被路径收敛拒绝。
  - 损坏但存在：路径存在但 JS 语法损坏 / 注册 hook 抛错（fail-hard 分支）→ 隔离探测剔除或启动失败恢复，会话仍起。
  - 全部 `-e` 有效时行为不变（回归）。
  - 边界：启用集为空 → 不传 `-e`，会话照常（沿用 `--no-extensions` 基线）。
- **Verification**：主进程单测（注入 fake spawn + 不存在/越界/损坏路径）；手动验证会话不崩。

---

## Scope Boundaries

**本计划范围内**：扩展（npm/git 包）经 pi install 的安装/列举/卸载、启用集与信任/溯源、指纹激活、两道门 UI 与已装管理、健壮性（失败回滚、级联卸载、坏 `-e` 隔离）。

**Deferred for later（承自 origin）**：
- 技能（`SKILL.md` 目录）分发——保留既有 `download.ts`/clawhub 路径，不动。
- MCP 单元类型安装（PluginManager 的 MCP 占位 tab 保持「敬请期待」）。

**Outside this product's identity（承自 origin）**：
- 自建中央注册服务器。

**Deferred to Follow-Up Work（本计划局部排期）**：
- **远程浏览/发现目录 UI**（远程 catalog、搜索、分类、安装按钮、已装态徽标）——origin 划归 ideation #3/#6，本计划只做「按 ref 安装 + 已装管理」。
- **项目级 `-l` 安装 + 按项目授信**——v1 仅用户级；数据模型已 scope-aware（`${scope}:${ref}`），后续加项目级（默认不授信）不破坏结构 (C7)。
- **R8 自建 importer 回退**——保留为应急契约，仅当 U1 前置验证不利才实现：复用 `server/internal/handler/skill.go` 的多源/配额（1MiB/8MiB/128 文件）/`validateFilePath`/origin 模型，经 `pi-extensions:download` 类 IPC 落地。**范围诚实化**：R8 下「呈现不变」**仅指 UI 层 + 启用集/指纹/两道门（U3/U5/U6 的用户可见语义）**；它会作废 pi-install 专有的部分——`pi list` 重建库存、C3 双源对账、`源类型+包名` 的 pi ref 语法。缓解：U2 已要求库存以抽象 id 建模、溯源安装时持久化，使 R8 下「换后端」尽量收敛为替换库存来源（pi list → importer 写入的本地清单）而非重写数据模型；但 C3 对账在 R8 下失去意义（importer 自有库存即主真相）。
- **同名扩展冲突的工具名告警 与 `pi update` 更新流**——记溯源已支持识别，冲突解析与更新后重开留后续 (C8)。

---

## Risks & Dependencies

- **R8 触发风险（U1 结论）**：若远程 `pi install` 在依赖阶段执行不可信脚本，或 `--no-extensions` 未真正抑制 settings 自动发现，则 pi-install 路径不成立，须切 R8 自建 importer——U2–U7 的「装上≠启用 + 指纹激活 + 两道门」对用户呈现可保持不变，仅安装后端替换。U1 必须先行。
- **双真相源漂移（C3）**：pi 的 `settings.json` 可被用户或其他 pi 客户端直接改。缓解：库存每次以 `pi list` 重建、UI 只持久启用/信任/溯源、失踪项标态不误删。
- **HOME/路径一致性（C7）**：`spawnEnvFor` 继承 `process.env.HOME`（`cli.ts` 未显式覆盖）。须确认宿主 spawn pi 时的 HOME 与 pi 读 `~/.pi/agent/settings.json` 一致，否则安装与运行看到不同 settings。
- **坏 `-e` fail-hard 风险（C10/U7）**：当前 `-e <path> -a` 直接拼接，一个坏路径可能拖垮会话；U1 旁路需确认 pi 容错语义。
- **pi 版本契约**：行为依附 pin 的 0.79.2（`apps/desktop/resources/pi/.pi-version`）；升级 pi 须复验子命令集、不跑脚本、settings 路径。

---

## Acceptance Examples（承自 origin，映射到单元）

- AE1（装≠启用，承 R2/R3）→ U5 状态迁移测试 + U6 列表态。
- AE2（来源门取消则零写入，承 R5）→ U6 来源确认门测试。
- AE3（进行中会话启用 → 下一轮重开生效，承 R4）→ U3 指纹漂移 + U5 惰性重开测试。
- AE4（验证不利则切 R8，呈现不变）→ U1 决策门 + Scope Boundaries 的 R8 契约。

---

## Open Questions（Deferred to Implementation，U1 回答）

**R8 触发器（任一不利即回退）：**
- 远程 `npm:/git: pi install` 是否拉运行时依赖、依赖阶段是否执行不可信生命周期脚本、远程包缓存落盘何处？（本地源已确认不解析依赖/不跑脚本；远程未知）
- 真实 key 起会话时，`--no-extensions` 是否逐字确认抑制 install 写入的 `packages[]` 自动发现（已装未启用包确不被加载）？**命门**：不抑制则「装≠启用」整体崩塌。

**塑形后续单元的输入（非 R8 触发器）：**
- `pi list`（及 `--json`）输出是否机器可读、携带哪些 R7 溯源字段？（不携带则 U2 须安装时持久化溯源）
- `-a` 是否支持逐 `-e` 信任，还是只能整批 trust-all？（定 R6/U6 信任门真实粒度文案）
- pi 对失效/损坏 `-e` 是 fail-soft 还是 fail-hard、失败在 spawn 期还是注册 hook 期？（定 U7 形态）
- 离线（`--offline`/`PI_OFFLINE=1`）与鉴权失败时 `pi install` 降级是否可恢复？（定离线是否纳入 v1）

---

## Sources & Research

- origin 需求文档：`docs/brainstorms/2026-06-17-pi-install-extension-runtime-requirements.md`（R1–R8 / AE1–AE4 / spike 实测事实）。
- 上游 ideation：`docs/ideation/2026-06-17-pi-app-marketplace-ideation.html`（idea #2）。
- 关键现状（repo 勘察，带 file:line）：IPC 四层契约 `apps/desktop/src/main/ipc/types.ts`（`CliStartRequest:193` / `PiOpenRequest:306` / `extraExtensionPaths:331`）、`register.ts:22-41`、`packages/core/desktop/bridge.ts:253`（skills 桥方法）；pi adapter `apps/desktop/src/main/agents/pi.ts:52`（buildArgs）/`pi-rpc.ts:200`（buildRpcArgs）/`pi-locate.ts:11`/`pi-extensions.ts:161`（writeExtension 0600）；指纹与重开 `packages/core/personal/pi-session.ts:86`（extensionFingerprint）/`:145`（ensurePiSession）；装配 `packages/core/personal/messages.ts:960`（resolveEnabledSkillPaths）；状态 `packages/core/store/personal.ts:409`（setters）/`packages/core/desktop/types.ts:397`（PiSkillSettings）/`:412`（DEFAULT_PI_SKILLS）；UI `packages/views/cortex-desktop/personal/PluginManager.tsx`（tabs/SkillPanel/decorated:130）；回退蓝本 `server/internal/handler/skill.go`（importer 入口:1582 / 配额:457 / validateFilePath:178 / origin 模型:743）；env `apps/desktop/src/main/ipc/cli.ts:109`（spawnEnvFor，HOME 继承）。
- 流程/边界分析：C1–C10（安装失败回滚、卸载在用扩展、双源对账、信任门、禁用防裸奔、scope 串场、同名/更新、惰性重开、坏 `-e` 隔离）已分别落到对应单元的 Approach 与 Test scenarios。
