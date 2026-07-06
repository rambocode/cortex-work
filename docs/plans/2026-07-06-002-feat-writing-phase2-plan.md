---
title: "feat: 写作工作区二期(图片/补全/检索/PDF/导出/信息图)"
type: feat
date: 2026-07-06
origin: docs/plans/2026-07-06-001-feat-writing-workspace-agent-assistant-plan.md
---

# feat: 写作工作区二期(图片/补全/检索/PDF/导出/信息图)

> 参照仓库:`Kun:` 前缀路径相对 Kun 仓库根(与本仓库同级的 `ai/Kun`);其余为本仓库路径。一期计划(origin)的 KTD 与守卫约束(`writing:` 前缀、保真守卫、脏态保护)全部沿用。

## Summary

补齐一期明确延后的写作能力:粘贴图片落盘(对齐 Kun 的空间 `img/` 约定)、字数口径对齐、打字 ghost text 补全与 Cmd-K 就地改写、工作区级检索上下文、PDF 阅读与文本抽取、重型导出(DOCX/PDF/PNG/HTML/复制富文本)、选区生成信息图(对接 cortex media-gen)。

## Requirements

**图片与字数**

- R1. 在 rich 与 live/source 档粘贴剪贴板图片:写入 `<空间根>/img/`(对齐 Kun `WORKSPACE_IMAGE_DIR`),文档中插入相对当前 md 的相对路径链接;重名不覆盖。
- R2. 工具栏字数与 Kun 口径一致:Markdown 解析为可见文本后去空白按 code point 计(对齐 Kun:`computeWriteDocumentStats`)。

**补全与改写(Kun 链路 B)**

- R3. live/source 档提供打字 ghost text 续写建议(Tab 采纳/Esc 关闭),可在设置中关闭;rich 档不做(沿用一期排除 Kun tiptap 扩展的决定)。
- R4. Cmd-K 选区就地改写:构造前后缀上下文 + `<<<EDIT>>>` 协议(对齐 Kun:`inline-edit.ts`),结果经既有 `beginDiffReview` 红绿 diff 裁决,不进聊天历史。
- R5. 补全后端为主进程服务,LLM 走既有 `openai-chat.ts` 直连(baseUrl/apiKey/model 独立于 timeline 配置,设置面板新增写作节,未配置时补全/改写入口降级隐藏)。

**检索**

- R6. 工作区级检索:索引当前空间 md(U5 后含 PDF 文本),助手发送时按用户正文检索 top-k 片段注入 `[相关文献上下文]`(对齐 Kun `composeWritePrompt` 的既有哨兵位);设置开关,关闭或索引失败时静默降级为不注入。

**PDF**

- R7. 文件树显示 .pdf;点击在中栏以 pdfjs 阅读(翻页/缩放);PDF 页内选中文本可引用进助手(sourceKind=pdf,带页码)。
- R8. 主进程 PDF 文本抽取服务供检索索引使用;抽取失败该文件跳过索引。

**导出**

- R9. 导出菜单扩为:DOCX、PDF、HTML、PNG、复制富文本,并保留一期的复制 Markdown/导出 .md 副本;各项失败给出可读提示,不落半成品文件。

**信息图**

- R10. 选区(或全文摘要)生成信息图:对接 cortex `capabilities/media-gen`(openai-images 协议),生成 PNG 落 `<空间根>/img/` 并在光标处插入图片链接;media-gen 未配置时入口降级隐藏。

## Key Technical Decisions

- **图片目录约定 = `img/`**(非 assets/):对齐 Kun `WORKSPACE_IMAGE_DIR`,粘贴图片与信息图共用;新增 IPC `fs:writingSaveImage`(空间根白名单校验,返回落盘绝对路径,渲染端换算相对链接)。
- **补全/改写 LLM 复用 `openai-chat.ts` 的 `postChatCompletion`**:与 timeline 日报同一真源,不再直连 fetch;写作独立配置(`WritingUiState` 或 settings 分片)——Kun 的补全就是独立 provider 配置,不与对话 agent 混用。
- **检索为纯本地轻量打分**(移植 Kun `write-retrieval-service` 的分词/打分核心),不引向量库;索引驻内存 + 磁盘缓存跟随空间。
- **pdfjs-dist 仅 renderer 且动态 import**(照 CM/tiptap 隔离范式);主进程文本抽取用 pdfjs 的 legacy build 在主进程跑(对齐 Kun `write-pdf-text-service` 的做法,实现时以 Kun 为准)。
- **导出管线对齐 Kun `write-export-service`**:md→HTML 用其同源渲染(实现时读 Kun 确认渲染器与样式内联方式);DOCX 经 `html-to-docx`(主进程依赖,发版前必须按 lessons 核查 electron-builder `files` 排除清单 + 仓库外验证);PDF/PNG 经隐藏 BrowserWindow 的 `printToPDF`/`capturePage`(以 Kun 实际实现为准)。
- **信息图不移植 Kun 的 image-gen 适配器**:cortex `capabilities/media-gen` 已有 openai-images 协议客户端,直接复用其配置与调用面;仅移植 Kun 的提示词模板与「选区→提示词→落盘→插链」编排。
- **一切新 IPC 走一期四层对齐惯例**(types 双镜像 → handler → preload → bridge 可选方法),run/审阅/保真守卫等一期红线不动。

## Scope Boundaries

### Deferred to Follow-Up Work

- rich 档 ghost text(Kun tiptap inline-completion 扩展)、term-propagation、recent-edits 意图信号
- 检索的语义向量升级;PDF 标注/高亮;导出模板自定义
- Kun 的 design 稿生成(`WriteInfographicKind: design`)——本轮只做 infographic 一种

### 非目标

- 不改一期已定的 agent 改稿回路、审阅、守卫行为。

## Implementation Units

### U1. 粘贴图片落盘(img/ 约定)

- **Goal**:R1。**Dependencies**:无。
- **Files**:`apps/desktop/src/main/ipc/fs.ts`(`fs:writingSaveImage`)、types 双镜像、preload、`packages/core/desktop/bridge.ts`、`packages/core/writing/paste-image.ts`(+测试)、`packages/views/cortex-desktop/writing/rich/WritingRichEditor.tsx`(paste handler,参照 Kun:`src/renderer/src/write/paste-image.ts`)、`WritingEditorPane.tsx`(CM 档 paste)。
- **Approach**:剪贴板图片 → base64 经 IPC 写 `<空间根>/img/pasted-<ts>-<rand>.<ext>`(mkdir -p,重名递增);返回绝对路径,渲染端算相对当前 md 的相对链接插入;rich 走 tiptap paste 事件,live/source 走 CM `dom paste`。
- **Test scenarios**:落盘路径/重名递增/非图片粘贴不拦截/相对链接换算(同目录、子目录、父目录)/无 bridge 降级不拦截。
- **Verification**:粘贴后 md 内出现相对链接且 rich 档立即渲染(一期 local-image 节点已支持)。

### U2. 字数口径对齐

- **Goal**:R2。**Dependencies**:无。
- **Files**:`packages/core/writing/doc-stats.ts`(+测试)、`WritingToolbar.tsx`/`WritingEditorPane.tsx` 接入。
- **Approach**:移植 Kun 统计口径(读 Kun:`computeWriteDocumentStats` 所在模块):Markdown → 可见文本(剥语法标记,保留链接文字/图片 alt)→ 去空白按 code point 计;rich 档可直接用 tiptap 文档 textContent(与解析口径一致性在测试中锁住)。
- **Test scenarios**:标题/粗斜体/链接/图片/代码块/表格/任务列表样例的计数与 Kun 口径断言;空文与纯空白为 0。

### U3. inline-completion(ghost text + Cmd-K 就地改写)

- **Goal**:R3、R4、R5。**Dependencies**:无(与 U4 并行)。
- **Files**:`apps/desktop/src/main/ipc/writing-llm.ts`(新,`registerWritingLlmHandlers`,进 register.ts)、types 双镜像、preload、bridge;`packages/core/writing/inline-edit.ts`(协议,参照 Kun:`src/renderer/src/write/inline-edit.ts`)、`packages/views/cortex-desktop/writing/completion/`(CM ghost text 扩展,参照 Kun:`src/renderer/src/write/inline-completion/`);SettingsMenu 写作节(baseUrl/apiKey/model/开关,参照 timeline 节写法);各就近测试。
- **Approach**:主进程移植 Kun `write-inline-completion-service` 的 prompt 构造/截断/去回声核心,LLM 调 `postChatCompletion`;ghost text:去抖触发、Tab 采纳、Esc/编辑取消;Cmd-K:前缀 6000/后缀 4000 字 + `<<<EDIT>>>` 协议 → 结果 `beginDiffReview(基线=当前内容, next=替换后内容)`。未配置 → 功能入口隐藏。
- **Execution note**:主进程服务先写协议纯函数测试(prompt 构造/响应解析),再接 IPC。
- **Test scenarios**:prompt 构造含前后缀截断边界;响应解析(合法/包尾语/空);Cmd-K 无选区禁用;未配置降级;ghost text Tab 采纳产出正确文本;审阅通道复用(不新建第二套 diff)。

### U4. 检索上下文

- **Goal**:R6。**Dependencies**:无(PDF 分支在 U5 接)。
- **Files**:`apps/desktop/src/main/ipc/writing-retrieval.ts`(新)+ types/preload/bridge;`packages/core/writing/prompt.ts`(`[相关文献上下文]` 注入位已有哨兵体系);助手发送编排接检索;设置开关;就近测试(主进程打分核心可测纯函数)。
- **Approach**:移植 Kun `write-retrieval-service` 的索引/分词/打分核心(md 全量、增量靠 watch 信号失效重建);发送时以用户正文查询 top-k,片段带文件名注入;失败/超时静默降级。
- **Test scenarios**:打分排序正确性(关键词命中/多文档);开关关闭不注入;空间无文档不注入;索引失效重建(文件改动后检索到新内容)。

### U5. PDF 阅读与文本抽取

- **Goal**:R7、R8。**Dependencies**:U4(接 PDF 索引分支)。
- **Files**:`packages/views/cortex-desktop/writing/pdf/WritingPdfViewer.tsx`(pdfjs 动态 import,参照 Kun:`src/renderer/src/components/write/WritePdfViewer.tsx`)、`WritingEditorPane.tsx`(按扩展名分派)、`WritingSpaceGroup.tsx`(树显示 pdf);`apps/desktop/src/main/ipc/writing-pdf.ts`(文本抽取,参照 Kun:`write-pdf-text-service.ts`)+ 四层;U4 索引接 pdf 文本;选区引用 sourceKind=pdf;就近测试。
- **Approach**:viewer 只读(翻页/缩放/文本层选择);抽取按页缓存;树中 pdf 不给重命名外的写操作特殊化。
- **Test scenarios**:.pdf 打开分派到 viewer;文本层选中 → 引用 chip 带页码;抽取失败跳过索引不报错;非 pdf 行为不回归。

### U6. 重型导出

- **Goal**:R9。**Dependencies**:U2(导出 HTML 复用可见文本/渲染管线口径)。
- **Files**:`apps/desktop/src/main/ipc/writing-export.ts`(新,参照 Kun:`write-export-service.ts`)+ 四层;`WritingToolbar.tsx` 导出菜单;就近测试(md→HTML 纯函数可测,DOCX/PDF/PNG 走集成冒烟)。
- **Approach**:md→HTML(对齐 Kun 渲染与内联样式)→ DOCX(html-to-docx)/PDF(隐藏窗口 printToPDF)/PNG(capturePage)/HTML 文件/复制富文本(clipboard html);目标路径经保存对话框(需确认既有 IPC,缺则加 `fs:pickSavePath`)。
- **Test scenarios**:md→HTML 快照(标题/表格/代码块/图片相对路径内联);各格式导出成功路径回报;取消保存对话框不写文件;html-to-docx 失败给可读错误。
- **Verification**:发版核查项——electron-builder `files` 不排除 html-to-docx 及传递依赖;打包后仓库外冒烟(lessons)。

### U7. 信息图生成

- **Goal**:R10。**Dependencies**:U1(共用 img/ 落盘)。
- **Files**:`apps/desktop/src/main/ipc/writing-infographic.ts`(新;编排:提示词模板 + media-gen client 调用 + img/ 落盘,参照 Kun:`write-infographic-service.ts` 与本仓库 `apps/desktop/src/main/capabilities/media-gen/`)+ 四层;入口在富文本浮动工具条与助手选区区;就近测试(提示词构造纯函数)。
- **Approach**:选区文本(超限截断照 Kun `WRITE_INFOGRAPHIC_MAX_TEXT_CHARS`)+ Kun 默认提示词模板 → media-gen 生成 PNG → `img/infographic-<ts>.png` → 光标处插入相对链接;media-gen 未配置入口隐藏;生成中状态与失败 toast。
- **Test scenarios**:提示词构造(截断/kind);未配置降级隐藏;落盘与插链正确;生成失败不写文件。

## Risks & Dependencies

- **html-to-docx 为主进程依赖**:externalizeDepsPlugin 下运行时从 asar 解析——发版前必须核查 `electron-builder.yml` 排除清单并仓库外验证(lessons 两条前车之鉴)。
- **pdfjs-dist 体积大**:renderer 动态 import + 可加入 builder 的 renderer-only 排除清单(同 @codemirror 待遇),U5 顺手处理。
- **主进程跑 pdfjs 抽取**:worker 与 Node 环境兼容问题以 Kun 实现为准,出现不兼容则降级「PDF 不入检索索引」不阻塞 U5 其余部分。
- **补全独立 LLM 配置**:默认未配置即全部降级隐藏,不得复用 agent CLI 凭据。

## Sources & Research

- 一期计划与 Kun 深挖报告(origin 文档 Sources 节);Kun 附属能力边界:检索被补全与助手上下文调用、pdf-text 喂检索,其余彼此独立。
- 本轮侦察:`apps/desktop/src/main/ipc/llm.ts`(openaiComplete + `openai-chat.ts` 真源)、`apps/desktop/src/main/capabilities/media-gen/`(openai-images 协议)、Kun `WORKSPACE_IMAGE_DIR='img'`(workspace-files.ts:59)、`electron-builder.yml` 排除清单现状(renderer-only 段)。
