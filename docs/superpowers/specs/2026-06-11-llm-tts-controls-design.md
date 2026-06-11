# LLM 回复语音控制优化设计

日期：2026-06-11

## 背景

个人工作区已有 TTS 基础能力：Agent 回复完成后在 `handleCliExit` 触发 `speakText`，系统语音走 renderer `speechSynthesis`，自定义语音走 OpenAI 兼容 `/v1/audio/speech`。当前缺口是播放控制和音色配置体验：

- 用户需要随时停止当前朗读。
- 用户需要重新听上一条回复，并可在切换音色后用新音色重听。
- 自定义语音配置应尽量根据当前模型返回的音色列表选择，而不是只能手填。

## 目标

1. 把 TTS 播放状态集中在 `packages/core/personal/tts.ts`，避免 UI 组件各自持有 `Audio` 或 `SpeechSynthesisUtterance`。
2. 为 UI 暴露最小控制面：停止、重新听、订阅播放状态。
3. 为 OpenAI-compatible TTS 增加可选的音色列表发现能力；接口不可用时回退到常用音色并允许手填。
4. 保持 web 端无 bridge 时静默降级，不破坏现有个人工作区。

## 非目标

- 不实现逐字/逐句高亮。
- 不做跨会话播放队列；始终单实例，新朗读打断旧朗读。
- 不强绑定某一个厂商的 voices endpoint。

## 方案

### 播放控制器

`tts.ts` 维护模块级状态：

- `lastSpeech`：最近一次清洗后的文本与设置快照，用于重听。
- `isSpeaking`：当前是否正在朗读。
- `listeners`：轻量订阅，供 React UI 渲染按钮状态。

公开函数：

- `speakText(bridge, settings, raw)`：清洗文本、停止旧朗读、记录 lastSpeech、开始播放。
- `stopSpeaking()`：取消 `speechSynthesis` 和当前 `Audio`。
- `replayLastSpeech(bridge, settings?)`：用传入设置或 lastSpeech 设置重新播放最近文本。
- `subscribeTtsPlayback(listener)` / `getTtsPlaybackState()`：给 UI 读取状态。

### 音色列表

新增 `TtsVoiceOption` 和 `TtsListVoicesRequest` 类型，并在 `DesktopBridge` / preload / Electron main 里增加：

```ts
listTtsVoices(req: TtsListVoicesRequest): Promise<TtsVoiceOption[]>
```

main 进程按顺序尝试常见扩展 endpoint：

1. `{base}/v1/audio/voices?model=<model>`
2. `{base}/v1/models/<model>/voices`
3. `{base}/v1/voices?model=<model>`

解析兼容 `{ voices: [...] }`、`{ data: [...] }` 和直接数组。失败返回空数组，由 UI 回退。

### UI

设置页：

- 系统语音保持系统 voices 列表。
- 自定义模型的 voice 字段改成可选列表 + 手填输入组合。
- 当 `baseUrl/model/apiKey` 变化时异步刷新音色列表；失败时显示回退选项。

聊天区：

- 在个人工作区 header 增加停止/重听按钮。
- `停止` 调 `stopSpeaking()`。
- `重听` 调 `replayLastSpeech(bridge, currentTtsSettings)`，因此切换音色后会使用当前音色重听。

## 验证

- `packages/core/personal/tts.test.ts` 覆盖文本清洗、lastSpeech、stop/replay 状态转换。
- `apps/desktop/src/main/ipc/push-sign.test.ts` 覆盖 voice endpoint URL 拼接。
- 运行 `pnpm test`、`pnpm typecheck`、`pnpm lint`。

## 自审

该方案把不可序列化的播放句柄留在单一模块，不进入 Zustand 持久化；UI 只消费小型状态快照。voices endpoint 采用 best-effort 发现，不让非标准端点阻断原有手填和试听流程。
