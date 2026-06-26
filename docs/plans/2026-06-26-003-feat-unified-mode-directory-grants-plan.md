---
title: "feat: 统一 Mode 与目录授权"
type: feat
date: 2026-06-26
status: ready
depth: deep
---

# feat: 统一 Mode 与目录授权

## Summary

把现有 3 档 `PermissionMode`(`plan` / `accept-edits` / `full-auto`)扩成统一的运行
**mode** 概念,新增第 4 档 `auto`(应用按 prompt 自动选档),并引入与 mode **正交**的
**目录授权**(`directoryGrants`)。运行时由 core 把 `(mode × grants)` 合成为各 agent
(claude / codex / pi)的真实启动参数。UI 上把 mode 从 GitBar 移出,在 Composer 上方
放 `Mode` 与 `目录授权` 两个 pill。

本轮已与用户敲定的范围裁剪(决定见下):

- **内部值不变,仅改 UI 标签**:内部 union 保留 `plan` / `accept-edits` / `full-auto`
  不改名(零迁移、零回归),只新增 `auto`;UI 文案展示为 `Plan` / `Edit automatically`
  / `Auto` / `Bypass permissions`。
- **本轮不做 `ask-before-edits`**:它需要交互审批回路,而 claude `-p` / codex `exec`
  是非交互 print 模式(现有注释明确「会卡住」),留待 claude/codex 接入交互审批后再加。
- **`auto` 本轮纳入(简单规则版)**:core 纯函数按 prompt 关键词派生具体档,危险命令
  不自动升 `full-auto`。
- **目录授权全量兑现**:既合成各 agent 真实启动参数(`--add-dir` 等),也统一 app 侧
  `openablePathInfo` / `openPath`。

非目标:目录内图库预览;`ask-before-edits`;`auto` 的 LLM 级意图分类(本轮只用关键词规则)。

---

## Problem Frame

现状有两处割裂:

1. **mode 语义不完整**:只有 3 档,缺少「应用自动决定松紧」的 `auto`。新会话默认从
   `plan` 起步,用户每次都要手动切到可写档,体验割裂。
2. **目录范围被 mode 隐式裹挟**:能访问哪些目录完全由 mode 的 sandbox 决定,用户无法
   在「自动改文件」的同时显式授权一个项目外目录(如 `~/.codex/generated_images` 或
   自选目录)。`generated_images` 图片虽因 `assertOpenable` 放行真实文件而**大体可点开**,
   但这是隐式副作用,既无 UI 表达也无法扩展到自定义目录/可写授权。

目标:`mode` 只表达**执行/审批松紧**,目录范围由独立的 `directoryGrants` 表达,两者在
运行时合成。用户能在 Composer 直接看到并调整这两个维度。

---

## Key Technical Decisions

### KTD1. `auto` 作为新 union 值,在「合成边界」解析为具体档,不下传 adapter

`PermissionMode` 增加 `"auto"`。adapter(claude/codex/pi)**只认识** `plan` /
`accept-edits` / `full-auto` 三个具体档——这是现有成熟翻译链,不动它。`auto` 在 core 的
**合成层**(装配 `CliStartRequest` / `PiOpenRequest` 前)经 `resolveEffectiveMode(prompt)`
派生成具体档再下传。好处:adapter 零改动承接 `auto`;`auto` 逻辑集中在 core 纯函数,可测、
可演进(后续换 LLM 分类不影响 adapter)。

**类型钉死「auto 不入 adapter」不变量**:新增
`ConcretePermissionMode = Exclude<PermissionMode, "auto">`。`resolveEffectiveMode` 返回
`ConcretePermissionMode`;`CliStartRequest.permissionMode` / `PiOpenRequest` 下传字段也用
`ConcretePermissionMode`。这样「auto 泄漏到 adapter」是**编译期**错误而非靠约定与测试。

### KTD2. 内部 mode 值不改名,仅 UI 英文文案改

持久化的存量会话带 `permissionMode: "accept-edits" | "full-auto"`。保持内部值不变 = 零
迁移、零存量回归。

UI 文案现状(已存在,见 `chat.json` `composer.permissionMode`):中文名
`accept-edits → "自动改文件"`、`full-auto → "全自动"`、`plan → "Plan · 只读"`,且已有
`planHint/acceptEditsHint/fullAutoHint`。本轮只**改英文 locale + 新增 auto**,不动既有中文名:
- 英文 `en/chat.json`:`accept-edits → "Edit automatically"`、`full-auto → "Bypass permissions"`
  (若现状英文已是其它值则改名至此;现状中文 `自动改文件 / 全自动` **沿用不动**)。
- 两个 locale **新增** `auto`(中文「自动」、英文「Auto」)+ `autoHint`。
- 新增 `directoryGrant.*`。

代价是「内部命名 ≠ UI 名」,以注释固化映射关系(`packages/core/desktop/types.ts` mode 段集中写明)。

**命名层纪律**:全文(含 HTD 示意图、测试场景)的 mode **标识符**一律用内部值
`plan / accept-edits / auto / full-auto`,**显示名**才用 `Plan / Edit automatically / Auto /
Bypass permissions`。不得出现 `edit-auto` / `bypass` 等第三套简写。

**`accept-edits` 语义反转记录**:`accept-edits` 内部值在本轮**永久**表示「自动改文件、不逐条
审批」。它的字面义(逐条接受编辑)恰是延后的 `ask-before-edits` 想要的——未来实现
`ask-before-edits` 时**必须用一个全新内部值**(如 `ask-before-edits`),**不得**回收
`accept-edits`(否则触发本轮刻意规避的存量迁移)。U1 类型注释须写明这一约定。

### KTD3. `directoryGrants` 用判别联合,正交于 mode;路径内聚进 grant

会话级新增单字段 `directoryGrants?: DirectoryGrant[]`,`DirectoryGrant` 为**判别联合**,
让非法态不可表达(评审命中:双字段 `customGrantDirs` 会出现「custom 启用但无路径 / 有路径
但未启用 custom / 关掉 custom 残留路径」三种坏态):

```ts
type DirectoryGrant =
  | { kind: "workspace" }
  | { kind: "generated-images" }
  | { kind: "custom"; dirs: string[] }   // 自定义路径内聚于此,不再单列 customGrantDirs
  | { kind: "all-files" };               // 无路径:全盘访问哨兵,仅 full-auto 有效(KTD4)
```

core 纯函数 `resolveGrantDirs(grants, cwd, home)` 把启用项展开为绝对目录集:
`workspace → cwd`、`generated-images → <home>/.codex/generated_images`(+ app 自身
`.cortex/media/images`)、`custom → grant.dirs`、`all-files → 哨兵布尔`。

> **home 来源**(评审命中:`packages/core` 不得读 `process.env`/`os`):`resolveGrantDirs`
> 显式收 `home: string` 形参。home 由壳侧在 app init 经一次 IPC 取得(主进程 `os.homedir()`),
> 经 `CoreProvider` 注入(随 `apiConfig`/`wsId` 同源),合成调用点取用。U3/U5 据此落地。

> **`generated-images` 现为 codex 约定**:`~/.codex/generated_images` 是 codex 产物目录。
> claude/pi 若产图在别处,本 grant 不覆盖。本轮按此实现并在 U3 注释标注「codex-specific,
> 其它 agent 产图目录待扩展」,不改名(保留用户既定 4 类)。

### KTD4. 授权不能突破 mode;`all-files` 仅 `full-auto` 可选

合成时 mode 是上界:
- `plan` + 任意授权 → 目录只**可读/可打开**,不进可写参数(plan 档本就 read-only sandbox)。
- `accept-edits` + 授权 → 展开目录作为**可写扩展**进 `--add-dir`(codex/claude),pi 按能力。
- `full-auto` + `all-files` → 完全放开(本就 danger-full-access,`--add-dir` 对其为 no-op)。
- `all-files` 选项在 UI 上仅当 mode 为 `full-auto` 时可选;其它 mode 下置灰并提示。

**`all-files` 安全闸**(评审命中:两键即永久落最高风险姿态,无确认):
- 首次启用 `all-files` 时弹一次显式确认(说明 agent 将获全盘读写)。
- `directoryGrants` 是**期望态记录**而非「能力过滤态」:mode 从 full-auto 切走时,UI 把
  `all-files` 显示为「置灰且仍勾选」(回到 full-auto 自动复效),运行时由 `clampByMode` 忽略——
  不静默从 `directoryGrants` 删除它(U6 状态机据此)。
- `all-files` 处于激活态时,DirectoryGrantPill 显示**常驻**警示样式(非仅未激活时置灰)。

### KTD5. 各 agent 目录参数映射,精确 flag 留待实现期核实

| agent | 可写目录扩展 | 备注 |
|-------|------------|------|
| claude | `--add-dir <dir>`(每目录一次) | Claude Code 原生支持 `--add-dir` |
| codex | `--add-dir <dir>` 或 `-c` writable_roots | exec 子命令具体 flag 名实现期实测核实(参考现有 `-c sandbox_mode` 经验:resume 分支只吃 `-c`) |
| pi | cwd 之外目录能力有限 | pi 用 `--tools` 限工具、无 sandbox flag;额外目录本轮以「app 侧可读/可打开」兜底,agent 级可写扩展若 pi 无对应能力则 UI 标「降级映射」,不伪造 sandbox |

精确 flag(尤其 codex exec / resume 两分支、pi 能力)在 U4 实现期用 `--help` 实测确认,
**不**在计划期假定;不支持的精确组合按方案要求显示「降级映射」。

### KTD6. 授权目录真相源在主进程;渲染端只传 sessionId,绝不传目录

**安全决策(四 persona 共识,必须在计划期定死)**:渲染进程不是可信边界。**禁止**让渲染端把
「已解析授权目录」随 IPC 调用传入再「二次校验」——那等于拿渲染端的声明校验它自己,被注入的
渲染端可借此打开任意路径(如 `~/.ssh`)。

落地:主进程维护**自有**的「会话 → 授权目录」注册表,在会话创建/更新(随 `saveState`/
会话持久化的可信写通道)时由主进程把该会话的 `directoryGrants` 解析并 `fs.realpath`
**规范化**(解符号链接,杜绝 `custom` 指向 symlink 越权——评审命中)后存入。

- `allowedRoots(sessionId?)`:除现有 promptRoot + documentsCortex + 项目根外,按 sessionId
  并入该会话注册表里的授权目录(已规范化的绝对路径)。
- 新增 IPC `shell:openablePathInfo({ path, sessionId? })` → `{ openable, isDirectory, reason? }`,
  统一判断文件**与目录**是否可打开(现有 `assertOpenable` 只放行真实**文件**,目录被拒)。
- **`shell:openPath` 签名扩展**(评审命中:现有 `openPath(path)` 无处带会话上下文):改为
  `openPath({ path, sessionId? })`,复用同一 `assertOpenable(path, sessionId)` 判定;同步更新
  bridge / preload / 所有现有调用点。
- 写/删仍走严格 `assertAllowed`(授权放宽只作用于打开/读取,沿用现有 openable vs allowed 二分)。

### KTD7. `auto` 逐轮解析,且实际档对用户可见

claude/codex 逐轮 fresh spawn(types.ts 注释)。`auto` 在每轮 spawn 按**当轮 prompt** 解析,
意味着同一 `auto` 会话会逐轮在 plan / accept-edits 间切换。这本身是 `auto` 的预期语义,但
**必须对用户可见**,否则「文件被意外改动」无从追因(评审命中):
- pill 在运行时显示解析出的实际档,如 `Auto → Edit automatically`。
- 该轮实际档随消息记入 transcript(start-of-stream 系统信息或消息级标记),便于事后核查。

确切呈现位置在 U6 定;**本 KTD 钉死「逐轮解析 + 可见」的语义**,不采「会话级锁定一次」。

---

## High-Level Technical Design

合成数据流(渲染端选择 → core 合成 → adapter 翻译):

```
 [Composer 两个 pill]                         会话级持久(SessionMeta / draft)
   Mode: plan|accept-edits|auto|       ─┐      permissionMode: PermissionMode("auto" 可入)
         full-auto                      │      directoryGrants: DirectoryGrant[]  (判别联合)
   目录: workspace|generated-images|   ─┤      (custom 的 dirs 内聚于 grant;无 customGrantDirs)
         custom|all-files               │
                                        ▼
                            ┌─────────────────────────────┐
                            │ core 合成层(装配 CliStart/  │
                            │ PiOpen 前)                  │
                            │  1. resolveEffectiveMode     │  auto → 具体档(逐轮,KTD7)
                            │     (mode, prompt)           │  → ConcretePermissionMode
                            │  2. resolveGrantDirs         │  grants → 绝对目录集
                            │     (grants, cwd, home)      │  (home 注入,KTD3)
                            │  3. clampByMode(mode, dirs)  │  plan → 只读;all-files gate
                            └──────────────┬──────────────┘
                       effectiveMode + writableDirs/readableDirs
                                           ▼
        ┌────────────────┬────────────────┬────────────────────────┐
        ▼                ▼                ▼                          ▼
  claude.buildArgs  codex.buildArgs  pi.buildArgs / pi-rpc     主进程会话授权注册表
   --permission-mode  -c sandbox_mode  --tools(plan) +          (KTD6:saveState 时
   + --add-dir        + --add-dir      derivePiCapabilities      realpath 规范化入册;
                                                                 allowedRoots(sessionId)
                                                                 据此放行打开/读取)
```

`auto` 关键词规则(U2,顺序判定,首个命中即返回):

```
resolveEffectiveMode(mode, prompt): ConcretePermissionMode
  if mode != "auto": return mode
  text = prompt.toLowerCase()
  // 命中策略须区分「祈使命令」与「关于动作的提问」:
  //   "修复这个 bug" → accept-edits;"如何修复这个 bug" / "解释怎么实现 X" → plan
  // 即:动作词前若有 如何/怎么/是否/能不能 等疑问引导,视为只读提问。
  if (无疑问引导) and matches(修复|实现|修改|fix|implement|edit|重构|...):
      return "accept-edits"
  else: return "plan"            // 普通问答/规划默认只读
  // 危险命令永不自动升 "full-auto"(KTD4 安全底线)
```

> 上为方向性示意,非实现规范;**确切关键词集合 + 疑问引导排除规则**在 U2 实现期定稿并以测试
> 钉死(含「如何/怎么 + 动作词 → plan」「裸祈使动作词 → accept-edits」对照用例)。

---

## Implementation Units

### U1. Core 类型与会话字段:`auto` 档 + `DirectoryGrant` 模型

**Goal**:落地统一 mode/目录授权的类型基座与会话持久字段。

**Requirements**:KTD1、KTD2、KTD3。

**Dependencies**:无。

**Files**:
- `packages/core/desktop/types.ts`(改):`PermissionMode` 增加 `"auto"`;新增
  `ConcretePermissionMode = Exclude<PermissionMode, "auto">`(KTD1);`PERMISSION_MODES`
  顺序加入 `auto`;新增判别联合 `DirectoryGrant`(KTD3:`workspace`/`generated-images`/
  `custom{dirs}`/`all-files`)、`DIRECTORY_GRANT_KINDS` 常量、`DEFAULT_DIRECTORY_GRANTS`
  (= `[{kind:"workspace"}]`);`SessionMeta` 增加 `directoryGrants?: DirectoryGrant[]`
  (**不**加 `customGrantDirs`——已内聚进 grant);`CliStartRequest` / `PiOpenRequest` 的
  `permissionMode` 下传字段收窄为 `ConcretePermissionMode`,并增加合成产物
  `writableExtraDirs?: string[]`、`readableExtraDirs?: string[]`(见 U4);更新 mode 段注释
  固化「内部值 ↔ UI 名」映射,并写明「`accept-edits` 永久=自动改文件,`ask-before-edits`
  未来用新值不回收本值」(KTD2)。
- `apps/desktop/src/main/ipc/types.ts`(改):镜像 `PermissionMode` 新值、
  `ConcretePermissionMode`、`DirectoryGrant`、新增会话字段与 `CliStartRequest` 合成字段
  (round-trip 持久,主进程不消费 mode 语义;但 KTD6 会消费 `directoryGrants` 入注册表)。
- `packages/core/index.ts`(改):导出 `DirectoryGrant`、`ConcretePermissionMode`、
  `DIRECTORY_GRANT_KINDS`、`DEFAULT_DIRECTORY_GRANTS` 等新符号。

**Approach**:纯类型 + 常量;不含逻辑。注意 `DEFAULT_PERMISSION_MODE` 仍为 `full-auto`
(存量回退不变)、`DEFAULT_NEW_SESSION_PERMISSION_MODE` 仍为 `plan`,`auto` 为显式可选档
不改默认。判别联合让 `custom` 的路径与「是否启用 custom」无法再各自悬空。

**Patterns to follow**:现有 `PermissionMode` / `PERMISSION_MODES` /
`DEFAULT_*_PERMISSION_MODE` 的声明与注释风格;`SummaryModelConfig` 既有判别联合(`kind` 标签)
的写法;types.ts ↔ ipc/types.ts 镜像约定。

**Test scenarios**:
- `DIRECTORY_GRANT_KINDS` 含四类且顺序稳定;`DEFAULT_DIRECTORY_GRANTS` 深等于
  `[{kind:"workspace"}]`。
- `PERMISSION_MODES` 含 `auto` 且 `plan`/`accept-edits`/`full-auto` 值未改名(防回归)。
- 类型层:`ConcretePermissionMode` 不含 `"auto"`(以 `// @ts-expect-error` 断言 auto 不可赋值)。
- Test expectation: 类型镜像一致性由下游单元的编译期保证,此处仅断言常量值与类型约束。

---

### U2. `auto` 解析:`resolveEffectiveMode` 纯函数

**Goal**:把 `auto` 档按 prompt 关键词派生为具体档。

**Requirements**:KTD1;Summary「auto 简单规则版」。

**Dependencies**:U1。

**Files**:
- `packages/core/personal/resolveMode.ts`(新):
  `resolveEffectiveMode(mode, prompt): ConcretePermissionMode`。
- `packages/core/personal/resolveMode.test.ts`(新)。
- `packages/core/index.ts`(改):导出。

**Approach**:见 HTD 伪码。非 `auto` 原样返回(类型已是 `ConcretePermissionMode`);`auto` 时
小写匹配「修复/实现/修改/重构」等中英关键词,但**先排除疑问引导**(动作词前有 如何/怎么/
是否/能不能 等 → 视为只读提问 → `plan`),裸祈使动作词命中 → `accept-edits`,否则 `plan`;
永不返回 `full-auto`。关键词集合 + 疑问引导词集合各为模块常量,便于演进与测试。

**Execution note**:test-first——先写关键词命中/疑问句不误升/危险词不升档的失败测试,再实现。

**Test scenarios**:
- `mode==="plan"|"accept-edits"|"full-auto"` 原样返回,prompt 不影响。
- `auto` + "修复登录 bug" / "实现导出功能" / "修改样式" → `accept-edits`。
- `auto` + "如何修复这个内存泄漏" / "解释怎么实现登录" → `plan`(疑问引导排除,评审命中)。
- `auto` + "解释这段代码" / "帮我规划方案" → `plan`。
- `auto` + 含危险词("rm -rf" 等)→ **不**返回 `full-auto`(返回 `plan` 或 `accept-edits`,按规则)。
- 空 prompt / 纯空白 → `plan`(安全默认)。

---

### U3. 目录授权解析:`resolveGrantDirs` + `clampByMode` 纯函数

**Goal**:把启用的授权类展开为绝对目录集,并按 mode 钳制读/写。

**Requirements**:KTD3、KTD4。

**Dependencies**:U1。

**Files**:
- `packages/core/personal/resolveGrants.ts`(新):`resolveGrantDirs(grants, cwd, home)`
  → `{ workspace: string | null; generatedImages: string[]; custom: string[]; allFiles: boolean }`;
  `clampByMode(mode, resolved)` → `{ writableExtraDirs: string[]; readableExtraDirs: string[] }`。
- `packages/core/personal/resolveGrants.test.ts`(新)。
- `packages/core/index.ts`(改):导出。

**Approach**:函数收 `home: string` 形参(KTD3——core 不读 `process.env`/`os`)。
`generated-images` 展开为 `<home>/.codex/generated_images` 与 app 媒体目录(逻辑绝对路径;
最终 `realpath` 规范化由主进程在入注册表时做,见 KTD6/U5,core 不碰 fs)。`custom` 取
`grant.dirs`。**空 grants 在函数内 fallback 到 `DEFAULT_DIRECTORY_GRANTS`**(与下方测试
「空 → workspace」对齐),故 `workspace` 在含 workspace 授权时恒有值。
钳制规则(KTD4):`plan` → 全部进 `readableExtraDirs`、`writableExtraDirs` 为空;
`accept-edits` → `workspace`+`custom`+`generated-images` 进 `writableExtraDirs`;
`full-auto` → `all-files` 为 `allFiles:true` 且不产 extraDirs(无需 add-dir,sandbox 已全开)。
注释标注 `generated-images` 当前为 codex 产物目录(KTD3)。

**Execution note**:test-first。

**Patterns to follow**:`core/personal/permissionMode.ts` 的纯函数 + 结构化返回风格。

**Test scenarios**:
- `[{kind:"workspace"}]` + plan → readable 含 cwd、writable 空。
- `[{kind:"workspace"},{kind:"generated-images"}]` + accept-edits → writable 含 cwd 与
  `<home>/.codex/generated_images`。
- `[{kind:"custom",dirs:["/a","/b"]}]` + accept-edits → writable 含 /a /b。
- `[{kind:"all-files"}]` + full-auto → allFiles=true、extraDirs 空。
- `[{kind:"all-files"}]` + plan/accept-edits → all-files 被忽略(非 full-auto 不放开),只按其余授权钳制。
- 空 grants(`[]` 或 undefined)→ 等价 `[{kind:"workspace"}]`(函数内 DEFAULT 兜底),workspace 有值。

---

### U4. Adapter 合成:目录参数下传 claude / codex / pi(+ pi-rpc)

**Goal**:把合成出的 `effectiveMode` + 可写/可读目录翻译进各 agent 真实启动参数。

**Requirements**:KTD1、KTD4、KTD5。

**Dependencies**:U1、U2、U3。

**Files**:
- `packages/core/personal/spawnAssembly.ts`(新,**先抽再加**):`messages.ts` 现已
  **2495 行,超 1200 上限 2 倍**(评审命中)——禁止再往里堆。先把 spawn 前装配
  `CliStartRequest`/`PiOpenRequest` 的逻辑抽到本新文件,再在此实现合成:调用
  `resolveEffectiveMode(mode, prompt)` 得具体档(`ConcretePermissionMode`)、
  `resolveGrantDirs(grants, cwd, home)`+`clampByMode` 得 `writableExtraDirs`/`readableExtraDirs`。
  `home` 经 `CoreProvider` 注入读取(KTD3)。
- `packages/core/personal/messages.ts`、`packages/core/personal/followup.ts`(改):改为调用
  `spawnAssembly`;**逐轮**解析 `auto`(KTD7,每轮用当轮 prompt)。
- `packages/core/provider.tsx` 与 `core/desktop` 注入契约(改):`CoreProvider` 接收并暴露
  `home`(壳侧 app init 经一次 IPC 取 `os.homedir()`)。
- `apps/desktop/src/main/agents/claude.ts`(改):可写目录 → `--add-dir <dir>` 逐个追加。
- `apps/desktop/src/main/agents/codex.ts`(改):可写目录 → `--add-dir`/`-c` writable_roots
  (实现期实测确认,exec 与 exec resume 两分支通用,沿用现有 `-c` 经验)。
- `apps/desktop/src/main/agents/pi.ts`(改):pi 单发按能力——无对应可写 flag 时不伪造,
  额外目录交由 app 侧可读/可打开兜底。
- `packages/core/personal/permissionMode.ts`(改,如需):pi-rpc `derivePiCapabilities`
  接受具体档(`auto` 已在合成层解析,不会到此)。
- 对应 `*.test.ts`(改):`claude.test.ts`、`codex.test.ts`、`pi.test.ts`、
  `permissionMode` 相关测试。

**Approach**:adapter 仍只读 `req.permissionMode` 的**具体档**(`auto` 不会到 adapter,
KTD1);新增读 `req.writableExtraDirs` 追加 `--add-dir`。不改现有三档 → 原生标志翻译。
`plan` 档不追加可写目录(KTD4)。

**Execution note**:adapter 改动 test-first——先加「带 extraDirs 时 args 含 --add-dir」
「plan 档不含 --add-dir」失败测试。

**Patterns to follow**:claude.ts/codex.ts 现有 `mode → flag` 分支与 args 拼装;
codex「`-c` 两分支通用、resume 不吃 `-s`」的既有踩坑注释。

**Test scenarios**:
- claude:`writableExtraDirs=["/a","/b"]` → args 含 `--add-dir /a --add-dir /b`;空则不含。
- claude:plan 档即便有 grants 也不出现可写目录(由合成层 clamp 保证,断言 args)。
- codex:exec 与 exec resume 两分支都正确带上目录扩展参数。
- pi:无可写 flag 时 args 不含伪造 sandbox 参数(回归保护)。
- 合成层(messages/followup):`mode="auto"` 下传到 adapter 的 `permissionMode` 已是具体档。
- Covers KTD4:`full-auto`+`all-files` 不追加 `--add-dir`(no-op)。

---

### U5. IPC / 主进程:会话授权注册表 + `openablePathInfo` + `openPath` 扩签

**Goal**:统一 app 侧目录/文件可打开判定,以**主进程自有**授权注册表(非渲染端声明)放行
授权目录(含 `generated_images` 目录本身)。

**Requirements**:KTD6(安全:真相源在主进程)。

**Dependencies**:U1。

**Files**:
- `apps/desktop/src/main/ipc/grantsRegistry.ts`(新):主进程「会话 → 已规范化授权目录」
  注册表。在会话创建/更新的可信写通道(随 `saveState`/会话持久化)由主进程解析该会话
  `directoryGrants`、`fs.realpath` 规范化(解符号链接,杜绝 custom 指向 symlink 越权)后入册;
  会话删除时清册。
- `apps/desktop/src/main/ipc/fs.ts`(改):`allowedRoots(sessionId?)` 并入注册表里该会话的
  授权目录;`assertOpenable(path, sessionId?)` 扩展为放行授权根内的**目录**(现仅放行真实文件);
  新增 IPC `shell:openablePathInfo({ path, sessionId? })`;**`shell:openPath` 改签为
  `{ path, sessionId? }`** 并复用同判定。
- `apps/desktop/src/main/ipc/types.ts`(改):`openablePathInfo` / 改签后的 `openPath` 请求·响应类型。
- `apps/desktop/src/preload/index.ts`(改):`window.desktopAPI.personal` 暴露 `openablePathInfo`、
  更新 `openPath` 形状。
- `packages/core/desktop/bridge.ts` + `types.ts`(改):`DesktopBridge` 增加 `openablePathInfo?`、
  `openPath` 签名带可选 sessionId;响应类型。
- **`openPath` 现有调用点**(改):全仓搜 `bridge.openPath(`/`shell:openPath` 调用,传 sessionId
  (聊天内联图片/文件预览工具栏等,会话上下文可得处传入;无会话上下文处传 undefined,退化为
  现有「真实文件即放行」语义)。
- `apps/desktop/src/main/ipc/fs.test.ts`、`grantsRegistry.test.ts`(新/改)。

**Approach**:**安全底线(KTD6)**:渲染端只传 `sessionId`(查表 key),**绝不**传授权目录;
主进程拿注册表里自己规范化过的目录做 `isInside` 判定。写/删仍走严格 `assertAllowed`(授权放宽
只作用于打开/读取)。`generated_images` 图片**文件**当前已因 `assertOpenable` 放行真实文件而可
点开;本单元新增的是**目录**可打开 + 授权目录可读扩展 + 主进程真相源 + 统一查询接口。

**Patterns to follow**:`fs.ts` 现有 `assertAllowed`/`assertOpenable`/`allowedRoots` 二分与
`getPersistedState()`(主进程拥有态)的可信读取范式;`shell:openPath`/`shell:revealInFolder`
handler 形态;preload contextBridge 约定。

**Test scenarios**:
- 注册表:`saveState` 含 custom symlink 目录 → 入册的是 `realpath` 后的真实目标(防 symlink 越权)。
- `openablePathInfo({path: 授权根内目录, sessionId})` → `{ openable:true, isDirectory:true }`。
- 对项目外、未授权、不存在路径 → `{ openable:false }` 且不抛。
- `~/.codex/generated_images` 目录(该会话授权 generated-images 时)→ openable。
- 写操作目标在授权目录但 mode=plan → `assertAllowed` 仍拒(授权不破 mode,回归保护)。
- **安全回归**:渲染端无法仅凭传参打开未授权路径——`openablePathInfo` 不接收目录列表入参,
  注册表里无 `/Users/x/.ssh` 则该路径恒 `openable:false`。
- `openPath` 复用同判定:授权目录可开、未授权项目外目录拒;旧调用(无 sessionId)行为不变。

---

### U6. UI:Composer 两个 pill + GitBar 移除 mode + i18n

**Goal**:把 mode 从 GitBar 移到 Composer,新增目录授权 pill,接好会话级状态。

**Requirements**:Summary「UI 两个 pill」;KTD2、KTD4。

**Dependencies**:U1(字段)、U3(授权语义,用于置灰规则)。

**Files**:
- `packages/views/cortex-desktop/personal/GitBar.tsx`(改):移除 mode `<select>` 与
  `onChangeMode`/`permissionMode` props 及 `PERMISSION_MODE_HINT_KEY`。
- `packages/views/cortex-desktop/personal/ModePill.tsx`(新):Mode pill(4 档:含 auto;
  hint tooltip;disabled when running)。mode=`auto` 且运行中时显示解析出的实际档,如
  `Auto → Edit automatically`(KTD7)。
- `packages/views/cortex-desktop/personal/DirectoryGrantPill.tsx`(新):目录授权 pill。
  **disabled when running**(与 ModePill 一致——运行中改授权不影响已 spawn 的本轮,会误导)。
  交互规格(评审命中,逐条钉死):
  - **折叠标签**:首个授权短名 + 多于一个时 ` +N`(仿 model pill 显示当前值);仅默认
    workspace 时显示工作区名。
  - **自定义目录**:经原生目录选择器(复用既有 open-dialog IPC)添加;每个 custom 目录在下拉里
    渲染为可删 chip(× 移除);路径若已落在某 workspace 根内 → 去重提示不静默加;上限 5,超出 toast。
  - **`all-files`**:仅 mode=`full-auto` 可勾;首次启用弹一次确认(全盘读写警示,KTD4);激活时
    pill 常驻警示样式。mode 切走 full-auto → all-files 显示「置灰且仍勾选」(期望态记录,KTD4),
    不从 `directoryGrants` 删除。
  - **降级映射提示**:挂在受影响的授权 chip 上的 ⚠ tooltip(非独立 banner)。**按 agent 列条件**:
    pi + (`custom`/`generated-images`)→「Pi 无法写入额外目录,仅 app 侧可读/打开」;codex/claude
    精确组合不支持时同理标注。提示串入 i18n(见下),不留空键。
- `packages/views/cortex-desktop/personal/PersonalChatArea.tsx`(改):会话页把两 pill 接到
  `session.permissionMode` / `session.directoryGrants`,`onChange` → `updateSession`;auto 运行中
  把解析出的实际档透传给 ModePill 并随消息记入 transcript(KTD7)。
- `packages/views/cortex-desktop/personal/NewSessionLanding.tsx`(改):新会话草稿接两 pill;
  `draft.directoryGrants` 默认 `[{kind:"workspace"}]`;落地时非默认才写入 patch(沿用现有
  permissionMode patch 模式)。
- **两 pill DOM 位置**(评审命中:ComposerShell 是「纯输入壳」,不塞布局):由
  `PersonalChatArea`/`NewSessionLanding` 各自渲染一个 `<div className="pw-composer-pills-bar">`
  含 ModePill + DirectoryGrantPill,置于 `ComposerShell` 之上、`.composer-wrap` 之外;
  **ComposerShell 不新增布局插槽**。
- i18n(按 KTD2):`packages/core/i18n/resources/zh-Hans/chat.json` 既有中文名
  `自动改文件`/`全自动`/`Plan · 只读` 与 `*Hint` **沿用不动**;`en/chat.json` 把
  `accept-edits`/`full-auto` 英文改名至 `Edit automatically`/`Bypass permissions`;
  两 locale **新增** `auto`(自动 / Auto)+ `autoHint`;新增 `directoryGrant.*`
  (label、四类名、各 hint、降级提示串、all-files 置灰原因、all-files 启用确认文案)。
- `packages/core/i18n/@types/resources.d.ts`(改,如自动生成则跑生成)。
  ⚠ memory `i18n-extract-ci-gotcha`:只提交本次新增/改动键,**不**提交 extract 全量规范化输出。
- 对应测试:`GitBar.test.tsx`(删 mode 断言)、`ModePill.test.tsx`(新)、
  `DirectoryGrantPill.test.tsx`(新)、`NewSessionLanding`/`PersonalChatArea` 相关。

**Approach**:pill 视觉复用现有 `pw-model-pill`/`pw-model-select` 风格(与最近合入的
「图片/附件合并按钮」「思考强度选择」一致的 Composer pill 范式)。注意 CLAUDE.md 记录的
**未分层 button reset 坑**:pill 内若用 `<button>` 需用未分层 `wf-*` 类绕过
`cortex-desktop.css` 的恒胜 reset(见 memory `cortex-css-unlayered-button-reset`)。

**Patterns to follow**:GitBar 现有 pill + `<select>` + tooltip(`title`)结构;
NewSessionLanding draft → patch 落地模式;i18n `composer.permissionMode.*` 键风格。

**Test scenarios**:
- ModePill 渲染 4 档(标识符 `plan`/`accept-edits`/`auto`/`full-auto`,显示名
  `Plan`/`Edit automatically`/`Auto`/`Bypass permissions`),选择回调透传具体值。
- ModePill:mode=`auto` + running + 解析出 accept-edits → 显示 `Auto → Edit automatically`(KTD7)。
- DirectoryGrantPill:`all-files` 在非 `full-auto` 下置灰;mode=full-auto 下可勾且首次弹确认。
- DirectoryGrantPill:full-auto+all-files 勾选后切到 plan → all-files 仍勾选但置灰(期望态记录,KTD4)。
- DirectoryGrantPill:经目录选择器添加 custom → grant `{kind:"custom",dirs:[...]}` 更新;chip × 可删;
  超 5 个 toast;落在 workspace 内给去重提示。
- DirectoryGrantPill:多授权折叠标签为「首项名 +N」;agent=pi 时 custom chip 带降级 ⚠ tooltip。
- DirectoryGrantPill + ModePill:`running` 时均禁用交互。
- GitBar 不再渲染 mode 入口(回归)。
- NewSessionLanding:默认 `directoryGrants=[{kind:"workspace"}]`;改为非默认时进 createSession patch。
- 会话页改 mode/grants → `updateSession` 收到对应字段。

---

### U7. ModeBlockBanner 与文案对齐(收尾)

**Goal**:工具被拦的「切档重发」横幅与新 4 档/目录授权文案一致。

**Requirements**:KTD2;不破坏现有「切档重发」体验。

**Dependencies**:U1、U6。

**Files**:
- `packages/views/cortex-desktop/personal/ModeBlockBanner.tsx`(改):目标档集合按新文案
  渲染(`accept-edits`/`full-auto` 仍是内部值,显示名走新 i18n)。
  (横幅内「目录授权」入口超出本轮确认范围,见 Deferred,不在此加。)
- `packages/views/cortex-desktop/personal/ModeBlockBanner.test.tsx`(改)。
- `packages/core/store/personal.ts`(改,如需):`fromMode` 相关切档逻辑兼容 `auto`
  (横幅切档应落到具体档,不落 `auto`)。

**Approach**:最小改动——横幅本质未变,仅显示名与 `auto` 不作为切档目标(切档给具体档)。

**Test scenarios**:
- edit 类被拦 → 建议切到 `accept-edits`/`full-auto`(显示新名),不建议 `auto`。
- 横幅切档触发重发,字段写入具体档。
- Covers KTD2:UI 显示新名而 store 写入旧内部值。

---

## Scope Boundaries

**本轮交付**:`auto` 档(关键词规则)、`DirectoryGrant` 模型与全量合成(launch 参数 +
app 打开)、Composer 两 pill、GitBar 去 mode、`openablePathInfo`、三 adapter 目录参数、
i18n 改名。

### Deferred to Follow-Up Work
- `ask-before-edits` 档(待 claude/codex 接入交互审批回路;届时用**新**内部值,不回收 `accept-edits`,见 KTD2)。
- `auto` 的 LLM 级意图分类(本轮仅关键词 + 疑问引导排除规则)。
- pi 的 agent 级可写目录扩展(若 pi 无原生能力,本轮以 app 侧可读/可打开兜底)。
- 目录授权的跨会话默认偏好持久(本轮按会话/草稿粒度)。
- ModeBlockBanner 内的「目录授权」直达入口(本轮横幅仅做显示名对齐)。
- `generated-images` 扩展到 claude/pi 各自产图目录(本轮仅 codex `~/.codex/generated_images`)。

### 非目标(Out of scope)
- 目录内图库预览。
- 危险命令自动升 `full-auto`(安全底线,永不做)。

---

## Risks & Dependencies

- **codex / pi 精确目录 flag 不确定**(KTD5):codex exec/resume 的可写目录 flag、pi 的目录
  能力需实现期 `--help` 实测;不支持的精确组合按方案显示「降级映射」,不伪造 sandbox。
  缓解:U4 先实测再写翻译,测试钉死。
- **授权目录安全边界**(KTD6,已定):真相源在主进程注册表,渲染端只传 sessionId、绝不传目录;
  custom 路径入册前 `realpath` 规范化防 symlink 越权;写/删仍严格 `assertAllowed`。
- **home 注入链**(KTD3):core 不读 `process.env`/`os`,home 经主进程 IPC → CoreProvider 注入。
  缓解:U4 落地注入链;未注入时 `generated-images` 展开降级为空(不崩)。
- **`shell:openPath` 改签波及现有调用点**(U5):改为带可选 sessionId 的对象入参,需全仓改调用。
  缓解:无 sessionId 时退化为现有「真实文件即放行」语义,旧调用不回归。
- **`messages.ts` 已超行数上限**:U4 必须**先抽** `spawnAssembly.ts` 再加逻辑,不得直接堆进 messages.ts。
- **i18n extract 全量规范化坑**(memory `i18n-extract-ci-gotcha`):新增 i18n key 会触发
  extract 全量规范化;**不要**提交规范化的全量输出,只提交本次新增/改动键。i18n-check 非阻断。
- **未分层 button reset 坑**(memory `cortex-css-unlayered-button-reset`):pill 内 `<button>`
  样式需用未分层 `wf-*` 类绕过。
- **单文件 1200 行上限**:GitBar.tsx / ComposerShell.tsx 改动注意拆分,新 pill 独立成文件。

---

## Verification

- `pnpm --filter @cortex-work/core test`、`pnpm --filter @cortex-work/desktop test`、
  `pnpm --filter @cortex-work/views test` 全绿(含本计划新增测试)。
- `pnpm typecheck`、`pnpm lint` 通过。
- 手验:
  - 新会话默认 `plan` + `目录: 工作区`;切 `auto`,发「修复 X」→ 实际按 accept-edits 跑、
    发「解释 X」→ 只读。
  - 授权 `generated-images` 后,点开 `~/.codex/generated_images` **目录**可打开;mode=plan
    时该目录不可写。
  - `all-files` 仅在 `bypass`(full-auto)下可选。
  - GitBar 不再有 mode 入口;两 pill 在 Composer 上方。
