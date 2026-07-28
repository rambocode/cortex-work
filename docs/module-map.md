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

## 入口三件套

定位任何功能前，先看这三个「地图文件」：

| 文件 | 作用 |
|---|---|
| `main/ipc/register.ts` | 主进程全部 40+ IPC 域一屏可见，找主进程功能先看这里 |
| `views/personal/PersonalWorkspace.tsx` | 个人工作区三栏容器，主区视图互斥切换总表 |
| `core/store/personal.ts` | 视图开关（`designOpen`/`writingOpen`/…）与个人工作区客户端态总店。注意 `designOpen` 目前**没有任何渲染方**（死开关），新入口勿挂 `openDesign()`，设计稿走 `/skill:design`；深度研究无整窗视图态，入口是会话 `/skill:research`，右栏 `rightView:"research"` 展示 |

## 一级功能名词表

| 名词（含别名） | views | core | main |
|---|---|---|---|
| 会话 / 跑 Agent / CLI 流式管线 | `personal/PersonalChatArea.tsx`、`PersonalComposer.tsx`、`ComposerShell.tsx` | `personal/messages.ts` | `ipc/cli.ts`（spawn+流式）、`ipc/chat.ts`（消息持久化） |
| 追问 / 编辑重发 | `personal/FollowupOverlay.tsx` | `personal/followup.ts` | `ipc/ask.ts`、`ipc/session-trim.ts` |
| 圆桌（多角色 @ 调度） | `personal/MentionAutocomplete.tsx` | `personal/mention.ts` | `ipc/roundtable.ts` |
| 角色库 | `personal/RolesSettingsSection.tsx` | — | `ipc/roles.ts` |
| Agent 适配（claude/codex/pi/自定义） | `personal/AgentSelect.tsx` | — | `agents/`（`index.ts` 注册表、`agent-profiles.ts` 自定义） |
| pi / codex 长驻会话 | — | — | `ipc/pi-session.ts`、`ipc/codex-ws-channel.ts` |
| 供应商 / 模型连接测试 | `personal/ProviderManagerModal.tsx` | — | `ipc/provider.ts`、`ipc/llm.ts`（单发补全） |
| MCP 配置 / 注入 | `personal/McpSection.tsx`、`McpServerForm.tsx` | — | `ipc/mcp-config.ts`、`capabilities/mcp-host/` |
| 执行权限（单轴:计划/询问/自动） | `personal/CustomizePill.tsx` | `personal/permissionMode.ts` | — |
| 子 Agent 编排 / 委派（全局开关在 设置→Agent） | `personal/PersonalProcessPanel.tsx`、`personal/SettingsMenu.tsx` | `store/personal.ts`（GeneralSettings.subagentOrchestration,缺省开） | `ipc/orchestrate.ts`、`capabilities/delegate/` |
| Agent 追踪窗口 | `personal/AgentTracePanel.tsx` | — | `ipc/agent-trace.ts`、`agent-trace-window.ts` |
| Agent 项目扫描（本机项目聚合） | — | — | `ipc/agent-projects.ts` |
| 写作 / 写作台 | `writing/`（`WritingWorkspace.tsx` 三栏容器） | `writing/` | `ipc/writing-*.ts`（见下文写作域） |
| 设计 / 会话产物 / 画布 | `personal/artifactDispatch.ts`（含落盘布局契约）、`design/ArtifactEditorPanel.tsx`、`design/useArtifactConversationTurn.ts` + `design/useDesignArtifactAutoRefresh.ts`（动作回流会话 / 回合结束重扫）、`design/DesignWorkspaceView.tsx`、`design/canvas/` | `personal/messages.ts`（产物 resume 隔离）、`design/`（子域见下文 core 表） | `ipc/artifact.ts`、`ipc/artifact-workspace.ts`、`ipc/design-types.ts` |
| 演示文稿 / Slides / 放映 | `design/ArtifactEditorPanel.tsx`、`design/slides/SlidesWorkspace.tsx`、`design/useArtifactConversationTurn.ts`（面板动作回流发起会话） | `design/slides/`（含 `bento/`、`slides-text-files.ts`）、`design/artifact-turn-dispatch.ts`（回合派发端口，与设计稿共用） | `ipc/artifact.ts`、`ipc/slides.ts`、`capabilities/slides/`、`capabilities/research/inject.ts`（会话级联网准入）、`presenter-window.ts` |
| 研究 / 深度研究（CRE） | `research/`（`ResearchArtifactPanel.tsx` 右栏面板 + `ResearchRunView` 等子组件；入口是会话 `/skill:research`，派发在 `personal/researchDispatch.ts`，已无整窗覆盖层） | `research/` | `research/`（引擎，报告归档见 `research/report-archive.ts`）、`ipc/research.ts`、`capabilities/research/`；chat 与 slides 均由各自会话栏按轮准入 |
| 任务 | `personal/TasksView.tsx`、`TaskDetail.tsx`、`Task*Field.tsx` | `personal/tasks.ts`、`taskTree.ts` 等 | `ipc/tasks*.ts`、`tasks-reminder-scheduler.ts` |
| 项目管理 / 项目阶段（独立窗口） | `personal/ProjectsWorkbench.tsx`、`ProjectStagesBar.tsx`、`StageTimeline*.tsx` | `personal/projectStages.ts`、`stageTemplates.ts` | `projects-window.ts` |
| 闪记（Flash Notes） | `personal/NotesView.tsx`、`FlashNoteEditor.tsx` | `personal/notes.ts` | `ipc/notes*.ts`、`notes-overlay.ts`（浮层窗口） |
| 时间线 / 日报 | `personal/TimelineView.tsx` | `personal/timeline.ts` | `ipc/timeline.ts` |
| 自动化（定时任务） | `personal/AutomationView.tsx`、`Automation*.tsx` | `personal/automation.ts` | `automation/`（scheduler/runner/store） |
| Loop 工作流 | `personal/WorkflowView.tsx`、`WorkflowCanvas.tsx` 等 | `personal/workflow.ts` | `workflow/`（DSL/scheduler/webhook）、`capabilities/loop-workflows/` |
| 推送（企微/钉钉/飞书/邮件） | 设置分区 | `personal/push.ts` | `ipc/push.ts` |
| 桌面宠物 | `pet/`（状态机 + sprite） | `store/pet.ts` | `ipc/pet.ts`、`pet-overlay-window.ts` |
| 快捷回复 | renderer `src/reply-bubble.tsx`；设置 `personal/ReplySettingsSection.tsx` | `reply/` | `reply/`（controller/气泡窗）、`ipc/reply.ts` |
| Spotlight 浮动框 / 全局热键 | renderer `src/spotlight.tsx` | `personal/spotlightHandoff.ts` | `ipc/spotlight.ts`、`hotkey.ts` |
| 记忆 / 做梦 | `personal/MemorySettingsSection.tsx`、`ResearchMemoryCandidates.tsx` | `memory/` | `ipc/memory.ts`、`memory/`（dreamer/scheduler） |
| 内嵌浏览器 / 页面标注 | `personal/BrowserView.tsx`、`BrowserAnnotator.tsx` | — | `ipc/browser.ts`、`browser/`、`capabilities/browser/` |
| 内嵌终端 | `personal/TerminalPanel.tsx` | — | `ipc/pty.ts` |
| 文件树 / 文件预览 / Git 信息条 | `personal/FilesView.tsx` + 各 Viewer（`MarkdownView`/`MonacoViewer`/`PdfViewer`/`DocxViewer`/`PptxViewer`/`sheet/`） | `personal/filePaths.ts` | `ipc/fs.ts`、`ipc/watch.ts`、`ipc/git-info.ts` |
| 图片 / 文档上传 | `personal/PersonalComposer.tsx` | — | `ipc/image.ts`、`ipc/doc.ts`、`capabilities/doc-extract/` |
| 语音输入 / 语音转文字（STT） | `personal/useComposerVoice.ts`、`SttLocalWhisperPanel.tsx` | `whisper/models.ts` | `ipc/stt.ts`、`capabilities/whisper/` |
| 语音播报（TTS） | 设置「语音」分区 | `personal/tts.ts` | — |
| 媒体生成（图像/语音/音乐/视频） | `personal/MediaGenSettingsSection.tsx` | — | `capabilities/media-gen/` |
| 插件 / 扩展市场 | `personal/PluginManager.tsx`、`PluginsHome.tsx`、`ExtensionPanel.tsx` | `personal/extensions.ts` | `ipc/plugins.ts`、`plugins/` |
| 技能（Skill） | `personal/SkillPanel.tsx` | `personal/skill-injection.ts`、`piSkills.ts` | `ipc/skills.ts`、`skills/` |
| 内置默认 skill（随包分发） | — | — | 内容在 `apps/desktop/resources/skills/<name>/`（见该目录 `SOURCE.md`）；**光放目录不会进 `/skill:` 菜单**——`resources/skills` 只喂「按名硬编码取用」那条链（`registry.ts` + `notes.ts` / `artifactDispatch.ts`），会话 skill 链的默认根是 `~/.cortex-desktop/skills`。要对用户可用须加进 `ipc/skills.ts` 的 `DEFAULT_BUILTIN_SKILLS` 白名单，其扫描根**必须 unshift 到最前**（去重是后者胜出，排后面会盖掉用户同名 skill）。落地页入口在 `personal/SceneChips.tsx` 的 `SCENES`，中文展示名在 `personal/useSlashCommands.ts` 的 `DOC_SKILL_COMMANDS`（不声明的话扫描项会退化成英文 Title-Case + 「个人」标签） |
| 快速打开 / 斜杠命令 | `personal/QuickOpenDialog.tsx`、`useSlashCommands.ts` | — | — |
| 落地页 / 新会话首页 / 场景快捷入口 | `personal/HomeView.tsx`（**HomeBoard = 落地内容单一来源**，`NewSessionLanding.tsx` 与 `PersonalChatArea.tsx` 空会话态共用）、`SceneChips.tsx`、`LandingHero.tsx` | `store/personal.ts`（`composerInsert.skill` 预置 skill pill、`composerSkill` 由 ComposerShell 单向镜像供示例区联动、`openResearch`/`openWriting`/`openAutomation`/`openWorkflow`） | — |
| 归档会话 | `personal/ArchivedSessionsSection.tsx` | `store/archivedSessions.ts` | — |
| 在编辑器打开（VS Code 等） | — | — | `ipc/editors.ts` |
| 应用更新 | `UpdateButton.tsx`、`UpdateDialog.tsx` | `desktop/useUpdateState.ts` | `ipc/update.ts` |
| 通知卡片 | `NotificationCard.tsx` | — | `ipc/notification-window.ts` |
| 设置（个人工作区整页） | `personal/SettingsMenu.tsx` + 各 `*SettingsSection.tsx` | `store/personal.ts` | `ipc/store.ts`（持久化总仓） |
| 团队工作区（issue/智能体/用量看板） | `CortexDesktopView.tsx`、`Sections.tsx`、`Sidebar.tsx`、`ChatArea.tsx` | `cortex/`、`mock/`、`api/`、`live/` | — |
| 外观 Tweaks（主题/字号/密度） | `useTweaksPersistence.ts` | `store/ui.ts`（`DEFAULT_TWEAKS`，不在 ui 包！） | — |

## 独立窗口清单

用户看到的「另一个窗口」，均为独立渲染进程（HTML 入口在 `renderer/` 下）：

| 名词 | HTML | renderer 入口 | main 侧 |
|---|---|---|---|
| 主窗口 | `index.html` | `src/App.tsx` | `index.ts` |
| Spotlight 浮动框 | `spotlight.html` | `src/spotlight.tsx` | `spotlight.ts`、`hotkey.ts` |
| 闪记浮层 | `notes.html` | `src/notes-overlay.tsx` | `notes-overlay.ts` |
| 桌面宠物 | `pet-overlay.html` | `src/pet-overlay.tsx` | `pet-overlay-window.ts` |
| 项目管理 | `projects.html` | `src/projects-window.tsx` | `projects-window.ts` |
| 通知卡片 | `notification.html` | `src/notification-window.tsx` | `notification-window.ts` |
| 快捷回复气泡 | `reply.html` | `src/reply-bubble.tsx` | `reply/bubble-window.ts` |
| Agent 追踪 | `agent-trace.html` | `src/agent-trace.tsx` | `agent-trace-window.ts` |
| 演示放映 | bento `deck.bento.html` | — | `presenter-window.ts` |

## 主进程 IPC 域分组速查

全部在 `main/ipc/`，注册入口 `register.ts`。按职责分五组：

**会话与 Agent 执行**：`cli.ts`（spawn/流式管线）、`ask.ts`（一次性追问）、`chat.ts` + `sessionWriteQueue.ts`（消息持久化）、`session-trim.ts`（编辑重发截断）、`orchestrate.ts`（子 agent 编排）、`roundtable.ts`（圆桌）、`roles.ts`（角色库）、`pi-session.ts` / `pi-extensions-market.ts`（pi 长驻）、`codex-ws-channel.ts` / `codex-ws-run.ts`（codex 长驻）、`run-retry-policy.ts`（瞬态失败重试）、`provider.ts`（供应商探测）、`llm.ts` + `openai-chat.ts`（LLM 单发补全唯一真源）、`mcp-config.ts`（MCP 注入）、`agent-trace.ts`（追踪窗口）。

**内容与文件**：`fs.ts` / `fs-binary.ts`（读写）、`watch.ts` + `watch-noise.ts`（目录监听）、`git-info.ts`、`image.ts`（图片上传）、`doc.ts`（文档附件）、`editors.ts`（在编辑器打开）、`pty.ts`（终端）、`browser.ts`（内嵌浏览器）。

**用户功能域**：`notes*.ts`（闪记）、`tasks*.ts`（任务）、`timeline.ts`（时间线/日报）、`push.ts`（推送）、`agent-projects.ts`（项目扫描）、`skills.ts`、`plugins.ts`、`stt.ts`、`memory.ts`、`reply.ts`、`pet.ts`、`spotlight.ts`、`notification-window.ts`、`update.ts`、`app.ts`（语言/托盘）、`store.ts`（`personal-workspace.json` 持久化总仓）。

**写作域**（前缀 `writing-`）：`writing-types.ts`（空间/文档契约）、`writing-llm.ts`（续写 + Cmd-K 改写）、`writing-retrieval.ts`（轻量 RAG）、`writing-pdf.ts`、`writing-export.ts`（DOCX/PDF/PNG/HTML）、`writing-infographic.ts`（信息图）。

**设计 / 演示 / 研究**：`artifact.ts` + `artifact-workspace.ts`（会话产物创建、索引与路径校验）、`design-types.ts`（历史设计工作台持久化契约）、`slides.ts` + `slides-ipc-types.ts`（演示文稿）、`research.ts` + `types-research.ts`（深度研究）、`agent-browser.ts`（Agent 用浏览器）。

主进程另有非 ipc 的功能目录：`agents/`（CLI 适配器）、`capabilities/`（给 Agent 的 MCP 能力：browser / doc-extract / delegate / design-delegate / loop-workflows / media-gen / research / slides / whisper / mcp-host）、`research/`（CRE 引擎：orchestrator / planner / clients / worker / report / SQLite 存储）、`automation/`、`workflow/`、`memory/`、`reply/`、`skills/`、`plugins/`、`browser/`、`log/`。

## packages/core 域速查

| 域 | 对应名词 |
|---|---|
| `design/` | 设计工作台：`canvas/`（画布）、`slides/`（演示文稿）、`directions/`（方向探索）、`design-system/`（设计系统/Tokens）、`code-binding/`（代码同步）、`prototype-flow/` + `prototype-player/`（原型）、`html-quality/`（质量检查）、`design-contract/` + `interop/`（交付/Penpot）、`agent-manager/` + `agent-actions/` + `agent-notes/`（设计智能体）、`run/`（回合派发）、`compat/`（Kun 移植兼容层）、`generator-lane/`（生成流水线） |
| `writing/` | 写作台：spaces / threads / file-tree / inline-edit / review-manager（评审 diff）/ attribution / `run/writing-run-manager.ts` |
| `research/` | 深度研究：protocol / evidence / citation / coverage / trust-policy / ui-store / live-sync（常驻事件订阅）/ report-export（归档文件名与抬头） |
| `personal/` | 个人工作区全部业务纯逻辑：任务、项目阶段、时间线、闪记、@提及、自动化、工作流、分支、推送、权限模式等（一名词一文件，按文件名找） |
| `cortex/`、`live/`、`mock/`、`api/` | 团队工作区服务端态：React Query options / 实时查询 / 假数据 / HTTP client |
| `store/` | 全部 Zustand 客户端态：`ui.ts`（Tweaks）、`personal.ts`（视图开关总店）、`pet.ts`、`memory.ts`、`reply.ts`、`archivedSessions.ts` |
| `desktop/` | 桥接层：`bridge.ts`（`DesktopBridge` 契约）+ 各 `*-types.ts` 类型镜像 + 持久化 wiring hooks |
| `memory/`、`reply/`、`retrieval/`、`whisper/` | 记忆分层模型 / 快捷回复纯逻辑 / BM25 检索原语（写作与 CRE 共用）/ 语音模型清单 |
| `i18n/`、`types/` | 多语言单例与资源 / `Tweaks`、`Contact` 等共享类型 |

> 新增 core 对外模块时，须同步更新 `packages/core/package.json` 的 `exports` 子路径（现有约 59 个）。

## 定位技巧与陷阱

- **镜像契约**：`main/ipc/` 与 `core/desktop/` 下的同名 `*-types.ts` 是逐字镜像（`types.ts` / `design-types.ts` / `tasks-types.ts` / `reply-types.ts` / `plugin-types.ts` / `slides-ipc-types.ts` / `writing-*-types.ts`），改一处必须改两处。
- **i18n 覆盖不全**：只有团队工作区外壳、设计工作台、设置页走 i18n（`core/i18n/resources/zh-Hans/` 共 10 个 namespace）；个人工作区（会话/写作/研究/任务/自动化）大量中文文案硬编码在组件里。按界面中文词定位时，直接 grep 源码比查 i18n JSON 更可靠。
- **「Tweaks」不在 ui 包**：外观设置在 `core/store/ui.ts` + `views/useTweaksPersistence.ts`；`packages/ui/` 只有图标（`icons/index.tsx`）、4 个基础控件（`controls/`）和 `lib/utils.ts`。
- 目录职责与包边界硬规则见 `docs/floder.md`；可复发问题的排查套路见 `docs/lessons.md`。
