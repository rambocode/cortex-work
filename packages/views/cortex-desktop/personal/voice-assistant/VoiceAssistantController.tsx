// 语音助手的主窗口 headless 控制器(不渲染 DOM,仿 pet/PetBridge 范式)。
//
// 为什么整条管线在主窗口而不是 overlay:录音/转写(voiceRecorder + stt)、发送
// (usePersonalActions().send —— 走 pi 长驻会话,带 computer-use / automation / MCP /
// skills 全部能力注入)、TTS(core/personal/tts)都依赖 CoreProvider 与 personal store,
// 它们只存在于主窗口。overlay 语音球是纯展示镜像:本控制器把状态快照/电平经
// desktopBridge 上报主进程转发,overlay 的点击经 voiceAssistant:control 归一成
// command 回流到这里。契约见 core/desktop/bridge.ts 的语音助手段。
//
// 会话语义(与旧 voice-chat 的固定会话根本不同):激活时若主窗口有未归档的当前会话,
// 语音轮次直接进该会话;否则新建一条无项目会话(口径与 PersonalSidebar 的
// createContextSession 一致)。执行权限强制切到「自动」档 —— gui_*/automation/calendar
// 写工具的强制审批红线在 permissionMode 派生层,不受档位影响。

import { useCallback, useEffect, useRef } from "react";
import {
  dayKey,
  getTtsPlaybackState,
  resolveDefaultAgent,
  speakText,
  stopSpeaking,
  subscribeTtsPlayback,
  useDesktopBridge,
  usePersonalStore,
} from "@cortex-work/core";
import type { ChatImageRef, SessionMeta } from "@cortex-work/core";
import { usePersonalActions } from "@cortex-work/core/personal/messages";
import { setVoiceTurnListener } from "@cortex-work/core/personal/voiceTurn";
import { DEFAULT_VOICE_CHAT_PROMPT } from "@cortex-work/core/desktop/types";
import type { VoiceAssistantCommand, VoiceAssistantSnapshot } from "@cortex-work/core/desktop/types";
import { VoiceCapture, transcribeRecording } from "../chat/composer/voiceRecorder";
import { createVoiceVadMonitor } from "./sileroVad";
import { initialVoiceAssistantState, transitionVoiceAssistant, type VoiceAssistantState } from "./state";

// 连续对话回环间隔:TTS 播完 → 重新开麦之间留 200ms 缓冲(让扬声器尾音衰减,
// 避免半双工切换瞬间把余音采进下一轮;沿用旧语音聊天的实测值)。
const RELISTEN_DELAY_MS = 200;
// 电平上报节流:约 30Hz 且变化量 > 0.02 才发(仿 pet 光标轮询的去重口径)。
const LEVEL_MIN_INTERVAL_MS = 33;
const LEVEL_MIN_DELTA = 0.02;
// runningBySession 清零后等 voiceTurn 钩子的宽限:超时仍停在 thinking 说明三处埋点都
// 没覆盖到(理论不该发生),兜底收尾避免语音球永远转圈。
const TURN_END_GRACE_MS = 600;
// SenseVoiceSmall 单次推理上限；到点自动按当前语句提交，避免 PCM 缓存无限增长。
const MAX_UTTERANCE_MS = 30_000;
const PRE_ROLL_BYTES = 16_000 * 2 * 0.32;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function VoiceAssistantController(): null {
  const bridge = useDesktopBridge();
  const actions = usePersonalActions();

  // 管线全部经 ref 驱动:command 订阅只挂载一次,不能让 React 闭包捕获旧 state。
  const bridgeRef = useRef(bridge);
  const actionsRef = useRef(actions);
  useEffect(() => {
    bridgeRef.current = bridge;
    actionsRef.current = actions;
  });

  const machineRef = useRef<VoiceAssistantState>(initialVoiceAssistantState);
  const sessionIdRef = useRef<string | null>(null);
  const captureRef = useRef<VoiceCapture | null>(null);
  const vadRef = useRef<{ stop: () => void } | null>(null);
  const vadEngineRef = useRef<"silero" | "energy" | null>(null);
  const localStreamIdRef = useRef<string | null>(null);
  const pcmWriteRef = useRef<Promise<void>>(Promise.resolve());
  const pcmWriteErrorRef = useRef<Error | null>(null);
  const speechStartedRef = useRef(false);
  const preRollRef = useRef<ArrayBuffer[]>([]);
  const preRollBytesRef = useRef(0);
  const utteranceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 退出/重开时递增,晚到的 getUserMedia resolve 依此自我释放,不占住下一次录音的麦克风。
  const recordingAttemptRef = useRef(0);
  const scanTickRef = useRef(0);
  const awaitingRef = useRef(false);
  const lastLevelRef = useRef({ value: 0, at: 0 });
  const relistenTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const turnGraceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 本轮是否观测到 running 置位(兜底判据:置位过又清零 = 一轮结束)。
  const sawRunningRef = useRef(false);

  /** 把当前状态汇成快照上报主进程(缓存并转发 overlay)。 */
  const report = useCallback((): void => {
    const m = machineRef.current;
    const snapshot: VoiceAssistantSnapshot = {
      active: m.active,
      phase: m.phase,
      level: 0,
      awaitingApproval: awaitingRef.current,
      scanTick: scanTickRef.current,
      error: m.error,
    };
    bridgeRef.current?.reportVoiceAssistantState?.(snapshot);
  }, []);

  const dispatch = useCallback(
    (event: Parameters<typeof transitionVoiceAssistant>[1]): VoiceAssistantState => {
      const prev = machineRef.current;
      const next = transitionVoiceAssistant(prev, event);
      if (next !== prev) {
        machineRef.current = next;
        report();
        // 连续对话回环:朗读正常收尾回 idle(无 error)→ 留缓冲后自动开麦。
        // 出错回 idle 不回环,避免同一错误无限循环;startListening 经 ref 调用,
        // 声明顺序在本回调之后。
        if (prev.phase === "speaking" && next.phase === "idle" && next.active && !next.error) {
          if (relistenTimerRef.current) clearTimeout(relistenTimerRef.current);
          relistenTimerRef.current = setTimeout(() => {
            relistenTimerRef.current = null;
            void listenRef.current?.();
          }, RELISTEN_DELAY_MS);
        }
      }
      return next;
    },
    [report],
  );
  // startListening 声明在 dispatch 之后,回环经 ref 解耦(与 submitRef 同款)。
  const listenRef = useRef<(() => Promise<void>) | null>(null);

  /** 停掉录音侧资源(麦克风 + VAD);不触碰 TTS 与状态机。 */
  const stopCapture = useCallback((): void => {
    if (utteranceTimerRef.current) clearTimeout(utteranceTimerRef.current);
    utteranceTimerRef.current = null;
    vadRef.current?.stop();
    vadRef.current = null;
    vadEngineRef.current = null;
    captureRef.current?.dispose();
    captureRef.current = null;
    const streamId = localStreamIdRef.current;
    localStreamIdRef.current = null;
    if (streamId) void bridgeRef.current?.cancelLocalAsrStream?.(streamId);
    preRollRef.current = [];
    preRollBytesRef.current = 0;
    speechStartedRef.current = false;
  }, []);

  /** 解析语音轮次的目标会话,三级回退保证「语音聊天的持续性」:
   * ① 主窗口正开着的会话(activeSessionId 且未归档)直接用;
   * ② 主窗口不在会话视图(落地页/写作/设置等,无 active)→ 续用**最近一次会话**并把它
   *    切成当前会话(主窗口同步跳回该会话,语音上下文不断档);
   * ③ 一条会话都没有 → 新建无项目会话。 */
  const resolveSession = useCallback(async (): Promise<SessionMeta | null> => {
    const s = usePersonalStore.getState();
    const existing = s.sessions.find((x) => x.id === s.activeSessionId && x.archivedAt == null);
    if (existing) return existing;
    // ② 续用最近会话:按 updatedAt 取最新的未归档会话,并置为 active(setActiveSession
    // 同时会把主窗口切回会话视图,用户看得到语音轮次落进了哪条会话)。
    const recent = s.sessions
      .filter((x) => x.archivedAt == null)
      .sort((a, b) => b.updatedAt - a.updatedAt)[0];
    if (recent) {
      s.setActiveSession(recent.id);
      return recent;
    }
    // ③ 新建。无项目会话必须带 noProjectDir(它就是 agent 的 cwd),口径与 PersonalSidebar 的
    // createContextSession 一致;桥缺能力(Web)时仍建会话,只是没有固定工作目录。
    const b = bridgeRef.current;
    const dir = b?.ensureNoProjectDir ? await b.ensureNoProjectDir(dayKey(Date.now())) : undefined;
    const agent = resolveDefaultAgent({ generalSettings: s.generalSettings, agentsAvailable: s.agentsAvailable });
    s.createSession(undefined, agent, undefined, dir ? { noProjectDir: dir } : undefined);
    const after = usePersonalStore.getState();
    return after.sessions.find((x) => x.id === after.activeSessionId) ?? null;
  }, []);

  /** 取会话最新元数据(store 里的对象随更新替换,不能长期持引用)。 */
  const currentSession = useCallback((): SessionMeta | null => {
    const id = sessionIdRef.current;
    if (!id) return null;
    return usePersonalStore.getState().sessions.find((x) => x.id === id) ?? null;
  }, []);

  const startListening = useCallback(async (): Promise<void> => {
    const phase = machineRef.current.phase;
    if (!machineRef.current.active || (phase !== "idle" && phase !== "speaking" && phase !== "thinking")) return;
    if (phase === "speaking") stopSpeaking(); // 打断:先停朗读再开麦
    if (phase === "thinking") {
      // 打断长时间思考:停掉本轮 agent 运行(走主窗口正常停止管线,与手点停止一致)。
      // 停止路径随后广播的 turn-end 因阶段已离开 thinking 会被钩子忽略,不会倒灌回来。
      const id = sessionIdRef.current;
      if (id) void actionsRef.current.stop(id);
      sawRunningRef.current = false;
      if (turnGraceTimerRef.current) {
        clearTimeout(turnGraceTimerRef.current);
        turnGraceTimerRef.current = null;
      }
    }
    if (relistenTimerRef.current) {
      clearTimeout(relistenTimerRef.current);
      relistenTimerRef.current = null;
    }
    const attempt = recordingAttemptRef.current + 1;
    recordingAttemptRef.current = attempt;
    dispatch({ type: "listening" });
    try {
      const s = usePersonalStore.getState();
      if (!s.asrSettings.enabled) throw new Error("请先在语音设置中启用语音识别");
      const b = bridgeRef.current;
      if (!b) throw new Error("桌面桥不可用");
      const capture = new VoiceCapture();
      // 先登记，sidecar/权限任一路失败时 catch 内的 stopCapture 都能释放刚申请的麦克风。
      captureRef.current = capture;
      const useLocal = s.asrSettings.protocol === "local-sensevoice";
      const requestId = useLocal ? crypto.randomUUID() : null;
      localStreamIdRef.current = requestId;
      pcmWriteErrorRef.current = null;
      speechStartedRef.current = false;
      preRollRef.current = [];
      preRollBytesRef.current = 0;

      const streamReady = useLocal
        ? (() => {
            if (!b.startLocalAsrStream || !b.appendLocalAsrAudio || !b.finishLocalAsrStream) {
              return Promise.reject(new Error("当前桌面版本不支持 SenseVoice 实时识别"));
            }
            return b.startLocalAsrStream({
              requestId: requestId!,
              modelId: s.asrSettings.model,
              language: s.asrSettings.language || "auto",
            });
          })()
        : Promise.resolve();
      pcmWriteRef.current = streamReady;
      void streamReady.catch(() => undefined);

      const enqueuePcm = (chunk: ArrayBuffer): void => {
        if (!requestId || !b.appendLocalAsrAudio) return;
        if (!speechStartedRef.current) {
          preRollRef.current.push(chunk);
          preRollBytesRef.current += chunk.byteLength;
          while (preRollBytesRef.current > PRE_ROLL_BYTES && preRollRef.current.length > 1) {
            preRollBytesRef.current -= preRollRef.current.shift()?.byteLength ?? 0;
          }
          return;
        }
        pcmWriteRef.current = pcmWriteRef.current
          .then(() => b.appendLocalAsrAudio!(requestId, chunk))
          .catch((error) => {
            pcmWriteErrorRef.current = error instanceof Error ? error : new Error(String(error));
          });
      };

      await capture.start(
        s.voiceSettings.micDeviceId || undefined,
        useLocal ? { onPcmChunk: enqueuePcm } : undefined,
      );
      if (attempt !== recordingAttemptRef.current || machineRef.current.phase !== "listening") {
        capture.dispose();
        if (captureRef.current === capture) captureRef.current = null;
        if (requestId) void b.cancelLocalAsrStream?.(requestId);
        return;
      }
      captureRef.current = capture;
      if (capture.mediaStream) {
        vadRef.current?.stop();
        vadRef.current = null;
        // 断句监视器:Silero 神经 VAD 优先,资产缺失/环境不支持自动降级能量 VAD
        // (见 sileroVad.ts)。两个引擎都保持持续监听(无 idle-timeout):不因无人说话退出,
        // 结束聆听的唯一途径是用户显式操作(✕ 退出 / 热键提交 / 点球打断)。
        // 首轮初始化含模型加载,await 期间用户可能已退出/换轮,回来必须校验代际。
        const monitor = await createVoiceVadMonitor(
          capture.mediaStream,
          (event) => {
            if (event === "speech-start") {
              speechStartedRef.current = true;
              const buffered = preRollRef.current;
              preRollRef.current = [];
              preRollBytesRef.current = 0;
              for (const chunk of buffered) enqueuePcm(chunk);
            } else {
              void submitRef.current?.();
            }
          },
          (rms) => {
            // 电平驱动语音球动画:RMS(近讲多在 0~0.12)放大到 0..1,节流 + 去抖后上报。
            const level = Math.min(1, rms * 8);
            const now = Date.now();
            const last = lastLevelRef.current;
            if (now - last.at < LEVEL_MIN_INTERVAL_MS || Math.abs(level - last.value) < LEVEL_MIN_DELTA) return;
            lastLevelRef.current = { value: level, at: now };
            bridgeRef.current?.reportVoiceAssistantLevel?.(level);
          },
          (message) => void bridgeRef.current?.logMessage?.("warn", message),
        );
        if (attempt !== recordingAttemptRef.current || machineRef.current.phase !== "listening") {
          monitor.stop();
          return;
        }
        vadRef.current = monitor;
        vadEngineRef.current = monitor.engine;
        utteranceTimerRef.current = setTimeout(() => void submitRef.current?.(), MAX_UTTERANCE_MS);
      }
      // VAD 必须在模型预热期间就开始监听，否则首次加载模型时用户已说出的句子会被漏掉；
      // PCM 写入链仍以 streamReady 为前置，因此不会在 BEGIN 之前写 AUDIO。
      await streamReady;
    } catch (err) {
      stopCapture();
      dispatch({ type: "failed", message: errorMessage(err) });
    }
  }, [dispatch, stopCapture]);

  /** VAD 判停/手动提交:转写 → 纠错 → (可选)截屏 → 送进会话。 */
  const submit = useCallback(async (): Promise<void> => {
    if (machineRef.current.phase !== "listening") return;
    const capture = captureRef.current;
    captureRef.current = null;
    if (utteranceTimerRef.current) clearTimeout(utteranceTimerRef.current);
    utteranceTimerRef.current = null;
    vadRef.current?.stop();
    vadRef.current = null;
    const vadEngine = vadEngineRef.current;
    vadEngineRef.current = null;
    dispatch({ type: "speechEnd" });
    try {
      // 手动提交可能早于 VAD 的 speech-start；此时把仅有的 320ms 前滚作为本句发送。
      if (!speechStartedRef.current) {
        speechStartedRef.current = true;
        const b = bridgeRef.current;
        const requestId = localStreamIdRef.current;
        if (b?.appendLocalAsrAudio && requestId) {
          for (const chunk of preRollRef.current) {
            pcmWriteRef.current = pcmWriteRef.current.then(() => b.appendLocalAsrAudio!(requestId, chunk));
          }
        }
      }
      preRollRef.current = [];
      preRollBytesRef.current = 0;
      const blob = await capture?.stop();
      capture?.dispose();
      if (!blob) throw new Error("没有录到音频");
      const s = usePersonalStore.getState();
      if (!s.asrSettings.enabled) throw new Error("请先在语音设置中启用语音识别");
      const b = bridgeRef.current;
      if (!b) throw new Error("桌面桥不可用");
      const streamId = localStreamIdRef.current;
      localStreamIdRef.current = null;
      let text: string;
      if (s.asrSettings.protocol === "local-sensevoice" && streamId && vadEngine === "silero") {
        await pcmWriteRef.current;
        if (pcmWriteErrorRef.current) throw pcmWriteErrorRef.current;
        if (!b.finishLocalAsrStream) throw new Error("当前桌面版本不支持 SenseVoice 实时识别");
        text = (await b.finishLocalAsrStream(streamId)).text.trim();
      } else {
        // Silero 不可用时按计划保留完整 WAV 降级路径；已启动的本地流先取消，避免占用 sidecar。
        if (streamId) await b.cancelLocalAsrStream?.(streamId);
        text = (
          await transcribeRecording(b, s.asrSettings, blob, {
            prompt: s.voiceSettings.dictationDictionary.join("，"),
          })
        ).trim();
      }
      if (!text) throw new Error("没有识别到语音内容");
      // 转写 LLM 纠错(开关/模型/prompt 由主进程按 voiceSettings 决定;失败原文返回)。
      if ((s.voiceSettings.transcriptPolish ?? true) && b.polishTranscript) {
        text = (await b.polishTranscript(text)).trim() || text;
      }

      let session = currentSession();
      if (!session || session.archivedAt != null) {
        // 会话被删/归档(用户在主窗口操作过):重新解析,不让语音助手指着尸体发言。
        session = await resolveSession();
        sessionIdRef.current = session?.id ?? null;
      }
      if (!session) throw new Error("没有可用的会话");
      const cwd =
        usePersonalStore.getState().projects.find((p) => p.id === session.projectId)?.path ??
        session.noProjectDir ??
        "";

      // 屏幕上下文(用户显式开关):截屏成功即触发语音球扫描脉冲动画。
      let presaved: ChatImageRef[] | undefined;
      if (s.voiceSettings.chatScreenContext && b.voiceAssistantCaptureScreen) {
        const path = await b.voiceAssistantCaptureScreen();
        if (path) {
          presaved = [{ path, name: "screen.png", mimeType: "image/png" }];
          scanTickRef.current += 1;
          report();
        }
      }

      // 提示词沿用旧语音聊天口径:自定义优先,空则内置(约束口语化输出适配 TTS)。
      // 经 extraSystemPrompt 注入,转写文本自身保持干净的用户消息。
      const chatPrompt = s.voiceSettings.chatPrompt.trim() || DEFAULT_VOICE_CHAT_PROMPT;
      sawRunningRef.current = false;
      let ok = await actionsRef.current.send(session, cwd, text, [], chatPrompt, undefined, presaved);
      if (!ok && presaved) {
        // vision 阻断(非视觉模型 + 图片)时去图重试一次;仍失败按会话忙处理。
        ok = await actionsRef.current.send(session, cwd, text, [], chatPrompt);
      }
      if (!ok) throw new Error("会话正忙或无法发送，请稍后再说");
      dispatch({ type: "sent" });
    } catch (err) {
      dispatch({ type: "failed", message: errorMessage(err) });
    }
  }, [currentSession, dispatch, report, resolveSession]);

  // VAD 回调经 ref 调 submit:互相引用的 useCallback 会形成声明顺序死结,ref 解耦。
  const submitRef = useRef<(() => Promise<void>) | null>(null);
  useEffect(() => {
    submitRef.current = submit;
    listenRef.current = startListening;
  }, [submit, startListening]);

  /** 回合结束:有正文 → 朗读;失败/空正文 → idle + 提示(点球即可继续)。 */
  const handleTurnEnd = useCallback(
    (ok: boolean, text: string): void => {
      if (turnGraceTimerRef.current) {
        clearTimeout(turnGraceTimerRef.current);
        turnGraceTimerRef.current = null;
      }
      if (machineRef.current.phase !== "thinking") return;
      const trimmed = text.trim();
      if (!ok || !trimmed) {
        dispatch({ type: "failed", message: ok ? "本轮没有可朗读的回复" : "本轮执行失败，点击球体重试" });
        return;
      }
      dispatch({ type: "speak" });
      void (async () => {
        try {
          const b = bridgeRef.current;
          const tts = usePersonalStore.getState().ttsSettings;
          if (!b) throw new Error("桌面桥不可用");
          await speakText(b, tts, trimmed, { allowFallback: true });
          // speakText 可能在排队后即返回;真正的播完信号由 subscribeTtsPlayback 兜住。
          if (!getTtsPlaybackState().isSpeaking && machineRef.current.phase === "speaking") {
            dispatch({ type: "speechFinished" });
          }
        } catch (err) {
          dispatch({ type: "failed", message: errorMessage(err) });
        }
      })();
    },
    [dispatch],
  );

  /** 退出语音助手:释放录音/朗读资源,复位状态。**不杀在跑的 agent 轮**——会话属于
   * 主窗口,轮次照常完成,只是没人朗读了(finalizeRun 的 voiceTurn 钩子返回 false 后
   * 会走用户自己的 autoSpeak 设置)。 */
  const teardown = useCallback((): void => {
    recordingAttemptRef.current += 1;
    stopCapture();
    stopSpeaking();
    if (relistenTimerRef.current) clearTimeout(relistenTimerRef.current);
    relistenTimerRef.current = null;
    if (turnGraceTimerRef.current) clearTimeout(turnGraceTimerRef.current);
    turnGraceTimerRef.current = null;
    sessionIdRef.current = null;
    dispatch({ type: "deactivate" });
  }, [dispatch, stopCapture]);

  const activate = useCallback(async (): Promise<void> => {
    if (machineRef.current.active) return;
    dispatch({ type: "activate" });
    try {
      const session = await resolveSession();
      if (!session) throw new Error("无法创建会话");
      sessionIdRef.current = session.id;
      // 完整权限:计划/询问档强制切自动(主窗口 CustomizePill 同步可见,诚实切档)。
      // gui_* 等红线工具的强制审批在 permissionMode 派生层,不随档位放开。
      if (session.execPermission === "plan" || session.execPermission === "ask") {
        usePersonalStore.getState().updateSession(session.id, { execPermission: "auto" });
      }
      await startListening();
    } catch (err) {
      dispatch({ type: "failed", message: errorMessage(err) });
    }
  }, [dispatch, resolveSession, startListening]);

  /** 主进程 command 分发(热键与 overlay 点击已在主进程归一)。 */
  const onCommand = useCallback(
    (command: VoiceAssistantCommand): void => {
      switch (command.type) {
        case "activate":
          void activate();
          return;
        case "deactivate":
          teardown();
          return;
        case "hotkey": {
          // 热键语义:聆听中 → 立即提交;朗读/思考中 → 打断重听;待机 → 开始聆听。
          const phase = machineRef.current.phase;
          if (phase === "listening") void submit();
          else if (phase !== "transcribing") void startListening();
          return;
        }
        case "ballClick": {
          // 点击球体:idle 唤醒 / speaking 打断朗读 / thinking 打断本轮运行(长时间思考
          // 不能只干等,startListening 内会先 stop 掉 agent 轮)。
          const phase = machineRef.current.phase;
          if (phase === "idle" || phase === "speaking" || phase === "thinking") void startListening();
          return;
        }
        case "micToggle": {
          // 🎙 按钮:待机开麦 / 聆听中手动发送 / 朗读与思考中打断。
          const phase = machineRef.current.phase;
          if (phase === "listening") void submit();
          else if (phase !== "transcribing") void startListening();
          return;
        }
        case "exit":
          teardown();
          return;
      }
    },
    [activate, startListening, submit, teardown],
  );
  const onCommandRef = useRef(onCommand);
  useEffect(() => {
    onCommandRef.current = onCommand;
  }, [onCommand]);

  // ── 订阅装配(挂载一次) ────────────────────────────────────────────────────
  useEffect(() => {
    const b = bridge;
    if (!b?.onVoiceAssistantCommand) return; // Web / 旧壳:无语音助手能力,整体降级
    const offCommand = b.onVoiceAssistantCommand((command) => onCommandRef.current(command));

    // 回合完成钩子:只接管「语音助手激活 + 绑定会话 + 正在等回复」的轮次;
    // 返回 true 让 finalizeRun 跳过 autoSpeak,同一轮不读两遍。
    setVoiceTurnListener((ev) => {
      if (!machineRef.current.active) return false;
      if (ev.sessionId !== sessionIdRef.current) return false;
      if (machineRef.current.phase !== "thinking") return false;
      handleTurnEnd(ev.ok, ev.text);
      return true;
    });

    // TTS 播完信号(speakText 早返回时的权威兜底)。
    const offSpeech = subscribeTtsPlayback((playback) => {
      if (!playback.isSpeaking && machineRef.current.phase === "speaking") {
        dispatch({ type: "speechFinished" });
      }
    });

    // 审批挂起派生(与 PetBridge 同款):散落多条路径的弹窗产生/清除,从 store 统一派生。
    const syncAwaiting = (pending: number): void => {
      const next = pending > 0;
      if (awaitingRef.current === next) return;
      awaitingRef.current = next;
      if (machineRef.current.active) report();
    };
    syncAwaiting(usePersonalStore.getState().piUiPending.length);
    const offAwaiting = usePersonalStore.subscribe((s) => syncAwaiting(s.piUiPending.length));

    // 兜底:runningBySession 置位过又清零、宽限期内 voiceTurn 钩子仍未收尾 → 按失败收。
    // (finalizeRun/failPiTurn/看门狗三处都埋了钩子,这里防的是未知第四条旁路。)
    const offRunning = usePersonalStore.subscribe((s) => {
      const id = sessionIdRef.current;
      if (!id || !machineRef.current.active) return;
      const running = !!s.runningBySession[id];
      if (running) {
        sawRunningRef.current = true;
        return;
      }
      if (!sawRunningRef.current || machineRef.current.phase !== "thinking") return;
      sawRunningRef.current = false;
      if (turnGraceTimerRef.current) clearTimeout(turnGraceTimerRef.current);
      turnGraceTimerRef.current = setTimeout(() => {
        turnGraceTimerRef.current = null;
        if (machineRef.current.phase === "thinking") {
          dispatch({ type: "failed", message: "本轮已结束但未取得回复，点击球体继续" });
        }
      }, TURN_END_GRACE_MS);
    });

    return () => {
      offCommand();
      offSpeech();
      offAwaiting();
      offRunning();
      setVoiceTurnListener(null);
      // 卸载即退出:释放麦克风/朗读,不留孤儿资源。
      recordingAttemptRef.current += 1;
      stopCapture();
      stopSpeaking();
      if (relistenTimerRef.current) clearTimeout(relistenTimerRef.current);
      if (turnGraceTimerRef.current) clearTimeout(turnGraceTimerRef.current);
    };
    // bridge 引用稳定(CoreProvider 注入),其余回调经 ref 转发,刻意只挂载一次。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bridge]);

  return null;
}
