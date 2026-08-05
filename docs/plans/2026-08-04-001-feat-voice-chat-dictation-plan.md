# 语音功能:统一「语音」设置页 + 语音聊天浮层 + 系统级听写

> 状态:已规划,待实施。参考 openworker/coworker 调研 + 本仓现状审计(2026-08-04)。

## Context

需求来源:参考 https://github.com/andrewyng/openworker/tree/main/coworker 接入 Whisper Base 中文,并按 ChatGPT 桌面端「语音」设置页截图实现三块能力:语音聊天(可设快捷键、屏幕上下文)、听写(按住/切换快捷键、听写栏、听写词典)、统一「语音」设置页。

调研结论:coworker(Tauri+Rust+whisper-rs)只有应用内输入框听写且仅英文,**本仓的本地 Whisper 链路已比它完整**(`stt:*` IPC 域、whisper-cli 二进制、base/small/medium 多语模型下载管理、`VoiceCapture` 录音封装、TTS)。故本任务是「补齐缺口」而非从零接入:真正要建的是 **系统级听写**、**语音聊天独立浮层**、**设置分区合并**。中文支持:现有模型均为 multilingual ggml,`transcribe.ts` 已支持 `-l` language 参数,Whisper Base(base-q5_1,60MB)开箱可用。

已拍板决策:
1. 语音聊天 = **独立浮层**(半双工:说话→整段转写→发聊天 agent→TTS 朗读);
2. 设置页 = **彻底合并** 现有 `voice`(TTS)与 `stt`(模型管理)两分区为统一「语音」分区。

macOS 优先(whisper-cli 仅 darwin-arm64;听写注入/push-to-talk 依赖 Cortex_Helper 仅 mac),非 mac 门控隐藏相关设置。

## 可复用资产(已核实)

| 能力 | 位置 |
|---|---|
| 本地/在线转写 | `apps/desktop/src/main/capabilities/whisper/{transcribe,online-transcribe,models,locate}.ts`,IPC `stt:*` |
| 录音封装 | `packages/views/cortex-desktop/personal/chat/composer/voiceRecorder.ts`(`VoiceCapture` + `transcribeRecording`)、`encodeWav.ts` |
| TTS | `packages/core/personal/tts.ts`(模块级单例、零 React 依赖,`speakText`) |
| 光标处文本注入 | Cortex_Helper one-shot `paste <text>`(剪贴板备份→模拟 ⌘V→恢复,`Paste.swift`;`helper-client.ts:424`) |
| 按键事件 tap | Cortex_Helper events 常驻模式(`EventsMode.swift`;mac+辅助功能授权即常驻,`main/index.ts:683` 无功能开关门控) |
| 不抢焦浮层窗口 | `main/reply/bubble-window.ts`(`focusable:false`+`showInactive`+panel;**该窗口内 getUserMedia 已被 reply-bubble.tsx 生产验证可用**) |
| 前台窗口截图 | `ScreenOCR.swift` 的 `captureFrontmostWindow(pid)`(只差输出 PNG 的命令) |
| TCC 权限检查/重申请 | `main/reply/permissions.ts` + `permission-reprompt.ts`(辅助功能/麦克风/屏幕录制均已覆盖) |
| 全局快捷键模式 | `main/hotkey.ts` 纯函数 + `main/index.ts:145` notesHotkey 注册链(乐观持久化→重注册→回滚) |
| 快捷键录制 UI | `packages/ui/controls/HotkeyCapture.tsx` |
| 聊天带图 | `CliStartRequest.images: CliImageRef[]`(`ipc/types.ts:781`,pi imagePaths / codex `--image`) |

关键既有缺口(已核实):`transcribe.ts` 无 `--prompt`;在线转写无 `prompt` form 字段;tap mask 无 `keyUp`(push-to-talk 必须改 Swift);`getUserMedia({audio:true})` 不支持指定设备;helper `ocr` 不输出图像。

## 架构决策

- **D1 新分区 id `"speech"`**(显示名「语音」),删 `"voice"`/`"stt"` 两 tab。`settingsTab` 是瞬态字段不持久化、全仓无 `openSettings("voice"/"stt")` 调用点 → 零迁移风险,SettingsMenu 内做一行旧值归一化即可。i18n `voice.*`/`stt.*` 内容块**原 key 原位保留**(被复用组件继续消费,避免丢已有翻译),只新增 `speech` 块、替换 `tabs.*`。
- **D2 新顶层持久化字段 `voiceSettings`**(形状见下),`ttsSettings`/`asrSettings` 结构不动。
- **D3 快捷键分两类**:语音聊天键、听写「切换」键 → `globalShortcut`(只需 keydown,无需辅助功能权限,是天然兜底);听写「按住」键 → 扩展 helper EventsMode(keyUp 检测)。三键默认空串=关闭,须与 notes/tasks/reply 三键及彼此互斥。
- **D4 听写编排在主进程**(`dictation-controller`),录音在听写栏浮层 renderer(bubble-window 配方,不抢焦是硬约束——否则注入目标错位),注入复用 `helper.paste`,注入前做前台 pid 校验(转写期间前台 app 变了则丢弃,复用 `shouldAbortWriteBack` 思路)。
- **D5 语音聊天浮层 = 独立薄 renderer**(共享 preload,天然拿到完整 `desktopAPI`,**不嵌 CoreProvider**):`stt:transcribe` 转写 → `cli:start` 固定会话 id(如 `voice-chat`)+ `chat:load/save` 持久化(主窗口会话列表可见)→ 浮层内实现最小流式消费 → `speakText` 朗读。浮层对设置**严格只读**(`store:load`),一切写入只在主窗口,防双窗口覆写 personal-workspace.json。
- **D6 屏幕上下文走 helper 新 one-shot `screenshot [pid]`**(复用 `captureFrontmostWindow` → PNG base64 经 stdout,主进程落 temp 文件),不用 desktopCapturer(前台窗口定位/权限/坐标逻辑 helper 全现成)。TCC 复用 permissions.ts。
- **D7 听写词典 → `prompt` 全链路**:`AsrTranscribeRequest.prompt?` → whisper-cli `--prompt` / 在线 form `prompt`。转写显式带 `language`(沿用 `asrSettings.language`,中文置 `zh`/`auto` 已支持)。词典偏置强度有限(base 模型尤甚),文案按「偏置非替换」预期管理。

### `VoiceSettings`(双镜像:`apps/desktop/src/main/ipc/types.ts` ↔ `packages/core/desktop/types.ts`,types-mirror.test.ts 守卫)

```ts
// 语音功能设置(麦克风/语音聊天/听写)。TTS 与 ASR 引擎配置沿用 ttsSettings/asrSettings。
export interface VoiceSettings {
  micDeviceId: string;              // getUserMedia deviceId;"" = 系统默认
  chatHotkey: string;               // 语音聊天全局键;"" = 关闭(默认)
  chatScreenContext: boolean;       // 语音聊天附带前台应用截图(默认 false)
  dictationHoldHotkey: string;      // 按住听写(push-to-talk);"" = 关闭
  dictationToggleHotkey: string;    // 切换听写;"" = 关闭
  dictationBarAlwaysVisible: boolean; // 不录音也显示听写栏提醒
  dictationDictionary: string[];    // 听写词典 → prompt 偏置
}
export function defaultVoiceSettings(): VoiceSettings; // 全关/全空
```

### 新 IPC / bridge 清单

新域 `voice:*`(`main/ipc/voice.ts`,进 `register.ts`):
- `voice:setHotkeys(pick3)` → 每键 `{ok, toast?}`(照 notesHotkey 模式)
- `voice:screenshot()` → `{ok, path?, appName?, error?}`
- `voice:openChat()` / `voice:closeChat()`
- `dictation:control("cancel"|"stopAndCommit")`(听写栏上行)、`dictation:result({ok,text?,reason?})`、`dictation:state`(main→听写栏推送 phase)
- `voice-chat:command`(main→浮层:`startListening`/`focus`)

`DesktopBridge` 可选方法:`setVoiceHotkeys?`、`openVoiceChat?`。听写栏/浮层专用桥仿 `replyBubble` 挂 `desktopAPI` 顶层,不进 DesktopBridge。

## 分阶段实现(每阶段可独立提交验证)

### 阶段 1:转写管线增强(prompt + 指定麦克风)
- `whisper/transcribe.ts`:`TranscribeLocalOptions.prompt?`,非空追加 `["--prompt", prompt]`;`online-transcribe.ts`:`form.append("prompt", ...)`。
- `ipc/types.ts` + `core/desktop/types.ts` 镜像:`AsrTranscribeRequest.prompt?`;`ipc/stt.ts` 两分支透传。
- `voiceRecorder.ts`:`VoiceCapture.start(deviceId?)` → `{audio: deviceId ? {deviceId:{exact}} : true}`,`OverconstrainedError` 回退默认设备;`transcribeRecording(..., opts?: {prompt?})`。
- 测试:transcribe/online-transcribe 补 prompt 用例。
- 验证:`pnpm --filter @cortex-work/desktop test`(whisper 目录用例);设置页现有 stt 测试路径不回归。

### 阶段 2:`voiceSettings` 持久化 + 设置分区合并
- 双镜像 types + `PersistedState.voiceSettings?`;`core/store/personal.ts` 切片 + `setVoiceSettings` + hydrate 兜底 `defaultVoiceSettings()`;`usePersonalPersistence.ts` 加浅比较字段。
- **新建** `settings/SpeechSettingsSection.tsx`(按截图四卡:常规-麦克风下拉 / 语音聊天-TTS 语音+快捷键+屏幕上下文 / 听写-两快捷键+听写栏+词典 / 模型管理-复用 `<SttSettingsSection/>`);**新建** `SpeechTtsPanel.tsx`(把 SettingsMenu L1092-1297 的 VoiceSection **只搬不改**,SettingsMenu 回到 1200 行红线内);**新建** `SpeechDictationDictionary.tsx`(词典增删列表)。
- `SettingsMenu.tsx`:union 删 `"voice"|"stt"` 加 `"speech"`,TAB_META/NAV_GROUPS(personalization 组 `["pet","speech","reply"]`)/三元链三处同步;旧 tab id 归一化一行。
- 麦克风下拉:枚举前先 `getUserMedia({audio:true})` 拿权限再 `enumerateDevices`(未授权 label 为空,显示「麦克风 n」兜底);听写/屏幕上下文相关行仅 mac 显示。
- `HotkeyCapture` 核对是否支持「未设置/清除」态,不支持则加清除按钮。
- i18n:en/zh-Hans 同步加 `speech` 块 + `tabs.speech`,删 `tabs.voice`/`tabs.stt`;更新 `@types/resources.d.ts`。`docs/module-map.md` 加「语音」条目。
- 验证:`personal.test.ts` hydrate 用例、SettingsMenu 相关测试绿;手动确认旧 TTS 朗读/模型下载在新分区可用;`wc -l SettingsMenu.tsx` < 1200。

### 阶段 3:全局快捷键注册(聊天键 + 听写切换键)
- **新建** `main/voice/hotkeys.ts`(纯函数:冲突校验含与 NOTES/TASKS/REPLY 三常量及彼此互斥、空串=解绑,复用 `isValidAccelerator`)+ 单测。
- **新建** `main/ipc/voice.ts`:`voice:setHotkeys` 精确 unregister/register;`register.ts` 挂上;`main/index.ts` 启动读 `voiceSettings` 注册(回调先占位)。
- preload/bridge `setVoiceHotkeys`;设置页照 `applyNotesHotkey`(乐观持久化→重注册→失败回滚+toast)。
- 验证:纯函数单测;手动设键即生效、冲突被拒回滚、清除解绑。

### 阶段 4:语音聊天浮层
- **新建** `main/voice/voice-chat-window.ts`(bubble-window 配方但 `focusable:true`,alwaysOnTop+panel+复用不销毁);**新建** `renderer/voice-chat.html` + `src/voice-chat.tsx`;`electron.vite.config.ts` renderer input 加条目。
- 浮层状态机 `idle→recording→transcribing→sending→speaking→idle`;快捷键再按=停止提交(`voice-chat:command`);`store:load` 只读设置;`VoiceCapture(micDeviceId)`→`encodeWav`→`stt:transcribe`(带 language);`cli:start` 固定会话 `voice-chat` + `chat:load/save`(需实现最小流式消费,注释说明与 messages.ts 全量管线的刻意取舍);回复→`speakText`(system 引擎零依赖;openai 引擎经 preload 暴露 `ttsSynthesize*`)。
- 屏幕上下文:**新建** `Screenshot.swift`(抽 `captureFrontmostWindow` 复用,PNG→base64 stdout,沿用 `CGPreflightScreenCaptureAccess` 结构化报错);`main.swift` 分发 `screenshot [pid]`;`helper-client.ts` 加 `screenshot()`;`voice:screenshot` 落 temp png → `CliStartRequest.images`。TCC 走 permissions.ts 引导。
- `docs/module-map.md`:独立窗口表 + IPC 域分组补条目。
- 验证:窗口几何纯逻辑单测;手动:任意 app 按键唤起→说中文→流式回复+TTS→开屏幕上下文后消息带前台截图→主窗口可见会话历史。

### 阶段 5:听写(切换模式)+ 听写栏
- **新建** `main/voice/dictation-controller.ts`:状态机(idle/recording/transcribing),`toggle()/holdStart()/holdEnd()`;**必须移植 reply 的 voicePendingStopToken 竞态守卫**(快按快松防麦克风常开);收 `dictation:result` 后前台 pid 校验 → `helper.paste(text)`;辅助功能未授权 → permissions 引导 + toast。
- **paste 载荷改走 stdin**(听写内容是口述隐私,argv 会被 ps 看见;`runCommand` 已支持 `opts.stdin`,`Paste.swift` 改 readLine——calendar-create 已有同款先例)。
- **新建** `main/voice/dictation-window.ts`(屏幕底部小横条,`focusable:false`+`showInactive`,照抄 bubble-window 的 sessionOpen 闸门与 did-finish-load 时序守卫);**新建** `renderer/dictation.html` + `src/dictation-bar.tsx`(录音红点 + AnalyserNode 真实电平 + 快捷键提醒);vite input 加条目。
- 转写带 `language` + `prompt`(词典 join、截断 ~200 字符);「保持听写栏可见」= phase idle 也显示;`main/index.ts` 切换键接 `toggle()`。
- `docs/module-map.md` 独立窗口表补「听写栏」。
- 验证:controller 状态机纯函数单测(仿 `controller-state.ts`);手动:备忘录/微信内切换键→说话→再按→文本注入光标;词典偏置生效;「保持可见」重启后常驻;转写期间切换前台 app → 注入被丢弃。

### 阶段 6:push-to-talk(Swift 扩展,风险最高,最后做)
- `EventsMode.swift`:tap mask 补 `keyUp`;config 加 `dictation: {modifiers: string[], keyCode: Int?}`;纯修饰组合走 `handleFlags` 组合掩码(全按下→start,任一松开→end),含普通键的组合在 keyDown 匹配 keycode+flags→start 并吞键、keyUp 同 keycode→end;事件命名 `dictation-start`/`dictation-end`(与 reply 的 `voice-start/end` 区分,状态独立互不干扰);repeat keyDown 去抖。
- `helper-client.ts`:`HelperEvent` 加两事件;`sendConfig` 支持 `dictation` 字段(重启重放机制自动覆盖)。**注意:主进程 settings→sendConfig 的接线本来就欠着(reply 的 draftTrigger/voiceTrigger 是死代码),本次只接 dictation 字段,不顺手修 reply 的**。
- **新建** `main/voice/accelerator-keycode.ts`:accelerator → `{keyCode, modifiers[]}` 纯映射(ANSI 键码;映射不到 → 设置时报「该键不支持按住模式」)+ 单测。
- `main/index.ts:260` 的 `onEvent` 改成 dispatcher:按事件名路由 reply controller / dictation controller(**共用单一 events 进程,绝不另起第二实例**——重启退避/降级按单例设计)。
- hold 可用性门控:mac + 辅助功能授权 + helper 未降级;设置页该行实时显示「需要辅助功能权限」引导(读 `queryReplyPermissions`)。
- helper 重编译走既有 `helper-build-script`。
- 验证:`swift run Cortex_Helper events` stdin 喂 config 手测;keycode 映射单测;手动:按住说话松开注入、与 reply Fn 手势互不干扰、快按快松(<300ms)不产生垃圾注入。

## 风险点

1. helper events 进程是 reply 与 hold 键共享单点:reply 降级 = hold 失效;toggle 键(globalShortcut)始终兜底。
2. 双窗口写 personal-workspace.json:浮层只读约束要在代码注释写死。
3. 麦克风 TCC 弹窗时机:设置页首次枚举设备时即触发授权,避免听写第一次按键才弹窗。
4. whisper 冷 spawn 延迟:base/small 短句 1-4s 可接受,medium 体验差 → 文档注明,server 常驻模式列为 future work。
5. 词典偏置(initial_prompt)对 base 模型效果有限,文案按「偏置」措辞。
6. 浮层最小流式消费与 messages.ts 全量管线(技能/记忆注入)不一致,刻意取舍,注释说明。

## 提交切分(Conventional Commits 中文)

1. `feat(stt): 转写链路支持 prompt 偏置与指定麦克风设备`
2. `feat(settings): 合并语音/听写为统一「语音」分区并新增 voiceSettings 持久化`
3. `feat(voice): 语音聊天与听写全局快捷键注册`
4. `feat(voice): 语音聊天浮层(转写→聊天 agent→TTS,屏幕上下文截图)`
5. `feat(voice): 系统级听写(切换模式)与听写栏浮层`
6. `feat(voice): 听写按住说话(Cortex_Helper 按键事件扩展)`

## 整体验证

- 每阶段:`pnpm --filter @cortex-work/desktop typecheck` + 相关包 `pnpm test`;types-mirror.test.ts 守卫双镜像。
- 端到端手动(mac):设置页只剩统一「语音」分区且 TTS/模型下载不回归 → 设三个快捷键互斥生效 → 任意 app 语音聊天(中文、TTS 朗读、屏幕上下文带图)→ 备忘录/微信听写注入(切换+按住)→ 词典偏置 → 权限未授权时的引导与降级提示。
- 不杀用户正在跑的 dev:desktop 进程(验证以构建/测试通过为准)。
