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
  replayLastSpeech,
  resolveDefaultAgent,
  speakText,
  stopSpeaking,
  subscribeTtsPlayback,
  useDesktopBridge,
  usePersonalStore,
} from "@cortex-work/core";
import type { ChatImageRef, SessionMeta } from "@cortex-work/core";
import { usePersonalActions } from "@cortex-work/core/personal/messages";
import { setVoiceTurnListener, setVoiceTurnStreamListener } from "@cortex-work/core/personal/voiceTurn";
import { DEFAULT_VOICE_CHAT_PROMPT } from "@cortex-work/core/desktop/types";
import { isLocalStreamingAsrProtocol } from "@cortex-work/core/desktop/media-gen-types";
import type { VoiceAssistantCommand, VoiceAssistantSnapshot } from "@cortex-work/core/desktop/types";
import {
  VoiceCapture,
  transcribePcm16Recording,
  transcribeRecording,
} from "../chat/composer/voiceRecorder";
import { detectIsMac } from "../shared/platform";
import {
  createVoiceVadMonitor,
  type VoiceVadMode,
  type VoiceVadMonitor,
} from "./sileroVad";
import { initialVoiceAssistantState, transitionVoiceAssistant, type VoiceAssistantState } from "./state";
import { createVoiceTurnSpeaker, type VoiceTurnSpeaker } from "./streamingSpeaker";
import { isIgnorableVoiceTranscript } from "./vad";

// 全双工插话监听若未能及时建立，仍走这条保守回退：TTS 真正播完后留 650ms 给扬声器、
// 蓝牙链路和系统混音尾音衰减，再重新申请麦克风。
const RELISTEN_DELAY_MS = 650;
// 电平上报节流:约 30Hz 且变化量 > 0.02 才发(仿 pet 光标轮询的去重口径)。
const LEVEL_MIN_INTERVAL_MS = 33;
const LEVEL_MIN_DELTA = 0.02;
// runningBySession 清零后等 voiceTurn 钩子的宽限:超时仍停在 thinking 说明三处埋点都
// 没覆盖到(理论不该发生),兜底收尾避免语音球永远转圈。
const TURN_END_GRACE_MS = 600;
// SenseVoiceSmall 单次推理上限；到点自动按当前语句提交，避免 PCM 缓存无限增长。
const MAX_UTTERANCE_MS = 30_000;
// 快速口头确认(借鉴 ChatGPT 语音"先应一声,复杂工作后台继续"):send 受理后首 token
// 迟迟未到才播一句短确认,消解"说完没反应"的死寂。阈值不能太短——TTFT 快时抢先播
// 确认反而拖慢真首句(真首句起播会经 stopSpeaking 打断确认语,已播的部分白播)。
// 附带收益:这次合成把 Edge TTS 的 WSS 握手提前消化,真首句复用长连接首包更快。
const ACK_DELAY_MS = 900;
const ACK_PHRASES = ["好的，我来处理。", "收到，稍等一下。", "嗯，我看一下。"];
// 转写纠错的竞速预算：polish 与意图/会话解析/截屏并行后，send 前最多再等这么久。
// 快模型(p50 <1s)仍全额兑现纠错；慢模型/断网时放行 ASR 原文（语音提示词已声明转写
// 可能有误，Agent 对少量错字鲁棒），迟到结果直接丢弃，避免旧串行路径最长 8s 的尾延迟。
const POLISH_RACE_BUDGET_MS = 1500;
const PRE_ROLL_BYTES = 16_000 * 2 * 0.32;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** React ref 会被异步 command 订阅修改；封装读取可避免 TypeScript 把 submit 入口处的旧
 * phase 窄化错误地跨 await 保留，也让所有迟到结果使用同一判据。 */
function isActiveTranscribing(state: VoiceAssistantState): boolean {
  return state.active && state.phase === "transcribing";
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
  const captureModeRef = useRef<VoiceVadMode | null>(null);
  const vadRef = useRef<VoiceVadMonitor | null>(null);
  const vadEngineRef = useRef<"silero" | "energy" | null>(null);
  const localStreamIdRef = useRef<string | null>(null);
  const pcmWriteRef = useRef<Promise<void>>(Promise.resolve());
  const pcmWriteErrorRef = useRef<Error | null>(null);
  const speechStartedRef = useRef(false);
  const preRollRef = useRef<ArrayBuffer[]>([]);
  const preRollBytesRef = useRef(0);
  // 只从 VAD 前滚起保存 PCM；在线 ASR 与 Silero 降级都用它，不把 TTS 播放期音轨送去识别。
  const utterancePcmRef = useRef<ArrayBuffer[]>([]);
  const utteranceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 退出/重开时递增,晚到的 getUserMedia resolve 依此自我释放,不占住下一次录音的麦克风。
  const recordingAttemptRef = useRef(0);
  const scanTickRef = useRef(0);
  const awaitingRef = useRef(false);
  const lastLevelRef = useRef({ value: 0, at: 0 });
  const relistenTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const turnGraceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 快速口头确认定时器(send 受理时挂;真首句/打断/失败/退出都要清)。
  const ackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
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
        if (
          next.phase === "idle" &&
          next.active &&
          !next.error &&
          (prev.phase === "speaking" || event.type === "transcriptIgnored")
        ) {
          if (relistenTimerRef.current) clearTimeout(relistenTimerRef.current);
          relistenTimerRef.current = setTimeout(() => {
            relistenTimerRef.current = null;
            const current = machineRef.current;
            // 等待尾音期间可能发生 TTS 失败、退出或用户手动操作；定时器只允许从无错误
            // idle 自动回环，不能复活已经失败或被终止的语音轮。
            if (current.active && current.phase === "idle" && !current.error) {
              void listenRef.current?.();
            }
          }, RELISTEN_DELAY_MS);
        }
      }
      return next;
    },
    [report],
  );
  // startListening 声明在 dispatch 之后,回环经 ref 解耦(与 submitRef 同款)。
  const listenRef = useRef<(() => Promise<void>) | null>(null);
  // speaking 阶段后台开麦入口。经 ref 解耦 TTS 发起函数与下方 startListening 声明顺序。
  const bargeInRef = useRef<(() => Promise<void>) | null>(null);
  // 句级流式朗读接管器(挂载 effect 内创建,跨轮复用)。
  const speakerRef = useRef<VoiceTurnSpeaker | null>(null);

  /** 打断点联动停轮：流式朗读期 agent 可能仍在生成，打断只停 TTS 的话，用户下一句 send
   * 会撞「会话正忙」。必须在「先 dispatch 再 stopSpeaking」这对红线动作之后调用。 */
  const stopStreamedRun = useCallback((): void => {
    const speaker = speakerRef.current;
    if (!speaker?.ownsRun()) return;
    speaker.cancel();
    const id = sessionIdRef.current;
    if (id && usePersonalStore.getState().runningBySession[id]) {
      void actionsRef.current.stop(id);
      sawRunningRef.current = false;
    }
    if (turnGraceTimerRef.current) {
      clearTimeout(turnGraceTimerRef.current);
      turnGraceTimerRef.current = null;
    }
  }, []);

  /** 停掉录音侧资源(麦克风 + VAD);不触碰 TTS 与状态机。 */
  const stopCapture = useCallback((): void => {
    if (utteranceTimerRef.current) clearTimeout(utteranceTimerRef.current);
    utteranceTimerRef.current = null;
    vadRef.current?.stop();
    vadRef.current = null;
    vadEngineRef.current = null;
    captureRef.current?.dispose();
    captureRef.current = null;
    captureModeRef.current = null;
    const streamId = localStreamIdRef.current;
    localStreamIdRef.current = null;
    if (streamId) void bridgeRef.current?.cancelLocalAsrStream?.(streamId);
    preRollRef.current = [];
    preRollBytesRef.current = 0;
    utterancePcmRef.current = [];
    speechStartedRef.current = false;
  }, []);

  /** 收口一轮 TTS。播放期麦克风已就绪时直接转 listening；否则走 idle 延迟重开。
   * 退出确认始终先释放后台麦克风，再经主进程关闭语音球。 */
  const finishSpeech = useCallback((): void => {
    const previous = machineRef.current;
    const canContinueListening =
      previous.phase === "speaking" &&
      !previous.exitAfterSpeech &&
      captureModeRef.current === "barge-in" &&
      captureRef.current?.active === true;
    const next = dispatch({
      type: canContinueListening ? "speechFinishedListening" : "speechFinished",
    });
    if (canContinueListening && next.phase === "listening") {
      // 继续沿用播放期已经打开的流。VAD 保持连续人声确认直到接管第一段真人声，既不
      // 漏掉用户紧接着说话，也不会把扬声器/蓝牙尾音的单帧残余当作新一轮起音。
      captureModeRef.current = "listening";
      return;
    }
    if (previous.phase !== "speaking" || !previous.exitAfterSpeech || next.active) return;
    recordingAttemptRef.current += 1;
    stopCapture();
    const deactivate = bridgeRef.current?.voiceAssistantDeactivate;
    if (!deactivate) {
      // 能进入退出确认说明开始时 bridge 存在；若播放期间桥被卸载，恢复可见错误态，
      // 不能让 renderer 已 inactive 但原生语音球仍悬着。
      dispatch({ type: "activate" });
      dispatch({ type: "failed", message: "当前桌面版本不支持退出语音助手" });
      return;
    }
    void deactivate().catch((error) => {
      dispatch({ type: "activate" });
      dispatch({ type: "failed", message: errorMessage(error) });
    });
  }, [dispatch, stopCapture]);

  /** 新建一条无项目语音会话并切为主窗口当前会话。意图“新建对话”必须走这条显式路径，
   * 不能复用 resolveSession 的“优先续最近会话”语义。 */
  const createVoiceSession = useCallback(async (
    isCurrent: () => boolean = () => true,
  ): Promise<SessionMeta | null> => {
    const s = usePersonalStore.getState();
    const b = bridgeRef.current;
    const dir = b?.ensureNoProjectDir ? await b.ensureNoProjectDir(dayKey(Date.now())) : undefined;
    // ensureNoProjectDir 跨 IPC；等待期间用户可能已退出。守卫在真正写 session store 前执行，
    // 让迟到的“新建对话”意图不留下用户看不见的空会话。
    if (!isCurrent()) return null;
    const agent = resolveDefaultAgent({ generalSettings: s.generalSettings, agentsAvailable: s.agentsAvailable });
    s.createSession(undefined, agent, undefined, dir ? { noProjectDir: dir } : undefined);
    const after = usePersonalStore.getState();
    return after.sessions.find((x) => x.id === after.activeSessionId) ?? null;
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
      .filter((x) => x.relation !== "side" && x.archivedAt == null)
      .sort((a, b) => b.updatedAt - a.updatedAt)[0];
    if (recent) {
      s.setActiveSession(recent.id);
      return recent;
    }
    // ③ 新建。无项目会话必须带 noProjectDir(它就是 agent 的 cwd),口径与 PersonalSidebar 的
    // createContextSession 一致;桥缺能力(Web)时仍建会话,只是没有固定工作目录。
    return createVoiceSession();
  }, [createVoiceSession]);

  /** 取会话最新元数据(store 里的对象随更新替换,不能长期持引用)。 */
  const currentSession = useCallback((): SessionMeta | null => {
    const id = sessionIdRef.current;
    if (!id) return null;
    return usePersonalStore.getState().sessions.find((x) => x.id === id) ?? null;
  }, []);

  /** 本地意图的简短确认不创建伪造聊天消息，也不启动 Agent run；普通确认播完自动重听，
   * 退出确认则通过 `exitAfterSpeech` 在真正播完后关闭语音球。 */
  const speakLocalReply = useCallback(async (
    text: string,
    options?: { exitAfterSpeech?: boolean },
  ): Promise<void> => {
    const b = bridgeRef.current;
    if (!b) throw new Error("桌面桥不可用");
    const event = options?.exitAfterSpeech ? { type: "exitReply" as const } : { type: "localReply" as const };
    if (dispatch(event).phase !== "speaking") return;
    // 不等待 TTS 起播才开麦；权限与设备初始化和合成并行，减少用户开口时的失聪窗口。
    void bargeInRef.current?.();
    try {
      await speakText(b, usePersonalStore.getState().ttsSettings, text, { allowFallback: true });
      if (!getTtsPlaybackState().isSpeaking && machineRef.current.phase === "speaking") {
        if (options?.exitAfterSpeech) {
          // 没有实际起播时不能伪造“已播完”并静默关窗；保留语音球让用户重试或点 ✕ 退出。
          recordingAttemptRef.current += 1;
          stopCapture();
          dispatch({ type: "failed", message: "未能播放退出确认，请重试或点击关闭按钮" });
          return;
        }
        // 无可用播放引擎时不会产生 true 事件；显式补齐“开始→结束”，避免状态停在 speaking。
        dispatch({ type: "speechPlaybackStarted" });
        finishSpeech();
      }
    } catch (error) {
      recordingAttemptRef.current += 1;
      stopCapture();
      dispatch({ type: "failed", message: errorMessage(error) });
    }
  }, [dispatch, finishSpeech, stopCapture]);

  const startListening = useCallback(async (options?: { bargeIn?: boolean }): Promise<void> => {
    const bargeIn = options?.bargeIn === true;
    const phase = machineRef.current.phase;
    if (!machineRef.current.active) return;
    if (bargeIn) {
      // 同一轮 TTS 只允许一条后台录音流；播放结束或手动操作会由 attempt 代际使迟到结果失效。
      if (phase !== "speaking" || captureRef.current) return;
    } else if (phase !== "idle" && phase !== "speaking" && phase !== "thinking") {
      return;
    }
    if (!bargeIn && phase === "speaking") {
      // 先切 listening 再停 TTS。stopSpeaking 会同步广播 isSpeaking=false；若先停，退出
      // 确认会把“用户主动打断”误当自然播完而关窗，普通回复也会短暂回 idle。
      dispatch({ type: "listening" });
      if (captureRef.current && captureModeRef.current === "barge-in") {
        // 播放期录音可能仍在等待 getUserMedia / Silero 初始化。直接接管同一 attempt，避免
        // 两次 MicVAD.start 争用单例；首段仍等待连续人声确认，确认后直接进入正常断句。
        captureModeRef.current = "listening";
        stopSpeaking();
        stopStreamedRun();
        return;
      }
      // 后台录音尚未建立时，作废可能迟到的异步结果，再按普通灵敏度开一条干净录音流。
      recordingAttemptRef.current += 1;
      stopCapture();
      stopSpeaking();
      stopStreamedRun();
    }
    if (!bargeIn && phase === "thinking") {
      // 打断长时间思考:停掉本轮 agent 运行(走主窗口正常停止管线,与手点停止一致)。
      // 停止路径随后广播的 turn-end 因阶段已离开 thinking 会被钩子忽略,不会倒灌回来。
      const id = sessionIdRef.current;
      if (id) void actionsRef.current.stop(id);
      sawRunningRef.current = false;
      if (turnGraceTimerRef.current) {
        clearTimeout(turnGraceTimerRef.current);
        turnGraceTimerRef.current = null;
      }
      // 快速确认语可能已挂起/在播:打断思考一并清掉。
      if (ackTimerRef.current) {
        clearTimeout(ackTimerRef.current);
        ackTimerRef.current = null;
      }
      stopSpeaking();
    }
    if (!bargeIn && relistenTimerRef.current) {
      clearTimeout(relistenTimerRef.current);
      relistenTimerRef.current = null;
    }
    const attempt = recordingAttemptRef.current + 1;
    recordingAttemptRef.current = attempt;
    if (!bargeIn && phase !== "speaking") dispatch({ type: "listening" });
    let capture: VoiceCapture | null = null;
    try {
      const s = usePersonalStore.getState();
      if (!s.asrSettings.enabled) throw new Error("请先在语音设置中启用语音识别");
      const b = bridgeRef.current;
      if (!b) throw new Error("桌面桥不可用");
      const activeCapture = new VoiceCapture();
      capture = activeCapture;
      // 先登记，sidecar/权限任一路失败时 catch 内的 stopCapture 都能释放刚申请的麦克风。
      captureRef.current = activeCapture;
      captureModeRef.current = bargeIn ? "barge-in" : "listening";
      // 两个本地协议（SenseVoice / 流式 Zipformer）共用这条实时 PCM 通道，
      // 差异只在主进程内部分流，渲染端的推流逻辑完全一致。
      const useLocal = isLocalStreamingAsrProtocol(s.asrSettings.protocol);
      const requestId = useLocal ? crypto.randomUUID() : null;
      localStreamIdRef.current = requestId;
      pcmWriteErrorRef.current = null;
      speechStartedRef.current = false;
      preRollRef.current = [];
      preRollBytesRef.current = 0;
      utterancePcmRef.current = [];

      const streamReady = useLocal
        ? (() => {
            if (!b.startLocalAsrStream || !b.appendLocalAsrAudio || !b.finishLocalAsrStream) {
              return Promise.reject(new Error("当前桌面版本不支持本地实时识别"));
            }
            return b.startLocalAsrStream({
              requestId: requestId!,
              modelId: s.asrSettings.model,
              language: s.asrSettings.language || "auto",
              protocol: s.asrSettings.protocol,
            });
          })()
        : Promise.resolve();
      pcmWriteRef.current = streamReady;
      void streamReady.catch(() => undefined);

      const enqueuePcm = (chunk: ArrayBuffer): void => {
        if (!speechStartedRef.current) {
          preRollRef.current.push(chunk);
          preRollBytesRef.current += chunk.byteLength;
          while (preRollBytesRef.current > PRE_ROLL_BYTES && preRollRef.current.length > 1) {
            preRollBytesRef.current -= preRollRef.current.shift()?.byteLength ?? 0;
          }
          return;
        }
        utterancePcmRef.current.push(chunk);
        if (!requestId || !b.appendLocalAsrAudio) return;
        pcmWriteRef.current = pcmWriteRef.current
          .then(() => b.appendLocalAsrAudio!(requestId, chunk))
          .catch((error) => {
            pcmWriteErrorRef.current = error instanceof Error ? error : new Error(String(error));
          });
      };

      await activeCapture.start(
        s.voiceSettings.micDeviceId || undefined,
        { onPcmChunk: enqueuePcm },
      );
      const capturePhaseIsCurrent = (): boolean => {
        const currentPhase = machineRef.current.phase;
        return bargeIn
          ? currentPhase === "speaking" ||
              (currentPhase === "listening" && captureModeRef.current === "listening")
          : currentPhase === "listening";
      };
      if (attempt !== recordingAttemptRef.current || !capturePhaseIsCurrent()) {
        activeCapture.dispose();
        if (captureRef.current === activeCapture) {
          captureRef.current = null;
          captureModeRef.current = null;
        }
        if (requestId) void b.cancelLocalAsrStream?.(requestId);
        return;
      }
      captureRef.current = activeCapture;
      if (activeCapture.mediaStream) {
        vadRef.current?.stop();
        vadRef.current = null;
        // 断句监视器:Silero 神经 VAD 优先,资产缺失/环境不支持自动降级能量 VAD
        // (见 sileroVad.ts)。两个引擎都保持持续监听(无 idle-timeout):不因无人说话退出,
        // 结束聆听的唯一途径是用户显式操作(✕ 退出 / 热键提交 / 点球打断)。
        // 首轮初始化含模型加载,await 期间用户可能已退出/换轮,回来必须校验代际。
        const monitor = await createVoiceVadMonitor(
          activeCapture.mediaStream,
          (event) => {
            if (event === "speech-start") {
              if (bargeIn) {
                const currentPhase = machineRef.current.phase;
                if (currentPhase === "speaking") {
                  // 先切状态再停 TTS，阻断同步 isSpeaking=false 被当成自然播完；退出确认的
                  // exitAfterSpeech 也在此被清除，因此用户一句“等等”就能取消退出。
                  dispatch({ type: "listening" });
                  captureModeRef.current = "listening";
                  stopSpeaking();
                  stopStreamedRun();
                } else if (currentPhase === "listening") {
                  // TTS 恰好自然结束：麦克风已被 finishSpeech 接续，继续沿用同一采集流。
                  captureModeRef.current = "listening";
                } else {
                  return;
                }
              } else if (machineRef.current.phase !== "listening") {
                return;
              }
              if (speechStartedRef.current) return;
              speechStartedRef.current = true;
              const buffered = preRollRef.current;
              preRollRef.current = [];
              preRollBytesRef.current = 0;
              for (const chunk of buffered) enqueuePcm(chunk);
              if (!utteranceTimerRef.current) {
                utteranceTimerRef.current = setTimeout(() => void submitRef.current?.(), MAX_UTTERANCE_MS);
              }
            } else {
              if (machineRef.current.phase === "listening") void submitRef.current?.();
            }
          },
          (rms) => {
            // speaking 时语音球继续用 TTS 动画；麦克风电平只在用户接管后上报。
            if (machineRef.current.phase !== "listening") return;
            // 电平驱动语音球动画:RMS(近讲多在 0~0.12)放大到 0..1,节流 + 去抖后上报。
            const level = Math.min(1, rms * 8);
            const now = Date.now();
            const last = lastLevelRef.current;
            if (now - last.at < LEVEL_MIN_INTERVAL_MS || Math.abs(level - last.value) < LEVEL_MIN_DELTA) return;
            lastLevelRef.current = { value: level, at: now };
            bridgeRef.current?.reportVoiceAssistantLevel?.(level);
          },
          (message) => void bridgeRef.current?.logMessage?.("warn", message),
          bargeIn ? "barge-in" : "listening",
        );
        if (attempt !== recordingAttemptRef.current || !capturePhaseIsCurrent()) {
          monitor.stop();
          return;
        }
        vadRef.current = monitor;
        vadEngineRef.current = monitor.engine;
      }
      // VAD 必须在模型预热期间就开始监听，否则首次加载模型时用户已说出的句子会被漏掉；
      // PCM 写入链仍以 streamReady 为前置，因此不会在 BEGIN 之前写 AUDIO。
      await streamReady;
    } catch (err) {
      if (capture && captureRef.current !== capture) capture.dispose();
      else stopCapture();
      if (attempt !== recordingAttemptRef.current) return;
      if (bargeIn && machineRef.current.phase === "speaking") {
        // 插话监听是增强能力；设备/AEC/VAD 初始化失败时保持当前朗读，播完仍走原来的
        // 延迟重听，不应把一次后台开麦失败显示成整轮对话失败。
        void bridgeRef.current?.logMessage?.("warn", `语音插话监听不可用: ${errorMessage(err)}`);
        return;
      }
      dispatch({ type: "failed", message: errorMessage(err) });
    }
  }, [dispatch, stopCapture, stopStreamedRun]);

  /** VAD 判停/手动提交:转写 → 纠错 → (可选)截屏 → 送进会话。 */
  const submit = useCallback(async (): Promise<void> => {
    if (machineRef.current.phase !== "listening") return;
    const capture = captureRef.current;
    captureRef.current = null;
    captureModeRef.current = null;
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
        utterancePcmRef.current.push(...preRollRef.current);
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
      const utterancePcm = utterancePcmRef.current;
      utterancePcmRef.current = [];
      if (!blob && utterancePcm.length === 0) throw new Error("没有录到音频");
      const s = usePersonalStore.getState();
      if (!s.asrSettings.enabled) throw new Error("请先在语音设置中启用语音识别");
      const b = bridgeRef.current;
      if (!b) throw new Error("桌面桥不可用");
      const streamId = localStreamIdRef.current;
      localStreamIdRef.current = null;
      let text: string;
      if (isLocalStreamingAsrProtocol(s.asrSettings.protocol) && streamId && vadEngine === "silero") {
        await pcmWriteRef.current;
        if (pcmWriteErrorRef.current) throw pcmWriteErrorRef.current;
        if (!b.finishLocalAsrStream) throw new Error("当前桌面版本不支持本地实时识别");
        text = (await b.finishLocalAsrStream(streamId)).text.trim();
      } else {
        // 在线 ASR 与 Silero 不可用的本地降级都直接封装 VAD 语音段 PCM，避免完整
        // MediaRecorder 音轨携带 TTS 播放期的长静音或残余回声。极旧环境没有 PCM 时
        // 才回退压缩 Blob 解码路径。
        if (streamId) await b.cancelLocalAsrStream?.(streamId);
        const transcriptionOptions = {
          prompt: s.voiceSettings.dictationDictionary.join("，"),
        };
        text = (
          utterancePcm.length > 0
            ? await transcribePcm16Recording(b, s.asrSettings, utterancePcm, transcriptionOptions)
            : await transcribeRecording(b, s.asrSettings, blob!, transcriptionOptions)
        ).trim();
      }
      if (!text) throw new Error("没有识别到语音内容");
      // Silero 是声学判定，仍可能把风扇等稳定噪声解码成“.”。在任何 LLM
      // 纠错/意图/Agent 请求之前静默拦截纯标点；“啊/嗯”等真实发声不能仅凭文本丢弃。
      if (isIgnorableVoiceTranscript(text)) {
        dispatch({ type: "transcriptIgnored" });
        return;
      }
      // 转写 LLM 纠错(开关/模型/prompt 由主进程按 voiceSettings 决定;失败原文返回)。
      // 不再串行 await 阻塞发送：与意图判定、会话解析、截屏并行，send 前按预算竞速采纳。
      const polishPromise =
        (s.voiceSettings.transcriptPolish ?? true) && b.polishTranscript
          ? b
              .polishTranscript(text)
              .then((t) => t.trim() || text)
              .catch(() => text)
          : null;

      // 参考 xiaozhi：精确本地控制先拦截；function_call 普通文本不做串行前置分类，
      // 继续进入已有 Agent 工具链。旧壳没有此 bridge 时保持原来的 continue_chat 行为。
      // 意图判定用 ASR 原文先行：本地精确命令原文即可命中，纠错反而可能改写命令措辞；
      // 命中本地动作时提前 return，纠错结果自然丢弃。
      const intent = await b.understandVoiceAssistantIntent?.(text);
      if (!isActiveTranscribing(machineRef.current)) return;
      if (intent?.name === "exit_assistant") {
        // 先给用户一个可感知的本地确认；只有状态机观察到 TTS 真起播并正常播完，
        // finishSpeech 才会经 main deactivate 关闭语音球。合成失败时保留窗口和错误提示。
        if (!b.voiceAssistantDeactivate) throw new Error("当前桌面版本不支持退出语音助手");
        await speakLocalReply("好的，我先退下了", { exitAfterSpeech: true });
        return;
      }
      if (intent?.name === "new_conversation") {
        const created = await createVoiceSession(
          () => isActiveTranscribing(machineRef.current),
        );
        if (!isActiveTranscribing(machineRef.current)) return;
        if (!created) throw new Error("无法创建新对话");
        sessionIdRef.current = created.id;
        await speakLocalReply("已开始新对话");
        return;
      }
      if (
        (intent?.name === "enable_screen_context" || intent?.name === "disable_screen_context") &&
        detectIsMac()
      ) {
        const enabled = intent.name === "enable_screen_context";
        s.setVoiceSettings({ chatScreenContext: enabled });
        await speakLocalReply(enabled ? "已开启屏幕上下文" : "已关闭屏幕上下文");
        return;
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

      // 竞速采纳纠错结果：前面的意图/会话解析/截屏已与 polish 并行重叠，此处实际新增
      // 等待 = max(0, polish 耗时 − 并行段耗时)，封顶 POLISH_RACE_BUDGET_MS。
      if (polishPromise) {
        const polished = await Promise.race([
          polishPromise,
          new Promise<null>((resolve) => setTimeout(() => resolve(null), POLISH_RACE_BUDGET_MS)),
        ]);
        if (polished !== null) {
          text = polished;
          // 纠错模型也可能把空白噪声收敛成纯标点；发送前重复同一确定性门控。
          if (isIgnorableVoiceTranscript(text)) {
            dispatch({ type: "transcriptIgnored" });
            return;
          }
        }
        // 竞速等待可能跨越用户点击退出；迟到的异步结果不能复活已经结束的语音轮。
        if (!isActiveTranscribing(machineRef.current)) return;
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
      // 快速口头确认:ACK_DELAY_MS 后仍停在 thinking 且句级流式尚未接管 → 播短确认。
      // phase 保持 thinking(不迁状态机),isSpeaking 广播因阶段不符被 offSpeech 忽略;
      // 真首句(流式 createSpeechStream / 整轮 speakText)起播时自动 stopSpeaking 打断。
      if (ackTimerRef.current) clearTimeout(ackTimerRef.current);
      ackTimerRef.current = setTimeout(() => {
        ackTimerRef.current = null;
        const m = machineRef.current;
        if (!m.active || m.phase !== "thinking") return;
        if (speakerRef.current?.ownsRun()) return;
        const ackBridge = bridgeRef.current;
        if (!ackBridge) return;
        const phrase = ACK_PHRASES[Math.floor(Math.random() * ACK_PHRASES.length)]!;
        // 瑕疵已知:确认语会写入"重播上一段";真回复到达后会覆盖,可接受。
        void speakText(ackBridge, usePersonalStore.getState().ttsSettings, phrase, { allowFallback: true }).catch(() => {});
      }, ACK_DELAY_MS);
    } catch (err) {
      dispatch({ type: "failed", message: errorMessage(err) });
    }
  }, [createVoiceSession, currentSession, dispatch, report, resolveSession, speakLocalReply]);

  // VAD 回调经 ref 调 submit:互相引用的 useCallback 会形成声明顺序死结,ref 解耦。
  const submitRef = useRef<(() => Promise<void>) | null>(null);
  useEffect(() => {
    submitRef.current = submit;
    listenRef.current = () => startListening();
    bargeInRef.current = () => startListening({ bargeIn: true });
  }, [submit, startListening]);

  /** 回合结束:有正文 → 朗读;失败/空正文 → idle + 提示(点球即可继续)。 */
  const handleTurnEnd = useCallback(
    (ok: boolean, text: string): void => {
      if (turnGraceTimerRef.current) {
        clearTimeout(turnGraceTimerRef.current);
        turnGraceTimerRef.current = null;
      }
      if (ackTimerRef.current) {
        clearTimeout(ackTimerRef.current);
        ackTimerRef.current = null;
      }
      if (machineRef.current.phase !== "thinking") return;
      const trimmed = text.trim();
      if (!ok || !trimmed) {
        // 确认语可能正在播;失败收场前停掉,避免 idle 态还在念"好的,我来处理"。
        stopSpeaking();
        dispatch({ type: "failed", message: ok ? "本轮没有可朗读的回复" : "本轮执行失败，点击球体重试" });
        return;
      }
      dispatch({ type: "speak" });
      void bargeInRef.current?.();
      void (async () => {
        try {
          const b = bridgeRef.current;
          const tts = usePersonalStore.getState().ttsSettings;
          if (!b) throw new Error("桌面桥不可用");
          await speakText(b, tts, trimmed, { allowFallback: true });
          // speakText 可能在排队后即返回;真正的播完信号由 subscribeTtsPlayback 兜住。
          if (!getTtsPlaybackState().isSpeaking && machineRef.current.phase === "speaking") {
            // 无可用播放引擎时不会产生 true 事件；显式补齐“开始→结束”。
            dispatch({ type: "speechPlaybackStarted" });
            finishSpeech();
          }
        } catch (err) {
          recordingAttemptRef.current += 1;
          stopCapture();
          dispatch({ type: "failed", message: errorMessage(err) });
        }
      })();
    },
    [dispatch, finishSpeech, stopCapture],
  );

  /** 退出语音助手:释放录音/朗读资源,复位状态。**不杀在跑的 agent 轮**——会话属于
   * 主窗口,轮次照常完成,只是没人朗读了(finalizeRun 的 voiceTurn 钩子返回 false 后
   * 会走用户自己的 autoSpeak 设置)。 */
  const teardown = useCallback((): void => {
    recordingAttemptRef.current += 1;
    // 退出即弃流：不停 agent 轮(会话属于主窗口),只是不再有人流式朗读。
    speakerRef.current?.cancel();
    stopCapture();
    stopSpeaking();
    if (ackTimerRef.current) clearTimeout(ackTimerRef.current);
    ackTimerRef.current = null;
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
        case "speakerToggle": {
          // 🔊 按钮:朗读中 → 打断(startListening 的 speaking 分支已封装「先切状态再停声
          // + 停流式轮」红线);待机 → 重播上一段回复(无历史时 no-op)。其余阶段忽略。
          const phase = machineRef.current.phase;
          if (phase === "speaking") void startListening();
          else if (phase === "idle") {
            void replayLastSpeech(bridgeRef.current, usePersonalStore.getState().ttsSettings).catch(() => {});
          }
          return;
        }
        case "exit":
          teardown();
          return;
        case "intentAction": {
          // Agent 在轮中调用语音控制工具(voice_exit_assistant 等)触发的本地动作。
          // 主进程已验过语音激活态;这里按意图复用与 fast-path 相同的动作路径。
          switch (command.intent) {
            case "exit_assistant": {
              // 给在途 agent 轮打 exitAfterSpeech:本轮回复(agent 自己的告别语)播完后
              // 经 finishSpeech 关闭语音球。thinking/speaking 之外(用户已打断)事件被状态机
              // 忽略——与「插话取消退出」同一语义,不强退。
              dispatch({ type: "exitAfterReply" });
              return;
            }
            case "new_conversation": {
              // 下一轮起用新会话;本轮仍在旧会话中完成(流式渲染按 sessionId 路由,不受影响)。
              void createVoiceSession().then((created) => {
                if (created) sessionIdRef.current = created.id;
              });
              return;
            }
            case "enable_screen_context":
            case "disable_screen_context": {
              usePersonalStore
                .getState()
                .setVoiceSettings({ chatScreenContext: command.intent === "enable_screen_context" });
              return;
            }
          }
          return;
        }
      }
    },
    [activate, createVoiceSession, dispatch, startListening, submit, teardown],
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

    // 句级流式朗读接管器：首句闭合即 thinking→speaking 并起播,不等整轮结束。
    speakerRef.current = createVoiceTurnSpeaker({
      getBridge: () => bridgeRef.current,
      getTtsSettings: () => usePersonalStore.getState().ttsSettings,
      onFirstSentence: () => {
        // speak 只允许从 thinking 迁移；竞态下(用户已打断/退出)状态机拒绝,放弃接管。
        if (dispatch({ type: "speak" }).phase !== "speaking") return false;
        void bargeInRef.current?.();
        return true;
      },
      onReset: () => {
        // willRetry:已播内容来自失败尝试。先切回 thinking 再停声(顺序红线),重试轮的
        // turn-end 落在 thinking,走整轮朗读旧路径,不重复不漏。
        if (machineRef.current.phase === "speaking") {
          dispatch({ type: "rethink" });
          stopSpeaking();
        }
      },
      onStreamFailed: () => {
        // 首句合成失败且从未起播(配置/网络问题):回 thinking,turn-end 走旧路径重试整轮。
        if (machineRef.current.phase === "speaking") {
          dispatch({ type: "rethink" });
          stopSpeaking();
        }
      },
    });

    // ── 其它会话 agent 活动卡片(overlay 球体上方浮层) ──
    // 语音助手激活期间,别的会话若有 agent 在跑,把「会话标题 + 流式响应尾部」经主进程
    // 转发到 overlay 实时滚动显示;轮次结束(running 清零)延迟隐藏。数据源直接复用
    // voiceTurn 流式埋点(它对全部会话广播,语音会话分支之外的 delta 正好是这里要的)。
    const FEED_TAIL_CHARS = 400;
    const FEED_PUSH_MIN_MS = 120;
    const FEED_HIDE_DELAY_MS = 1500;
    let feedSessionId: string | null = null;
    let feedText = "";
    let feedLastPush = 0;
    let feedHideTimer: ReturnType<typeof setTimeout> | null = null;
    const pushFeed = (feed: { title: string; text: string } | null): void => {
      bridgeRef.current?.reportVoiceAssistantFeed?.(feed);
    };
    const hideFeed = (): void => {
      if (feedHideTimer) clearTimeout(feedHideTimer);
      feedHideTimer = null;
      feedSessionId = null;
      feedText = "";
      pushFeed(null);
    };
    const onOtherSessionDelta = (sessionId: string, delta: string): void => {
      if (feedHideTimer) {
        clearTimeout(feedHideTimer);
        feedHideTimer = null;
      }
      // 多会话并发时跟随最新出声的那个(卡片只有一张,最近活跃者最相关)。
      if (feedSessionId !== sessionId) {
        feedSessionId = sessionId;
        feedText = "";
      }
      feedText = (feedText + delta).slice(-FEED_TAIL_CHARS);
      const now = Date.now();
      if (now - feedLastPush < FEED_PUSH_MIN_MS) return;
      feedLastPush = now;
      const title =
        usePersonalStore.getState().sessions.find((x) => x.id === sessionId)?.title?.trim() || "其它会话";
      pushFeed({ title, text: feedText });
    };
    // 轮次结束(running 清零)→ 留一段可读时间后隐藏;期间有新 delta 会取消隐藏。
    const offFeedRunning = usePersonalStore.subscribe((s) => {
      if (!feedSessionId || feedHideTimer) return;
      if (s.runningBySession[feedSessionId]) return;
      feedHideTimer = setTimeout(hideFeed, FEED_HIDE_DELAY_MS);
    });

    // 句级流式增量：语音会话之外的流喂活动卡片;语音会话按「激活 + 开关开启 +
    // (等回复中|已接管)」的守卫喂句级朗读。
    setVoiceTurnStreamListener((ev) => {
      if (!machineRef.current.active) return;
      if (ev.sessionId !== sessionIdRef.current) {
        if (ev.type === "delta") onOtherSessionDelta(ev.sessionId, ev.delta);
        return;
      }
      const speaker = speakerRef.current;
      if (!speaker) return;
      if ((usePersonalStore.getState().voiceSettings.chatStreamTts ?? true) === false) return;
      if (machineRef.current.phase !== "thinking" && !speaker.ownsRun(ev.runId)) return;
      speaker.onStream(ev);
    });

    // 回合完成钩子:只接管「语音助手激活 + 绑定会话 + 正在等回复」的轮次;
    // 返回 true 让 finalizeRun 跳过 autoSpeak,同一轮不读两遍。
    setVoiceTurnListener((ev) => {
      if (!machineRef.current.active) return false;
      if (ev.sessionId !== sessionIdRef.current) return false;
      const speaker = speakerRef.current;
      if (speaker?.ownsRun()) {
        // 流式接管中(phase=speaking):正常轮补尾差收尾;失败轮先回 thinking 再停声,
        // 沿旧路径报错(半截已播内容作废,与 willRetry 同款处理)。
        if (turnGraceTimerRef.current) {
          clearTimeout(turnGraceTimerRef.current);
          turnGraceTimerRef.current = null;
        }
        if (!ev.ok) {
          dispatch({ type: "rethink" });
          stopSpeaking();
          speaker.cancel();
          handleTurnEnd(ev.ok, ev.text);
          return true;
        }
        speaker.finish(ev.text);
        return true;
      }
      // tracking 未接管的残留(首句未闭合的短回答):清掉装配器,走整轮朗读旧路径。
      speaker?.cancel();
      if (machineRef.current.phase !== "thinking") return false;
      handleTurnEnd(ev.ok, ev.text);
      return true;
    });

    // TTS 播完信号(speakText 早返回时的权威兜底)。
    const offSpeech = subscribeTtsPlayback((playback) => {
      if (machineRef.current.phase !== "speaking") return;
      // speakText 会先广播 hasLastSpeech 变化，此时 isSpeaking 仍为 false。状态机要求先
      // 观察到 true，才能让之后的 false 结束本轮，从协议层隔离“元数据更新”和“播完”。
      if (playback.isSpeaking) {
        dispatch({ type: "speechPlaybackStarted" });
        void bargeInRef.current?.();
      }
      else finishSpeech();
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
      if (!sawRunningRef.current) return;
      // 流式接管中 phase 已提前迁到 speaking:turn-end 若丢失,流永不 finalize、isSpeaking
      // 卡 true——这条兜底与 thinking 同款宽限,超时按「已喂入文本」强制收尾。
      const phase = machineRef.current.phase;
      const streaming = phase === "speaking" && !!speakerRef.current?.ownsRun();
      if (phase !== "thinking" && !streaming) return;
      sawRunningRef.current = false;
      if (turnGraceTimerRef.current) clearTimeout(turnGraceTimerRef.current);
      turnGraceTimerRef.current = setTimeout(() => {
        turnGraceTimerRef.current = null;
        if (machineRef.current.phase === "thinking") {
          dispatch({ type: "failed", message: "本轮已结束但未取得回复，点击球体继续" });
        } else if (machineRef.current.phase === "speaking" && speakerRef.current?.ownsRun()) {
          // finish("") = 不补尾差,只 flush 已装配内容并 finalize,防语音球永远停在 speaking。
          speakerRef.current.finish("");
        }
      }, TURN_END_GRACE_MS);
    });

    return () => {
      offCommand();
      offSpeech();
      offAwaiting();
      offRunning();
      offFeedRunning();
      if (feedHideTimer) clearTimeout(feedHideTimer);
      setVoiceTurnListener(null);
      setVoiceTurnStreamListener(null);
      speakerRef.current?.cancel();
      speakerRef.current = null;
      // 卸载即退出:释放麦克风/朗读,不留孤儿资源。
      recordingAttemptRef.current += 1;
      stopCapture();
      stopSpeaking();
      if (relistenTimerRef.current) clearTimeout(relistenTimerRef.current);
      if (turnGraceTimerRef.current) clearTimeout(turnGraceTimerRef.current);
      if (ackTimerRef.current) clearTimeout(ackTimerRef.current);
    };
    // bridge 引用稳定(CoreProvider 注入),其余回调经 ref 转发,刻意只挂载一次。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bridge]);

  return null;
}
