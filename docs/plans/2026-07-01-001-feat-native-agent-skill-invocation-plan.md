# feat: claude/codex 的 skill 调用改为各自原生机制,退掉统一改写文案

## Summary

`/skill:<name>` 触发单个 skill 时,claude 与 codex 目前都被 cortex 统一改写成一段「请用 Read
工具打开 SKILL.md 再执行」的通用 prose 文案,并不使用两者各自真正拥有的原生 skill 机制。已实测
verified:claude CLI 在本应用现用的 headless(`-p` + stdin stream-json)调用方式下,把 skill 放在
项目级 `.claude/skills/<name>/` 时,原生 `/<skill-name>` 展开确实可用;但本 plan 实际要用的
「桥接目录 + `--add-dir` + symlink」发现路径**尚未独立实测**,是基于官方文档描述的假设,U1
落地前需要先做一次窄口径验证(见 U1 Approach)。codex 的 app-server(WebSocket)交互路径确认有
原生的 `skill` input item 可显式触发(字段名待用 `generate-json-schema` 核实)。本 plan 把 claude
切换为「目录桥接 + 原生 slash 展开」,把 codex 的主交互路径切换为「app-server 原生 skill 触发」,
codex 的非 ws(`codex exec`,如委派场景)路径保留现有 prose 回退。pi 不受影响(已是原生 `--skill`
机制)。

## Problem Frame

commit `ba12efe`(feat(skills): claude/codex 支持 slash 指令调用 skill)放开了 claude/codex 的
`/skill:<name>` 触发,但当年判断「claude/codex 无法消费 `/skill:name`」——这个前提已被证明不成立:

- claude CLI 原生支持 `/<skill-name>`(裸名字,无前缀)展开,且该展开发生在**送模型之前的输入层**,
  在本应用现用的 `-p --input-format stream-json`(stdin 投喂一条 user message 后 EOF)调用方式下
  同样生效——**这一点已用应用的确切命令行实测验证,但实测覆盖的是「skill 直接放在项目
  `.claude/skills/<name>/` 下」这一种发现路径**。触发前提:不传 `--disable-slash-commands`/
  `--bare`,且 skill 目录能被 claude 发现。官方文档另说明 `--add-dir <dir>` 会让该目录下的
  `.claude/skills/` 被自动加载——**这是本 plan(U1)实际要用的桥接方式(临时目录 + 指向真实 skill
  目录的 symlink),但这条路径本身、以及 claude 是否会跟随 symlink 读到 target 目录里的
  SKILL.md,尚未被独立实测,只是基于文档描述的假设**(见 U1 Approach 的验证步骤与 Open
  Questions)。
- codex 存在原生「Agent Skills」机制(取代已废弃的 custom prompts/TUI slash)。`codex app-server`
  (本应用主交互会话使用的 WebSocket 传输)的 `turn/start` RPC 接受显式的 `skill` input item
  (`name`+`path`),服务端据此注入完整 skill 指令,不依赖 codex 自己的目录发现。但 `codex exec`
  (非交互一次性调用,委派/delegate 场景会退回这条路径)下 `/name` 只会被当纯文本(已有社区 issue
  实测佐证),没有等价结构化触发点。

现状问题:cortex 现在的实现把这两个本可以原生完成的能力,都用同一套「改写成通用 Read 指令」的
文案代劳——不仅放弃了 claude 自身已经做好的 skill 加载/展开/命名空间处理,claude 那侧还主动传
`--disable-slash-commands`(其官方定义是 "Disable all skills")关掉了自己的原生能力。**需要
明确说明**:现状 prose 机制目前是「能用」的(用户已经能通过它调用 skill),本次改动的收益主要是
**保真度**(fidelity)——用 agent 自己的加载/命名空间/参数处理逻辑取代 cortex 自造的一份简化版,
而不是修复一个当前会报错或产出错误结果的 bug。是否值得为此多维护 claude/codex 两条分裂路径,
是本 plan 明确要做的取舍,不是无成本的纯收益。

## Requirements

- **R1**:claude 会话中已启用的 skill 被 `/skill:<name>` 触发时,应经 claude CLI 自身原生的
  Skill 加载/执行机制完成,不再由 cortex 改写成「请自行 Read 文件」的 prose 指令。
- **R2**:codex 主交互会话(app-server ws 传输、无委派角色)中已启用的 skill 被 `/skill:<name>`
  触发时,应经 `turn/start` 的原生 `skill` input item 显式触发。
- **R3**:codex 会话因委派(`delegateRoles` 非空)等原因退回 `codex exec`(非 ws)传输时,维持现有
  的 prose 改写回退,不出现功能倒退。
- **R4**:pi 会话的现有原生 `--skill` 机制不受影响。
- **R5**:claude 侧现有的批量 prose 系统提示注入(`renderSkillBlock` → `appendSystemPrompt`)在
  `useOwnSkills` 开启**且走单发(`bridge.startCli`)路径**时下线,由原生目录发现取代;圆桌编排
  (`bridge.startOrchestration`)路径继续保留 `renderSkillBlock` 批量注入不变(见 Scope
  Boundaries)。codex 侧的批量注入两条路径都保持不变(codex 未做目录桥接,没有等价的免费自动
  发现)。
- **R6**:skill frontmatter 的 `supportedAgents` 过滤规则对两条新路径继续生效。
- **R7**:claude 原生调用名(桥接目录名)与 UI/registry 展示的 skill 名字保持一致,避免「菜单显示
  的名字」与「claude 实际认得的命令名」不一致导致的调用落空。

## Key Technical Decisions

**KTD1:claude 走「目录桥接 + 原生文本展开」,不引入结构化字段。**
研究实测证明 claude 的展开完全发生在 CLI 输入层,cortex 唯一要做的是(a)让 claude 发现到已启用
skill 目录(经 `--add-dir` 桥接),(b)把 UI 的 `/skill:<name>` 语法转成 claude 认得的裸
`/<name>`。不需要经 IPC 传递「选中了哪个 skill」这类结构化信息——claude 自己处理加载与执行。

**KTD2:codex 按 transport 分裂处理,ws 走结构化触发、exec 走 prose 回退;不对 codex 做
claude 式的目录桥接。**
根因是 claude 与 codex 在「slash 展开发生在哪一层」上有本质能力差异:claude 的 `/<name>` 展开
发生在 **CLI 输入层**,不管 headless 还是交互式都生效;codex 的 slash 语法只在**交互式 TUI 的
输入预处理层**生效,`codex exec` 一律把 `/name` 当纯文本(已有 GitHub issue #3641 实测佐证)。
这意味着即便照 claude 的方式给 codex 也做一份目录桥接(桥接到 `.codex/skills` 或等价路径),
`codex exec` 场景依然没有输入层去做 slash→内容 的替换,桥接对 exec 无意义;而 ws 的 `skill`
input item 本身就带 `path`,也不需要目录桥接才能定位 skill。所以「不对 codex 做目录桥接」不是
偷懒省略,而是能力差异决定的——ws 走结构化触发、exec 走 prose 回退,是两条 transport 各自唯一
已验证可行的路径。

**KTD3:claude 桥接目录以 `skill.name`(而非原始目录 basename)命名 symlink,且该命名规则必须
对齐 claude 自己的命令名派生算法。**
registry 允许 frontmatter `name` 与目录名不一致。若桥接用原始目录名,用户在菜单里看到的
`/skill:<name>` 会跟 claude 实际认得的 `/<目录名>` 不一致,出现「点了却没用」。桥接层统一用
`skill.name` 作为 symlink 目录名——但「清洗成合法目录名」这一步必须先实测确认 claude 自己怎么把
目录名转成 slash 命令名(是否做大小写/空格归一化),再让 cortex 的清洗规则复现同一算法,而不是
独立发明一套「安全但不保证与 claude 一致」的规则(U1 已补验证步骤)。symlink 的**目标**(`record.dir`)
也需要限制在已知 skill 根目录内(builtin/userData/已授信插件根/已授信工作区根),不做额外的目录
穿越暴露(见 Risks 的 security 记录)。

**KTD4:`--disable-slash-commands` 的开关语义不变,仍由 `useOwnSkills` 唯一控制;`--add-dir`
只在开启分支追加。**
不把「启用原生 skill」和「该 CLI 参数的其它副作用范围」混为一谈,也不扩大影响面到未使用这个开关
的其它调用点(oneshot/ask/automation 等)。`useOwnSkills !== true` 时行为与现状完全一致。

**KTD5:桥接目录构建放在 `apps/desktop/src/main/ipc/cli.ts` 的 `cli:start` handler 内、
`buildArgs` 之前,复用 `applyClaudeMcp` 已验证的「主进程内部填充字段」模式。**
与现有 MCP 注入架构保持一致(`skillsBridgeDir` 类比 `piExtensionPath`),`buildArgs` 保持纯函数、
不做文件系统副作用,失败时降级为不追加 `--add-dir`(不阻断发送),对齐 `applyClaudeMcp` 的降级
风格。

## High-Level Technical Design

```mermaid
flowchart TD
    A["用户在 composer 输入 /skill:name args"] --> B{"PersonalChatArea.tsx onSend<br/>按 session.agent 分支"}
    B -->|pi| C["原样透传<br/>(pi CLI 自行原生展开,不变)"]
    B -->|claude| D["转成裸 slash:<br/>/&lt;sanitized skill.name&gt; args"]
    B -->|codex| E["设置 req.invokedSkill = {name, path}<br/>文本部分保留 args"]

    D --> F["cli.ts: cli:start handler"]
    E --> F

    F --> G{"agent === claude?"}
    G -->|是| H["构建/刷新 skillsBridgeDir<br/>(.claude/skills/&lt;name&gt;/ symlink)"]
    H --> I["claude.ts buildArgs:<br/>--add-dir &lt;skillsBridgeDir&gt;"]
    I --> J["spawn claude -p ...<br/>claude 自己展开 /&lt;name&gt; 并执行 SKILL.md"]

    G -->|否,codex| K{"transport===ws &&<br/>无 delegateRoles?"}
    K -->|是| L["startCodexWsRun →<br/>buildTurnInput 附加<br/>{type:'skill', name, path}"]
    L --> M["app-server turn/start<br/>原生注入 skill 指令"]
    K -->|否(委派等)| N["渲染 prose 回退<br/>(现有 renderSkillInvocation)<br/>并入 prompt"]
    N --> O["codex.ts buildArgs → codex exec"]
```

上图覆盖的是主聊天 composer 单发路径(`bridge.startCli` → `cli:start` handler)。圆桌编排
(`subagentOrchestration` → `bridge.startOrchestration` → `orchestrate.ts` 的 `runStage`)
是完全独立的一条 IPC 路径,不经过 `cli:start`,因此不在上图范围内——见 Scope Boundaries。

## Implementation Units

### Phase A:主进程原生能力接线(U1-U4)

### U1. claude skill 桥接目录构建模块

**Goal**:新增主进程模块,把「当前已启用的 skill 记录」物化成 claude CLI 能原生发现的目录结构。

**Requirements**:R1、R7

**Dependencies**:无

**Files**:
- `apps/desktop/src/main/skills/claude-bridge.ts`(新增)
- `apps/desktop/src/main/skills/claude-bridge.test.ts`(新增)

**Approach**:
- **实现前置验证(spike,阻塞性)**:先用应用现用的确切命令行做一次窄口径验证——`--add-dir` 指向
  一个临时根目录,该根目录下 `.claude/skills/<name>/` 是指向真实 skill 目录(如
  `resources/skills/<name>` 或 `userData/skills/<name>`)的 symlink,确认 (a) claude 确实自动
  加载了这个附加目录下的 `.claude/skills/`,(b) claude 会跟随 symlink 读到 target 目录里的
  `SKILL.md` 及其 `references/`/`scripts/` 等附属文件。通过再进入本单元其余实现;若 symlink 不被
  跟随,改为直接把 skill 内容拷贝进桥接目录(见 Risks)。
- 导出 `buildClaudeSkillBridge(records: InjectableSkill[], bridgeRootDir: string): string | undefined`。
- 空 `records` → 返回 `undefined`(不建目录、无需 `--add-dir`)。
- 非空时:清空 `<bridgeRootDir>/.claude/skills/` 下的旧内容,为每条记录在该目录下建一个 symlink,
  指向 `record.dir`,返回 `bridgeRootDir`。
- **命令名对齐(R7,需先验证再实现)**:symlink 目录名必须与 claude 自己派生 slash 命令名的算法
  完全一致,而不是 cortex 独立发明一套"安全但不保证一致"的清洗规则——claude 官方文档只说明调用名
  取自目录名,但是否会话大小写/空格做进一步归一化(如小写化、空格转连字符)未逐条验证。实现前需
  用一个含空格/大小写的 skill name 做一次实测,确认 claude 实际识别的命令名,再让 symlink 命名
  严格复现该算法(而不是先定义一套 sanitize 规则再假设两者一致)。
- 名字清洗除了对齐 claude 的算法外,还要满足文件系统安全:去除路径分隔符、`..`、控制字符。
- **同批次内的名字碰撞**:两个不同 `record.name` 经清洗/归一化后可能落到同一个目录名(如
  `my/skill` 与 `my-skill`)。建链时检测目标目录名是否已被本批次占用,冲突时对后到的记录追加基于
  原始 `name` 的短 hash 后缀消歧,避免 symlink 互相覆盖导致用户点了一个 skill、claude 却执行了
  另一个。
- 单条记录建链失败(如目标已被删除)只跳过该条,不中断其余,不抛出未捕获异常(对齐现有降级风格)。

**Patterns to follow**:`apps/desktop/src/main/skills/locate.ts`(目录定位风格)、
`apps/desktop/src/main/ipc/mcp-config.ts` 的 `applyClaudeMcp`(落盘 + 降级风格)。

**Test scenarios**:
- 给定 2 条记录 → 桥接目录下存在两个对应命名的 symlink,各自指向正确的 `dir`。
- 空数组 → 返回 `undefined`,不创建任何目录。
- `name` 含 `/`、`..`、空格等 → 落地为安全的目录名,不越权、不与其它记录冲突。
- 两条不同 `name` 经清洗/归一化后落到同一个目录名 → 各自建链且不互相覆盖(消歧后缀生效)。
- 目标目录不存在(skill 被手动删除)→ 该条跳过,其余记录仍正确建链,函数正常返回。
- 重复调用(模拟上一轮遗留的旧 skill 集合)→ 旧 symlink 被清空,只保留本轮记录对应的链接。

**Verification**:上述 spike 验证通过后,单测覆盖以上场景;在应用内对一个真实项目开启
`useOwnSkills` 后,检查生成的桥接目录内容与符号链接目标是否正确,并实测一个含空格/大小写的
skill name 确认菜单显示名与 claude 实际响应的命令名一致(R7)。

---

### U2. `CliStartRequest` 类型扩展 + `cli.ts` 接入桥接构建时机

**Goal**:让主进程在 `cli:start` handler 里,于 `buildArgs` 之前算好 `skillsBridgeDir`
(claude)与承接 `invokedSkill`(codex,供 U4 使用)。

**Requirements**:R1、R2、R5

**Dependencies**:U1

**Files**:
- `apps/desktop/src/main/ipc/types.ts`(`CliStartRequest` 补 `skillRecords?: InjectableSkill[]`
  渲染端填充字段、`skillsBridgeDir?: string` 主进程内部填充字段、`invokedSkill?: { name: string;
  path: string }` 渲染端填充字段)
- `packages/core/desktop/types.ts`(镜像补同三个字段,对齐 `piExtensionPath` 现有镜像惯例)
- `packages/core/personal/messages.ts`(claude 单发分支:`resolveEnabledSkillRecords` 的结果不再
  只用于渲染 `skillBlock`,同时把这份记录塞进 `bridge.startCli` 请求的 `skillRecords` 字段——
  main 进程没有 `usePersonalStore`/`DesktopBridge`,拿不到这份数据,必须由渲染端算好传过去)
- `apps/desktop/src/main/ipc/cli.ts`(`cli:start` handler 内,MCP 注入之后、`buildArgs`/ws 分流
  判断之前,读 `req.skillRecords` 调用 `buildClaudeSkillBridge`,写入 `req.skillsBridgeDir`)

**Approach**:
- **数据流(修正关键澄清)**:`resolveEnabledSkillRecords` 是渲染端纯函数(依赖
  `usePersonalStore`/`DesktopBridge`),main 进程无法直接调用它。渲染端(`messages.ts` 单发分支)
  已经在算这份记录用于旧的 `skillBlock` 渲染——本次改动让它**同时**把这份 `InjectableSkill[]`
  写进请求的 `skillRecords` 字段发给 main,main 侧 `cli.ts` 只负责按 `skillRecords` 建桥接目录,
  不重新解析。
- 仅当 `req.agent === "claude"` 且 `req.useOwnSkills === true` 且 `req.skillRecords` 非空时才
  构建桥接目录(对齐 KTD4 的开关语义,不影响 codex/pi 及未使用该开关的调用点)。
- 桥接根目录用一个确定性、每次覆盖重建的路径(如 `userData/skill-bridge/<sessionId>/`),避免
  跨会话堆积;具体生命周期/清理策略留给实现阶段决定(不在 plan 里预先钉死)。
- 构建失败(如权限问题)只 warn,不阻断发送,`req.skillsBridgeDir` 保持 `undefined`。

**Patterns to follow**:同文件内 `applyClaudeMcp` 调用点的位置与降级写法(`cli.ts` 现有 MCP 注入
段落);`req.images`/`req.appendSystemPrompt` 等渲染端填充字段的现有惯例(数据在渲染端算好,
随请求传给 main,main 侧只消费不重算)。

**Test scenarios**:
- `useOwnSkills===true` 且 `req.skillRecords` 非空 → `buildArgs` 前 `req.skillsBridgeDir` 被设为
  桥接目录路径。
- `useOwnSkills!==true` → 不构建桥接目录,`req.skillsBridgeDir` 保持 `undefined`。
- `agent !== "claude"` → 不触发桥接构建逻辑。
- `req.skillRecords` 为空数组/`undefined` → 不构建桥接目录(无需 `--add-dir`)。
- 桥接构建过程抛错 → 仅 warn,继续正常发送流程,不阻断。

**Verification**:单测覆盖 handler 内的分支逻辑(可仿 `cli.test.ts` 现有对 MCP 注入分支的测试
写法)。

---

### U3. `claude.ts` buildArgs 接入原生调用

**Goal**:让 `claude.ts` 的 `buildArgs` 在开启原生 skill 时追加 `--add-dir`,并保持
`--disable-slash-commands` 的既有开关语义不变。

**Requirements**:R1、R4(不影响 pi,此单元只动 claude adapter)

**Dependencies**:U2

**Files**:
- `apps/desktop/src/main/agents/claude.ts`
- `apps/desktop/src/main/agents/claude.test.ts`

**Approach**:
- 保留现有 `if (req.useOwnSkills !== true) args.push("--disable-slash-commands")` 不变。
- 新增:`if (req.useOwnSkills === true && req.skillsBridgeDir) args.push("--add-dir", req.skillsBridgeDir)`。
- 不新增任何 skill 相关的 prompt 文本处理——claude 的原生展开发生在 CLI 内部,`buildArgs` 不需要
  关心 prompt 文本里的 `/<name>`。

**Patterns to follow**:同文件内 `--append-system-prompt`/`--model` 等条件式 push 的现有写法。

**Test scenarios**:
- `useOwnSkills===true` 且 `skillsBridgeDir` 有值 → args 含 `--add-dir <dir>`,不含
  `--disable-slash-commands`。
- `useOwnSkills!==true` → args 含 `--disable-slash-commands`,不含 `--add-dir`(回归现状,防止
  本次改动引入退化)。
- `useOwnSkills===true` 但 `skillsBridgeDir` 为 `undefined`(无已启用 skill)→ 既不追加
  `--add-dir` 也不追加 `--disable-slash-commands`。

**Verification**:单测覆盖以上三种组合;结合 U1 的实测方法(`--add-dir` 指向真实桥接目录,喂
`/<name>` 验证展开),做一次端到端手动验证。

---

### U4. codex app-server 原生 `skill` input item

**Goal**:让 codex 的 ws(app-server)交互路径能显式带上选中的 skill,交给 `turn/start` 原生
处理;非 ws(exec,含委派场景)路径维持现状 prose 回退。

**Requirements**:R2、R3

**Dependencies**:U2(`invokedSkill` 字段的类型定义)。虽然与 U1/U3(claude 侧)在代码上不共享,
但 U4 与 U2 **都修改 `cli.ts` 同一个 `cli:start` handler**(U2 在 ws 分流判断之前写
`skillsBridgeDir`,U4 在 ws 分流判断处读 `req.invokedSkill` 并决定结构化触发或 prose 回退),
两者需协调合入顺序/一次性一起改,避免各自独立改动互相冲突。

**Files**:
- `apps/desktop/src/main/agents/codex-app-server-protocol.ts`(`CodexUserInput` 联合类型新增
  `{ type: "skill"; name: string; path: string }`)
- `apps/desktop/src/main/ipc/codex-ws-channel.ts`(`buildTurnInput` 在 `req.invokedSkill` 存在时
  追加该 skill input item;`buildTurnInput` 的实际调用点在 `codex-ws-run.ts:286`
  `channel.startTurn({ input: buildTurnInput(req), ... })`——该调用点已把完整 `req` 传入,
  U2 给 `req` 加上 `invokedSkill` 字段后此处无需改动,只需确认这一点)
- `apps/desktop/src/main/ipc/cli.ts`(ws 分流判断前,若 `req.agent === "codex"` 且
  `req.invokedSkill` 存在但请求不会走 ws 分支,渲染 prose 回退写回 `req.prompt`/
  `req.appendSystemPrompt`,复用现有 `renderSkillInvocation`)
- 对应测试文件:`codex-ws-channel.test.ts`、`cli.test.ts`

**Approach**:
- codex-app-server-protocol.ts 的类型新增是本次唯一的协议层改动,字段命名先按官方文档描述
  (`name`+`path`)实现;**实现前建议跑一次 `codex app-server generate-json-schema` 核对
  0.142.x 实际字段名**(见 Risks)。
- `buildTurnInput` 签名扩展为额外接收 `invokedSkill?: { name: string; path: string }`,存在时
  push 进 `input` 数组(文本项仍走 `wrapPrompt`,只是不再包含 prose 改写的长文案)。
- `cli.ts` 的路由判断:复用现有 `(adapter.transport ?? "spawn") === "ws" && !req.delegateRoles?.length`
  这个既有条件——命中则走 ws + skill input item;不命中(比如委派场景)则在进入
  `buildArgs`(exec)前,用 `renderSkillInvocation` 把 `req.invokedSkill` 对应的 skill 渲染成
  prose 追加进 prompt(与现状行为等价,只是触发条件从「codex 会话」收窄为「codex 且未走 ws」)。

**Patterns to follow**:`codex-ws-channel.ts` 现有 `wrapPrompt`/`buildTurnInput` 写法;
`cli.ts` 现有 ws 分流判断代码块。

**Test scenarios**:
- `req.invokedSkill` 存在且会走 ws 分支 → `buildTurnInput` 输出的 `input` 数组含一个
  `{type:"skill", name, path}` 项,文本项不含 prose 改写文案。
- `req.invokedSkill` 存在但会走 exec 分支(`delegateRoles` 非空)→ prompt 含
  `renderSkillInvocation` 渲染结果(与现状一致,验证 R3 不倒退)。
- `req.invokedSkill` 为 `undefined` → 两条路径行为都与改动前完全一致(无 skill 项,无 prose
  注入)。
- ws 分支下 `req.images` 与 `invokedSkill` 同时存在 → 两者互不影响,`input` 数组同时含
  `localImage` 项与 `skill` 项。
- 向后兼容:`invokedSkill` 缺省(未传)时,`buildTurnInput` 产出的 `input` 数组与改动前逐字相同
  (仅含 `text` 项与若干 `localImage` 项),防止本次扩展签名误伤现有调用点。

**Verification**:单测覆盖 `buildTurnInput` 与 `cli.ts` 路由分支;若能核对到 0.142.x 的
`generate-json-schema` 输出,以其为准调整字段名后补充一次手动验证(真实 codex 会话里选中一个
skill,确认 app-server 侧确实注入了指令而非模型自己瞎猜)。

---

### Phase B:核心/渲染端派发改造(U5-U6)

### U5. Core 层:新增 claude 原生转换函数,messages.ts 派发分支按 agent 收窄

**Goal**:`skill-injection.ts` 新增 claude 专用的裸 slash 渲染函数;`messages.ts` 的**单发**
发送分支(`bridge.startCli`)在 claude 时不再把 `renderSkillBlock` 结果并入
`appendSystemPrompt`(R5),codex 分支保持不变。**圆桌编排分支
(`bridge.startOrchestration`)不改动**——见下方 Approach 与 Scope Boundaries。

**Requirements**:R5、R6、R7

**Dependencies**:无(可与 Phase A 并行开发,在 U6 落地前合流)

**Files**:
- `packages/core/personal/skill-injection.ts`
- `packages/core/personal/skill-injection.test.ts`
- `packages/core/personal/messages.ts`
- `packages/core/personal/messages.test.ts`

**Approach**:
- 新增 `renderClaudeSkillSlash(skill: InjectableSkill, args: string): string`,产出
  `` /`<sanitize(skill.name)`>`(空格 + args)?`` ``——与 U1 的 symlink 命名规则共用同一份
  sanitize 逻辑(避免两处漂移,可考虑把 sanitize 函数提到共享位置由主进程/渲染端分别引用,或
  保持逻辑一致的独立实现,具体取舍留给实现)。
- **只改 `messages.ts` 的单发分支**(`bridge.startCli` 调用点,`:2456-2517` 附近):
  `agent === "claude"` 时,`appendWithSkills` 不再拼接 `skillBlock`(即 claude 的
  `appendSystemPrompt` 只保留原始 `appendSystemPrompt`/delegate guide,不含 skill 列表
  prose);`agent === "codex"` 时行为不变,继续拼接 `renderSkillBlock(...)`。
- **编排分支(`bridge.startOrchestration` 调用点,`:2429-2455` 附近)不改动**:该分支对应
  `orchestrate.ts` 的 `runStage`/圆桌 BFS,完全绕开 `cli:start` handler,没有
  `skillsBridgeDir`/`invokedSkill` 的接入点(见 System-Wide Impact)。claude/codex 在这条路径
  下继续用现状的 `renderSkillBlock` 批量注入,不做原生化——如果这里也停掉 skillBlock 拼接,
  claude 会因为没有桥接目录而把裸 `/name` 当成未知命令(回归),codex 会彻底丢失定向 skill 信息
  (相比现状的 `renderSkillInvocation` 精准定向是倒退)。
- `resolveEnabledSkillRecords` 调用本身继续为 claude 保留,只是在单发分支不再把结果渲染进
  prose,而是把这份 `InjectableSkill[]` 写进 `bridge.startCli` 请求的 `skillRecords` 字段
  (供 U2 在主进程侧建桥接目录用——main 进程没有渲染端的 store/bridge,拿不到这份数据,必须由
  渲染端算好传过去,见 U2 Approach)。

**Patterns to follow**:文件内现有的 `renderSkillBlock`/`resolveEnabledSkillRecords` 写法与
注释风格(纯函数、不读盘、sanitize 防注入)。

**Test scenarios**:
- `renderClaudeSkillSlash({name:"My Skill!"}, "foo bar")` → 产出合法的 `/<sanitized-name> foo bar`。
- `renderClaudeSkillSlash({name:"deploy"}, "")` → 产出 `/deploy`(无尾随空格)。
- messages.ts 单发分支:`agent==="claude"` 时 `appendWithSkills` 等于原始 `appendSystemPrompt`
  (不含 `## 已启用的 Skills` 段落)。
- messages.ts 单发分支:`agent==="codex"` 时 `appendWithSkills` 仍含 `renderSkillBlock` 渲染的
  skill 列表(回归现状,防止本次改动误伤 codex)。
- messages.ts **编排**分支:claude 与 codex 的 `appendWithSkills` 都仍含
  `renderSkillBlock` 渲染结果,与改动前逐字一致——显式断言这条分支未被误改(防止未来重构把
  单发分支的改动误扩散到编排分支)。

**Verification**:单测覆盖以上场景;跑现有 `skill-injection.test.ts`/`messages.test.ts` 确认
无回归。

---

### U6. Views 层:`PersonalChatArea.tsx` onSend 按 agent 分支接入

**Goal**:把发送时的 `/skill:<name>` 拦截逻辑,从「claude/codex 共用一份 `renderSkillInvocation`」
改成三路分支:pi 透传、claude 转裸 slash(U5 的新函数)、codex 设置 `invokedSkill` 结构化字段。

**Requirements**:R1、R2、R3、R4

**Dependencies**:U5(claude 转换函数)、U2(`invokedSkill` 字段已在类型上可用)

**Files**:
- `packages/views/cortex-desktop/personal/PersonalChatArea.tsx`
- `packages/views/cortex-desktop/personal/PersonalChatArea.test.tsx`
- `packages/core/index.ts`(导出新增的 `renderClaudeSkillSlash`)

**Approach**:
- 现有 `onSend` 内 `session.agent !== "pi" && bridge` 分支拆成三路,且**先判断本次发送是否走
  圆桌编排**(`session.subagentOrchestration` 为真、最终走 `bridge.startOrchestration` 而非
  `bridge.startCli`):是则维持现状行为不变(claude/codex 都继续用 `renderSkillInvocation`
  prose 改写,对齐 U5 编排分支不变的决定,避免规则在两处出现"改一半"的不一致)。仅当本次发送
  走单发 `bridge.startCli` 时,才按下列三路分支:
  - `pi`:不变,原样透传。
  - `claude`:解析出 `skill` 记录后,`outText = renderClaudeSkillSlash(skill, parsed.args)`。
  - `codex`:不改写 `outText`(保留用户的 `args` 作为文本,或在找不到 args 时用原始
    `/skill:name` 之外的占位),而是把 `{ name: skill.name, path: skill.dir }` 通过新参数/字段
    传给 `send(...)`,最终落到 `CliStartRequest.invokedSkill` 上(具体是 `send()` 的哪个参数位、
    还是在构造请求对象时合并,留给实现按现有 `send` 签名的最小改动方式决定;新参数须有默认值
    `undefined`,不影响 `send()` 的其它现有调用点)。
  - 找不到对应 skill 记录时,三路都保持「原样发送、不阻断」的现状行为。
- `send()` 除本文件的主 `onSend` 之外还有其它调用点(如 GitBar 的 `onSend`、`editResend`),均
  不解析 `/skill:` 语法——本次给 `send()` 新增的 `invokedSkill` 相关参数必须缺省
  `undefined`,不触碰这些调用点(它们的行为需保持逐字不变)。
- **走圆桌编排的判断要复现 `messages.ts` 的完整路由条件**(`subagentOrchestration &&
  bridge.startOrchestration && !hasDelegateMentions`),不能只看 `session.subagentOrchestration`
  一个字段——否则「开了编排 + 本条消息带 @mention 委派 + 又带 `/skill:name`」这种组合会被
  `onSend` 误判为编排路径(维持 prose),而 `messages.ts` 实际把它路由去了单发路径,导致本该走
  原生调用的组合悄悄退回 prose,不算错但也没达到本次改动的目的。
- **claude 且消息带图片时**,`buildClaudePrompt`(`claude.ts`)会在 `req.prompt` 前面插入一段
  "用户上传了以下图片,请先用 Read 工具…" 的说明文字,导致改写后的裸 `/<name>` 不再是消息的起始
  token——原生 slash 展开通常要求 slash 在消息开头,这个组合可能导致 `/<name>` 被当字面文本、
  skill 悄悄不触发。需要在实现前决定:调整 `buildClaudePrompt` 让图片说明排在 skill slash 行之后,
  还是接受这一已知限制并在 UI 提示用户(见 Open Questions)。

**Patterns to follow**:文件内现有 `onSend` 的分支结构与 `parseSkillSlash`/
`resolveEnabledSkillRecords` 调用方式。

**Test scenarios**:
- pi 会话:`/skill:name args` 原样发送,不做任何改写(回归现状)。
- claude 会话(单发):`/skill:name args` 被改写为 `/<sanitized-name> args`(裸 slash),不再是
  长 prose 文案。
- codex 会话(单发):`/skill:name args` 被解析后,发送请求带上 `invokedSkill:{name, path}`,
  文本部分为 `args`。
- claude/codex 会话且本次发送走圆桌编排:`/skill:name args` 仍被改写成现状的
  `renderSkillInvocation` prose 文案,与改动前逐字一致(验证 U5 的编排分支排除在 onSend 侧也
  被正确落实)。
- 三个 agent 下,`/skill:name` 对应的记录在已启用列表里找不到(未启用/`supportedAgents` 不含
  当前 agent)→ 都保持原样发送、不阻断的现状行为。
- 编辑重发(`editing` 分支)路径与 GitBar 的 `onSend`:这些路径在改动代码之前就已走独立分支/
  不解析 `/skill:` 语法,补测试显式断言它们不受本次改动影响,防止未来重构误伤。
- `subagentOrchestration` 为真但同一条消息带 @mention 委派(`hasDelegateMentions` 为真)→
  实际会走单发路径,`onSend` 的判断需要与之一致(走 claude/codex 的原生分支,不是编排分支)。
- claude 会话且本次发送带图片附件 → 需按实现前决定的方案验证(裸 slash 排在图片说明之前 /
  或已知限制的降级行为),避免"看着支持、实际因图片说明抢占消息开头而悄悄失效"。

**Verification**:单测覆盖以上场景;在应用内对 claude/codex 各跑一次真实 skill 调用,人工确认
claude 侧不再出现「请用 Read 工具查看…」的文案、codex 侧交互会话确认 skill 指令是经 app-server
注入而非模型自己猜。

---

## System-Wide Impact

- **圆桌编排(`subagentOrchestration` → `bridge.startOrchestration` → `orchestrate.ts` 的
  `runStage`/roundtable)完全绕开 `cli:start` handler**,直接调用
  `adapter.buildArgs(req, CODEX_MCP_CLEAR)`,没有 U2 的 `skillsBridgeDir` 也没有 U4 的
  `invokedSkill`/ws 路由接入点。这是本次改动**明确排除**的一条边界(见 Scope Boundaries)——
  U5/U6 都已在 Approach 里注明"编排分支不改动",claude/codex 在这条路径下继续用现状的
  `renderSkillBlock`/`renderSkillInvocation` prose 机制,不会因为本次改动而回归。
- **`oneshot`/`ask`/`automation`/`workflow-headless` 路径同样绕开 `cli:start` 的 transport
  分流**(`apps/desktop/src/main/ipc/cli.ts:729` 注释:"仅 cli:start 读 transport;
  oneshot/ask/automation/workflow-headless 不经此、恒走 spawn+`codex exec`")。这些路径恒不
  设置 `skillsBridgeDir`/`invokedSkill`,而 U3 给 claude 追加 `--add-dir` 以
  `req.skillsBridgeDir` 存在为前置守卫 → 对这些路径是空操作,行为不变。即便它们的
  `AutomationMeta`/`AutomationInput` 也带 `useOwnSkills` 字段,也不受本次改动影响。
- **`send()` 的其它调用点**(如 GitBar 的 `onSend`、`editResend`)不解析 `/skill:` 语法,
  U6 给 `send()` 新增的 `invokedSkill` 相关参数缺省 `undefined`,不触碰这些调用点。
- **会话续接(`--continue`/`--resume`)与桥接目录/`invokedSkill` 无有害交互**:claude/codex
  逐轮 fresh spawn(每条消息都是新进程),桥接目录按当前已启用 skill 集合逐轮重建、`--add-dir`
  逐轮重传;`invokedSkill` 是 per-turn 的 `buildTurnInput` 输入项,与 codex thread 的
  resume/续接机制正交。因此续接旧会话不需要额外的桥接/skill 记录重算逻辑。

## Scope Boundaries

**本次覆盖**:主聊天 composer 的单发 `/skill:<name>` 发送流程(`PersonalChatArea.tsx onSend`
经 `bridge.startCli` 的路径)及其下游两条路径——claude(所有走 `buildArgs` 的调用点,因为 claude
没有 ws/exec 分裂)、codex 的 app-server ws 交互路径(原生)与因委派退回 exec 的路径(prose
回退)。

**不属于本次**:
- pi 会话——已是原生机制,不涉及改动。
- **圆桌编排(`subagentOrchestration`/`bridge.startOrchestration`/`orchestrate.ts` 的
  `runStage`/roundtable)**——完全独立的 IPC 路径,不经过 `cli:start`,没有接入 U1-U4 原生能力
  的现成挂点(见 System-Wide Impact)。claude/codex 在这条路径下继续用现状 prose 机制,原生化
  留待独立的后续工作。
- `oneshot`/`ask`/`automation`/`workflow-headless` 等轻量调用路径——它们不经过
  `PersonalChatArea.tsx` 的 `onSend`,现状也没有暴露 `/skill:<name>` 的交互入口,本次不新增。

### Deferred to Follow-Up Work

- **圆桌编排(`orchestrate.ts`)路径的原生 skill 调用**:该路径完全绕开 `cli:start`,要接入
  U1-U4 的原生能力需要单独设计(桥接目录/`invokedSkill` 如何在 per-stage fresh spawn 的模型下
  复用或重建),留待独立 plan。
- **`usePiEnabledSkills`/`filterEnabledPiSkills`/`piSkillsList`/`PiSlashSkill` 等 "pi" 前缀
  命名**:这些标识符自 `ba12efe` 后已服务 claude/codex/pi 三个 agent,命名与实际语义脱节,容易
  误导后续维护者。这是纯粹的命名重构,与本次「调用机制」改动是不同维度的工作,且牵涉的文件较多,
  留待独立的重命名 PR。
- **claude 桥接目录的生命周期/清理策略**(创建时机之外的 GC、跨进程崩溃后的孤儿目录清理)——
  U2 只钉死了「何时构建」,具体清理时机/策略留给实现阶段决定。
- **claude 最低版本的运行期探测与优雅降级 UI**——本次按文档假设 claude ≥ 2.1.181,不引入运行期
  版本探测(与文件内其它未做版本探测的既有特性假设一致),若需要面向用户的版本提示,留待后续。

## Risks & Dependencies

- **claude 版本依赖(≥ 2.1.181)是一次真实的功能回归风险,不是「新特性在旧版本上不可用」那种
  中性风险**:「`-p` + stream-json 下 `/<name>` 会被展开」这一行为官方文档标注了
  `min-version: 2.1.181`。低于该版本的用户目前用 prose 改写**能**调用 skill;本次改动把 claude
  的 prose 注入下线、换成裸 `/<name>`,若用户的 claude 版本低于该阈值,`/<name>` 会被当字面文本
  发给模型——用户从「能调用」变成「悄悄调不动」,是功能回归而非「新能力暂不可用」。本次不引入
  运行期探测(避免过度设计),但把这个取舍显式记录为 Open Question,而不是按同一档次的假设一笔
  带过。
- **codex `skill` input item 的确切字段名未逐版本核实**:结论基于官方 `developers.openai.com`
  文档描述(`name`+`path`),未针对本项目实测的 0.142.x 版本用
  `codex app-server generate-json-schema` 逐字核对。实现 U4 前建议先跑一次该命令核对字段名,
  避免协议层字段名对不上导致 skill 注入静默失效。
- **移除 `--disable-slash-commands` 的间接影响范围未逐条验证**:该 flag 官方定义是
  "Disable all skills",但 `useOwnSkills===true` 时不再传它,是否会同时放开 claude 其它内建
  slash 命令(如 `/compact`)在用户文本恰好匹配时被意外触发,未做逐条验证。风险较低(内建命令名
  与 skill 名通常不冲突),但记录在此以防后续排查时遗漏这条线索。
- **`--add-dir` 的语义超出 skill 发现范围**:该 flag 本身是「授予目录访问权限」的通用机制,
  skill 自动加载只是其中一个例外行为。桥接目录只含指向已启用 skill 目录的符号链接,理论上不会
  扩大额外的文件访问面,但这是 `--add-dir` 的一个副作用值得记录。

## Open Questions

- U4 的 `skill` input item 字段名(`name`/`path` vs 其它命名)需要在实现时用
  `codex app-server generate-json-schema` 对当前锁定的 codex 版本核实一次,plan 阶段无法进一步
  收窄。同时需确认该字段期望的 `path` 是 skill 目录还是 `SKILL.md` 文件本身。
- 桥接目录的具体存放路径与清理时机(U2 提到但未钉死)留给实现阶段按现有目录管理惯例决定。
- **是否要为 claude 加一次会话级(启动时缓存)的最低版本探测(≥ 2.1.181)**,低于阈值时回退到
  现状 prose 注入,而不是让 `/<name>` 静默失效?本次决定不加(避免过度设计),但这是一个真实的
  取舍——留给实现阶段或后续按实际用户版本分布决定是否值得加。
- **claude 消息同时带图片附件 + `/skill:name` 时**,`buildClaudePrompt` 插入的图片说明会抢占
  消息开头,可能让裸 slash 展开失效——实现前需决定是调整 `buildClaudePrompt` 的拼接顺序,还是
  接受这一已知限制(见 U6 Approach)。
- claude 派生 slash 命令名时是否对目录名做大小写/连字符归一化,尚未逐条实测确认(见 U1 的
  命令名对齐验证步骤)——这决定桥接层 symlink 命名规则的精确算法。

## Sources / Research

- Claude Code headless 文档(`/skill-name` 在 `-p` 模式下的展开行为、`--disable-slash-commands`
  语义、`--add-dir` 对 `.claude/skills/` 的自动加载例外):https://code.claude.com/docs/en/headless.md
- Claude Code skills 文档(发现路径优先级、命令名生成规则):https://code.claude.com/docs/en/skills.md
- 本项目内实测:用应用现有的确切 `claude -p --input-format stream-json ...` 命令行,构造项目级
  测试 skill,验证「不传 `--disable-slash-commands` 时原生展开生效」与「传了则 `Unknown command`」
  两种行为。
- OpenAI Codex Agent Skills 官方文档:https://developers.openai.com/codex/skills
- OpenAI Codex custom prompts(已废弃)文档:https://developers.openai.com/codex/custom-prompts
- OpenAI Codex slash commands 文档(明确 slash 展开是 TUI 输入层特性):https://developers.openai.com/codex/cli/slash-commands
- OpenAI Codex non-interactive(`codex exec`)文档:https://developers.openai.com/codex/noninteractive
- OpenAI Codex app-server 文档(`skills/list`、`turn/start` 的 `skill` input item):https://developers.openai.com/codex/app-server
- GitHub issue 实测佐证 `codex exec` 下 slash 语法不被解析:https://github.com/openai/codex/issues/3641
- 本仓库现状代码:`apps/desktop/src/main/agents/{claude,codex,codex-app-server,pi,pi-rpc}.ts`、
  `apps/desktop/src/main/skills/{locate,registry}.ts`、
  `packages/core/personal/{skill-injection,piSkills,messages}.ts`、
  `packages/views/cortex-desktop/personal/{PersonalChatArea,PersonalComposer}.tsx`、
  `apps/desktop/src/main/ipc/{cli,codex-ws-channel,codex-ws-run,types}.ts`、
  `apps/desktop/src/main/agents/codex-app-server-protocol.ts`。
