---
date: 2026-06-17
topic: pi-install-extension-runtime
---

# 用 pi 原生 `pi install` 作扩展市场的安装运行时

## Summary

把 pi 自带的 `pi install` 当作扩展市场的**惰性下载运行时**：市场只做策展、信任与 UI 层，安装经 `spawn(pi, ["install", <ref>])` 走 pi 自己的解析器，省掉自建一整套下载/依赖/校验栈。范围限于**扩展**（npm/git 包）；技能保留既有的 download 路径。是否采用由一个 bun spike 门控，不通过则回退到自建 Go importer。

## Problem Frame

用户想要「通过应用市场安装工具」。在 pi 的模型里，用户真正想装的「工具」是**扩展**（`registerTool` / `registerCommand`，经 `package.json` 的 `pi.extensions` 声明），而扩展在本仓库当前**完全没有分发通道**——它们是 `pi-extensions.ts` 里写死模板、本地代码生成、写到固定文件名的 0600 JS。技能（`<name>/SKILL.md` 目录）有一条已设计好接口的下载路径（`apps/desktop/src/main/skills/download.ts` 存根 + Go importer 蓝本），扩展则一条都没有。

与此同时，pi *官方*已提供 `pi install npm:/git:` + `settings.json` 的 `packages[]` 清单。团队当前以 `--no-extensions --no-skills` 为启动基线并显式注入，绕开了 pi 的自动发现。问题是：补「扩展无分发」这个空白时，是再造一套下载/依赖/校验栈，还是借力 pi 已有的安装能力。后者若可行，省去的工作量与未来 pi 升级 `packages` 的红利都很可观，但需先证明它不与本仓库「UI 单一真相源 + 默认拒绝信任」的底色冲突。

## Key Decisions

- **借力 pi install 而非自建下载栈。** 把 pi 二进制当安装运行时。这是「别先建中央服务器」的最优解。spike 已确认 0.79.2 原生提供 `install / remove / update / list / config` 一整套子命令，前提成立；剩余风险见 Outstanding Questions，硬性不满足才触发 R8 回退。
- **范围限于扩展，技能保留 download 路径。** `pi install` 原生分发 npm/git 包（扩展），恰好补上当前缺失的那半边；技能继续走 `download.ts`/clawhub。两条路按单元类型分工，不为「统一」强行让技能套包语义。
- **pi install 只当下载器，不当加载驱动。** pi 把已装包写进它自己的 `~/.pi/agent/settings.json`（用户级）或 `-l` 的 `.pi/settings.json`（项目级），并原生用 `pi list` / `pi config` 区分「已装」与「启停」。市场把它视为「已装库存」，UI 仍是启用集的唯一真相源；扩展的实际加载继续走 `--no-extensions` 基线 + 显式 `-e` 注入，而非由 settings 自动发现驱动。
- **装上≠启用，两步分离。** 从市场「安装」只下载入库；用户须显式 trust + enable 后扩展才被注入生效。这保住默认拒绝信任的姿态，且与 pi 原生的 install/config 分离一致。
- **信任门落在「启用/加载」时刻，安装前再加一道轻量来源确认。** spike 实测 `pi install` **不执行 npm 生命周期脚本**（本地零依赖包的 `postinstall` 哨兵未触发），所以「安装期执行任意代码」的风险基本不存在，代码首次执行在扩展被启用加载时——主信任门因此放在启用。安装前仍展示一道来源/版本确认，作为纵深防御，并覆盖 npm:/git: 真实安装时「拉取依赖是否跑脚本」这一尚未验证的情形。

## Requirements

**安装机制**

- R1. 市场安装一个扩展时，经 `spawn` 调用 pi 二进制的 `install` 子命令完成下载与依赖解析，宿主进程不 import pi 的任何模块（沿用现有 `--mode json/rpc` 的进程隔离模型）。
- R2. 安装的产物落入一个**已装库存**，与「已启用集」是两个独立状态；安装本身不使任何扩展进入启用集。
- R3. 用户须对一个已装扩展显式执行 trust + enable，之后它才经 `-e` 注入进 pi 会话；启用集的真相源是宿主 UI/配置，而非 `settings.json` 的 `packages[]`。
- R4. 启用/禁用一个扩展须使 `extensionFingerprint` 漂移，从而触发会话 close-and-reopen 使变更生效（与现有技能/扩展激活语义一致）。

**信任与安全**

- R5. 在 `spawn` `pi install` *之前*，向用户展示一道来源确认，至少呈现：来源（npm/git ref）、包名与版本；用户拒绝则不执行安装。
- R6. 主信任门设在「启用/加载」时刻：扩展被启用经 `-e` 注入即首次执行其代码，须经此门。安装本身不执行第三方生命周期脚本（spike 已实测），因此不依赖 `--ignore-scripts`（0.79.2 的 `pi install` 亦无此 flag）。
- R7. 已装扩展须记录来源溯源（来源类型、source ref、版本），以支撑后续的更新、卸载与供应链审计。pi 的 `pi list` 可读出 settings 中的已装集，作为该溯源的数据起点。

**回退**

- R8. 若 spike 判定 pi install 不可用作惰性下载器（见 Outstanding Questions 的判据），市场的扩展安装回退到自建路径：复用 `server/internal/handler/skill.go` 的多源/配额/路径安全蓝本，经一个 `pi-extensions:download` 类 IPC 落地，激活语义（R2–R4）保持不变。

## Acceptance Examples

- AE1. **Covers R2, R3.** 用户在市场点「安装」扩展 X。系统下载 X 入库，但当前 pi 会话行为不变、X 未被注入；市场列表把 X 标为「已安装·未启用」。用户随后点「信任并启用」，下一轮对话中 X 的工具方可调用。
- AE2. **Covers R5.** 用户点「安装」一个来自任意 GitHub 仓库的扩展。在任何下载/代码执行发生前，先弹同意门展示该 git ref 与版本；用户取消，则磁盘无任何写入、无代码执行。
- AE3. **Covers R4.** 用户在一个进行中的会话里启用一个已装扩展。系统不在当前轮注入，而是令指纹漂移、于下一轮冷重开会话时经 `-e` 注入，并尽量经 `switchSession` 恢复上下文。
- AE4. **Covers R8.** 进一步验证发现 `pi install` 在 `--no-extensions` 下仍强制自动加载已装包（破坏 UI 真相源），或远程安装行为不可接受。团队据 R8 切换到自建路径；R2–R4 的「装上≠启用 + 指纹激活」对用户呈现不变。

## Scope Boundaries

- 技能（`SKILL.md` 目录）的分发——保留既有 `download.ts`/clawhub 路径，不纳入本机制。
- 浏览/发现 UI（远程目录、搜索、分类、安装按钮、已装态徽标）——相邻但独立，见 ideation 的 #3/#6。
- MCP 单元类型的安装。
- 自建中央注册服务器。

## Dependencies / Assumptions

- `pi install` 在 `spawn` 出的 pi 进程内完成、产物落 `~/.pi/agent/settings.json`（用户级）或 `.pi/settings.json`（`-l`），已由本地 spike 确认（见 Sources）。
- 已知权衡：pi 安装不跑生命周期脚本，**需要安装期构建步骤的包（含原生依赖编译）将不被构建**，启用时可能加载失败。pi 自家扩展模板是零 import JS、不受影响；引入此类 npm 包前需各自验证——这是 R8 自建路径同样要面对的，非本方案独有。
- pi 版本已 pin `0.79.2`；`pi install` 的行为契约（子命令集、不跑脚本、settings 路径）依附该版本，升级 pi 须复验。

## Outstanding Questions

已由本地 spike 解决（见 Sources），不再阻塞规划：`pi install` 子命令集存在、不跑生命周期脚本、本地源不解析依赖、落盘 `~/.pi/agent/settings.json` 或 `.pi/settings.json`、`pi list`/`pi config` 原生分离装与启用。

**Deferred to Planning（需联网或真实 key，规划阶段带以下假设推进并验证）**

- 假设：远程 `pi install npm:/git:` 会下载依赖，但其依赖安装阶段不执行不可信生命周期脚本，或即便执行也被 R5 来源确认 + R6 启用时信任门覆盖。**验证：** 规划阶段用一个真实已发布扩展包联网实测（注意执行第三方代码，挑可信源）。**不利则：** 收紧 R5 为更强的安装前同意，或触发 R8 回退。
- 假设：`--no-extensions` 抑制 settings 自动发现、已装包不被自动加载（help 语义 + 仓库注释佐证）。**验证：** 规划阶段用真实 API key 起会话逐字确认。**不利则：** 加一步把市场已装包排除出 pi 自动发现的 settings，或触发 R8 回退。
- 假设：离线（`--offline` / `PI_OFFLINE=1`）与鉴权失败时 `pi install` 可恢复降级。**验证：** 规划阶段联网用例覆盖。

## Sources / Research

- `apps/desktop/src/main/agents/pi-locate.ts:2` — pi 为 bun 编译自包含二进制、依赖闭包 inline、不依赖 node_modules、经 `child_process.spawn` 执行（`spawn pi install` 进程隔离的依据）。
- `apps/desktop/src/main/agents/pi.ts:57-62` 与 `apps/desktop/src/main/agents/pi-rpc.ts:201-204` — `--no-extensions --no-skills` 基线 + 显式 `--skill`/`-e` 注入，「UI 为启用集唯一真相源」。
- `apps/desktop/src/main/agents/pi-extensions.ts` — 扩展当前为本地代码生成的固定文件名 0600 JS（无分发单元）。
- `apps/desktop/src/main/skills/download.ts` 与 `server/internal/handler/skill.go` — 技能下载存根与多源/配额/路径安全的 Go importer 蓝本（R8 回退所复用）。
- pi 官方 `docs/extensions.md` — `pi install npm:/git:`、`package.json` 的 `pi.extensions`、`settings.json` 的 `packages[]`、「扩展以全系统权限执行任意代码」的信任声明。
- 本地 spike（pi 0.79.2，2026-06-17，隔离 HOME、无 key、无网络）：
  - `pi --help` / `pi install --help` — 子命令集为 `install / remove / uninstall / update / list / config`；`pi install <source>` 仅有 `-l/--local` 与 `-a/--approve` flag，**无 `--ignore-scripts`**；源支持 `npm: / git: / https:// / ssh:// / ./path`。
  - `pi install ./零依赖测试扩展` — 安装成功；附带的 `postinstall` 哨兵文件**未生成** → 安装不跑顶层包的 npm 生命周期脚本。产物记入 `~/.pi/agent/settings.json`，`pi list` 可读出（本地源为就地引用、不复制）。
  - `pi install ./带本地依赖的扩展` — 依赖的 `postinstall` **未跑**、未生成 `node_modules` → 本地源安装**完全不解析依赖**。远程源（npm:/git:）的依赖拉取与脚本行为仍待联网验证。
- ideation 来源：`docs/ideation/2026-06-17-pi-app-marketplace-ideation.html`（idea #2）。
