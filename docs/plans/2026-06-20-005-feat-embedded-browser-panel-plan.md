---
title: "feat: 集成内嵌浏览器面板与 agent 输出浏览器预览"
type: feat
date: 2026-06-20
deepened: 2026-06-20
revised: 2026-06-21
depth: deep
status: ready
reference_repo: ~/source/ai/Kun
---

# feat: 集成内嵌浏览器面板与 agent 输出浏览器预览

借鉴 `~/source/ai/Kun`（Electron 应用）的浏览器集成方案，为 cortex-work 桌面端新增一个**右栏内嵌浏览器面板**，并让 **agent 输出支持「用浏览器打开」**：从 agent 流式输出中探测本地 dev 预览 URL，以卡片入口或自动打开的方式载入内嵌浏览器。

> **架构选择（2026-06-21 用户定调，覆盖原 WebContentsView 方案）**：内嵌实现采用 Kun 的 **Electron `<webview>` 标签**（而非 `WebContentsView`）。决定性理由是**未来演进方向**——「用户在页面上标注 → 把标注发给 agent → 实现可视化编辑」。`<webview>` 把页面渲染进**渲染进程的 DOM 树**，使得在其上叠加 DOM 标注浮层、取元素、注入取色/选区脚本成为自然之事；`WebContentsView` 是主进程托管的**原生层、永远盖在 DOM 之上**，无法用 DOM 浮层标注。详见 [KTD1](#ktd1-内嵌实现采用-kun-的-webview承载可视化标注未来)。

> **借鉴 = 几乎照搬 + 放宽 allow-list**：直接移植 Kun 的 `DevBrowserPanel`（webview/iframe 双实现）、探测逻辑（`dev-preview-detection.ts`）、URL allow-list（`dev-preview-url.ts`）、三道 webview 闸门（`installDevPreviewWebviewGuards`）。**唯一实质放宽**：Kun 的内嵌只服务本地/私网，本计划地址栏要支持**任意 https 公网站点**，故闸门从「local-only allow-list」改为「严格 scheme 白名单 + 公网 origin 禁跳私网」（见 [KTD2](#ktd2-webview-安全闸门承载任意-https--安全评审不变量)）。

**Target repo:** 当前仓库（cortex-work）。下文所有 `**Files:**` 路径均为本仓库相对路径。`~/source/ai/Kun` 是**参考仓库**，其路径仅作借鉴来源标注。

---

## Summary

- **新增能力一**：右栏一个内嵌浏览器面板（`RightView = "browser"`），含地址栏、前进/后退/刷新/停止、加载与错误态。基于 Electron `<webview>`（Web 端 `<iframe>` 回退）。地址栏可输入**任意 https 公网站点**，也能预览本地 dev server（localhost/私网）。
- **新增能力二**：从 agent 输出（个人区消息）探测本地 dev 预览 URL —— 一般展示「打开预览」卡片（card 模式），输出明确像 dev server 时**自动打开**（auto_open 模式，**仅环回地址**），并过滤 `/health` `/metrics` 等非页面端点。
- **架构定位**：`<webview>` 活在**渲染进程 DOM 树**里（右栏 React 子树），导航/历史/状态全在渲染端用 webview 元素 API 处理（Kun `DevBrowserPanel` 模式）；主进程只做**安全闸门**（`will-attach-webview` 强制 webPreferences + partition + 权限 deny-by-default）。因 webview 在 DOM 内，CSS 定尺寸，**无需** bounds-sync IPC——这同时是「未来可叠加标注浮层」的前提。
- **复用既有**：外链（含 webview 内 `window.open` / 越界导航）一律走现有 `shell:openExternal` → 系统默认浏览器，对齐仓库既有 `bridge.openExternal` 约定。
- **未来钩子**：webview 模型为「标注 → agent → 可视化编辑」预留扩展点（webview 专用标注 preload + DOM 浮层 + `executeJavaScript` 取元素），本计划**不实现**，见 [Future Considerations](#future-considerations)。

---

## Problem Frame

cortex-work 当前**完全没有任何内嵌 web 能力**（全仓零 `webview` / `BrowserView` / `WebContentsView` / `iframe`），唯一的「外部内容」通路是 `shell:openExternal`（仅 http/https，把链接交给系统浏览器）。当 agent 帮用户起了一个本地 dev server 并在输出里打印 `http://localhost:5173` 时，用户只能手动复制到外部浏览器，**预览与对话割裂**。

目标是把「agent 起服务 → 预览结果」收进应用内：agent 输出里的本地 URL 可一键（或自动）在右栏内嵌浏览器打开，同时这个浏览器面板本身也能当作应用内浏览器使用。**更进一步**（本计划只奠定基础、不实现），webview 内嵌为后续「在页面上标注并回传 agent 做可视化编辑」铺路——这是选 `<webview>` 而非 `WebContentsView` 的根本动机。

**非目标**见 [Scope Boundaries](#scope-boundaries)。

---

## Key Technical Decisions

### KTD1. 内嵌实现采用 Kun 的 `<webview>`（承载可视化标注未来）

承载内容用 Electron `<webview>` 标签（Web 端 `<iframe>` 回退），**不用** `WebContentsView`。

**决定性理由——可视化标注未来**：`<webview>` 把页面渲染进**渲染进程的 DOM 树**，是 React 树里的一个自定义元素。于是：
- 可在其上用**绝对定位 DOM 浮层**画标注框、放标注工具条、做选区高亮——`WebContentsView` 是原生层、永远盖在 DOM 之上，DOM 浮层压不住它，标注无从叠加。
- 可给 webview 挂**专用标注 preload** + `webview.executeJavaScript()` 注入取元素/取色脚本，把用户圈选的 DOM 节点/坐标回传，再发给 agent 做可视化编辑。

**附带收益（相对 WebContentsView 方案）**：
- **布局大幅简化**：webview 由 CSS/flex 定尺寸，**取消** bounds-sync IPC、`ResizeObserver`→IPC、rAF 节流、原生层遮挡处理（原方案的 KTD5 整块复杂度消失）。
- **跨进程面收窄**：导航/历史/状态在渲染端用 webview 元素 API 完成，主进程几乎只剩"装闸门"，IPC 仅余「清除浏览数据」一条。
- **Web 端可降级**：用 Kun 的 `canUseElectronWebviewEnvironment`（`openExternal` 存在 + UA 含 `Electron/`）特征探测，非 Electron 回退 `<iframe>`（功能受限但不崩），契合 `packages/views` 的 Web/Desktop 复用边界（不 import 任何 Electron 模块）。

**接受的取舍**：
- `<webview>` 被 Electron 官方标注"不推荐"、未来 API 不保证稳定。**缓解**：webview 是声明式、可放进 React 树、支持 partition 隔离，且我们对宿主完全可控；安全靠主进程三道闸门兜底（KTD2）。若 Electron 未来移除 webview，再评估迁移——但 WebContentsView 无法满足标注诉求，故现在选 webview 是产品方向决定的，非技术惰性。
- 隔离强度略弱于 WebContentsView（同属 out-of-process iframe，但与宿主关系更近）。**缓解**：`will-attach-webview` 强制安全 webPreferences + 独立 partition + 不注入业务 preload（KTD2）。

### KTD2. webview 安全闸门：承载任意 https + 安全评审不变量

移植 Kun 的三道闸门（参考 `~/source/ai/Kun/src/main/index.ts:287` `installDevPreviewWebviewGuards`），但因地址栏要支持**任意 https**，把「local-only allow-list」放宽为「严格 scheme 白名单 + 公网 origin 禁跳私网」。主进程在 `app.on('web-contents-created')` 安装：

- **`will-attach-webview`**：强制覆盖 webview 的 `webPreferences`——删除任何业务 preload、`nodeIntegration:false` / `nodeIntegrationInSubFrames:false` / `contextIsolation:true` / `sandbox:true` / `webSecurity:true` / `allowRunningInsecureContent:false`，强制 `partition:'persist:browser-panel'`（防渲染端被篡改绕过）。校验初始 `src` 的 scheme。
- **`will-navigate` / `will-redirect`**（webview 的 webContents）：**严格 scheme 白名单**——仅放行 `https:` 与 环回/私网 `http:`，**其余一切拒绝**（显式覆盖 `javascript:`/`data:`/`blob:`/`about:`/`file:`/自定义协议）；**公网 origin 禁跳私网/环回**（区分"用户地址栏主动输本地" vs "公网页试图跳本地"，堵 SSRF 跳板）。
- **`setWindowOpenHandler`**：一律 `deny`；仅 http(s)（复用 `apps/desktop/src/main/ipc/fs.ts:610` 同一 protocol 校验）才 `shell.openExternal` 外溢，自定义协议不外溢。
- **partition session**（`session.fromPartition('persist:browser-panel')`，应用启动时配置）：`setPermissionRequestHandler` / `setPermissionCheckHandler` 对摄像头/麦克风/剪贴板/通知/地理位置**默认全拒**；`will-download` 默认 `preventDefault`/强制确认 + 限定目录、禁自动执行。
- **会话隔离 + 数据清理**：独立 partition 把第三方 cookie/缓存/localStorage 与宿主隔离；选 `persist:`（保留本地 dev 登录态便利），配套「清除浏览数据」入口（`session.clearStorageData`，经 IPC）。
- **宿主窗口**：`apps/desktop/src/main/index.ts` 的 `webPreferences.webviewTag:true` 开启 webview 能力；宿主主窗口 CSP 不变（第三方 view 的 CSP 由站点自负，隔离靠 partition + 闸门 + 不注入 preload）。

### KTD3. 探测与 allow-list 逻辑移植到 `packages/core`，按 cortex 真实消息模型重写

Kun 的 `dev-preview-url.ts`（URL 归一化 + allow-list）是**纯 TS、无 Electron 依赖**，**直接移植**进 `packages/core/personal/`。但 Kun 的 `dev-preview-detection.ts` 不能"仅换输入类型"——cortex 的消息模型与 Kun 的 `ChatBlock` 根本不同（**可行性评审确认**）：

- cortex 的 `agentLog`（`packages/core/types/index.ts`）是 `{ title: string; items: AgentLogItem[] }`，每个 item 为 `{ ic; text: RichText }`，`RichText = string | { kind:"rich"; parts }`——**没有** Kun 的 `summary` / `detail` / `meta.command` 字段；适配时须解 `item.text` 的 RichText 两种形态。
- **dev server 的 stdout 根本不进消息流**：agent 适配器（`pi.ts` / `claude.ts` / `codex.ts` 的 `toolDetail`）只把**工具入参**（command / file_path / url）归一化进 `tool` 事件 detail，并**截断到 80/100 字符**；工具的 stdout 输出（`Local: http://...` / `vite vX ready in`）从不进入归一化流，也从不进 `Message[]`。
- `agentLog` 还被 `sanitizeForSave`（`messages.ts`，`survivesSanitize` 剔除）剥离，活在**另一条 query**（`usePersonalProcess` / `personalProcessKeys`），不在 `usePersonalChat` 的 `allMessages` 里。

因此探测的真实数据源 = **assistant 正文 `kind:"text"` 的 text**（主信号）+ **工具命令入参 detail（截断后）** + **process query 的 agentLog item.text**（次信号），而**不是** dev-server stdout。`textFromMessage` 须按真实 `Message` 联合重写。好处仍在：纯 core、可单测、Web/Desktop 共享、与注入侧同源。

> 影响见 KTD4 与 Scope Boundaries：auto_open 的命中**主要依赖 agent 在正文里打印 URL**，对 `DEV_SERVER_OUTPUT_RE` 这类 stdout 特征的命中率预期**下调**。

### KTD4. 「任意网址」与「自动打开」的边界分离 + auto_open 仅环回地址

- **地址栏**：放开 allow-list，接受任意 `https:`（dev 场景额外放行 `http://localhost`/私网）。
- **自动打开（auto_open）= 攻击面，收紧到环回地址**：agent 输出是**不可信输入**（见 KTD6），auto_open **无需用户点击**就加载，构成自动请求原语。故 auto_open **只**对 `127.0.0.1` / `localhost` / `::1` 生效——**移除** `169.254.0.0/16`（链路本地 + 云 metadata）、`host.docker.internal`、`10/172.16-31/192.168` 私网段（地址栏手动仍可，但**不自动**）。**绝不**对任意公网 URL 自动弹面板。
- card 模式可展示探测到的本地/私网 URL（需用户点击才加载），与 auto_open 的收紧白名单分离。

### KTD5. 布局：webview 在 DOM，CSS 定尺寸，iframe 回退（无 bounds IPC）

`<webview>` 是渲染端 DOM 元素，置于右栏 React 子树，由 flex/CSS 定尺寸，**取消**原 WebContentsView 方案的全部 bounds-sync 机制。导航/历史/状态用 webview 元素 API + 事件在渲染端处理（`webview.loadURL`/`src`、`goBack`/`goForward`/`reload`/`stop`、`canGoBack`/`canGoForward`、`did-navigate`/`page-title-updated`/`did-fail-load`/`did-start-loading`/`did-stop-loading`）——直接照搬 Kun `DevBrowserPanel`。

**Web 端回退**：用 `canUseElectronWebviewEnvironment`（`bridge.openExternal` 存在 + UA 含 `Electron/`）特征探测；Electron 用 `<webview>`，否则 `<iframe>`（自维护 back/forward 栈、10s 超时判失败——Kun 已实现）。该组件**不 import 任何 Electron 模块**（webview 只是自定义元素 + UA 判断），故可安全放进 `packages/views`，契合 Web/Desktop 复用边界。

**因 webview 在 DOM 内**：未来标注浮层可用绝对定位 DOM 叠加（KTD1），本计划布局即为其铺路。

### KTD6. 不可信输入核心不变量

**agent 输出与第三方页面内容均为攻击者可控的不可信输入**（agent 可被 prompt-injection、可执行不可信仓库代码；公网页可含恶意脚本/重定向）。由它们触发的任何导航/加载，必须经过与用户主动输入**相同或更严**的 scheme + host 闸门；公网 origin 不得自动导航进私网；auto_open 的 URL 必须视为攻击者可控（故收紧到环回地址，KTD4）。当前能力的信任**不建立在"探测到的本地 URL"这一中间产物上**——这是 SSRF 类风险的共同根因防线。

---

## High-Level Technical Design

### 组件与进程边界（webview 模型）

```mermaid
flowchart TB
  subgraph Renderer["渲染进程 (apps/desktop + packages/views)"]
    Chat["PersonalChatArea<br/>合并 allMessages + process agentLog"]
    Detect["devPreviewDetection (core)<br/>card / auto_open 探测"]
    Card["DevPreviewCard 卡片入口"]
    subgraph Panel["BrowserView 面板 (右栏 DOM 子树)"]
      Bar["地址栏 + ◀▶⟳/停止 + 清除数据"]
      WV["&lt;webview partition=persist:browser-panel&gt;<br/>(Web 端回退 &lt;iframe&gt;)"]
    end
    Bridge["DesktopBridge: openExternal / browserClearData"]
  end
  subgraph Main["主进程 (apps/desktop/src/main)"]
    Guards["installBrowserWebviewGuards<br/>will-attach-webview / will-navigate /<br/>will-redirect / setWindowOpenHandler"]
    Sess["partition session<br/>权限 deny-by-default / 下载 / clearStorageData"]
  end

  Chat --> Detect
  Detect -->|card URLs| Card
  Detect -->|auto_open 环回| Panel
  Card -->|open url| Panel
  Bar --> WV
  WV -. attach/navigate 被闸门校验 .-> Guards
  WV -. window.open / 越界导航 .-> ExternalBrowser["系统默认浏览器<br/>shell.openExternal"]
  Bar -->|清除数据| Bridge
  Bridge <-->|browser:clearData| Sess
```

> 与原 WebContentsView 方案的关键差异：无 bounds-sync IPC、无 browser:loadURL/back/forward 等导航 IPC（均在渲染端 webview API 完成）；主进程只装闸门 + 管 session。

### agent 输出 → 浏览器打开 时序

```mermaid
sequenceDiagram
  participant Msg as allMessages + process agentLog
  participant Det as devPreviewDetection
  participant UI as PersonalChatArea
  participant WV as &lt;webview&gt; (渲染端)
  participant Main as webview 闸门(主进程)

  UI->>Det: 传入合并后的消息(正文 text + agentLog items)
  Det-->>UI: card URLs(本地/私网) + auto_open URLs(仅环回, 过滤端点)
  alt 正文像 dev server 且为环回(auto_open)
    UI->>UI: 本轮仅一次, rightView=browser & rightOpen
    UI->>WV: 设 webview src = url
  else 仅 card
    UI-->>UI: 渲染 DevPreviewCard
    Note over UI: 用户点击后才设 src
  end
  WV->>Main: will-attach-webview / will-navigate 校验
  Main-->>WV: 强制安全 webPreferences + scheme/host 闸门
  WV-->>UI: did-navigate / page-title-updated / canGoBack* 事件 → 更新地址栏与按钮
```

### 安全闸门判定（主进程，webview）

```mermaid
flowchart TD
  Nav["webview attach/导航/重定向/window.open url"] --> Scheme{scheme 严格白名单?}
  Scheme -->|"非 https/http<br/>(javascript:/data:/blob:/file:/自定义)"| Block["preventDefault / deny<br/>(deny-by-default)"]
  Scheme -->|https:| FromPub{当前页 origin 是公网?}
  Scheme -->|http:| Local{host 为环回/私网?}
  Local -->|是| FromPub
  Local -->|否| BlockHttp["拒绝(明文公网 http)"]
  FromPub -->|"是 且 目标为私网/环回"| BlockSSRF["拒绝<br/>(公网 origin 禁跳私网)"]
  FromPub -->|否| AllowNav["放行(面板内导航)"]
  Nav -.window.open.-> WO{http(s)?}
  WO -->|是| Ext["openExternal 系统浏览器"]
  WO -->|否| Block
```

> 以上为方向性设计，非实现规格。

---

## Output Structure

新增/关键改动（相对本仓库根）：

```text
apps/desktop/src/main/
  browser/
    webviewGuards.ts             # installBrowserWebviewGuards + scheme/host 闸门(新)
    webviewGuards.test.ts        # 闸门/权限单测(新)
    partition.ts                 # partition session 权限 deny-by-default + clearData(新)
  index.ts                       # webPreferences.webviewTag:true + 启动时装闸门/配 session(改)
  ipc/
    browser.ts                   # browser:clearData(仅此一条 IPC)(新)
    register.ts                  # 注册 registerBrowserHandlers(改)

packages/core/
  personal/
    devPreviewUrl.ts             # 移植自 Kun, allow-list + isLoopbackOnly(新)
    devPreviewUrl.test.ts        # (新)
    devPreviewDetection.ts       # 移植自 Kun, 适配 Message[](新)
    devPreviewDetection.test.ts  # (新)
  desktop/
    bridge.ts                    # 新增 browserClearData?(可选)(改)
  store/
    personal.ts                  # RightView 增 "browser" + 自动打开去重游标(改)

packages/views/cortex-desktop/personal/
  BrowserView.tsx                # 右栏内嵌浏览器面板(webview/iframe 双实现, 移植 Kun DevBrowserPanel)(新)
  BrowserView.test.tsx           # (新)
  DevPreviewCard.tsx             # 「打开预览」卡片(新)
  PersonalRightPanel.tsx         # 增加 browser 分派 + RIGHT_VIEW_TITLE(改)
  PersonalTopBar.tsx             # 右栏入口增加 browser + pick 局部类型扩展(改)
  PersonalChatArea.tsx           # 探测接线 + 卡片/自动打开(改)
  useBrowserViewVisibility.ts    # 门控小 hook(新, 可选)

apps/desktop/src/preload/index.ts # personal 暴露 browserClearData(改)
```

> 结构为范围声明，实现可微调；各 Unit 的 `**Files:**` 为准。

---

## Implementation Units

### U1. 主进程 webview 安全闸门与 partition 权限配置

**Goal:** 在主进程安装 webview 三道闸门、开启 `webviewTag`、配置 partition session 的 deny-by-default 权限与下载控制，并提供唯一一条 `browser:clearData` IPC。这是 webview 内容安全的根基。

**Requirements:** 承载任意 https + 本地预览（KTD1）、安全闸门与不变量（KTD2/KTD6）。

**Dependencies:** U2（复用其 allow-list/环回判定；可先内联占位后接 U2）。

**Files:**
- `apps/desktop/src/main/browser/webviewGuards.ts`（新）
- `apps/desktop/src/main/browser/partition.ts`（新）
- `apps/desktop/src/main/browser/webviewGuards.test.ts`（新）
- `apps/desktop/src/main/index.ts`（改：`webPreferences.webviewTag:true`；启动时调 `installBrowserWebviewGuards()` + `configureBrowserPartition()`）
- `apps/desktop/src/main/ipc/browser.ts`（新：`browser:clearData`）
- `apps/desktop/src/main/ipc/register.ts`（改：注册 `registerBrowserHandlers`）

**Approach:**
- `installBrowserWebviewGuards()`（`app.on('web-contents-created')`，移植 Kun `installDevPreviewWebviewGuards` 结构）：
  - `will-attach-webview`：删 `webPreferences.preload`，强制 `nodeIntegration:false / nodeIntegrationInSubFrames:false / contextIsolation:true / sandbox:true / webSecurity:true / allowRunningInsecureContent:false`；强制 `params.partition = 'persist:browser-panel'`；校验初始 `src` scheme。
  - `will-navigate` / `will-redirect`：共用纯函数 `evaluateNavigation({ targetUrl, currentOrigin })`——严格 scheme 白名单 + 公网 origin 禁跳私网，违规 `event.preventDefault()`。
  - `setWindowOpenHandler`：一律 `deny`，http(s) 复用 `fs.ts:610` protocol 校验后 `shell.openExternal`，自定义协议不外溢。
- `configureBrowserPartition()`：`session.fromPartition('persist:browser-panel')` 上挂 `setPermissionRequestHandler` / `setPermissionCheckHandler`（默认全拒）、`will-download`（默认拦截/限定目录）。
- `browser:clearData` handler → `session.clearStorageData()`。
- `evaluateNavigation` 的环回/私网判定**直接 import** `@cortex-work/core` 的 `devPreviewUrl`（KTD5 已证 main 可 import core：`electron.vite.config.ts` 的 `externalizeDepsPlugin({ exclude:["@cortex-work/core"] })`），**不内联副本**。

**Patterns to follow:** 参考仓库 `~/source/ai/Kun/src/main/index.ts:287`（三道闸门），`apps/desktop/src/main/ipc/fs.ts:610`（protocol 校验）、`register.ts:31`（注册入口）。

**Technical design:** 见上「安全闸门判定」流程图（方向性）。

**Test scenarios:**
- attach: `will-attach-webview` 收到带 `preload`/`nodeIntegration:true` 的 params → 被强制清/关，partition 被强制为 `persist:browser-panel`。
- scheme(deny-by-default): `will-navigate`/`loadURL` 收 `file://`、`javascript:`、`data:text/html`、`blob:` → 逐一被拒。
- host: `http://localhost:5173` 放行；`http://evil.com`（明文公网 http）被拒。
- 公网禁跳私网(P1-1): 当前页 `https://attacker.com` 跳 `http://127.0.0.1:9000` / `http://169.254.169.254` → 拒；同目标由地址栏（无公网 currentOrigin）触发 → 放行。
- window.open: `window.open('https://x.com')` → `deny` + `openExternal`；`window.open('vscode://x')` → 既不导航也不外溢。
- 权限: `media`/`geolocation`/`notifications`/`clipboard-read` 默认回调 `false`。
- 下载: 恶意页 `will-download` → 被拦截/需确认。
- clearData: `browser:clearData` → `clearStorageData` 被调用。

**Verification:** 单测全绿；手动起 vite dev server 在 webview 渲染；地址栏输入公网 https 可浏览；页面内外链跳系统浏览器；自定义协议/明文公网 http 被拦。

---

### U2. URL allow-list 与 dev 预览探测（core，移植 Kun）

**Goal:** 把 Kun 的 URL 归一化/allow-list 与 dev 预览探测移植进 `packages/core/personal`，输入适配 cortex 的消息模型。纯函数、重单测。

**Requirements:** 探测能力（KTD3）、自动打开仅环回（KTD4）。

**Dependencies:** 无（纯 core，可最先并行起手）。

**Files:**
- `packages/core/personal/devPreviewUrl.ts`（新，移植 `~/source/ai/Kun/src/shared/dev-preview-url.ts`）
- `packages/core/personal/devPreviewUrl.test.ts`（新）
- `packages/core/personal/devPreviewDetection.ts`（新，移植 `~/source/ai/Kun/src/renderer/src/lib/dev-preview-detection.ts`）
- `packages/core/personal/devPreviewDetection.test.ts`（新）
- `packages/core/package.json`（改：`exports` 加 `./personal/devPreviewUrl` 子路径，供 main 与 views import）

**Approach:**
- `devPreviewUrl.ts`：原样移植 `isAllowedDevPreviewHostname` / `normalizeDevPreviewUrlInput` / `isAllowedDevPreviewUrl`（card 用本地/私网全集）。**额外导出 `isLoopbackOnly(host)`**（仅 `127.0.0.1`/`localhost`/`::1`）供 auto_open 与 main 闸门收紧用。
- `devPreviewDetection.ts`：移植正则常量与 `card`/`auto_open` 双模式收集。**适配点（按真实 `Message` 重写，KTD3）**：`textFromMessage` —— `kind:"text"` 取 `text`（主信号）；`kind:"agentLog"` 遍历 `items[].text`，对 `RichText` 两形态（`string` 直取 / `{kind:"rich",parts}` 拼接）归一为字符串（工具入参，已被截断 80/100 字符）；其余 kind 返回 `""`。**作废** Kun 的 `summary`/`detail`/`meta.command` 措辞。
- 导出 `extractDetectedDevPreviewUrls`（card）、`extractAutoOpenDevPreviewUrls`（auto_open，经 `isLoopbackOnly` 二次过滤）、`extractLatestTurn*`、`formatDevPreviewUrlLabel`。

**Patterns to follow:** 参考仓库两文件逐行对照；cortex `Message`/`AgentLogItem`/`RichText` 在 `packages/core/types/index.ts`，折叠在 `packages/core/personal/messages.ts`。

**Test scenarios:**
- happy(card): 正文含 `打开 http://localhost:5173` → `http://localhost:5173/`。
- happy(auto_open 环回): 正文含 `vite v5` + `Local: http://127.0.0.1:5173/` → 命中。
- auto_open 收紧(KTD4): dev 特征 + `http://192.168.1.10:3000` / `http://169.254.169.254/` → card 命中、auto_open 被 `isLoopbackOnly` 拒。
- 仅 card: 纯 `localhost` URL 无 dev 特征 → 仅 card。
- 过滤: `/health` `/metrics` `/v1/` → `urlLooksLikePagePreview` 排除；`bearer token`/`sse`/`threads` → `NON_PREVIEW_CONTEXT_RE` 不展卡片。
- 适配(RichText): `agentLog` 的 `item.text` 为 `{kind:"rich",parts}` 含本地 URL → 被 `textFromMessage` 扫到。
- 公网: `http://8.8.8.8:3000` → 拒。
- 去重/上限/切片: 同 URL 去重；超 `MAX_DETECTED_URLS=4` 截断；`extractLatestTurn*` 只看最近一轮 user 之后。

**Verification:** `pnpm --filter @cortex-work/core test -- run packages/core/personal/devPreviewDetection.test.ts` 全绿。

---

### U3. 右栏 webview 浏览器面板 UI 与 RightView 接入

**Goal:** 移植 Kun `DevBrowserPanel` 为 `BrowserView`（webview + iframe 双实现：地址栏、◀▶⟳/停止、auto-follow、加载/错误态），扩展 `RightView = "browser"` 并在 `PersonalRightPanel` 分派。这是 webview 模型的核心、也是未来标注的载体。

**Requirements:** 内嵌浏览器面板（KTD1）、DOM 布局（KTD5）。

**Dependencies:** 无强依赖（手动浏览即可用）；地址栏归一化用 U2 的 `normalizeDevPreviewUrlInput`。

**Files:**
- `packages/views/cortex-desktop/personal/BrowserView.tsx`（新，移植 `~/source/ai/Kun/src/renderer/src/components/DevBrowserPanel.tsx`）
- `packages/views/cortex-desktop/personal/BrowserView.test.tsx`（新）
- `packages/core/store/personal.ts`（改：`RightView` 增 `"browser"`；:47 类型。默认 `"todos"` 与 `toPersistedState` 均不含 `rightView`，**无迁移负担**——可行性评审确认）
- `packages/views/cortex-desktop/personal/PersonalRightPanel.tsx`（改：`view === "browser"` 分支渲染 `<BrowserView/>`；**`RIGHT_VIEW_TITLE` 补 `browser: "浏览器"`**，否则落 `?? "面板"` 兜底）

**Approach:**
- 直接移植 Kun `DevBrowserPanel` 的双实现：`canUseElectronWebviewEnvironment`（`bridge.openExternal` 存在 + UA 含 `Electron/`）→ Electron 用 `<webview partition="persist:browser-panel" webpreferences="contextIsolation=yes,sandbox=yes,nodeIntegration=no" allowpopups=false>`；否则 `<iframe sandbox>`（自维护 back/forward 栈 + 10s 超时）。**不 import 任何 Electron 模块**（webview 只是自定义元素），契合 views 边界。
- 地址栏：受控 input，回车 → 本地输入走 `normalizeDevPreviewUrlInput`、否则补 `https://` → 设 webview `src`/`loadURL`。导航按钮态由 webview `canGoBack()`/`canGoForward()`/`isLoading()` 驱动；监听 `did-start-loading`/`did-stop-loading`/`did-navigate`/`did-navigate-in-page`/`did-fail-load`（忽略 `-3 ERR_ABORTED`）/`page-title-updated` 更新地址栏与按钮。
- 「在系统浏览器打开」按钮 → `bridge.openExternal(currentUrl)`；「清除浏览数据」→ `bridge.browserClearData?.()`（U1）。
- 由 CSS/flex 定尺寸，**无** bounds 上报。首帧白闪加 loading 遮罩。
- 为未来标注预留：webview 容器为定位上下文（`position:relative`），便于后续叠加绝对定位浮层（本计划不实现，见 Future Considerations）。

**Patterns to follow:** 参考仓库 `~/source/ai/Kun/src/renderer/src/components/DevBrowserPanel.tsx`（几乎照搬，去掉 dev-only allow-list 限制以支持任意 https）；本仓 `PersonalRightPanel.tsx`（`view` 分派）、`FilesView.tsx`（面板骨架/i18n）。

**Test scenarios:**
- happy: 地址栏输入 `localhost:5173` 回车 → webview `src` = `http://127.0.0.1:5173/`；输入 `example.com` → `https://example.com`。
- 状态: `did-start-loading` → spinner + 停止按钮；`did-stop-loading` → 刷新按钮；导航后 `canGoBack/Forward` 驱动按钮禁用态。
- 错误: `did-fail-load`（非 -3）→ 错误态 + 重试；`-3 ERR_ABORTED` → 不显错。
- 回退: 模拟非 Electron 环境（`canUseElectronWebviewEnvironment` 假）→ 渲染 `<iframe>`，back/forward 走自维护栈。
- 外链/清除: 点「系统浏览器打开」→ `bridge.openExternal`；点「清除数据」→ `bridge.browserClearData`。
- RightView: `setRightView("browser")` → `PersonalRightPanel` 渲染 BrowserView，标题为「浏览器」。

**Verification:** 组件测试全绿；手动切到浏览器面板可浏览任意 https + 本地预览、前进后退/刷新可用、错误页正确、Web 端 iframe 回退不崩。

---

### U4. 右栏入口、可见性门控与生命周期

**Goal:** 在右栏入口（TopBar/Sidebar）加「浏览器」项；把面板可见性与右栏开合/落地页/会话切换联动。webview 在 DOM，显隐靠条件渲染/CSS（比原生层简单）。

**Requirements:** 面板可达 + 正确显隐（KTD5）。

**Dependencies:** U3。

**Files:**
- `packages/views/cortex-desktop/personal/PersonalTopBar.tsx`（改：右栏切换项加 `browser` + 勾选态；**其局部 `pick` 签名硬编码字面量 `"files"|"skills"|"todos"|"notes"`，须同步扩 `browser`**，否则 typecheck 报错——可行性评审确认）
- `packages/views/cortex-desktop/personal/PersonalSidebar.tsx`（改：同步入口，若适用）
- 可能新增 `packages/views/cortex-desktop/personal/useBrowserViewVisibility.ts`（小 hook：`rightOpen && rightView==="browser" && !homeOpen` 时挂载/显示 webview，否则卸载/隐藏；核对实际门控 hook 名——`useCloseRightPanelOnHome` 为既有范式指代，grep 未命中同名符号，按真实 hook 对齐，可参考 `PersonalProcessPanel.tsx` 门控注释）

**Approach:**
- 入口：TopBar 右栏菜单加「浏览器」，点击 `setRightView("browser")` + `setRightOpen(true)`，与现有 files/todos/notes/skills 勾选态一致。
- 门控（复用既有教训）：**不**用渲染期强制隐藏，而用副作用——非 browser/未开/落地页时把 BrowserView 从 DOM 卸载（webview 随之销毁、释放渲染进程，无需手动 close），满足条件时挂载。把联动抽成 `useBrowserViewVisibility` 小 hook 并单测，而非渲染整树断言。
- 会话/工作区切换：默认**保留**当前页（webview 持久），仅工作区切换时复位 src。

**Patterns to follow:** `PersonalTopBar.tsx` 现有 `rightView` 勾选态；既有门控范式（机构经验：`2026-06-14-001` / `2026-06-18-003` plan）。

**Test scenarios:**
- 入口: 点 TopBar「浏览器」→ `rightView==="browser"` 且 `rightOpen===true`。
- 门控: 切到 files / 关闭右栏 / 进落地页 → BrowserView 卸载（webview 不再驻留）。
- hook 单测: `useBrowserViewVisibility` 各状态组合产出正确挂载/卸载决策（不渲染整树）。

**Verification:** 切换右栏/落地页时 webview 正确挂卸、不残留；hook 单测全绿。

---

### U5. agent 输出探测接线（卡片入口 + 自动打开）

**Goal:** 把 U2 的探测接到个人区会话：探测到本地 dev URL 时渲染「打开预览」卡片；正文明确像 dev server 且为环回时自动打开（本轮仅一次）。

**Requirements:** agent 输出支持打开方式浏览器（KTD3/KTD4，用户确认的 card+auto_open）。

**Dependencies:** U2、U3、U4。

**Files:**
- `packages/views/cortex-desktop/personal/DevPreviewCard.tsx`（新，「打开预览 + host 标签」卡片）
- `packages/views/cortex-desktop/personal/PersonalChatArea.tsx`（改：合并消息源、探测、渲染卡片、自动打开副作用）
- `packages/core/store/personal.ts`（改：`autoOpenedPreviewKey?` 游标，按"会话 + URL"去重，防重复自动弹）
- `packages/views/cortex-desktop/personal/DevPreviewCard.test.tsx`（新）

**Approach:**
- **数据源（可行性评审阻断项的解法）**：`usePersonalChat(session.id)` 的 `allMessages` **已被 sanitize 剥离 agentLog**，工具步骤活在 `usePersonalProcess` / `personalProcessKeys` 的另一条 query。故探测输入须**合并两源**：`allMessages`（正文 text，主信号）+ process query 的 agentLog items（工具入参，次信号），传给 U2 的 `extractLatestTurn*`。
- card：渲染 `<DevPreviewCard url onOpen/>`，`onOpen` → `setRightView("browser")` + `setRightOpen(true)` + 设 webview src（经 BrowserView 受控 url 或共享 store 字段）。
- auto_open：`useEffect` 监听 auto_open URLs（已 `isLoopbackOnly` 收紧），对 `sessionId+url` 用 `autoOpenedPreviewKey` 去重——首次才自动打开，**仅环回**才会走到这里。
- 无桥/Web 端：卡片降级走 `openExternal` 或 iframe 预览。

**Patterns to follow:** 参考仓库 `Workbench.tsx:2607` `DevPreviewLaunchCard` + `latestAutoOpenDevPreviewUrl`；本仓 `chatMarkdown.tsx` 链接拦截、`PersonalChatArea.tsx` 装配。

**Test scenarios:**
- card: 会话含 `打开 http://localhost:5173` → 渲染卡片；点击 → 打开面板加载该 URL + `rightView="browser"`。
- auto_open(环回): 正文含 `vite v5` + `Local: http://127.0.0.1:5173/` → 自动打开一次。
- auto_open 收紧: 私网 `http://192.168.1.10:3000`（card 命中）→ 不自动打开。
- 合并源: process query agentLog 里的本地 URL 能进卡片探测（即便 allMessages 已剥离 agentLog）。
- 去重: 同会话同 URL 再渲染 → 不重复自动打开。
- 端点过滤: 仅 `localhost:9090/metrics` → 不渲染卡片、不自动打开。
- Covers：用户确认的「卡片入口 + 自动打开（借鉴 Kun）」。

**Verification:** 跑真实 agent 起 dev server 的会话，卡片出现且（环回时）自动打开；健康检查端点不误触发。

---

## Scope Boundaries

### 本计划包含
- 右栏单个 `<webview>` 内嵌浏览器面板（Web 端 iframe 回退），地址栏任意 https + 本地预览。
- agent 输出本地 dev URL 探测：card（全本地/私网）+ auto_open（**仅环回**，KTD4），含端点过滤、去重、本轮一次。
- 安全闸门：webview 三道闸门、会话隔离、deny-by-default 权限、严格 scheme 白名单、公网 origin 禁跳私网、window.open/下载外溢（KTD2/KTD6）。
- 「清除浏览数据」入口（persist partition 配套）。
- 个人区（personal）接线。

### 已知限制（数据源现实，可行性评审）
- **auto_open 命中率受限**：cortex 的工具 stdout 不入消息流、agentLog 被 sanitize 剥离，故 auto_open 主要靠 agent 在**正文**打印环回 URL + dev server 语境，无法像 Kun 那样从 dev-server stdout 稳定捕获。提高命中率需后续放开"不改归一化结构"非目标（见 Deferred）。

### Deferred to Follow-Up Work（本仓后续 PR）
- **可视化标注 → agent → 可视化编辑**（本计划的根本动机，但不在本期实现）：见 Future Considerations。
- 让 agent 适配器透传 dev-server 工具 stdout 进流，以提高 auto_open 命中率（需放开"不改归一化结构"非目标）。
- 多标签 / 多 webview。
- 团队区（team）会话的探测接线（先做个人区，结构可复用）。
- 浏览器书签、历史持久化 UI、下载管理面板。
- 内嵌页内细粒度权限白名单 UI（本计划默认全拒）。
- `auto-follow` 连续跟随最新探测 URL（Kun 有；本计划先做"首次自动打开"）。

### 非目标（Outside scope）
- 不做通用浏览器替代品（无扩展、无多窗口、无隐私模式切换 UI）。
- 不改 agent adapter 的 `CliStreamEvent` 归一化结构。
- 不放宽 `shell:openExternal` 既有 http/https 协议白名单。

---

## Risks & Mitigations

| 风险 | 影响 | 缓解 |
|---|---|---|
| **auto_open SSRF**：恶意/被注入 agent 输出构造 dev 特征 + 私网/metadata URL → 自动加载（安全 P0-1） | 内网探测、读无鉴权本地端口、命中云 metadata | auto_open 收紧到**仅环回**（KTD4）；KTD6 不可信输入不变量；端点过滤 + 本轮一次去重 |
| **scheme 逃逸**：`javascript:`/`data:`/`blob:` 未显式拒（安全 P0-2） | webview 内执行脚本/钓鱼 | 严格 deny-by-default 白名单（`will-navigate`/`will-redirect`/attach 共用），仅 https + 环回/私网 http（KTD2/U1） |
| **公网页跳私网**：任意 https 放行后经 `will-redirect`/JS 跳私网（安全 P1-1） | SSRF 跳板 | `will-navigate`/`will-redirect` 共用闸门 + 公网 origin 禁跳私网不变量（KTD2/U1） |
| **下载/window.open 协议攻击**（安全 P1-2/P1-4） | drive-by 下载、自定义协议 handler 攻击 | `will-download` 默认拦截；`setWindowOpenHandler` 复用 http/https-only 校验（KTD2/U1） |
| **`<webview>` 官方不推荐、未来 API 不稳定** | 长期维护风险、可能需迁移 | webview 是满足"DOM 标注未来"的唯一选项（KTD1），非技术惰性；安全靠主进程闸门兜底；Electron 若移除再评估迁移 |
| webview 渲染端被篡改 webPreferences/partition 绕过隔离 | 提权/逃逸 | `will-attach-webview` 主进程**强制覆盖** webPreferences + partition，不信渲染端声明（U1） |
| 探测误报（把非预览 URL 当 dev server 自动弹） | 打扰用户 | 端点过滤 + dev 特征 + auto_open 仅环回 + 本轮一次去重（U2/U5） |
| persist partition 第三方数据跨会话落盘（安全 P2-2） | 跟踪 cookie/登录态留存 | 选 persist + 「清除浏览数据」入口（KTD2/U1/U3） |
| iframe 回退对 SPA 路由/历史不准（Web 端） | Web 端预览体验降级 | Kun 已实现自维护 back/forward 栈 + 10s 超时；Web 端为次要场景，桌面端为主 |

---

## Dependencies / Prerequisites

- Electron 支持 `<webview>` + `webPreferences.webviewTag`（本仓 39.8.10 满足）。
- main 可 import `@cortex-work/core`：`apps/desktop/electron.vite.config.ts` `externalizeDepsPlugin({ exclude:["@cortex-work/core"] })` 已证（现网 `main/automation/tray.ts` 先例）。
- 无新增 npm 依赖（纯 Electron 原生 + 现有 React/i18n）。
- 遵守 CLAUDE.md：四层 IPC 契约同步（本计划 IPC 仅 `browser:clearData` 一条）、`packages/views` 不 import Electron（webview 仅自定义元素 + UA 判断）、单文件 ≤1200 行。

---

## Sequencing

```text
U2(探测+allow-list, 纯core, 最先) ─┐
U1(webview 闸门+partition) ────────┤
U3(webview 面板 UI + RightView) ───┴─> U4(入口+门控) ─> U5(探测接线)
```

建议：U2 最先并行起手（TDD）；U1 与 U3 可并行（U3 地址栏归一化用 U2）；U4 依赖 U3；U5 收口依赖 U2/U3/U4。

---

## Future Considerations

**可视化标注 → agent → 可视化编辑**（选 webview 的根本动机，单独 PR）：

- **标注层**：因 webview 在 DOM（KTD5），可在其容器内叠加绝对定位浮层——画框、选区高亮、标注工具条。`WebContentsView` 做不到，这是 KTD1 选 webview 的核心原因。
- **取元素/坐标**：给 webview 挂**专用标注 preload**（非业务 preload，仅暴露最小 contextBridge 通道）或用 `webview.executeJavaScript()` 注入选取脚本，回传用户圈选的 DOM 节点路径/截图/坐标。
- **回传 agent**：把标注 payload（选中元素 + 用户意图）组装进个人区 prompt 发给 agent，由 agent 产出修改，形成「标注→编辑→预览」闭环。
- **安全注意**：标注 preload 必须仍遵守 KTD2/KTD6——不暴露任意 IPC、不放业务能力；注入脚本只读 DOM、不改第三方页执行环境之外的东西。

本计划的 webview 架构、partition 隔离、容器定位上下文（U3）即为此铺路，但**不实现**上述任何一项。

---

## Sources & Research

- **参考仓库** `~/source/ai/Kun`（用户指定借鉴对象，webview 模式）：
  - `src/shared/dev-preview-url.ts` — URL 归一化 + allow-list（U2 直接移植 + 加 `isLoopbackOnly`）。
  - `src/renderer/src/lib/dev-preview-detection.ts` — card/auto_open 探测、端点过滤（U2 移植 + 适配 Message）。
  - `src/renderer/src/components/DevBrowserPanel.tsx` — webview/iframe 双实现、地址栏/导航/auto-follow（U3 几乎照搬，放宽 allow-list 支持任意 https）。
  - `src/main/index.ts:287` `installDevPreviewWebviewGuards` — 三道闸门（U1 移植，scheme 改严格 deny-by-default + 公网禁跳私网）。
- **Electron 官方文档**（支撑 KTD2 安全加固，亦记录 webview 取舍）：
  - [Web Embeds](https://www.electronjs.org/docs/latest/tutorial/web-embeds) — webview/WebContentsView/iframe 对比与 webview "不推荐"声明（KTD1 取舍依据）。
  - [Security checklist](https://www.electronjs.org/docs/latest/tutorial/security) — webPreferences 加固、导航/window.open 拦截、权限处理。
  - [`<webview>` Tag](https://www.electronjs.org/docs/latest/api/webview-tag) — webview 元素 API/事件（U3 导航/状态）。
  - [Session](https://www.electronjs.org/docs/latest/api/session) — partition/权限/下载/`clearStorageData`（U1）。
- **本仓机构经验**（`docs/solutions/` 不存在；来自 plan 与 CLAUDE.md）：
  - 外链统一走 `bridge.openExternal`（`2026-06-14-003` / `2026-06-15-002` plan）。
  - 右栏门控用"副作用 + 小 hook 单测"，非渲染期强制隐藏（`2026-06-14-001` / `2026-06-18-003` plan）→ U4 采纳。
  - 四层 IPC 契约同步 + `packages/views` 平台无关边界（CLAUDE.md）→ U1/U3 贯穿。
  - **空白信号**：内嵌 web / webview 选型 / 沙箱在本仓无前例，落地后建议 `/ce-compound` 沉淀首条经验。
- **本会话评审**（已整合）：安全视角（auto_open SSRF / scheme / 公网禁跳私网 / 下载 / window.open / persist）、可行性视角（探测数据源现实、main 可 import core、RightView 接线补漏）——见各 KTD/Unit 标注。
