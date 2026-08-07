# 语音功能领域说明

## 背景与范围

Cortex Desktop 的语音能力由统一的「设置 → 语音」分区管理，包含三项协作能力：

- 语音聊天：从独立浮层录音，转写整段语音后交给聊天 Agent，再用现有 TTS 朗读回复。
- 系统级听写：以切换或按住快捷键录音，将识别结果安全地写回当前应用的光标位置。
- 语音识别与播报：本地 SenseVoiceSmall、云端 ASR 与现有 TTS 引擎配置。

桌面优先目标是 macOS。非 macOS 或不具备桌面 bridge 的环境仍可查看通用 TTS/ASR 配置，但不会展示依赖系统级快捷键、辅助功能或前台应用截图的控制项。

## 领域概念

| 概念 | 说明 | 真源 |
|---|---|---|
| `VoiceSettings` | 麦克风、语音聊天与听写的交互偏好；不包含 TTS/ASR 引擎参数 | `core/desktop/types.ts` 与 `main/ipc/types.ts` 镜像 |
| `ttsSettings` | 自动朗读、系统语音、Edge TTS 或 OpenAI 兼容 TTS 引擎配置 | `store/personal.ts` |
| `asrSettings` | SenseVoiceSmall / 云端转写服务、语言与模型配置 | `store/personal.ts` |
| 语音词典 | 专有名词的转写 prompt 偏置列表；不是文本替换规则 | `VoiceSettings.dictationDictionary` |
| 语音聊天键 | 调起或提交语音聊天的全局快捷键 | `VoiceSettings.chatHotkey` |
| 听写切换键 / 按住键 | 前者走 Electron `globalShortcut`，后者依赖 helper 的按键抬起事件 | `VoiceSettings` |

`VoiceSettings` 的缺省值全部关闭或为空：空 `micDeviceId` 使用系统默认麦克风，三项空快捷键都表示禁用，词典为空。`defaultVoiceSettings()` 必须每次返回新对象，避免数组在 store 实例之间共享。

## 设置与持久化

设置页由 `SpeechSettingsSection.tsx` 组装四块内容：常规麦克风、语音聊天（含既有 TTS 面板）、听写和模型管理（复用 `SttSettingsSection`）。旧 tab id `voice` 与 `stt` 会在 `SettingsMenu` 中归一化为 `speech`，但不会再显示两个旧入口。

持久化路径如下：

```mermaid
flowchart LR
  UI[SpeechSettingsSection] --> Store[usePersonalStore.voiceSettings]
  Store --> Snapshot[toPersistedState 白名单]
  Snapshot --> Bridge[DesktopBridge.saveState]
  Bridge --> Disk[personal-workspace.json]
  Disk --> Hydrate[usePersonalPersistence.loadState]
  Hydrate --> Store
```

`voiceSettings` 是持久化切片，故 `saveUrgency` 将其变更纳入节流保存。hydrate 遇到旧存档缺少该字段时，必须回落 `defaultVoiceSettings()`，而不是保留 `undefined`。

`ttsSettings` 缺失时回落 `DEFAULT_TTS_SETTINGS`，因此新用户默认使用 `zh-CN-XiaoxiaoNeural` 的 Edge TTS；已有 `personal-workspace.json` 中保存的引擎配置不会被迁移或覆盖。

## 跨进程契约

`VoiceSettings` 与 `PersistedState.voiceSettings?` 是双镜像契约：任何字段变化都必须同时修改：

- `packages/core/desktop/types.ts`
- `apps/desktop/src/main/ipc/types.ts`

主窗口只通过可选的 `DesktopBridge.setVoiceHotkeys()` 下发三项快捷键。UI 先乐观更新持久化状态，再将完整的三键组合原子下发；若任一注册失败，整体回滚到旧组合并显示失败提示，保证 UI 与系统实际注册结果一致。

```mermaid
sequenceDiagram
  participant Settings as 设置页
  participant Store as Personal Store
  participant Bridge as DesktopBridge
  participant Main as main/voice
  Settings->>Store: 乐观写入完整三键
  Settings->>Bridge: setVoiceHotkeys(pick3)
  Bridge->>Main: voice:setHotkeys
  Main->>Main: 校验冲突并原子重绑
  alt 成功
    Main-->>Settings: 每项 ok
  else 失败
    Main-->>Settings: ok=false + toast
    Settings->>Store: 整组回滚
  end
```

## 关键实现与边界

### Edge TTS

Edge TTS 是无需 API Key 的在线神经网络语音。renderer 仅通过 `DesktopBridge.ttsSynthesizeEdge()` 与 `listEdgeTtsVoices()` 请求；WebSocket、微软的防重放签名和版本协商均留在主进程 `capabilities/edge-tts/`，避免暴露服务细节并绕开 renderer 的网络限制。它返回完整 MP3，播放层按句分块预取，不能复用只支持 WAV PCM 的流式播放器。

自动朗读、聊天手动朗读和语音聊天浮层会在 Edge 失败时静默回落系统语音；设置页试听不回落，直接显示错误以便用户排查。Edge 依赖网络且为非公开接口，系统语音始终保留为离线方案。

维护时首先检查 `capabilities/edge-tts/client.ts` 的 `SEC_MS_GEC_VERSIONS`：微软会提高可接受的 Chromium 版本下限，候选值全部收到 HTTP 403 时应更新该列表。`Sec-MS-GEC` 同时依赖本机五分钟时间窗口；设备时钟偏移超过五分钟也会导致 403。

### 麦克风设备

浏览器在未获授权前通常不会提供设备标签。设置页先尝试 `getUserMedia({ audio: true })`，立即停止临时轨道，再调用 `enumerateDevices()`；授权被拒或旧 WebView 不支持枚举时，仍保留「系统默认」回退。无标签设备显示「麦克风 n」，避免空白选项。

### 听写词典与转写

词典条目在 UI 侧去重、去首尾空白、单条限长，随后由听写控制器拼为有限长度的 prompt。在线转写链路将 prompt 透传给服务端；SenseVoiceSmall GGUF 本地链路不支持提示词偏置。词典只能影响支持 prompt 的模型偏好，不能保证纠正所有识别错误，也不能代替用户原始口述内容。

本地识别的协议、生命周期与失败边界见 [SenseVoiceSmall 本地语音识别](./sensevoice-asr.md)。

### 系统级听写

听写栏必须是 `focusable:false` 且以 `showInactive` 显示，避免录音时抢走目标应用焦点。控制器在提交前校验前台应用 pid；转写期间用户切换了应用时，结果必须丢弃而非注入错误窗口。文本注入复用 helper 的 paste 能力，敏感听写内容走 stdin，不能放进进程 argv。

### 语音聊天

语音聊天使用独立浮层、半双工状态机：`idle → recording → transcribing → sending → speaking → idle`。浮层仅读取已保存设置，不能写 `personal-workspace.json`，防止与主窗口的全量保存竞争。可选屏幕上下文会在浮层抢焦前冻结原前台应用的 pid，并由 helper 截取该窗口，不能在提交时重新读取前台应用而误截 Cortex 浮层；屏幕录制和麦克风权限失败时要保留无截图/无录音的明确降级提示。

### 权限与平台

- macOS 辅助功能权限是按住听写和光标注入的前提。
- 麦克风权限用于设备标签、语音聊天和听写录音。
- 屏幕录制权限只在启用语音聊天屏幕上下文时需要。
- 切换听写和语音聊天键使用 `globalShortcut`，因此可作为辅助功能权限不可用时的降级入口；按住听写不能降级为无权限可用。

## 测试与维护清单

- 为 `voiceSettings` 添加 hydrate、setter、`toPersistedState` 与 `saveUrgency` 覆盖。
- 设置测试应断言只存在 `speech` 入口、旧 tab 可归一化、模型管理仍渲染已有 ASR 表单。
- 修改设置资源后运行 `pnpm i18n:types`，同步 `resources.d.ts`。
- 新增语音 IPC、浮层或 helper 能力时更新 `docs/module-map.md`；独立窗口同时更新其窗口清单。
