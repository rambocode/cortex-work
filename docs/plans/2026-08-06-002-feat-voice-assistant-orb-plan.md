# 语音聊天 → 语音助手（语音球）改造方案

> 状态：已实施（2026-08-06）。本文档记录架构决策与约束，便于后续维护者理解「为什么长这样」。

## 背景与目标

旧「语音聊天」是独立浮层窗口（480×520，显示消息列表），链路走 `cli:start` 旁路：会话硬锁死在
固定的 `"voice-chat"` 一条，pi 走 oneshot 单发（无 computer-use / automation / calendar / MCP /
skills 能力注入），无权限档语义，且唯一入口是默认未绑定的全局热键。本次改造为「语音助手」：

- **全部 agent 能力 + 完整权限**：语音轮次改走主窗口会话发送管线（`usePersonalActions().send`，
  pi 长驻 gateway 会话），执行档强制「自动」；`gui_*` / automation / calendar 写工具的强制审批
  红线在 `permissionMode.ts` 派生层，不随档位放开。
- **不显示会话内容**：UI 只有一个按设计稿（Cortex Voice HiFi）canvas 绘制的「语音球」。
- **复用会话（三级回退，保持语音聊天持续性）**：① 主窗口正开着的会话（未归档
  activeSessionId）直接用；② 主窗口不在会话视图（落地页/写作/设置等）→ 续用**最近一次
  会话**并 `setActiveSession` 切回（主窗口同步跳到该会话）；③ 一条会话都没有 → 新建无项目
  会话（口径与 `PersonalSidebar.createContextSession` 一致：`ensureNoProjectDir(dayKey)` 作 cwd）。
- **与宠物同窗口互斥**：语音球渲染在 pet-overlay 窗口，启动即宠物隐藏，退出恢复。
- **彻底替换**旧 voice-chat 浮层；入口 = 宠物悬停 🎙 按钮（`.pet-mic`）+ 沿用全局热键
  `voiceSettings.chatHotkey`（宠物被禁用时热键也能唤起）。

## 核心架构决策

### D1. 管线在主窗口 headless 控制器 + overlay 纯展示（与 pet 镜像架构同构）

录音（`voiceRecorder` 共享）/ VAD（能量判停）/ STT（`stt:transcribe` + 可选纠错）/ 发送 / TTS
全在主窗口 renderer（CoreProvider、personal store、`speakText` 都只在那里）；overlay 只收状态
快照 + 电平渲染语音球，点击经 `voiceAssistant:control` 归一成 command 回流控制器。

- 主窗口 closeToTray 隐藏时 media 不受节流，但 32ms VAD interval 会被 Chromium 节流到秒级 →
  激活期间主进程对 mainWindow `setBackgroundThrottling(false)`，退出恢复。
- 电平上报 30Hz 节流 + 变化量 > 0.02 才发；speaking 态电平由 overlay 侧渲染器合成振荡
  （真电平需给 TTS `<audio>` 挂 AnalyserNode，列为后续增强）。

### D2. 窗口双模式 `mode: "pet" | "voice"` + 可见性双轴

- `pet-overlay-window.ts`：`setPetOverlayMode()` 切模式即 `setBounds`（中心点不动 + 钳回显示器），
  voice 尺寸 `VOICE_OVERLAY_W/H = 280×380`（与 views `VoiceOrb.tsx` 常量镜像，改一处必须改两处）。
- 可见性拆两轴：`visibilityRequested`（宠物 enabled 轴）不动，`shouldShow = voice 模式 || 宠物轴`。
  宠物被禁用时热键也能唤起；退出 voice 不把已禁用的宠物带出来；voice 模式下 Pet 组件返回 null
  触发的 `pet:set-overlay-visible(false)` 不会把语音球窗口藏掉。
- IPC 走**新域 `voiceAssistant:*`**（`main/ipc/voice-assistant.ts`），`pet:*` 保持纯宠物职责；
  光标轮询 `pet:overlay-cursor` 复用（窗口 focusable:false 收不到 mousemove，语音球悬停靠它）。

### D3. 回合完成钩子 `core/personal/voiceTurn.ts`

`messages.ts` 三处埋点（`finalizeRun` / `failPiTurn` / pi 看门狗超时——后两处不经 finalizeRun）
广播 `VoiceTurnEnd`；控制器监听并接管朗读（返回 true 让 finalizeRun 跳过 `ttsSettings.autoSpeak`，
防同轮双读）。另以 `runningBySession` 置位→清零 + 600ms 宽限作未知旁路的兜底。

### D4. 状态机与交互

`idle → listening（VAD 静音判停）→ transcribing → thinking（send 后至回合结束）→ speaking
（TTS）→ 200ms 后回 listening`（连续对话回环；出错回 idle + hint 不回环）。
**持续监听**：VAD 的 idle-timeout 已禁用（`maxIdleMs=∞`），无人说话不会自动退出聆听；
结束聆听的唯一途径是用户显式操作（✕ 退出 / 热键提交 / 点球打断）。
**降噪链**（保证 STT 准确性）：① `VoiceCapture.start` 显式开启 Chromium 内建
echoCancellation / noiseSuppression / autoGainControl（作用于录音信号）；② VAD 判定链在
AnalyserNode 前加高通 120Hz + 低通 4kHz 语音频带滤波（只影响判定,不触碰录音），环境噪声
不再抬高自适应阈值或误触发。
点击球体：idle 唤醒 / speaking 打断朗读 / **thinking 打断本轮 agent 运行**（`actions.stop`，
长时间思考不用干等）；热键：listening 立即提交 / speaking·thinking 打断 / idle 开麦；
🎙 按钮同语义；✕ 退出（退出本身不杀在跑的 agent 轮，会话属于主窗口）。
审批挂起（`piUiPending`）→ 语音球 hint「需要在主窗口确认操作」（审批弹窗只在主窗口渲染，
红线优先于流畅性）。

### D5. 屏幕上下文

`voiceSettings.chatScreenContext` 开时：激活前主进程冻结前台 pid（`axCapture`，必须在语音球
show 之前——之后 frontmost 语义被污染），提交前 `voiceAssistant:captureScreen` 截前台窗口写
0600 临时 PNG，以 `presavedImages` 附进语音轮；截屏成功触发语音球扫描脉冲动画（`scanTick`）。
vision 阻断（非视觉模型 + 图）时去图重试一次。

## 删除清单（硬切，无兼容层）

- 整文件：`renderer/voice-chat.html`、`src/voice-chat.tsx|.css`、`voice-chat-state.ts(+test)`、
  `voice-vad.ts(+test)`（迁至 views `personal/voice-assistant/vad.ts`）、`main/voice/voice-chat-window.ts(+test)`。
- `ipc/voice.ts`：固定会话逻辑（`VOICE_CHAT_SESSION_ID` / `upsertVoiceChatSession` /
  `voice-chat:load|save` / `voice:openChat|closeChat` / `toggleVoiceChatFromHotkey`）全删；
  保留热键校验/注册事务、听写、截图 provider 与前台 pid 冻结（`captureVoiceScreenshot` 供新域复用）。
- `preload/voice.ts` 删 `voiceChat` 桥（留 `dictation`）；vite 入口删 `voiceChat`。
- `VoiceSettings` 双镜像删 `chatProviderId/chatModelId`（模型跟随会话；hydrate 对旧档多余键天然容忍）。
- 存量用户的 `"voice-chat"` 会话不迁移不删（结构合法的普通 SessionMeta，主窗口可正常打开/归档）。

## 已知局限

1. 审批弹窗只在主窗口；语音球以 `awaitingApproval` hint 引导。
2. 目标会话已有在跑轮次时语音提交被拒 → hint「会话正忙」，不排队。
3. speaking 电平为合成振荡。
4. overlay 拖动窗口靠语音球外围容器（canvas 本体是 no-drag 的点击区）。
