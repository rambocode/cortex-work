# 右栏 Tasks Markdown 预览渲染增强

背景：右栏 tasks 文档预览（TodosView → MarkdownDetail，容器 `.pw-todo-md`）。

## 需求
- [x] 行内代码 `` ` `` 背景色太深（原用 `--bg-hover`），调浅
- [x] 支持 URL 链接渲染：点击走系统浏览器（Electron 里不能让 a 导航当前窗口）
- [x] 代码块渲染优化：卡片样式 + 语言标签
- [x] 支持 callout：`> [!important]` / `[!warning]` / `[!note]` / `[!tip]` / `[!caution]`，按类型渲染不同背景色

## 方案（已实施）
1. CSS：`.pw-todo-md code` 背景改 `--bg-card-2` + `--border-soft` 细边框（GitHub 风浅底）
2. 新 remark 插件 `markdownCallouts.ts`：mdast 层识别 blockquote 首段 `[!type]` 前缀，
   剥掉标记文本，注入 `className: pw-md-callout is-<type>` + `data-callout`；
   CSS 按类型上色（note→blue / tip→green / important→violet / warning→amber / caution→red），
   未知类型回落 note 配色，`::before` 显示类型标签
3. 链接：`components.a`（MdLink）拦截点击，http(s) 经 `bridge.openExternal` 开系统浏览器；
   bridge 新增可选 `openExternal`（core 接口 + preload + main `shell:openExternal`，仅放行 http/https）；
   无 bridge 时 fallback `window.open`
4. 代码块：`components.pre`（MdPre）读取 `language-x` className，`data-lang` + CSS `::after` 显示语言角标

## 改动文件
- packages/views/cortex-desktop/personal/markdownCallouts.ts（新增）
- packages/views/cortex-desktop/personal/markdownCallouts.test.ts（新增，7 用例）
- packages/views/cortex-desktop/personal/TodosView.tsx（MdLink/MdPre/插件接入）
- packages/views/cortex-desktop/personal/TodosView.test.tsx（新增 3 用例：链接/代码块/callout）
- packages/views/cortex-desktop/cortex-desktop.css（行内 code、pre 角标、callout 五色）
- packages/core/desktop/bridge.ts（接口 openExternal?）
- apps/desktop/src/preload/index.ts（openExternal → shell:openExternal）
- apps/desktop/src/main/ipc/fs.ts（shell:openExternal，仅 http/https）

## 验证
- [x] markdownCallouts 单测（mdast 变换，7 passed）
- [x] TodosView.test.tsx：callout class / 链接点击 openExternal / 代码块语言角标
- [x] 全量测试：views 77 passed、core 83 passed、desktop 42 passed；三包 typecheck + lint 通过
- [ ] UI 效果由用户手动验证（见 memory: 验证分工）

## 遗留
- PersonalChatArea 的聊天 Markdown 未套用同一套 callout/链接处理（本次只改 tasks 预览，按需求范围）
