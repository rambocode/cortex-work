# Cortex Desktop AI Slides 设计规格

## 背景

Cortex Desktop 已具备三项可复用基础能力：

- Design Workspace 能管理 `.cortex-design/<documentId>/` 下的设计稿与 HTML 产物。
- Desktop 主进程能安全授权本地 HTML，并在内嵌 `webview` 中预览。
- Claude、Codex、Pi 均可通过 Cortex 自带 MCP host 获得会话级工具。

参考 QoderWork 当前 AI Slides 的实现，成熟的演示文稿生成并不是“让模型直接拼 PPTX XML”，而是：

1. 先生成固定画布尺寸的 HTML 页面。
2. 以工作区文件为事实来源，持续修改单页和 deck 元数据。
3. 在应用内预览、排序和局部编辑。
4. 导出时分析浏览器渲染结果，把可表达内容重建为 PPTX 原生对象，把复杂视觉层栅格化。

Cortex 应采用相同的 HTML-first 思路，但复用现有 Design、MCP、preload 和 Electron 导出边界，不复制 QoderWork 的内部目录、工具命名或字体许可规避逻辑。

## 目标

- 用户能在 Design Workspace 中创建“演示文稿”类型的设计稿。
- Agent 能完成主题设置、提纲确认、逐页生成、素材写入、检查和修订。
- 每页以独立、可直接预览的 16:9 HTML 文件保存。
- 用户能在应用内查看缩略图、切换、排序、新增、复制、删除和编辑页面。
- 支持导出 PPTX、PDF、PNG 和可独立播放的 HTML。
- PPTX 中的普通文本、图片和表格尽可能保持可编辑；复杂 CSS、图表和 canvas 允许降级为图片。
- 所有文件访问、MCP 工具和 IPC 调用都限制在当前 deck 根目录及当前会话。
- 生成过程可恢复，应用重启后不依赖聊天上下文重建状态。

## 非目标

- 首版不实现 PowerPoint 全功能替代品。
- 不保证任意 HTML/CSS 都能无损转换为 PPTX 原生对象。
- 不把动画、视频、3D、滤镜和任意 JavaScript 交互转换为 PowerPoint 动画。
- 不在首版提供多人实时协作。
- 不直接修改 `.pptx` 文件内部 XML 作为主要生成路径。
- 不修改字体的 embedding permission bits；只允许嵌入明确授权可嵌入的字体。
- 不把 Slides MCP 工具注入普通聊天、写作模式或无关的 Design 会话。

## 核心领域模型

### Design Document

Design Workspace 的顶层设计稿。新增可选字段：

```ts
export type DesignDocumentKind = "board" | "slides";

export type DesignDocument = {
  // existing fields
  kind?: DesignDocumentKind;
  slidesManifestPath?: string;
};
```

兼容规则：

- 旧数据缺少 `kind` 时按 `"board"` 处理。
- `"board"` 继续使用现有 `artifacts`、自由画布和 active artifact 投影。
- `"slides"` 由 `slidesManifestPath` 指向 deck manifest，不把每页伪装成自由画布节点。

### Deck

一套有顺序、统一主题和统一画布尺寸的演示文稿。manifest 是 deck 元数据的唯一事实来源。

```ts
export type SlidesDeckManifest = {
  schemaVersion: 1;
  id: string;
  title: string;
  width: 1280;
  height: 720;
  status:
    | "draft"
    | "outline-proposed"
    | "outline-approved"
    | "generating"
    | "ready"
    | "error";
  revision: number;
  theme: SlidesTheme;
  outline: SlidesOutline | null;
  slides: SlidesSlot[];
  activeSlideId: string | null;
  createdAt: string;
  updatedAt: string;
};
```

### Slide Slot

Deck 中一个稳定、有顺序的位置。`id` 在重排和重新生成时不变，HTML 文件名不承担业务标识。

```ts
export type SlidesSlot = {
  id: string;
  order: number;
  title: string;
  purpose?: string;
  htmlPath: string;
  notesPath?: string;
  snapshotPath?: string;
  revision: number;
  status: "empty" | "generating" | "ready" | "error";
  updatedAt: string;
};
```

### Theme

控制整套 deck 的设计约束，而不是一段仅供模型参考的自由文本。

```ts
export type SlidesTheme = {
  name: string;
  mood: string[];
  palette: {
    background: string;
    foreground: string;
    primary: string;
    secondary: string;
    accent: string;
  };
  fonts: {
    heading: string;
    body: string;
    mono?: string;
  };
  density: "minimal" | "balanced" | "dense";
  imageStyle?: string;
  customInstructions?: string;
};
```

### Outline

生成页面前由 Agent 提议、用户确认的叙事合同。提纲确认前，不允许批量写入正式 slide HTML。

```ts
export type SlidesOutline = {
  version: number;
  summary: string;
  audience?: string;
  goal?: string;
  items: Array<{
    id: string;
    title: string;
    purpose: string;
    keyPoints: string[];
    visualIntent?: string;
  }>;
  approvedAt?: string;
};
```

## 工作区文件结构

每个 Slides 设计稿使用独立目录：

```text
.cortex-design/<documentId>/
├── deck.json
├── slides/
│   ├── slot-001.html
│   ├── slot-002.html
│   └── ...
├── assets/
│   ├── source/
│   └── generated/
├── snapshots/
│   ├── slot-001.png
│   └── ...
├── notes/
│   ├── slot-001.md
│   └── ...
├── drafts/
│   ├── outline.json
│   └── research/
└── exports/
```

约束：

- `deck.json` 是 deck 顺序、状态、主题、提纲和 revision 的唯一事实来源。
- `slides/*.html` 是页面视觉内容的唯一事实来源。
- 所有路径在 manifest 中使用工作区相对路径。
- Agent 和 renderer 不得写 deck 根目录之外的文件。
- 正式写入采用临时文件加原子替换，避免进程退出留下半个 manifest 或 HTML。
- 导出文件默认通过系统保存对话框写到用户选择位置；`exports/` 只存显式要求保留的中间产物。

## 用户体验

### 入口

Design Sidebar 的“新建设计稿”菜单增加：

- 设计画布
- 演示文稿

创建“演示文稿”后，中间区域切换到专用 Slides Workspace。

### Slides Workspace 布局

```text
┌──────────────┬──────────────────────────────────┬───────────────┐
│ 页面缩略图栏 │             当前页面舞台          │ Agent / 属性栏 │
│ 新增/排序    │          16:9 HTML webview        │ 主题/提纲/检查 │
└──────────────┴──────────────────────────────────┴───────────────┘
```

- 左栏：页面缩略图、页码、状态、新增、复制、删除和拖拽排序。
- 中间：当前页面预览；编辑模式下显示元素选择框和文字工具条。
- 顶栏：标题、提纲、主题、播放、检查、导出。
- 右栏：沿用 Design Agent 会话；可切换 deck 摘要、当前页上下文和检查结果。

### 首次生成流程

1. 用户输入主题、目标或上传参考资料。
2. Agent 可调用文档抽取和媒体生成能力收集内容与素材。
3. Agent 设置结构化主题。
4. Agent 提交提纲草案。
5. UI 显示提纲确认面板；用户可修改、批准或要求重做。
6. 批准后 Agent 才能创建正式 slide slots 并逐页写 HTML。
7. 每页写入后自动生成缩略图并进行基础检查。
8. 生成完成后显示 deck 检查摘要和导出入口。

### 局部编辑

页面 HTML 注入独立编辑 bridge，不把 Node 或 Electron 能力暴露给 slide：

- 单击元素：选择并显示边框。
- 双击文字：进入 `contenteditable`。
- 工具条：加粗、字号、颜色、对齐。
- `Delete`：删除允许删除的当前元素。
- 文本修改 500ms debounce 后提交整页 HTML。
- 保存请求携带 `expectedRevision`；revision 不匹配时拒绝覆盖并要求刷新。
- 编辑 bridge 只能向宿主发送结构化消息，不能直接调用 preload。

首版不提供任意 DOM 树编辑器、自由拖拽布局或完整 CSS 面板。

## Agent 与 MCP 工具契约

新增第一方 MCP server：`cortex-slides`。

它只在以下条件同时满足时注入：

- 当前回合来自 Slides Workspace。
- `runId` 使用明确前缀，如 `slides:<documentId>:<turnId>`。
- 主进程已为 `sessionId` 注册当前 deck 根目录与 document id。

### MVP 工具

| 工具 | 用途 | 关键约束 |
|---|---|---|
| `get_deck_state` | 读取主题、提纲、slots、revision | 不返回 deck 根之外内容 |
| `set_theme` | 写结构化主题 | revision 乐观锁 |
| `propose_outline` | 写 `drafts/outline.json` | 不直接创建正式 slides |
| `place_slide_html` | 创建或替换单页 HTML | 提纲已批准；固定 1280×720 |
| `read_slide_html` | 读取指定页面 | 仅 manifest 中已有 slot |
| `replace_slide_text` | 精确文字替换 | 必须命中唯一目标 |
| `move_slide` | 调整顺序 | 原子更新 manifest |
| `insert_slide` | 插入空 slot | 生成稳定 id |
| `delete_slide` | 删除 slot | 文件移入 deck 内部回收区，首版不硬删 |
| `upload_asset` | 写入 base64 或已有附件资产 | 类型、大小、目录白名单 |
| `check_slide` | 运行单页静态和渲染检查 | 返回结构化 findings |
| `screenshot_slide` | 刷新页面缩略图 | 固定 viewport 和超时 |

### 后续工具

- `edit_slide_element`
- `swap_slides`
- `generate_speaker_notes`
- `check_deck`
- `apply_template`

### 多 Agent 分工

首个可用版本允许一个主 Agent 串行完成全部工作。稳定后再引入：

- Topic Researcher：资料提取、事实与引用整理。
- Visual Researcher：素材建议和媒体生成。
- Slide Designer：逐页 HTML。
- Render Reviewer：溢出、遮挡、对比度、视觉一致性。
- Narrative Reviewer：结构、重复、节奏和结论。
- Notes Writer：演讲者备注。

子 Agent 只通过受控任务输入和 Slides MCP 访问 deck，不直接获得任意文件写权限。

## HTML 页面合同

每页必须：

- 使用 `<!doctype html>` 和 UTF-8。
- 根画布固定为 `1280px × 720px`。
- 不依赖远程 JavaScript。
- 资源使用 deck 相对路径或已内联 data URI。
- 在 `document.fonts.ready`、图片完成加载后视为可截图。
- 提供稳定的 `data-cortex-id`，供精确编辑和导出映射。
- 禁止弹窗、下载、外部导航、`window.open` 和顶层跳转。

允许内联 CSS 和受限内联脚本。预览 `webview` 继续走现有本地 HTML 授权与导航闸门，并额外禁止 deck 文件跳出当前 document root。

## 检查模型

### 静态检查

- manifest/schema/path 合法性。
- 页面尺寸和 viewport 声明。
- 远程资源、外部导航和危险脚本。
- 文本密度、标题缺失、空页面。
- 图片缺失、超大 data URI、未知字体。

### 渲染检查

- 内容是否越出 1280×720。
- 元素是否被裁切。
- 文本和背景对比度。
- 最小字号。
- 图片加载失败。
- 页面截图是否为空或尺寸异常。

检查只产生结构化 findings，不自动改写页面。修复必须由用户或 Agent 发起新的、可追踪 revision。

## 导出架构

导出在 Electron 主进程执行，复用写作导出的隐藏 `BrowserWindow` 模式，但独立为 Slides IPC 域。

### 统一渲染步骤

1. 校验 deck 路径和 manifest。
2. 依顺序加载每页 HTML。
3. 固定 viewport 为 1280×720，等待 fonts、images 和显式 ready signal。
4. 使用 Chrome DevTools Protocol 获取 DOM snapshot、computed styles、布局边界和平台字体。
5. 对页面元素分类。
6. 生成目标格式。
7. 完成后再一次性写入用户选择的目标路径，失败不留下半成品。

### PPTX

采用 `PptxGenJS` 生成 16:9 deck，使用混合导出：

- 普通文本：原生 PPT text box。
- 普通图片和 SVG：原生 PPT image。
- 简单表格：原生 PPT table。
- 纯色背景和简单矩形：原生 shape。
- Chart.js、canvas、滤镜、复杂渐变、复杂 stacking context：局部栅格图。
- 无法安全拆分的复杂页面：整页栅格降级，并在导出报告中标注。

为避免“整页截图 + 原生对象”产生重复内容，栅格层使用以下策略：

1. 克隆页面。
2. 隐藏将被原生重建的节点。
3. 截取剩余背景和复杂层作为 base raster。
4. 按 z-order 叠加原生对象和局部栅格对象。

首版保证普通文本、图片、表格可编辑，不承诺图表为 PowerPoint 原生 chart。

### PDF

生成临时组合 HTML，每页使用固定尺寸和 page break，再由隐藏 `BrowserWindow.printToPDF()` 一次导出。不得逐页打印后依赖系统工具拼接。

### PNG

按页 `capturePage()`，导出到用户选择的目录；文件名按 deck 顺序补零。

### HTML

生成自包含 presenter：

- 内嵌或复制 slide HTML 与资产。
- 支持上一页、下一页、全屏、页码和键盘操作。
- 不包含 Cortex preload 或编辑 bridge。

## IPC 与 preload 边界

新增窄接口：

```ts
slidesCreateDocument(...)
slidesLoadDeck(...)
slidesApproveOutline(...)
slidesReorder(...)
slidesSaveEditedHtml(...)
slidesRunCheck(...)
slidesExport(...)
```

要求：

- 主进程重新校验所有 document id、路径、format、revision 和文件大小。
- renderer 不传任意输出路径；导出由主进程打开系统保存对话框。
- IPC 类型在 `apps/desktop` 与 `packages/core/desktop` 镜像，并通过契约测试防止漂移。
- preload 不暴露通用文件系统或任意 CDP 能力。

## 依赖策略

MVP 新增：

- `pptxgenjs`：生成 PPTX。
- `jszip`：仅在必须补充 speaker notes、缩略图或 package metadata 时使用。

暂不新增：

- `sharp`：会增加原生模块、跨架构和 asar unpack 风险；优先使用 Electron `nativeImage` 和浏览器截图。只有局部裁剪质量无法满足时再单独评估。
- `pdf-lib`：组合 HTML 一次 `printToPDF()` 可覆盖首版需求。

打包前必须检查 `externalizeDepsPlugin`、`electron-builder.yml` 排除规则、asar 运行时解析和仓库外启动。

## 错误与恢复

- 所有写操作携带 expected revision，冲突返回 `revision_conflict`。
- Agent 工具错误返回可恢复的结构化错误，不抛出主进程未捕获异常。
- 单页生成失败只把该 slot 标记为 `error`，不回滚其他已完成页面。
- 启动时若发现 `.tmp` 文件，优先保留最后一个合法 manifest，并提示恢复。
- 截图或导出超时必须销毁隐藏窗口、detach debugger、清理临时目录。
- MCP host、会话 state 和临时导出资源在会话结束或应用退出时释放。

## 安全

- deck 根目录先做路径规范化，再做允许根校验。
- 拒绝符号链接逃逸。
- `upload_asset` 限制 MIME、扩展名和字节数。
- HTML 预览保留 webview 导航闸门，不开放 Node integration。
- 导出窗口启用 sandbox，不加载远程页面。
- CDP 仅连接 Cortex 自己创建的隐藏窗口。
- presenter 导出移除编辑 bridge、宿主消息协议和内部文件绝对路径。

## 可观测性

关键日志使用 `slides` scope，至少记录：

- deck/document/session/run id。
- 工具名、耗时、输入字节数和结果状态，不记录完整 HTML。
- 页面加载、字体等待、截图和导出耗时。
- PPTX 每页 native/raster 对象数量和降级原因。
- revision conflict、路径拒绝和超时。

## 验收标准

### MVP

- 能创建 Slides 设计稿，重启应用后仍能恢复。
- 能完成“主题 → 提纲确认 → 5 页生成”的完整流程。
- 页面可切换、排序、新增、复制、删除并自动刷新缩略图。
- 文本编辑保存后刷新页面仍保留。
- 基础检查能发现越界、图片加载失败和远程资源。
- PPTX 可被 Microsoft PowerPoint 和 Apple Keynote 打开。
- PPTX 中普通标题、正文、图片和简单表格可编辑。
- PDF、PNG 和 HTML presenter 的页面顺序、尺寸和视觉与应用预览一致。
- Slides MCP 不出现在普通会话。
- 非法路径、符号链接逃逸和 revision 冲突均被拒绝。

### 质量门槛

- 10 页 deck 的重启恢复不丢顺序或内容。
- 单页截图默认不超过 10 秒；超时有可读错误。
- 10 页 PPTX 导出默认不超过 90 秒，失败时不留下半成品。
- 典型页面的预览与 PPTX 渲染截图进行像素差对比，差异阈值由技术验证阶段确定。
- 打包后的 arm64/x64 应用在仓库外启动并完成至少一次 PPTX 导出。

## 推进顺序

1. 先做 HTML → PPTX 技术验证，证明可编辑对象和视觉保真可同时达到最低门槛。
2. 再实现 deck manifest、恢复和专用 workspace。
3. 接入 Slides MCP，完成提纲确认和逐页生成。
4. 增加局部编辑和检查。
5. 最后补齐正式导出、备注、模板和多 Agent review。

如果技术验证无法达到 PPTX 质量门槛，产品仍可先交付 PDF、PNG 和 HTML presenter，但不得把“整页截图 PPTX”描述为可编辑演示文稿。
