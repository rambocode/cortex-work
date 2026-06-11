# 团队/个人工作区双 Tab 功能

计划详情见 `/Users/mike/.claude/plans/squishy-enchanting-wreath.md`（已获批准）。

## 任务清单

- [x] 阶段 0：顶层 Tab 骨架（ui store + WorkspaceTabs + PersonalWorkspace 占位）
- [x] 阶段 1：Electron main fs/持久化 IPC + preload + core DesktopBridge
- [x] 阶段 2：usePersonalStore + 持久化 wiring
- [x] 阶段 3：PersonalSidebar + PromptPanel + PromptEditor
- [x] 阶段 4：MessageStream 复用 + PersonalChatArea / PersonalComposer
- [x] 阶段 5：Claude CLI 接入（spawn + stream-json + --resume）
- [x] 阶段 6：拖曳 Prompt → Composer 附件（--append-system-prompt 注入）
- [x] 验证：typecheck/lint/test 全绿 + 实测 stream-json 格式 + 桌面端截图确认渲染
- [ ] 用户验收测试（进行中，由用户自行测试）

## 执行结果

- 质量门：`pnpm typecheck` 0 错误、`pnpm lint` 0 警告、`pnpm test` 25 个测试全过（含 claude adapter 11 个新单测）。
- 实测 claude 2.1.172 的 `--output-format stream-json --verbose --include-partial-messages` 输出，parser 与实际格式一致（init/text_delta/tool_use/result）。
- 桌面端运行截图确认：双 tab 切换、项目/Session 列表、真实 claude 流式输出渲染、Prompt 库面板均正常。
- 持久化确认：`~/Library/Application Support/Cortex Desktop/personal-workspace.json` 正确记录项目、session 与捕获到的 claudeSessionId（多轮 --resume 链路通）。

## 关键设计决策

- claude 以 `--dangerously-skip-permissions` 运行（与用户终端 alias 习惯一致，print 模式下否则工具调用会被拒）。
- 「Skills 开/关」pill 映射 `--disable-slash-commands`（关闭 = 不带 agent 自身 skills）。
- 拖入的 Prompt md 经 `--append-system-prompt` 以 `<skill>` 包裹注入。
- codex 仅 adapter 占位（`apps/desktop/src/main/agents/codex.ts`），接入时实现 buildArgs/parseLine 即可。
- 消息流存 React Query cache（不持久化）；项目/session 元数据持久化在主进程 userData JSON。

## 验收反馈修复（第一轮）

- [x] agentLog 工具调用日志：个人工作区运行中默认展开，结束自动收起（显示步数），点击标题可展开/收起（`collapsibleLogs` prop，团队侧不受影响）。
- [x] agent 输出按 Markdown 渲染：views 新增 `react-markdown` + `remark-gfm`，`TextMessage` 增 `markdown` prop（仅 agent 消息、用户消息保持纯文本），新增 `.md-body` 样式（标题/列表/代码块/表格/引用）。
- [x] Agent 选择器位置错乱：根因是 `.ch-meta` `flex-shrink:0` + 长项目路径 nowrap 把 header 顶出去；改为 `pw-head-meta` 可收缩 + 路径 ellipsis，选择器移入独立的 `.pw-head-controls`。

## 验收反馈修复（第二轮）

- [x] 历史 session 消息持久化：主进程新增 `chat:load/chat:save` IPC（`userData/personal-chats/<sessionId>.json`，原子写 + 按 session 串行队列）；`usePersonalChat` 的 queryFn 从磁盘加载历史；缓存每次变更节流 600ms 落盘，一轮 CLI 结束立即冲刷；落盘前清理瞬态（typing 丢弃、运行中 agentLog 标记完成）；发送前 `ensureChatLoaded` 防止首条写入覆盖磁盘历史。

## 验收反馈修复（第三轮）

- [x] 「Agent 一直卡在运行中 / 停止按钮无效」：根因是 renderer 被 HMR/刷新重载后，内存中的 runId→session 注册表丢失，后续 CLI 事件与 exit 事件全被丢弃。修复：
  - 主进程在 `cli:event` / `cli:exit` 中回显 `sessionId`；renderer 收到未知 runId 的事件时按 sessionId 重建运行状态，流式渲染无缝恢复。
  - exit 事件找不到注册表时按 sessionId 兜底清理（清 typing、收尾 agentLog、复位 running、冲刷落盘）。
  - 停止按钮：`cli:kill` SIGTERM 3 秒未退升级 SIGKILL；renderer 侧 4 秒未收到 exit 事件则强制复位 UI。
  - 历史加载时同样清理瞬态状态（双保险）。

## 验收反馈修复（第四轮）

- [x] session 标题自动生成（全异步）：首次发送先用首条消息截断（≤16 字）占位，主对话 spawn 成功后后台 `cli:oneshot`（`claude -p --output-format text --model haiku`，30s 超时，中性目录运行不加载项目上下文）生成 ≤12 字概括标题，完成后替换（仅当标题仍为占位值，避免覆盖手动修改）；codex/失败时保留截断标题。
- [x] 持久化迁移到 `~/.cortex-desktop/`：`personal-workspace.json` + `chats/<sessionId>.json`，新增 `apps/desktop/src/main/paths.ts` 统一管理；启动后首次访问自动从旧 userData 位置幂等迁移（rename 优先，失败回退复制）。

## 验收反馈修复（第五轮）

- [x] 个人工作区隐藏顶部 Projects/Issues/Autopilot 导航（TitleBar 增 `personal` prop）。
- [x] 顶栏右侧新增「终端」开关与「折叠右侧面板」按钮（右栏复用 ui store 的 `rightOpen`）。
- [x] 底部内嵌终端（参考 fanbox）：xterm.js + node-pty（1.1.0 自带 N-API 预编译,无需 electron-rebuild）。主进程 `pty:spawn/input/resize/kill` + `pty:data/exit` 推送;单终端,cwd = 当前项目;收起面板保留进程;进程退出回车重开;可拖拽调高（120–600px）;xterm 动态 import + 核心 CSS 内嵌进 cortex-desktop.css（规避 Next 对 node_modules CSS 限制）;GUI locale 兜底 UTF-8。

## 验收反馈修复（第六轮）

- [x] 终端启动失败 `posix_spawnp failed`：根因是 pnpm 安装 node-pty 预编译产物时丢失 `spawn-helper` 执行权限。已 chmod 修复当前安装,并在主进程 `loadPty()` 加入运行时自愈（`fixSpawnHelperPerms`）;独立脚本验证 spawn + 双向 IO 正常。
- [x] 终端布局调整：终端面板移到 `pw-main` 底部,横跨聊天区 + Prompt 库（`pw-upper` 包裹 chat + PromptPanel）。
- [x] 工具栏对齐 fanbox：多标签（可切换/关闭/新建）+ 启动 Claude / Codex 按钮（向当前终端写入命令）+ 铺满切换（`:has` 隐藏上方区域）+ ✕ 收起;每个标签独立 PTY,关标签 kill,收起面板保留进程,ResizeObserver 自动 fit。

## 验收反馈修复（第七轮）

- [x] 终端视觉对齐 fanbox 截图：采用 fanbox `warm` 皮肤同款 ANSI 主题（奶油底 #ece2d2 + 暖色 16 色板 + `minimumContrastRatio: 4.5`）；工具栏改浅色；标签名改为目录名（项目名/`~`）并带运行状态点（绿=运行中,灰=已退出）。

## 验收反馈修复（第八轮）

- [x] 终端标签实时显示 shell 所在目录：主进程新增 `pty:cwd`（lsof 查 PTY 子进程真实 cwd + \xNN 转义还原,fanbox 同款）;renderer 面板可见时每 2.5s 刷新标签名为目录 basename,跟随 `cd` 变化。
- [x] 终端底色改为 #FDF9EF（xterm theme background/cursorAccent + 面板/活动标签同步,工具栏 #f8f2e4 区分层次）。

## 验收反馈修复（第九轮）

- [x] 左栏底部「AGENT 用量」面板（移植 fanbox server.js 1227-1410）：
  - Claude token 三连（近5h/今日/本周）：增量解析 `~/.claude/projects/**/*.jsonl`（mtime≤8天,文件 offset 增量缓存 + message.id 去重 + 30s 结果缓存）。
  - Claude 官方限额：Keychain/credentials 取 OAuth token → 系统 curl 打 `api.anthropic.com/api/oauth/usage`（TLS 指纹原因不能用 Node https;macOS 系统代理兜底）→ 5h/周窗口百分比 + 重置时间。
  - Codex：`~/.codex/sessions/**/rollout-*.jsonl` 尾读最后一条 rate_limits 快照（plan 徽章/5h/周配额/快照时间,过期归零标 stale）。
  - UI：可折叠,展开时 60s 轮询;进度条 ≥85% 标红;重置时间格式「周X HH:MM 重置」。

## 验收反馈修复（第十轮）

- [x] 右栏改多视图（PersonalRightPanel,顶部「文件 / Skills」tab）：
  - 文件视图（FilesView）：「全部文件」= 项目目录全量文件树（`fs:scanDirTree`,跳过 node_modules/.git）;「最近变更」= `fs:gitChanges`（git status --porcelain,非 git 仓库回退 mtime 最近修改 top30）;点文件预览内容,变更文件优先 `fs:gitDiff`（+/− 着色）,untracked/无 diff 回退内容预览。
  - Skills 视图 = 原 PromptPanel（bare 嵌入模式,拖入聊天等能力不变）。
  - 终端保持底部位置不动。

## 验收反馈修复（第十一轮）

- [x] 去掉右栏内的「文件 / Skills」tab 行，改为顶栏面板按钮下拉菜单选择（参考 Conductor 风格）：菜单含 文件 / Skills / 终端（带当前态勾选）+ 收起/展开右侧面板；`rightView` 状态提升到 usePersonalStore。

## 验收反馈修复（第十二轮）

- [x] 桌面宠物「小柯」：纯 SVG+CSS 动画橘猫,全局浮层,7 态状态机（idle 呼吸眨眼甩尾 / typing 竖耳盯输入 / thinking 思考泡泡 / working 齿轮敲爪冒汗 / replying 笑眼说话气泡 / sleeping 闭眼 Zzz / happy 跳跃爱心）;状态接线:输入框 onChange→typing,CLI send→thinking,tool→working,text→replying,exit→happy/idle,2 分钟无活动→sleeping;core 新增 usePetStore。
- [x] 宠物可拖动（pointer capture + 4px 阈值区分点击,位置存 localStorage,resize 夹回可视区）+ 悬停伪 3D 视差倾斜（perspective + rotateX/Y 跟随光标）。
- 3D 评估：真 3D 需 three.js + 带骨骼动画的 GLB 模型资产（体积/授权/状态动画制作成本高）,当前先以伪 3D 视差提升立体感,真 3D 留作可选演进。

## 验收反馈修复（第十三轮）

- [x] 宠物造型库：新增 3 个造型（阿柴·柴犬/团子·兔子/比特·机器人）,与小柯·橘猫共用状态机和动画类名骨架（`pet/designs.tsx`,各造型内联 transformOrigin 标定支点）;`usePetStore` 增 `kind`,localStorage 持久化。
- [x] 个人工作区左栏底部新增「设置」入口,弹出层对话框形式:左侧 Tab 菜单（宠物/外观）+ 右侧详细内容;ESC/遮罩/✕ 关闭。
- [x] Tweaks 迁移:右下角浮动 Tweaks 按钮移除,布局密度/品牌色调/侧栏样式 全部迁入设置弹层「外观」Tab。
- 注:按用户要求,后续验证由人工测试。

## 验收反馈修复（第十四轮）

- [x] 输入框 slash 命令 `/clear`：清空当前聊天框显示但不删除历史——实现为内存清屏标记（`clearedCountBySession`,隐藏前 N 条,仅影响显示）,磁盘历史文件不动,重启/重开后完整恢复;输入 `/` 前缀时浮现命令提示,可点击补全;claude 侧 `--resume` 上下文不受影响。
- [x] slash 命令快捷匹配 + Tab 执行：输入 `/` 前缀即时过滤命令注册表（`SLASH_COMMANDS`,可扩展）;唯一匹配时按 Tab **直接执行**（提示行显示「Tab 执行」徽章）,多个匹配时 Tab 补全第一个;点击提示行也直接执行。

## 遗留事项

- codex CLI 接入（本期范围外）。
- Prompt 编辑器为纯文本 textarea（MVP），后续可换 markdown 编辑器。
- ~~消息历史不持久化~~（第二轮已实现持久化）。
