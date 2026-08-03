# Pi Provider、模型能力与图片输入修复计划（修订版）

日期：2026-07-30
前置研究：`docs/2026-07-30-pi-tui-provider-model-capabilities-research.md`
版本锁定：`@earendil-works/pi-coding-agent@0.82.1` / `@earendil-works/pi-ai@0.82.1`

## 0. 范围与非目标

- **不做旧配置迁移**。旧 `providerSettings` 直接弃用，用户在新体系中重新添加 Provider；新版本负责清理旧明文与悬空引用的优雅降级（见 §5）。
- 不扩展 HEIC 转码；不恢复 Pi TUI 入口；Media Provider（图/音/乐/视频）不进入文本 Gateway；不做任何运行时远程模型目录同步。
- TTS/ASR 的 `/v1/audio/*` 链路不属于文本 Gateway 收编范围。

## 1. 总体原则

- 以锁定版本的 `@earendil-works/pi-ai` 为唯一 Provider、模型与能力来源；不维护 Cortex 自己的能力映射表，能力对用户只读。
- 构建时从 `builtinProviders()` 生成 `provider-catalog.json` 随应用打包；运行时设 `PI_OFFLINE=1`（已核实：只禁版本检查、目录刷新、包更新，不影响 OAuth 与模型请求），不访问 `pi.dev`。
- 内建 Provider 注册 extension 时**只覆盖 endpoint 与认证，不传 `models`**（pi 官方保留内置模型目录的方式）——这是本次事故的最小正确修复。
- 文本模型场景统一走 Pi 目录与认证状态；模型引用统一为 `{ providerId, modelId }`。
- 文本模型发送图片时阻止发送并保留草稿，不静默换模型、不静默丢图。

## 2. 阶段 ①：能力事故止血（最高优先级，独立交付）

目标：修复「Cortex extension 覆盖 pi 内置模型目录 → 能力被简化 → 图片被静默替换为占位文本」的根因。

### 2.1 构建期 Catalog

- 扩展 `scripts/build-pi-binary.mjs`（或新增同级脚本），从 `@earendil-works/pi-ai/providers/all` 的 `builtinProviders()` 生成 `resources/pi/provider-catalog.json`。
  - **注意**：`builtinProviders()` 不在 pi-ai 根 index 导出，必须走子路径 `@earendil-works/pi-ai/providers/all`；在 `apps/desktop/package.json` 显式添加与 pi-coding-agent 锁同版本的 `@earendil-works/pi-ai` 直接依赖，不依赖 pnpm 提升的传递依赖。
  - Catalog 含 schema version、pi version、内容 hash，以及 Provider 认证方式与模型的 `api/input/reasoning/thinkingLevelMap/contextWindow/maxTokens/cost/compat` 原始元数据。
  - Catalog 与 pi 二进制同版本、同时生成；缺失、版本不一致或生成失败直接让构建失败。
  - 零静态模型的 Provider（当前为纯动态的 `radius`）排除，不进 UI。
- 主进程新增 `providerCatalog.get`：返回只读、已校验、不含任何秘密的 Catalog。

### 2.2 extension 生成修正

- 重写 `apps/desktop/src/main/agents/pi-providers.ts`：内建 Provider 的 extension 只 `registerProvider(id, { baseUrl?, apiKey })`，**不传 `models`**，保留 pi 内置目录（含 `thinkingLevelMap`、`compat` 等 Cortex 未建模的字段）。
- 自定义 Provider 仍传完整模型对象，但字段来自用户提供的完整 Pi Provider/Model JSON（阶段 ③ 落地编辑器前，先保持现有 UI 字段直转，不再写入 `reasoning:false / input:["text"] / 131072 / 8192` 一类猜测默认——缺失字段视为配置不完整，拒绝注册并提示）。

### 2.3 图片链路修复

- **RPC 路径**：已有原生 `prompt.images`（`pi-rpc.ts`），保持不动。
- **Print/CLI、delegate、artifact/design 路径**：pi CLI 原生支持 `@<path>` 文件参数——`cli/args.js:172` 解析、`cli/file-processor.js` 做 MIME 魔数检测 + 自动缩放并转成 `initialImages`（源码已核实）。修复只需 `apps/desktop/src/main/agents/pi.ts` 的 `buildArgs` 把 `req.images[].path` 追加为 `@<path>` 参数，并把 `imageDelivery` 标记改为对应能力位。**不需要新造 runtime wrapper**。
  - 阶段 ① 落地时用真实多模态模型做一次冒烟，确认 `@file` 路线端到端可用。
- **发送前 vision 阻断**（主进程为最终权威）：Composer 在选模型、加图、发送前读取 Catalog 确认的模型能力（`input` 含 `image`）。不支持时：阻止发送、明确提示当前模型不支持图片、保留文本/图片/附件/编辑状态，提供「选择支持图片的模型」与「移除图片」操作，不自动换模型。此检查覆盖 RPC 与 CLI 两条路径的入口（`packages/core/personal/messages.ts` 发送分流点）。
- 保持现有上传范围 PNG/JPEG/GIF/WebP、多图（≤6）与重发；路径不存在、内容损坏、MIME 不符返回结构化错误并保留草稿。

## 3. 阶段 ②：凭据安全与 OAuth

目标：API Key 与 OAuth token 不再明文落盘；接入 pi provider-owned 认证流程。

- 主进程专属凭据文件：所有 API Key、OAuth token、refresh token、命名 Secret 用 `safeStorage` 加密。Renderer 只能获得 `configured/type/source/error` 状态，永不接触明文或密文。
- 实现 pi `CredentialStore` 接口的 safeStorage 后端（已核实接口可注入，`modify` 是唯一写路径且 OAuth 刷新在 store 锁内执行）；`modify` 在主进程串行，避免并发刷新覆盖。
- OAuth 接入：provider-owned `login/refresh` 走 pi 的 `ProviderAuth.oauth` 钩子；**登出没有 provider 钩子**，落到 `Models.logout(providerId)` / `CredentialStore.delete()`。
- 接受环境变量、AWS profile、gcloud ADC 等 ambient auth，UI 标注来源；Cortex 只能删除自己保存的凭据。
- **保留用户级「显示/隐藏 Provider」偏好**（与认证解耦，替代旧 `enabled` 的职责）：防止 shell 环境里的 ambient key 让模型选择器涌入几十个 Provider。
- `safeStorage` 不可用（如部分 Linux 环境）：只读警告、禁止新增或修改密钥，恢复后可正常使用；不做任何明文回写。
- **wrapper/broker 决策**：仅当「Agent 子进程长驻期间 OAuth token 过期需回主进程集中刷新」被证实为必要场景时，才引入带随机进程令牌的 IPC broker 与 runtime wrapper；API Key 场景维持现有 `CORTEX_PI_KEY` 环境变量注入（extension 文件 0600、不含明文）。图片修复与 wrapper 无关（已在阶段 ① 用 `@file` 解决）。
- 全链路禁泄：凭据、OAuth code、Header、token 不得进入日志、traces、argv、持久化业务状态或错误详情。

### 主进程接口（阶段 ② 落地）

- `providerAuth.status/login/respond/cancel/logout/setApiKey/setSecrets`：API Key 与 provider-neutral OAuth 交互（复用 pi `AuthInteraction` 的 `prompt/notify` 协议：text/secret/select/manual_code + auth_url/device_code/progress）。
- `providerConnection.test`：显式用所选或首个模型发最小文本请求，调用前提示可能产生少量费用；保存配置不自动测试。

## 4. 阶段 ③：Gateway 收编与 UI 重构

### 4.1 Pi Model Gateway

- 新增 Gateway（主进程内模块或 worker），直接调用 pi `Models.complete/stream`，覆盖 Catalog 中出现的 `api` 类型；统一流式事件、取消、usage、认证错误与 Provider 错误。
- 暴露 `modelGateway.complete/stream/abort`；Renderer 与业务模块不得直接拼接 Provider URL。
- **收编清单**（现直连 `/chat/completions` 的全部调用方）：
  - Reply 草稿生成（`main/reply/draft-generator.ts`）
  - Research（`main/research/research-model-gateway.ts`）
  - 用户记忆「做梦」蒸馏（`main/index.ts` dreamGenerate）
  - Timeline/日报（`ipc/llm.ts` openaiComplete）
  - Writing ghost-text / Cmd-K（`ipc/writing-llm.ts`，含独立 `WritingLlmSettings` 的归并决策）
  - workflow AI 节点与 Automation 若走文本补全的部分
- **排除项**：TTS/ASR（`/v1/audio/*`，与 `push-sign.ts` 共用 URL 拼接，需先拆分再删旧路径）、Media-gen、Knowledge。
- 静态检查「业务模块不再硬编码 `/chat/completions`」的 lint/测试要显式豁免音频路径。

### 4.2 Provider 管理页与模型选择器

- 管理页左侧列 Catalog 中的 Provider，区分未配置 / safeStorage / OAuth / 环境变量 / ambient auth。
- 内建 Provider：登录、API Key、注销、连接测试、高级 `baseUrl` 覆盖；**不再提供模型增删、能力复选框或启用开关**。模型详情为只读可搜索列表（图片输入、推理、context、max output、协议、成本）。
- 自定义 Provider：带 Pi schema 校验与行级错误的 JSON 编辑器；明文 Secret 禁止内嵌，敏感 Header 用 `${secret:NAME}` 引用，由独立 Secret 编辑器写入 safeStorage；保存时拒绝未定义引用与非法 schema。
- OAuth 统一交互对话框（登录方式选择、打开浏览器、设备码、复制/粘贴回调码、进度、取消、重试、注销），不为单个 Provider 写专属页面。
- 全局模型选择器只展示「认证可用 ∧ 用户未隐藏」的 Provider，支持按 Provider/模型 ID/名称搜索，显示图片、推理、context 徽标；Research、Reply、Automation、workflow、Computer Use 复用同一组件，Computer Use 只列 `input` 含 `image` 的模型。

## 5. 旧配置处理（不迁移）

- 新版本首启：**删除** `~/.cortex-desktop/personal-workspace.json` 中的旧 `providerSettings` 字段（含全部明文 `apiKey`），一次性提示「Provider 配置已升级，请重新添加」。不保留明文备份。
- 悬空引用兜底：会话 `defaultProviderId/defaultModel`、Reply/Research/Automation/workflow 设置、Computer Use 模型选择，遇到 Catalog 中不存在或未认证的引用时进入「未配置模型」阻断态并给出设置入口；**不自动回退任何模型**。
- Automation/定时任务在后台触发且模型未配置时：跳过执行并产生一条用户可见的失败通知/记录（单次去重，不刷屏），不静默失败。
- 其余明文密钥（`mediaGenSettings`、`writingLlmSettings`、TTS/ASR）不在本计划范围，但阶段 ② 的 safeStorage 基建应预留复用接口，后续单独立项收编。

## 6. 测试与验收

- **Catalog**：固定 pi 版本的生成快照、完整能力字段、radius 排除、版本/hash 校验、dev 与 packaged 均能加载。
- **事故根因回归（关键）**：同一 pi 二进制加载 Cortex extension 前后，`get_available_models` 中已知模型的 `reasoning/input/thinkingLevelMap/contextWindow/maxTokens/compat` 逐字段不变；对原生 provider 断言注册配置不含 `models`。
- **图片**：多模态模型在 RPC、Print(`@file`)、delegate、Design/Artifact 中解析单图与多图，pi 不产生 `(image omitted...)`；文本模型在全部入口被阻断且草稿不丢；能力全程不可由用户修改（内建）。
- **安全**：safeStorage 加解密、OAuth 并发刷新串行、Secret 引用替换、日志/traces/argv/错误详情不泄密、safeStorage 不可用时的只读降级。
- **Gateway**：对 Catalog 中出现的每种 `api` 做 **mock transport 层契约测试**（bedrock/vertex 等 ambient 凭据协议不真调），覆盖 complete、stream、abort、usage、认证失败；静态检查豁免音频路径。
- **Agent 回归**：RPC/Print 双模式、native resume、`calibratePiSessionFile → closePiSession → delegate → 恢复` 生命周期、session file 争用、配置变更后经 extensionFingerprint 机制在下一轮重启（复用现有指纹机制，不另起判定）、traces 归属不串线。
- **旧配置**：存在旧 `providerSettings` 时正常启动、字段被清除、各入口显示待配置引导、自动化失败通知可见。
- **UI**：认证状态、OAuth 全交互、只读能力、搜索与徽标、自定义 JSON/Secret 校验、连接测试费用提示、无障碍键盘操作。
- 最终 packaged smoke test：至少一个 API Key Provider、一个 OAuth Provider、一个自定义 Provider、一个文本模型、一个图片模型。

## 附：已核实的关键技术事实（0.82.1 源码）

| 事实 | 证据 |
| --- | --- |
| `builtinProviders()` 同步静态，需子路径导入 | `pi-ai/dist/providers/all.js`；根 index 不导出 |
| `radius` 纯动态、静态目录零条目 | `providers/radius-config.js:44`，默认网关 `radius.pi.dev` |
| `Models.complete/stream` 存在 | `pi-ai/dist/models.d.ts`；`ModelRuntime implements Models` |
| `KnownApi` 10 种 + 开放字符串 | `pi-ai/dist/types.d.ts:15` |
| `CredentialStore` 可注入，`modify` 唯一写路径 | `pi-ai/dist/auth/types.d.ts`；`createModels({credentials})` |
| OAuth login/refresh 是 provider 钩子，logout 不是 | `ProviderAuth.oauth`；登出走 `Models.logout` |
| RPC `prompt/steer/follow_up` 带 `images` | `rpc-types.d.ts` |
| `runPrintMode` 有 `initialImages`；CLI `@file` 参数原生转图片 | `print-mode.d.ts`；`cli/args.js:172`、`cli/file-processor.js`、`main.js:624-694` |
| `PI_OFFLINE` 只禁启动网络与目录刷新 | `main.js:366`、`model-runtime.js:71`、`version-check.js:21` |
| 不传 `models` 注册保留内置目录 | `provider-composer.js:108-131`、`docs/custom-provider.md:93-120` |
