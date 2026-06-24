# 集成 cowart 画布(仅 codex agent)— 需求文档

- 日期:2026-06-21
- 范围层级:Deep — feature(在既有桌面 app 形态内扩展)
- 状态:待规划(交接 ce-plan)

## 背景与问题

[cowart](https://github.com/zhongerxin/cowart) 是一个**面向 Codex 的本地无限画布插件**(基于 tldraw),用于构思、标注、AI 生图、按标注图迭代图片。其工作方式是 Codex 插件机制:

- 安装:`codex plugin add cowart@personal`(需先把仓库放到 `~/plugins/cowart` 并配置个人 marketplace)。
- 能力:提供三个 skills(`cowart:cowart-open-canvas` / `cowart:cowart-imgae-gen` / `cowart:cowart-image-edit`)+ 一组 **MCP 工具**(读画布选区状态、把生成图片插入占位、存本地资源)。
- 运行:起一个本地 HTTP 服务渲染画布(默认 `http://127.0.0.1:43217/`),画布数据落到项目 `canvas/` 目录。
- 配置环境变量:`COWART_PORT`(默认 43217)、`COWART_PROJECT_DIR`、`COWART_CANVAS_DIR`。

我们希望把这套画布体验集成进 Cortex Desktop,让用户在 app 内看到并操作画布、由 **codex agent** 驱动生图与按标注迭代。**只有 codex agent 可以使用**(cowart 本身就是 Codex-only 插件,claude/pi adapter 不涉及)。

### 当前仓库现状(已核实)

- codex adapter:`apps/desktop/src/main/agents/codex.ts`,走 `codex exec --json`(**非交互 print 模式**)。第 42 行 `common.push("-c", "mcp_servers={}")` **故意清空所有 MCP server**,注释写明"纯净启动,只保留全局指令 `~/.codex/AGENTS.md`"。
- 这与 cowart 的核心张力:cowart 依赖 Codex 的 MCP 工具 + 插件 skills,而当前 adapter 恰好把 MCP 清空、且不是交互式 TUI。
- 内置浏览器真实存在:`apps/desktop/src/main/ipc/browser.ts`、`apps/desktop/src/main/browser/`。可用于加载 cowart 画布的 localhost URL。
- 请求契约:`CliStartRequest` 于 `apps/desktop/src/main/ipc/types.ts:285`,含 `permissionMode`(302 行)。
- 全仓**无任何 cowart 引用**,本次为净新增。

## 目标

- 用户在 Cortex Desktop 内,通过 codex agent 会话即可完成 cowart 画布流程:打开画布 → 在画布上标注/放置 AI 图片占位 → 让 codex 生图并插入 → 按标注截图迭代。
- 画布在 app 的**内置浏览器**中展示(复用现有能力,加载 `http://127.0.0.1:<port>/`)。
- 画布既能在 codex 拉起服务后**自动打开**,也能通过 app 的**手动入口**打开。

## 非目标(本次不做)

- **不**由 app 负责安装 cowart 插件 / 配置 marketplace —— 用户按 cowart README 自行安装。app 仅在 codex 运行时不再屏蔽它。
- **不**把 cowart 画布 fork/移植成 app 原生模块;沿用 cowart 上游的 Codex 插件 + 本地 HTTP 服务形态。
- **不**为 claude / pi adapter 提供画布能力。
- **不**自建图片生成后端;生图依赖 cowart 自身配置的后端(模型/API),由用户负责。

## 已确定的产品决策

1. **集成形态**:app 内嵌画布 + codex 驱动。画布即 cowart 的 tldraw Web UI,通过内置浏览器加载,codex agent 运行时往画布生图/按标注迭代。
2. **画布位置**:复用现有**内置浏览器**打开 `localhost:<COWART_PORT>`(默认 43217),不新建独立画布面板。改动最小。
3. **MCP 开口范围**:codex adapter **停止 `mcp_servers={}` 清空**,改为**继承用户 `~/.codex` 配置**(其中含用户已装的 cowart 插件/MCP)。
4. **画布打开时机**:**两者都要** —— (a) codex 启动 cowart 服务后,app 自动在内置浏览器打开画布 URL;(b) 同时提供一个显式"打开画布"入口作为兜底,不依赖解析 codex 输出。

## 功能需求

- FR-1:修改 codex adapter,使 codex 会话能加载用户 `~/.codex` 的插件/MCP 配置(不再强制 `mcp_servers={}`),从而使 cowart 的 MCP 工具与 skills 对 codex 可用。
- FR-2:当 codex 会话触发 cowart 画布启动(本地服务起在 `localhost:<port>`)时,app 自动在内置浏览器打开该画布 URL。
- FR-3:提供一个显式"打开画布"入口(按钮/菜单),点击后在内置浏览器打开画布 URL;必要时先确保服务已起。
- FR-4:画布 URL 的端口需与 cowart 的 `COWART_PORT`(默认 43217)保持一致,支持非默认端口。
- FR-5:画布能力仅对 codex agent 生效;claude / pi 会话行为不变。

## 范围边界

### 暂缓(后续可做)

- 由 app 托管/自动安装 cowart 插件、托管其本地服务生命周期(启动/停止/健康检查)。
- 独立的画布面板视图(与会话并排),替代"内置浏览器 tab"。
- 端口冲突自动协商、多项目多画布并存的管理 UI。

### 不属于本产品身份

- 把画布做成脱离 Codex 的 app 原生绘图工具。

## 关键风险与待定项

- **R-1(头号,需尽早验证)**:Codex 的插件 **skills 在 `codex exec` 非交互模式下是否可用**?skills/斜杠命令可能仅在 TUI 生效。若 exec 模式不加载 skills,则"codex 驱动"需退回**直接调用 cowart 的裸 MCP 工具**(而非 `cowart:cowart-open-canvas` 等 skill)。规划第一步应实测确认。
- **R-2**:停止清空 MCP 后,**所有 codex 会话**都会带上用户的全部 MCP server(不仅 cowart),原"纯净启动"的可预测性/启动开销让步。是已知并接受的取舍,但需在规划中评估是否给一个总开关或排除项作为缓解。
- **R-3**:自动打开(FR-2)需 app 可靠识别"画布服务已起 + URL"。判定来源待定:解析 codex stream 中的工具事件 / 探测 `localhost:<port>` 端口可达 / 约定固定 URL。ce-plan 选型。
- **R-4**:cowart 画布数据写入项目 `canvas/` 目录,依赖明确的 `COWART_PROJECT_DIR`/工作目录映射;与 app 当前 codex `--cd <cwd>` 的对应关系待对齐。

## 依赖与假设

- 假设用户已按 cowart README 完成安装(`codex plugin add cowart@personal`)并配置好生图后端;app 不代为安装/配置。
- 假设用户本地 codex CLI 版本支持插件/MCP 继承(现 adapter 注释基于 codex-cli 0.139.x;cowart 未声明最低版本要求 —— 需在规划期核对)。
- 假设内置浏览器可加载任意 `http://127.0.0.1` 本地 URL(webview 安全策略需确认,见 `apps/desktop/src/main/browser/webviewGuards.ts`)。

## 成功标准

- 在 app 内用 codex agent 发起会话,可让 codex 打开 cowart 画布,且画布自动呈现在内置浏览器中。
- 在画布上放置 AI 图片占位后,经 codex 生图并插入,图片正确出现在画布对应占位。
- 对画布标注/截图后,经 codex 触发迭代,得到修订图片。
- claude / pi 会话不受 MCP 改动影响,行为与改动前一致。

## 交接 ce-plan

规划首要事项:先实测 R-1(exec 模式下 skills vs 裸 MCP 工具的可用性),它决定 FR-1 的具体形态;再定 R-3 的"画布就绪"判定来源与 FR-2/FR-3 的 UI 入口落点。
