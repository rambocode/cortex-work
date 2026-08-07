# 名词 → 模块速查表（module-map）

用途：用户用**功能名词**描述需求（如「闪记」「深度研究」「演示文稿」「快捷回复」）时，先查本表定位对应代码，再进文件，避免全仓盲搜。同一功能通常横跨三端：**views**（界面）、**core**(纯逻辑/状态) 、**main**（Electron 主进程）。

> **维护规则（务必遵守）**：新增功能模块、IPC 域、工作区视图或独立窗口时，必须同步在本表补充条目；目录重命名/迁移时同步修正。缺更新视为该功能改动未完成。

路径前缀约定（各表内省略）：

| 列 | 省略的前缀 |
|---|---|
| views | `packages/views/cortex-desktop/` |
| core | `packages/core/` |
| main | `apps/desktop/src/main/` |
| renderer | `apps/desktop/src/renderer/` |

`views/personal/` 已按功能域分子目录：`layout/`（三栏外壳）、`chat/`（会话主区，输入区在 `chat/composer/`）、`home/`（落地页）、`sessions/`（会话检索/归档）、`tasks/`、`projects/`、`files/`（含 `files/sheet/` 表格查看器）、`markdown/`（跨域 Markdown 渲染栈）、`notes/`、`editor/`（跨域 CodeMirror 编辑器，notes/tasks/writing 共用）、`timeline/`、`automation/`、`workflow/`（含 `workflow/node-config/` 节点表单）、`browser/`、`terminal/`、`plugins/`、`skills/`、`knowledge/`、`settings/`、`shared/`（跨域通用 hook/小组件）。

## 入口三件套

定位任何功能前，先看这三个「地图文件」：

| 文件 | 作用 |
|---|---|
| `main/ipc/register.ts` | 主进程全部 40+ IPC 域一屏可见，找主进程功能先看这里 |
| `views/personal/layout/PersonalWorkspace.tsx` | 个人工作区三栏容器，主区视图互斥切换总表 |
| `core/store/personal.ts` | 视图开关（`designOpen`/`writingOpen`/…）与个人工作区客户端态总店。注意 `designOpen` 目前**没有任何渲染方**（死开关），新入口勿挂 `openDesign()`，设计稿走 `/skill:design`；深度研究无整窗视图态，入口是会话 `/skill:research`，右栏 `rightView:"research"` 展示 |

## 一级功能名词表

> **命名约定（找不到「Pi」时看这里）**：`pi` 是**技术标识符**，继续用于 `AgentKind`、npm 包作用域
> （`@earendil-works/*`）、IPC 契约、日志与本表的文件路径；**面向用户一律显示为 “Cortex”**（内置、
> 恒可用的 agent，模型来自用户自配供应商）。设置左栏原「Pi」分区显示名为**「模型」**——tab 的
> 枚举值仍是 `"pi"`（`openSettings("pi")` 多处调用）。内置角色 mention 为 `@cortex`（旧 `@pi` 已
> 硬切下线，不做兼容）。显示名的**唯一真源**是 `core/desktop/types.ts` 的 `AGENT_LABEL` /
> `AGENT_LABEL_SHORT`，不要在别处重新声明。

| 名词（含别名） | views | core | main |
|---|---|---|---|
| 会话 / 跑 Agent / CLI 流式管线 | `personal/chat/PersonalChatArea.tsx`、`chat/composer/PersonalComposer.tsx`、`chat/composer/ComposerShell.tsx` | `personal/messages.ts` | `ipc/cli.ts`（spawn+流式）、`ipc/chat.ts`（消息持久化） |
| 追问 / 编辑重发 | `personal/chat/FollowupOverlay.tsx` | `personal/followup.ts` | `ipc/ask.ts`、`ipc/session-trim.ts` |
| 圆桌（多角色 @ 调度） | `personal/chat/composer/MentionAutocomplete.tsx` | `personal/mention.ts` | `ipc/roundtable.ts` |
| 角色库 | `personal/settings/RolesSettingsSection.tsx` | — | `ipc/roles.ts` |
| Agent 适配（claude/codex/pi/自定义） | `personal/chat/AgentSelect.tsx` | — | `agents/`（`index.ts` 注册表、`agent-profiles.ts` 自定义） |
| pi / codex 长驻会话 | — | — | `ipc/pi-session.ts`（IPC 契约不变）+ `agents/pi-gateway/`（**pi 唯一引擎**：JSONL 协议 + 主进程客户端，实现 `PiSessionEngine`）+ `src/worker/pi-host/`（常驻 worker 执行体，worker 内直调 `createAgentSession`）、`ipc/codex-ws-channel.ts`。registry / 命令转发 / 事件回推 / 清理全走 `PiSessionEngine` 契约 |
| 会话产物 / Artifacts（pi 产物，pi-web-ui 移植；与设计稿落盘型 `rightView:"artifact"` 是两个概念） | **主呈现是会话内联卡** `ChatArea.tsx` 的 `PiArtifactMessage`（`kind:"piArtifact"` 持久消息,沙箱直渲 HTML/SVG/markdown,落盘可回看;**不自动弹侧栏**——实机反馈宽面板挤占中栏）；侧栏 `personal/chat/artifacts/`（`PiArtifactsPanel.tsx` 右栏 `rightView:"piArtifacts"`,点卡片/步骤 pill 才打开、`SandboxedIframe.tsx` + `sandboxHtml.ts` 沙箱红线：**永不加 allow-same-origin**、`ConsoleBlock.tsx`）、`personal/chat/toolRenderers/`（按 toolName 自定义步骤卡注册表，`ArtifactStepCard.tsx`） | `store/piArtifacts.ts`（按 uiSessionId 命名空间 + 纯 reducer）、`personal/messages.ts` `handlePiEvent` 的 `case "artifact"`（单事件三消费:store / piArtifact 卡 / 过程流步骤） | `agents/pi-inproc/artifacts-tool.ts`（worker 闭包内存态 + `tool_execution_end.details` 派生 `artifact` 事件，`rpc-shared.ts` mapPiEvent 特判） |
| JS 沙箱执行 / javascript_repl（LLM 写 JS 在渲染端沙箱 iframe 跑，结果回流模型） | `personal/chat/artifacts/useReplExecHost.ts`（挂 PersonalWorkspace 常驻；method:"jsrepl" 独立订阅，**绝不进确认弹窗流**）、`replRuntime.ts`（一次性隐藏 iframe 执行器） | `personal/permissionMode.ts`（ask 档进审批底线集） | `agents/pi-inproc/js-repl-tool.ts`（askquestion 同款 sentinel + `ctx.ui.input` 借道，零新 IPC；`ui-context.ts` 归一化、`pi-session.ts` 生成 sentinel、`worker/pi-host/capabilities.ts` 门控注册） |
| **pi 执行形态**（**常驻 gateway worker 为唯一执行形态**；单发走主进程 in-process oneshot，gateway 化另案） | —（无 UI 入口） | — | 长驻会话与编排：常驻 `utilityProcess` worker 多会话复用（`agents/pi-gateway/` 协议/客户端 + `src/worker/pi-host/` 执行体，构建 `electron.pi-host.config.ts` → `out/worker/pi-host.js`，三包 external、运行时裸包名 import；fork+三包 ESM 加载只付一次，app 启动按需 `primePiGatewayRuntime()` 预热；凭据经 RPC 回主进程 safeStorage 金库四操作，密钥不落 worker；worker 崩溃 → 全会话 `crashed` + 懒重启）。单发：`agents/pi-inproc/oneshot.ts`（主进程内 in-process），编排会话生命周期 `session-pool.ts`。护栏 `scripts/verify-pi-inprocess.mjs`（`verify:pi-inproc`）+ 打包态 `scripts/verify-pi-ai-packaging.mjs`（含 gateway worker 产物存在性检查） |
| 供应商管理（Catalog 驱动：认证 / 只读能力 / 自定义 Provider；**平铺在设置→模型**,无弹窗）| `personal/settings/provider/PiProvidersSection.tsx`（**五类接入形态的 tab 壳**:订阅登录/API Key/云平台/聚合网关/自定义 + `HiddenToggle`/`ModelsPopover`；**搜索时隐藏 tab 栏、退回全量平铺**——tab 用于浏览、搜索用于查找）、`PiProviderCloudRows.tsx`（云平台折叠行）、`PiGatewaySection.tsx`（聚合网关顶层分区）、`PiCustomProviderSection.tsx`（自定义列表 + 内联编辑，**只列非网关来源**）、`CustomProviderForm.tsx`（预制表单新增:预设 chips + 显式能力声明,Key 走 Secret 引用）、`DefaultModelSelects.tsx`（默认模型级联下拉）、`PiApiKeyRows.tsx`（API Key 行：已接入/可接入分组、三列骨架、**「配置」是唯一入口**（密钥 + Base URL 同屏，留空即不改动）、**一行一个保存**）、`ProviderTestControl.tsx`（带费用确认的紧凑连接测试按钮 + traceId）、`ProviderTestPanel.tsx`（锚定浮层：参数 + 实时步骤 + 诊断复制，portal 到 body 避开 `.pw-dlg-body` 裁剪）、`shared/useAnchoredLayer.ts`（fixed 锚定 + 跟随滚动）、`BaseUrlOverride.tsx`（`useBaseUrlDraft` 草稿 hook + 纯展示字段，保存已上收到行）、`useProviderRowSave.ts`（行内唯一保存：先地址后密钥）、`useProviderData`（数据层）、`ProviderModelList`（只读能力）、`CustomProviderPanel`（JSON/Secret 编辑器）+ `customProviderRules`、`ProviderAuthDialog`（通用 OAuth 交互）| `desktop/provider-catalog.ts`（契约）、`personal/modelCapabilities.ts`（Catalog 缓存 + 能力三态查询）| `providers/catalog.ts`、`ipc/provider-auth.ts` |
| 全局模型选择器（Chat / Research / Reply / Automation / workflow AI 节点 / Computer Use 复用）| `personal/settings/provider/ModelPicker.tsx`、`ModelPickerDialog.tsx`、`ModelRefField.tsx`（悬空引用阻断态）| `personal/modelCapabilities.ts` | `providers/catalog.ts` |
| 发送前 vision 阻断（文本模型/能力未知 + 图片 → 拒发并保留草稿）| `personal/chat/VisionBlockBanner.tsx`（挂在 `composer/ComposerShell.tsx` 输入框上方）| `personal/messages.ts` 的 `usePersonalActions().send`、`personal/modelCapabilities.ts`、`store/personal.ts` 的 `visionBlockHints` | `agents/pi-inproc/oneshot.ts`（oneshot 的 `images` 入参,最终权威）|
| 自定义供应商在**非聊天**场景可用（连接测试 / Reply 草稿 / Research / 日报 / Writing 续写与 Cmd-K）| —（经主进程调用，渲染端无直接入口）| —| `providers/custom-provider-registry.ts`（把自定义供应商同步进**主进程**那份 pi-ai 注册表；**Catalog 优先、绝不覆盖内建供应商**；密钥在 `resolve()` 时才解密）、`providers/pi-runtime.ts` 的 `getModels()`（每次取注册表都同步一遍）、`providers/gateway.ts` 的 `resolveModel`（自定义引用跳过 Catalog 一关，改由运行时注册表把关）；打包态护栏 `scripts/verify-pi-ai-packaging.mjs` + `scripts/verify-pi-inprocess.mjs`（后者把 `pi-coding-agent`/`pi-agent-core`/`pi-ai` 三包动态 import → 工具集构造 → 一整轮真跑的 agent loop 串起来；打包态由前者注入 asar 内的 `importModule` 复用后者的断言。**pi 相关包一律是运行时动态 import、bundler 不打包**，asar 缺任何一个都只在正式包暴露——`dist:dir` 后必跑） |
| 聚合网关接入（new-api / one-api：填地址 + Key → 自动拉模型 → 勾选启用，零手填） | `personal/settings/provider/PiGatewaySection.tsx`（**顶层分区**，与订阅登录/API Key/云平台并列；存储仍是 `provider-custom.json`，分区归属运行期算出、不落盘）、`GatewayWizard.tsx`（两步向导：连接探测 → 勾选启用；传 `initial` 即**编辑态**：直接进第二步、id 与 Secret 名锁死不随改名漂移）、`gatewayDefinition.ts`（已保存定义 ↔ 向导种子的转换 + `isGatewayGenerated` 判据，决定条目归哪个分区、「编辑」开向导还是开 JSON 编辑器）、`GatewayReferencePicker.tsx`（unknown 模型的参照模型内联选择器，数据源是**全量 Catalog**、不按认证过滤）、`capabilityFormat.tsx`（只读能力徽标）、`useProviderData.useGatewayActions`（桥调用）| `desktop/provider-catalog.ts` 的 `GatewayDiscover*` / `GatewayBuild*` 契约 | `providers/gateway-onboarding.ts`（`GET /models` 发现 + JSON 生成，**生成物过同一个 `validateCustomProviderJson`**）、`providers/capability-resolver.ts`（能力只从随包目录解析，解析不出即显式 unknown、绝不猜）、`ipc/provider-auth.ts` 的 `providerGateway:discover|build` |
| 自定义 Provider 接进 pi 聊天会话（用户 JSON → `ModelRuntime` 注册，**密钥只在内存**） | 复用「全局模型选择器」（自定义模型经 `useProviderData.parseCustomProvider` 并入候选集）| `desktop/provider-catalog.ts` 的 `parseCustomProvider` / `findCustomProviderModel`、`personal/modelCapabilities.ts`（能力判定与会话指纹兼容自定义 Provider）| `providers/pi-inproc-models.ts`（建注入了 safeStorage 金库的 `ModelRuntime` → 复用 `custom-provider-registry.ts` 同步自定义供应商 → 解析出可直接喂给 `createAgentSession({ model })` 的模型；**三段式解析 Catalog → 自定义 → 响亮失败**）。入口 `ipc/pi-session.ts`。**收益**（对比已删除的二进制路径）：密钥不经环境变量跨进程传递、不烘焙进 `userData/pi-providers/*.js`；API Key 在**请求那一刻**才从金库解出，不在注册时捕获进闭包 |
| Provider 凭据 / OAuth 登录 / 自定义 Provider 与 Secret（**明文永不过桥**） | 设置→模型 的供应商平铺区（见上行「供应商管理」） | `desktop/provider-catalog.ts`（契约镜像）、`desktop/types.ts` 的 `hiddenProviderIds` | `ipc/provider-auth.ts`（IPC 边界）、`providers/credentials.ts`（safeStorage 金库 + pi `CredentialStore` 串行写）、`providers/pi-native-auth.ts`（金库 ↔ pi 的 `~/.pi/agent/auth.json` 的 OAuth 双向同步:登录推送/注销清除/**建会话前按 expires 对齐**,api_key 永不写入。⚠️ 聊天会话的凭据由 `CredentialStore` 经 gateway RPC 原生供给,**不经过**这份 `auth.json`;该同步链只维系 `~/.pi` 侧 pi 生态的一致性）、`providers/oauth.ts`（登录交互状态机）、`providers/custom-providers.ts`（Pi Provider JSON 校验与落盘）、`providers/secrets.ts`（`${secret:}` 引用 + 禁泄文本清洗）、`providers/pi-runtime.ts`（pi-ai 懒加载注入；`probe` 的五步埋点经 `providerConnection:testEvent` 实时推给面板，并把 `provider-prefs.json` 的 baseUrl 覆盖贴到模型上——probe 与 Gateway 都要贴，否则「测试通过但聊天不通」）、`providers/prefs.ts`（main-owned 的显示/隐藏 + baseUrl 覆盖，**`getBaseUrlOverrides()` 仍是同步读**：供 `providers/pi-inproc-models.ts` 在**建会话前**取用。同步这条约束保留——原因是「模型注册同步阶段不做隐式 IO」，不再与 spawn 时序有关） |
| **文本补全（全仓唯一出口，Pi Model Gateway）**：Reply 草稿 / Research / 做梦蒸馏 / Timeline 日报 / Writing 续写与 Cmd-K | — （业务模块经主进程调用，渲染端如需直调走 `modelGateway:*`） | `desktop/provider-catalog.ts` 的 `GatewayCompleteRequest` / `GatewayStreamEvent` | `providers/gateway.ts`（寻址 + 取消 + 错误分类）、`ipc/model-gateway.ts`（IPC 过桥）、`ipc/openai-chat.ts`（「返回文本 / 失败抛错」的适配层）、`providers/default-model.ts`（全局默认模型引用）。**排除项**：TTS/ASR 的 `/v1/audio/*`（`ipc/push-sign.ts` 音频函数 + `capabilities/asr/**`）、media-gen、knowledge —— 静态检查见 `providers/no-direct-endpoint.test.ts` |
| MCP 配置 / 注入 | `personal/plugins/McpSection.tsx`、`plugins/McpServerForm.tsx` | — | `ipc/mcp-config.ts`、`capabilities/mcp-host/` |
| 公司知识库 / 知识库检索 / 引用预览（远端 MCP，server 在 `../../knowledge-base-system` 的 `/api/mcp`） | `personal/settings/KnowledgeSettingsSection.tsx`（设置）、`personal/knowledge/KnowledgeDocRef.tsx`（正文里 `kb://` 引用 chip）、`personal/knowledge/KnowledgeDocPanel.tsx`（右栏正文预览） | `store/personal.ts` 的 `openKnowledgeDoc` / `knowledgeDocRequest`（rightView `knowledge`） | `capabilities/knowledge/inject.ts`（三门控注入）、`capabilities/knowledge/client.ts`（主进程自用的极简 MCP 客户端）、`ipc/knowledge.ts`（令牌加密落盘 + 连通性自检 + 取文） |
| 电脑操作 / Computer Use / GUI 自动化（pi 点鼠标按键盘操作本机 app，由第三方 package `pi-computer-use` 供能，**默认启用**、**独属 pi**） | `personal/plugins/ComputerUseSection.tsx`（总开关 / 环境状态行 / GUI 定位模型 / `/learn` 告知）——挂在**管理页 → MCP 标签**，与 `ExtensionPanel` 并列（`plugins/PluginManagePage.tsx`），**不在**设置→模型：同一开关只挂一处 | `personal/permissionMode.ts`（**安全红线**：`gui_*` 写工具强制进审批集，auto 档也强制开审批）、`desktop/types.ts` 的 `COMPUTER_USE_*` 常量与 `ComputerUseSettings` | `capabilities/computer-use/inject.ts`（五门控唯一决策点）、`install.ts`（首启后台经 `DefaultPackageManager` 把 `pi-computer-use` 安装到 `~/.pi` + userData marker 幂等；**不再 spawn 二进制跑 `pi install`**，与扩展市场 `ipc/pi-extensions-market.ts` 共用同一条包管理串行链）、`env.ts`（swiftc 探测 + 复用 `reply/permissions.ts` 查两项 TCC）、`ipc/computer-use.ts`（状态自检 / 重试安装 / 重新申请授权 / 在 Finder 中显示）、`reply/permission-reprompt.ts`（`tccutil reset` + 重新弹提示，破解「授权提示只弹一次、之后应用再也不进列表」的死角；辅助功能与屏幕录制专用） |
| 执行权限（单轴:计划/询问/自动） | `personal/chat/composer/CustomizePill.tsx` | `personal/permissionMode.ts` | — |
| 子 Agent 编排 / 委派（全局开关在 设置→Agent） | `personal/chat/PersonalProcessPanel.tsx`、`personal/settings/SettingsMenu.tsx` | `store/personal.ts`（GeneralSettings.subagentOrchestration,缺省开） | `ipc/orchestrate.ts`、`capabilities/delegate/` |
| Agent 追踪窗口 | `personal/chat/AgentTracePanel.tsx` | — | `ipc/agent-trace.ts`、`agent-trace-window.ts` |
| Agent 项目扫描（本机项目聚合） | — | — | `ipc/agent-projects.ts` |
| 写作 / 写作台 | `writing/`（`WritingWorkspace.tsx` 三栏容器） | `writing/` | `ipc/writing-*.ts`（见下文写作域） |
| 设计 / 会话产物 / 画布 | `personal/chat/artifactDispatch.ts`（含落盘布局契约）、`design/ArtifactEditorPanel.tsx`、`design/useArtifactConversationTurn.ts` + `design/useDesignArtifactAutoRefresh.ts`（动作回流会话 / 回合结束重扫）、`design/DesignWorkspaceView.tsx`、`design/canvas/` | `personal/messages.ts`（产物 resume 隔离）、`design/`（子域见下文 core 表） | `ipc/artifact.ts`、`ipc/artifact-workspace.ts`、`ipc/design-types.ts` |
| 演示文稿 / Slides / 放映 | `design/ArtifactEditorPanel.tsx`、`design/slides/SlidesWorkspace.tsx`、`design/useArtifactConversationTurn.ts`（面板动作回流发起会话） | `design/slides/`（含 `bento/`、`slides-text-files.ts`）、`design/artifact-turn-dispatch.ts`（回合派发端口，与设计稿共用） | `ipc/artifact.ts`、`ipc/slides.ts`、`capabilities/slides/`、`capabilities/research/inject.ts`（会话级联网准入）、`presenter-window.ts` |
| 研究 / 深度研究（CRE） | `research/`（`ResearchArtifactPanel.tsx` 右栏面板 + `ResearchRunView` 等子组件；入口是会话 `/skill:research`，派发在 `personal/chat/researchDispatch.ts`，已无整窗覆盖层） | `research/` | `research/`（引擎，报告归档见 `research/report-archive.ts`）、`ipc/research.ts`、`capabilities/research/`；chat 与 slides 均由各自会话栏按轮准入 |
| 任务 | `personal/tasks/`（`TasksView.tsx`、`TaskDetail.tsx`、`Task*Field.tsx`） | `personal/tasks.ts`、`taskTree.ts` 等 | `ipc/tasks*.ts`、`tasks-reminder-scheduler.ts` |
| 项目管理 / 项目阶段（独立窗口） | `personal/projects/`（`ProjectsWorkbench.tsx`、`ProjectStagesBar.tsx`、`StageTimeline*.tsx`） | `personal/projectStages.ts`、`stageTemplates.ts` | `projects-window.ts` |
| 闪记（Flash Notes） | `personal/notes/`（`NotesView.tsx`、`FlashNoteEditor.tsx`；共用编辑器在 `personal/editor/`） | `personal/notes.ts` | `ipc/notes*.ts`、`notes-overlay.ts`（浮层窗口） |
| 时间线 / 日报 | `personal/timeline/TimelineView.tsx` | `personal/timeline.ts` | `ipc/timeline.ts` |
| 自动化（定时任务） | `personal/automation/`（`AutomationView.tsx`、`Automation*.tsx`；`AutomationList.tsx` 有「AI 创建」角标，读 `AutomationMeta.createdBy`） | `personal/automation.ts` | `automation/`（scheduler/runner/store；**领域逻辑单一真源在 `service.ts`**，IPC 与 MCP 工具共用——create 的「校验→落盘→`scheduleOne`→广播」四联动缺一步就是「任务建好了却永不触发」且完全静默） |
| **AI 帮我建定时任务 / 会话里管理自动化**（`list_automations` 等 7 个 MCP 工具，写工具强制审批） | `personal/plugins/AutomationToolsSection.tsx`（总开关，挂管理页 → MCP 标签） | `personal/permissionMode.ts` 的 `ALWAYS_APPROVE_TOOLS`、`desktop/types.ts` 的 `AUTOMATION_*` 常量与 `AutomationToolsSettings` | `capabilities/automation/`（`server.ts` 工具集 + G1 守卫、`schedule-input.ts` 定时参数纯函数） |
| **系统日历 / 查日程 / 建日程**（macOS EventKit，`list_calendar_events` + `create_calendar_event`） | 授权入口在 `personal/settings/ReplySettingsSection.tsx` 的权限行（无独立开关，授权即门控） | `desktop/types.ts` 的 `CALENDAR_*` 常量 | `capabilities/calendar/`（`server.ts` 四道门控、`time.ts` 时间解析、`helper.ts` 授权探测缓存）、`reply/helper-client.ts` 的 `calendarEvents`/`calendarCreate`、`native/Cortex_Helper/…/CalendarEvents.swift` |
| Loop 工作流 | `personal/workflow/`（`WorkflowView.tsx`、`WorkflowCanvas.tsx`、节点表单 `node-config/`） | `personal/workflow.ts` | `workflow/`（DSL/scheduler/webhook）、`capabilities/loop-workflows/` |
| 推送（企微/钉钉/飞书/邮件） | 设置分区 | `personal/push.ts` | `ipc/push.ts` |
| **消息中心 / 消息提醒 / 侧栏铃铛**（持久化历史，60 天过期 + 500 条上限） | `personal/layout/NotificationBell.tsx`（铃铛 + 列表 popover）、`personal/layout/SidebarUserBar.tsx`（承载它的底部用户行） | `desktop/types.ts` 的 `NotificationRecord`（与 main 逐字镜像）、`desktop/bridge.ts` 的 `notificationCenter*` | `ipc/notification-center.ts`（IPC + 广播 + 内部写入口 `recordNotification`）、`ipc/notification-center-store.ts`（存储核心，可单测）。**埋点方**：`automation/runner.ts`（收尾，无条件记录，不受 opt-in 推送渠道约束）、`workflow/events.ts`（广播 end 时统一记）、`ipc/tasks.ts`（提醒投递）、`ipc/update.ts`（进入 available，按版本 dedupe） |
| 桌面宠物 / 宠物图鉴（petdex） | `pet/`（`Pet.tsx` 纯展示 + 拖拽 + `.pet-resize` 右下角缩放手柄（尺寸不在设置页调）+ `.pet-tip` 状态气泡、`PetCanvas.tsx` canvas 逐帧、`source.ts` 内置↔petdex 唯一分叉、`rows.ts` 姿态→sheet 行降级链、`prefs.ts` **唯一偏好写入端口**、`petdexSource.ts` Desktop↔Web 分叉、`pet/petdex/` 图鉴 UI）、`personal/settings/PetSettingsSection.tsx` | `pet/`（活动位 + `derivePetState` 优先级链 + 去抖引擎 + `grid.ts` 网格探测）、`store/pet.ts`（纯展示镜像）、`desktop/petdex-types.ts` | `ipc/pet.ts`（状态镜像广播，全单向 send）、`ipc/petdex.ts`（图鉴拉取 + 磁盘缓存 + `cortex-petdex://` 协议）、`ipc/petdex-security.ts`（host 白名单 / slug 防穿越 / WebP 只读头部）、`ipc/petdex-cache.ts`、`pet-overlay-window.ts`（含**光标轮询**：overlay 窗口 focusable:false + app-region:drag，收不到鼠标移动事件，悬停态只能由主进程算，见 `docs/lessons.md`；**窗口双模式** pet↔voice：语音助手启动时宠物隐藏、语音球接管本窗口，见上方「语音助手」行）。**协议特权注册在 `index.ts` 模块顶层，必须早于 `app.ready`** |
| 快捷回复 | renderer `src/reply-bubble.tsx`；设置 `personal/settings/ReplySettingsSection.tsx` | `reply/` | `reply/`（controller/气泡窗）、`ipc/reply.ts`。原生 helper `native/Cortex_Helper` 同时承载日历 MCP 的 `calendar-events` / `calendar-create`；其 `calendar` 子命令（未来 3 天忙碌区间）是快捷回复专用，`reply/controller.ts` 逐字段依赖它，**不要参数化** |
| Spotlight 浮动框 / 全局热键 | renderer `src/spotlight.tsx` | `personal/spotlightHandoff.ts` | `ipc/spotlight.ts`、`hotkey.ts` |
| 记忆 / 做梦 | `personal/settings/MemorySettingsSection.tsx`、`settings/ResearchMemoryCandidates.tsx` | `memory/` | `ipc/memory.ts`、`memory/`（dreamer/scheduler） |
| 内嵌浏览器 / 页面标注 | `personal/browser/`（`BrowserView.tsx`、`BrowserAnnotator.tsx`） | — | `ipc/browser.ts`、`browser/`、`capabilities/browser/` |
| 内嵌终端 | `personal/terminal/TerminalPanel.tsx` | — | `ipc/pty.ts` |
| 文件树 / 文件预览 / Git 信息条 | `personal/files/`（`FilesView.tsx` + `MonacoViewer`/`PdfViewer`/`DocxViewer`/`PptxViewer`/`sheet/`；Markdown 渲染栈独立在 `personal/markdown/`） | `personal/filePaths.ts` | `ipc/fs.ts`、`ipc/watch.ts`、`ipc/git-info.ts` |
| 图片 / 文档上传 | `personal/chat/composer/PersonalComposer.tsx` | — | `ipc/image.ts`、`ipc/doc.ts`、`capabilities/doc-extract/` |
| 语音（麦克风 / TTS / 系统级听写 / STT） | `personal/settings/SpeechSettingsSection.tsx`（统一分区）、`SpeechTtsPanel.tsx`、`SpeechDictationDictionary.tsx`、`SttSettingsSection.tsx`、`personal/chat/composer/useComposerVoice.ts` | `store/personal.ts` 的 `voiceSettings`、`personal/tts.ts`、`asr/local-models.ts` | `ipc/voice.ts`（热键注册事务 / 听写 / 截图 provider 与前台 pid 冻结）、`ipc/stt.ts`、`capabilities/asr/`（在线与纠错）、`capabilities/sensevoice/`（本地模型、常驻 sidecar 与 PCM 协议）、`capabilities/edge-tts/` |
| **语音助手 / 语音球**（旧「语音聊天」浮层已删；与宠物共用 pet-overlay 窗口互斥显示。管线在主窗口 headless 控制器：录音/VAD/STT → `usePersonalActions().send` 走当前会话（无 active 则续用最近会话并切回，再无则新建），带全部能力注入、执行档强制「自动」（`gui_*` 强制审批红线不动）→ 回合结束经 `voiceTurn` 钩子 TTS 朗读 → 连续对话回环；overlay 只镜像快照渲染语音球） | `personal/voice-assistant/`（`VoiceAssistantController.tsx` headless 控制器（挂 `CortexDesktopView`）、`VoiceOrb.tsx` 语音球（`VOICE_OVERLAY_W/H` 与 main 镜像）、`orbRenderer.ts` canvas 逐帧、`sileroVad.ts` **断句唯一入口**（Silero 神经 VAD 优先，MicVAD 单例跨轮复用；资产缺失自动降级 `vad.ts` 能量 VAD）、`state.ts` 状态机）、`pet/Pet.tsx` 的 `.pet-mic` 悬停入口 | `personal/voiceTurn.ts`（回合完成钩子，`messages.ts` 三处埋点）、`desktop/types.ts` 的 `VoiceAssistant*` 契约 | `ipc/voice-assistant.ts`（窗口编排/状态中继/指令归一 + `toggleVoiceAssistantFromHotkey`）、`pet-overlay-window.ts` 的 `setPetOverlayMode`（pet↔voice 双模式 + 可见性双轴）、`vad-assets.ts`（Silero 资产 `cortex-vad://` 只读协议；资产由 `electron.vite.config.ts` 内联插件拷进 `out/renderer/vad/`，dev 走 http 同源 `/vad/`）、`protocol-schemes.ts`（**全部自定义协议特权的单次注册收口**——`registerSchemesAsPrivileged` 全进程只能调一次，新协议必须并入，不得自行再调） |
| 媒体生成（图像/语音/音乐/视频） | `personal/settings/MediaGenSettingsSection.tsx`（壳：总览 + 四卡组装）、`personal/settings/media-gen/`（`useMediaGenProviders.ts` 目录×认证快照数据层、`MediaGenRows.tsx` 共享行与协议 i18n 查表、`MediaSecretKeyField.tsx` 密钥金库控件（store 只落 `${secret:NAME}` 引用）、`ImageGenCard/SpeechGenCard/MusicGenCard/VideoGenCard.tsx` 各模态卡） | `desktop/media-gen-types.ts`（类型/默认工厂/`normalizeMediaGenSettings`/`MAX_TIMEOUT_MS_BY_MODALITY`，与 main `ipc/types.ts` 双镜像）、`desktop/media-provider-directory.ts`（媒体供应商目录，core 单份、main 直接 import 不镜像） | `capabilities/media-gen/`（`server.ts` 四工具按协议动态 schema；`client.ts` 含 `assertRealWithinWorkspace` symlink 防护与参考图/帧图收集；`protocols/` 按协议拆文件：`shared.ts` 公共工具、`minimax-image/-audio/-video.ts`、`openai-images.ts`） |
| 插件 / 扩展市场 | `personal/plugins/`（`PluginManager.tsx`、`PluginsHome.tsx`、`ExtensionPanel.tsx`） | `personal/extensions.ts` | `ipc/plugins.ts`、`plugins/` |
| 技能（Skill） | `personal/skills/SkillPanel.tsx` | `personal/skill-injection.ts`、`piSkills.ts` | `ipc/skills.ts`、`skills/` |
| 内置默认 skill（随包分发） | — | — | 内容在 `apps/desktop/resources/skills/<name>/`（见该目录 `SOURCE.md`）；**光放目录不会进 `/skill:` 菜单**——`resources/skills` 只喂「按名硬编码取用」那条链（`registry.ts` + `notes.ts` / `artifactDispatch.ts`），会话 skill 链的默认根是 `~/.cortex-desktop/skills`。要对用户可用须加进 `ipc/skills.ts` 的 `DEFAULT_BUILTIN_SKILLS` 白名单，其扫描根**必须 unshift 到最前**（去重是后者胜出，排后面会盖掉用户同名 skill）。落地页入口在 `personal/home/SceneChips.tsx` 的 `SCENES`，中文展示名在 `personal/chat/composer/useSlashCommands.ts` 的 `DOC_SKILL_COMMANDS`（不声明的话扫描项会退化成英文 Title-Case + 「个人」标签） |
| 快速打开 / 斜杠命令 | `personal/projects/QuickOpenDialog.tsx`、`chat/composer/useSlashCommands.ts` | — | — |
| 落地页 / 新会话首页 / 场景快捷入口 | `personal/home/HomeView.tsx`（**HomeBoard = 落地内容单一来源**，`home/NewSessionLanding.tsx` 与 `chat/PersonalChatArea.tsx` 空会话态共用）、`home/SceneChips.tsx`、`home/LandingHero.tsx` | `store/personal.ts`（`composerInsert.skill` 预置 skill pill、`composerSkill` 由 ComposerShell 单向镜像供示例区联动、`openResearch`/`openWriting`/`openAutomation`/`openWorkflow`） | — |
| 归档会话 | `personal/sessions/ArchivedSessionsSection.tsx` | `store/archivedSessions.ts` | — |
| 在编辑器打开（VS Code 等） | — | — | `ipc/editors.ts` |
| 应用更新 | `UpdateButton.tsx`、`UpdateDialog.tsx` | `desktop/useUpdateState.ts` | `ipc/update.ts` |
| 通知卡片（**瞬态**弹窗，看完即弃；要找可回溯的历史见上面「消息中心」） | `NotificationCard.tsx` | — | `ipc/notification-window.ts` |
| 设置（个人工作区整页） | `personal/settings/SettingsMenu.tsx` + 各 `*SettingsSection.tsx` | `store/personal.ts` | `ipc/store.ts`（持久化总仓） |
| 团队工作区（issue/智能体/用量看板） | `CortexDesktopView.tsx`、`Sections.tsx`、`Sidebar.tsx`、`ChatArea.tsx` | `cortex/`、`mock/`、`api/`、`live/` | — |
| 外观 Tweaks（主题/字号/密度） | `useTweaksPersistence.ts` | `store/ui.ts`（`DEFAULT_TWEAKS`，不在 ui 包！） | — |

## 独立窗口清单

用户看到的「另一个窗口」，均为独立渲染进程（HTML 入口在 `renderer/` 下）：

| 名词 | HTML | renderer 入口 | main 侧 |
|---|---|---|---|
| 主窗口 | `index.html` | `src/App.tsx` | `index.ts` |
| Spotlight 浮动框 | `spotlight.html` | `src/spotlight.tsx` | `spotlight.ts`、`hotkey.ts` |
| 闪记浮层 | `notes.html` | `src/notes-overlay.tsx` | `notes-overlay.ts` |
| 桌面宠物（兼语音助手语音球宿主，双模式互斥） | `pet-overlay.html` | `src/pet-overlay.tsx` | `pet-overlay-window.ts` |
| 项目管理 | `projects.html` | `src/projects-window.tsx` | `projects-window.ts` |
| 通知卡片 | `notification.html` | `src/notification-window.tsx` | `notification-window.ts` |
| 快捷回复气泡 | `reply.html` | `src/reply-bubble.tsx` | `reply/bubble-window.ts` |
| Agent 追踪 | `agent-trace.html` | `src/agent-trace.tsx` | `agent-trace-window.ts` |
| 演示放映 | bento `deck.bento.html` | — | `presenter-window.ts` |

## 主进程 IPC 域分组速查

全部在 `main/ipc/`，注册入口 `register.ts`。按职责分五组：

**会话与 Agent 执行**：`cli.ts`（spawn/流式管线，claude/codex；pi 单发走 in-process `agents/pi-inproc/oneshot.ts`）、`ask.ts`（一次性追问）、`chat.ts` + `sessionWriteQueue.ts`（消息持久化）、`session-trim.ts`（编辑重发截断）、`orchestrate.ts`（子 agent 编排，会话生命周期走 `pi-inproc/session-pool.ts`，引擎同为 gateway）、`roundtable.ts`（圆桌）、`roles.ts`（角色库）、`pi-session.ts`（pi 长驻，引擎唯一形态为常驻 gateway worker `agents/pi-gateway/`）/ `pi-extensions-market.ts`（扩展市场与包管理，经 `DefaultPackageManager` 编程接口）、`codex-ws-channel.ts` / `codex-ws-run.ts`（codex 长驻）、`run-retry-policy.ts`（瞬态失败重试）、`provider.ts`（供应商探测）、`llm.ts` + `openai-chat.ts`（LLM 单发补全唯一真源）、`mcp-config.ts`（MCP 注入）、`agent-trace.ts`（追踪窗口）。

**内容与文件**：`fs.ts` / `fs-binary.ts`（读写）、`watch.ts` + `watch-noise.ts`（目录监听）、`git-info.ts`、`image.ts`（图片上传）、`doc.ts`（文档附件）、`editors.ts`（在编辑器打开）、`pty.ts`（终端）、`browser.ts`（内嵌浏览器）。

**用户功能域**：`notes*.ts`（闪记）、`tasks*.ts`（任务）、`timeline.ts`（时间线/日报）、`push.ts`（推送）、`agent-projects.ts`（项目扫描）、`skills.ts`、`plugins.ts`、`voice.ts`（语音热键事务 / 听写）、`voice-assistant.ts`（语音助手窗口编排与状态中继）、`stt.ts`、`memory.ts`、`reply.ts`、`pet.ts`、`petdex.ts`（公共宠物图鉴：manifest 缓存 + sprite 落盘 + LRU 淘汰 + 只读协议）、`spotlight.ts`、`notification-window.ts`、`update.ts`、`app.ts`（语言/托盘）、`store.ts`（`personal-workspace.json` 持久化总仓）、`knowledge.ts`（公司知识库连接配置：令牌 safeStorage 加密落盘 + MCP 连通性自检）。

**写作域**（前缀 `writing-`）：`writing-types.ts`（空间/文档契约）、`writing-llm.ts`（续写 + Cmd-K 改写）、`writing-retrieval.ts`（轻量 RAG）、`writing-pdf.ts`、`writing-export.ts`（DOCX/PDF/PNG/HTML）、`writing-infographic.ts`（信息图）。

**设计 / 演示 / 研究**：`artifact.ts` + `artifact-workspace.ts`（会话产物创建、索引与路径校验）、`design-types.ts`（历史设计工作台持久化契约）、`slides.ts` + `slides-ipc-types.ts`（演示文稿）、`research.ts` + `types-research.ts`（深度研究）、`agent-browser.ts`（Agent 用浏览器）。

主进程另有非 ipc 的功能目录：`agents/`（agent 适配：claude / codex 走 CLI `spawn`；pi 走常驻 gateway worker `agents/pi-gateway/`（长驻会话与编排），单发走 in-process `pi-inproc/oneshot.ts`）、`capabilities/`（给 Agent 的能力：automation / browser / calendar / computer-use / doc-extract / delegate / design-delegate / knowledge / loop-workflows / media-gen / research / slides / whisper / mcp-host——其中 `computer-use` 是唯一不走 MCP 的一个，它以原生 `customTools` / tool-call hook 形式注册进会话，且**只在聊天会话路径**生效；`automation` 与 `calendar` 同样**只在 pi 聊天会话路径注入**（`ipc/pi-session.ts` 一处，`ipc/cli.ts` 刻意不接），因为它们的写工具必须逐次经用户确认，而 claude 走 `--dangerously-skip-permissions`、codex 内置 server 被强制 `approve`、pi 单发路径不注册审批 hook——那些路径上**兑现不了审批**；定时任务自身的执行路径 `automation/runner.ts` 更是绝不注入，无人值守时给 Agent 建/删定时任务的权限等于让它无监督自增殖。这条约束由 `capabilities/automation/inject-points.test.ts` 读源码守住）、`research/`（CRE 引擎：orchestrator / planner / clients / worker / report / SQLite 存储）、`automation/`、`workflow/`、`memory/`、`reply/`、`skills/`、`plugins/`、`browser/`、`log/`。

## packages/core 域速查

| 域 | 对应名词 |
|---|---|
| `design/` | 设计工作台：`canvas/`（画布）、`slides/`（演示文稿）、`directions/`（方向探索）、`design-system/`（设计系统/Tokens）、`code-binding/`（代码同步）、`prototype-flow/` + `prototype-player/`（原型）、`html-quality/`（质量检查）、`design-contract/` + `interop/`（交付/Penpot）、`agent-manager/` + `agent-actions/` + `agent-notes/`（设计智能体）、`run/`（回合派发）、`compat/`（Kun 移植兼容层）、`generator-lane/`（生成流水线） |
| `writing/` | 写作台：spaces / threads / file-tree / inline-edit / review-manager（评审 diff）/ attribution / `run/writing-run-manager.ts` |
| `research/` | 深度研究：protocol / evidence / citation / coverage / trust-policy / ui-store / live-sync（常驻事件订阅）/ report-export（归档文件名与抬头） |
| `personal/` | 个人工作区全部业务纯逻辑：任务、项目阶段、时间线、闪记、@提及、自动化、工作流、分支、推送、权限模式等（一名词一文件，按文件名找） |
| `cortex/`、`live/`、`mock/`、`api/` | 团队工作区服务端态：React Query options / 实时查询 / 假数据 / HTTP client |
| `store/` | 全部 Zustand 客户端态：`ui.ts`（Tweaks）、`personal.ts`（视图开关总店）、`pet.ts`、`piArtifacts.ts`（pi 会话产物）、`memory.ts`、`reply.ts`、`archivedSessions.ts` |
| `desktop/` | 桥接层：`bridge.ts`（`DesktopBridge` 契约）+ 各 `*-types.ts` 类型镜像 + 持久化 wiring hooks |
| `pet/` | 桌面宠物状态机：活动位模型 / `derivePetState` 优先级链 / 去抖引擎 / petdex 网格探测（两端共享） |
| `memory/`、`reply/`、`retrieval/`、`asr/` | 记忆分层模型 / 快捷回复纯逻辑 / BM25 检索原语（写作与 CRE 共用）/ 本地语音模型清单 |
| `i18n/`、`types/` | 多语言单例与资源 / `Tweaks`、`Contact` 等共享类型 |

> 新增 core 对外模块时，须同步更新 `packages/core/package.json` 的 `exports` 子路径（现有约 66 个）。

## 定位技巧与陷阱

- **镜像契约**：`main/ipc/` 与 `core/desktop/` 下的同名 `*-types.ts` 是逐字镜像（`types.ts` / `design-types.ts` / `tasks-types.ts` / `reply-types.ts` / `plugin-types.ts` / `slides-ipc-types.ts` / `writing-*-types.ts` / `petdex-types.ts`↔`types-petdex.ts`），改一处必须改两处。
- **i18n 覆盖不全**：只有团队工作区外壳、设计工作台、设置页走 i18n（`core/i18n/resources/zh-Hans/` 共 10 个 namespace）；个人工作区（会话/写作/研究/任务/自动化）大量中文文案硬编码在组件里。按界面中文词定位时，直接 grep 源码比查 i18n JSON 更可靠。
- **「Tweaks」不在 ui 包**：外观设置在 `core/store/ui.ts` + `views/useTweaksPersistence.ts`；`packages/ui/` 只有图标（`icons/index.tsx`）、4 个基础控件（`controls/`）和 `lib/utils.ts`。
- 目录职责与包边界硬规则见 `docs/floder.md`；可复发问题的排查套路见 `docs/lessons.md`。
