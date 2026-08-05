// 语音聊天浮层 renderer：录音、转写、最小 CLI 流消费与 TTS 在此进程串行完成。
//
// 此窗口不挂 CoreProvider，只通过 desktopAPI.voiceChat 的窄桥读设置，并只读写固定
// `voice-chat` 会话。它没有 store:save，因此不会用陈旧的全量 personal 快照覆盖主窗口设置。

import { useCallback, useEffect, useRef, useState } from "react";
import ReactDOM from "react-dom/client";
import {
  DEFAULT_TTS_SETTINGS,
  getTtsPlaybackState,
  speakText,
  stopSpeaking,
  subscribeTtsPlayback,
  type DesktopBridge,
} from "@cortex-work/core";
import type { Message } from "@cortex-work/core";
import { DEFAULT_VOICE_CHAT_PROMPT } from "@cortex-work/core/desktop/types";
import type { AsrSettings, PersistedState, TtsSettings } from "@cortex-work/core/desktop/types";
import { VoiceCapture, transcribeRecording } from "@cortex-work/views/cortex-desktop/voice-recorder";
import { initialVoiceChatState, transitionVoiceChat, type VoiceChatEvent, type VoiceChatState } from "./voice-chat-state";
import { startVadMonitor } from "./voice-vad";
import "./voice-chat.css";

// 连续对话回环间隔:TTS 播完 → 重新开麦之间留 200ms 缓冲(借鉴 xiaozhi 打断后的 sleep(0.2),
// 让扬声器尾音衰减、避免半双工切换瞬间把余音采进下一轮)。
const RELISTEN_DELAY_MS = 200;

const VOICE_CHAT_SESSION_ID = "voice-chat";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function phaseLabel(state: VoiceChatState): string {
  switch (state.phase) {
    case "idle": return "点击麦克风开始语音聊天";
    case "recording": return "正在聆听，再按快捷键或按钮即可发送";
    case "transcribing": return "正在转写语音…";
    case "sending": return "正在向聊天 Agent 发送…";
    case "speaking": return "正在朗读回复…";
  }
}

/** 保持在函数边界检查，避免异步 getUserMedia 前的 idle 窄化掩盖状态已经转换。 */
function isRecordingState(state: VoiceChatState): boolean {
  return state.phase === "recording";
}

/** chat:load 兼容 v1 数组与 v2 对象；语音浮层不创建分支，只保留既有消息顺序。 */
function messagesFromLoadedChat(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw === "object" && Array.isArray((raw as { messages?: unknown }).messages)) {
    return (raw as { messages: unknown[] }).messages;
  }
  return [];
}

/** 消息联合类型中可上屏的 text 成员(who/text 字段仅存在于该成员)。 */
type TextMessage = Extract<Message, { kind: "text" }>;

/** RichText(string | {kind:"rich",parts}) → 纯文本(与 core devPreviewDetection 同形)。 */
function plainText(text: TextMessage["text"]): string {
  return typeof text === "string" ? text : text.parts.map((part) => part.v).join("");
}

/** 从加载的会话消息里取可上屏的文本消息(其余种类丢显示、不丢持久化)。 */
function textMessagesFrom(raw: unknown[]): TextMessage[] {
  return raw.filter((m): m is TextMessage => {
    const msg = m as { kind?: unknown; text?: unknown; who?: unknown };
    return msg?.kind === "text" && typeof msg.text === "string" && (msg.who === "me" || msg.who === "assistant");
  });
}

function messageTime(now = new Date()): string {
  return now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
}

/** 语音转写与最终答复使用与主聊天兼容的 text 消息结构，供主窗口直接加载回显。 */
function voiceChatTextMessage(who: "me" | "assistant", text: string): Message {
  return {
    kind: "text",
    who,
    time: messageTime(),
    text,
    uid: `voice-${crypto.randomUUID()}`,
  };
}

function VoiceChat(): React.ReactElement {
  const api = window.desktopAPI?.voiceChat;
  const [state, setState] = useState<VoiceChatState>(initialVoiceChatState);
  // 对话消息列表(滚屏累积显示,不随下一轮语音清空);response 是流式中的实时气泡,
  // 落定后并入 messages 并清空,避免同一条回复出现两份。
  const [messages, setMessages] = useState<TextMessage[]>([]);
  const [response, setResponse] = useState("");
  const listRef = useRef<HTMLDivElement | null>(null);
  const configRef = useRef<PersistedState | null>(null);
  const historyRef = useRef<unknown[] | null>(null);
  const captureRef = useRef<VoiceCapture | null>(null);
  const runIdRef = useRef<string | null>(null);
  const responseRef = useRef("");
  const completedRunRef = useRef<string | null>(null);
  // 窗口关闭时递增；getUserMedia 的晚到 resolve 依此自我释放，不能占住下一次录音的麦克风。
  const recordingAttemptRef = useRef(0);
  const stateRef = useRef(state);
  // 连续对话:TTS 播完自动回到聆听态,录音期间由能量 VAD 静音判停自动发送(半双工,
  // speaking 期间麦克风本来就是关的,天然免回声消除)。开关只在浮层内存态,不落盘。
  const [continuous, setContinuous] = useState(true);
  const continuousRef = useRef(continuous);
  useEffect(() => { continuousRef.current = continuous; }, [continuous]);
  const vadRef = useRef<{ stop: () => void } | null>(null);
  const prevPhaseRef = useRef<VoiceChatState["phase"]>("idle");
  // 多轮上下文:从 init 流事件捕获各 agent 自己的 session/thread id,下一轮 cli:start 带
  // resumeSessionId 续接(与主聊天 agentSessionIds 同形)。缺它时每轮都是全新会话,agent 失忆。
  const agentSessionIdsRef = useRef<Record<string, string>>({});
  const activeAgentRef = useRef<string>("");
  // TTS 预热只在 renderer 生命周期内做一次(浮层隐藏不销毁,重开不再预热)。
  const ttsWarmupDoneRef = useRef(false);

  useEffect(() => { stateRef.current = state; }, [state]);
  // 新消息/流式增量到达时贴底滚动,保持最新内容可见(用户手动上翻查看历史时不强拉——
  // 仅在本就接近底部时跟随;阈值放宽到 200px,容忍效应触发时 scrollHeight 已含新增内容)。
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 200;
    if (nearBottom) list.scrollTop = list.scrollHeight;
  }, [messages, response]);
  const advance = useCallback((event: VoiceChatEvent): void => {
    // 全局快捷键可能紧跟在 React effect 之前到达；ref 与可见 state 同步推进，避免重复启录。
    const next = transitionVoiceChat(stateRef.current, event);
    stateRef.current = next;
    setState(next);
  }, []);

  const loadConfig = useCallback(async (): Promise<PersistedState> => {
    if (!api) throw new Error("语音聊天桥不可用");
    // 每段新录音都读取主进程权威设置；但同一轮后续转写/TTS 继续使用这份快照，避免中途漂移。
    const config = await api.loadState();
    configRef.current = config;
    return config;
  }, [api]);

  const loadHistory = useCallback(async (): Promise<unknown[]> => {
    if (!api) throw new Error("语音聊天桥不可用");
    const history = messagesFromLoadedChat(await api.loadChat());
    historyRef.current = history;
    setMessages(textMessagesFrom(history));
    return history;
  }, [api]);

  /** 追加后保存完整固定会话；专用主进程 handler 会再次锁定该 session ID。 */
  const appendHistoryText = useCallback(async (who: "me" | "assistant", text: string): Promise<void> => {
    if (!api) throw new Error("语音聊天桥不可用");
    const history = historyRef.current ?? await loadHistory();
    const next = [...history, voiceChatTextMessage(who, text)];
    await api.saveChat(next);
    historyRef.current = next;
    setMessages(textMessagesFrom(next));
  }, [api, loadHistory]);

  const speakResponse = useCallback(async (text: string, settings: TtsSettings): Promise<void> => {
    if (!api) return;
    // speakText 的 OpenAI 分支只读取这两条合成能力；收窄后断言避免把 personal 全桥暴露给浮层。
    // 必须带上 ttsSynthesizeStream:缺它会退回「整段合成完才出声」的非流式路径,
    // 本地慢速推理(如 OMLX)下首响会拖到全篇合成结束。
    const ttsBridge = {
      ttsSynthesize: api.ttsSynthesize,
      ttsSynthesizeEdge: api.ttsSynthesizeEdge,
      ttsSynthesizeStream: api.ttsSynthesizeStream,
      // stopSpeaking 靠它把「取消在途合成」传导到主进程,浮层打断/关闭时停掉服务端生成。
      ttsCancelStreams: api.ttsCancelStreams,
    } as Pick<DesktopBridge, "ttsSynthesize" | "ttsSynthesizeEdge" | "ttsSynthesizeStream" | "ttsCancelStreams">;
    await speakText(ttsBridge as DesktopBridge, settings, text, { allowFallback: true });
    if (!getTtsPlaybackState().isSpeaking) advance({ type: "speechFinished" });
  }, [advance, api]);

  const finishRun = useCallback(async (runId: string, error?: string): Promise<void> => {
    if (completedRunRef.current === runId) return;
    completedRunRef.current = runId;
    if (runIdRef.current === runId) runIdRef.current = null;
    if (error) {
      advance({ type: "failed", message: error });
      return;
    }
    const text = responseRef.current.trim();
    if (!text) {
      advance({ type: "failed", message: "聊天 Agent 没有返回可朗读的文本" });
      return;
    }
    advance({ type: "responseComplete" });
    try {
      const config = configRef.current ?? await loadConfig();
      await appendHistoryText("assistant", text);
      // 回复已并入消息列表:清掉实时气泡,避免同一条内容出现两份。
      responseRef.current = "";
      setResponse("");
      await speakResponse(text, config.ttsSettings ?? DEFAULT_TTS_SETTINGS);
    } catch (err) {
      advance({ type: "failed", message: errorMessage(err) });
    }
  }, [advance, appendHistoryText, loadConfig, speakResponse]);

  const startListening = useCallback(async (): Promise<void> => {
    if (!api || stateRef.current.phase !== "idle") return;
    // 只重置实时气泡;消息列表滚屏累积,不随新一轮语音清空。
    setResponse("");
    responseRef.current = "";
    completedRunRef.current = null;
    const recordingAttempt = recordingAttemptRef.current + 1;
    recordingAttemptRef.current = recordingAttempt;
    advance({ type: "startListening" });
    try {
      const config = configRef.current ?? await loadConfig();
      const capture = new VoiceCapture();
      await capture.start(config.voiceSettings?.micDeviceId || undefined);
      if (recordingAttempt !== recordingAttemptRef.current || !isRecordingState(stateRef.current)) {
        capture.dispose();
        return;
      }
      captureRef.current = capture;
      // 连续模式:在录音同一条流上接能量 VAD,静音判停自动发送;手动模式仍靠快捷键/按钮停止。
      if (continuousRef.current && capture.mediaStream) {
        vadRef.current?.stop();
        vadRef.current = startVadMonitor(capture.mediaStream, (event) => {
          if (event === "speech-end") {
            void submitRef.current?.();
          } else if (event === "idle-timeout") {
            // 长时间无人说话:退出本轮聆听并中止回环,避免连续模式无限占用麦克风。
            vadRef.current?.stop();
            vadRef.current = null;
            captureRef.current?.dispose();
            captureRef.current = null;
            advance({ type: "failed", message: "长时间未检测到语音，已停止聆听" });
          }
        });
      }
    } catch (err) {
      captureRef.current = null;
      advance({ type: "failed", message: errorMessage(err) });
    }
  }, [advance, api, loadConfig]);

  const stopAndSubmit = useCallback(async (): Promise<void> => {
    if (!api || stateRef.current.phase !== "recording") return;
    const capture = captureRef.current;
    captureRef.current = null;
    // 提交即停 VAD:转写/播报期间麦克风已关,残留监视器只会对旧流空转。
    vadRef.current?.stop();
    vadRef.current = null;
    advance({ type: "stopAndSubmit" });
    try {
      const blob = await capture?.stop();
      if (!blob) throw new Error("没有录到音频");
      const config = await loadConfig();
      const asr = config.asrSettings as AsrSettings | undefined;
      if (!asr?.enabled) throw new Error("请先在语音设置中启用语音识别");
      let text = (await transcribeRecording({ transcribeSpeech: api.transcribe }, asr, blob, {
        prompt: config.voiceSettings?.dictationDictionary.join("，"),
      })).trim();
      if (!text) throw new Error("没有识别到语音内容");
      // 转写 LLM 纠错(开关/模型/prompt 由主进程按 voiceSettings 决定;失败原文返回)。
      if ((config.voiceSettings?.transcriptPolish ?? true) && api.polishTranscript) {
        text = (await api.polishTranscript(text)).trim() || text;
      }
      await appendHistoryText("me", text);
      advance({ type: "transcribed" });

      const runId = `voice-chat:${crypto.randomUUID()}`;
      runIdRef.current = runId;
      // 语音聊天专用模型:设置了完整 Catalog 引用则强制走 pi 会话(providerId 是 pi 专属字段,
      // 见 CliStartRequest 注释);未设置则跟随主聊天最近使用的 agent/模型。
      const voiceCfg = config.voiceSettings;
      const chatRef =
        voiceCfg?.chatProviderId?.trim() && voiceCfg?.chatModelId?.trim()
          ? { providerId: voiceCfg.chatProviderId.trim(), modelId: voiceCfg.chatModelId.trim() }
          : null;
      const agent = chatRef ? "pi" : (config.lastAgent ?? config.generalSettings?.defaultAgent ?? "codex");
      activeAgentRef.current = agent;
      // 屏幕上下文是用户显式开关：helper 只截取前台窗口，主进程写 0600 临时 PNG 后才作为
      // 正常聊天图片附件交给 CLI；关闭开关时完全不请求 Screen Recording 权限。
      const images = config.voiceSettings?.chatScreenContext ? [await api.captureScreen()] : undefined;
      // 提示词:用户自定义(voiceSettings.chatPrompt)优先,空则内置默认;静态指令在前、
      // 转写文本在后,保证供应商前缀缓存命中。
      const chatPrompt = voiceCfg?.chatPrompt?.trim() || DEFAULT_VOICE_CHAT_PROMPT;
      await api.startCli({
        runId,
        sessionId: VOICE_CHAT_SESSION_ID,
        agent,
        model: chatRef ? chatRef.modelId : config.lastModel,
        providerId: chatRef ? chatRef.providerId : config.lastProviderId,
        resumeSessionId: agentSessionIdsRef.current[agent],
        cwd: config.generalSettings?.workspaceRoot ?? "",
        prompt: `${chatPrompt}\n\n用户的语音转写如下：\n${text}`,
        images,
      });
    } catch (err) {
      advance({ type: "failed", message: errorMessage(err) });
    }
  }, [advance, api, appendHistoryText, loadConfig]);

  // VAD 回调经 ref 调 stopAndSubmit:两个 useCallback 互相引用会形成声明顺序死结,ref 解耦。
  const submitRef = useRef<(() => Promise<void>) | null>(null);
  useEffect(() => {
    submitRef.current = stopAndSubmit;
  }, [stopAndSubmit]);

  // 连续对话回环:speaking 正常收尾回到 idle(无错误)时,留 RELISTEN_DELAY_MS 缓冲后自动开麦。
  // 出错回 idle(error 置位)不回环,避免同一错误无限循环。
  useEffect(() => {
    const prev = prevPhaseRef.current;
    prevPhaseRef.current = state.phase;
    if (prev !== "speaking" || state.phase !== "idle" || state.error || !continuousRef.current) return;
    const timer = setTimeout(() => {
      void startListening();
    }, RELISTEN_DELAY_MS);
    return () => clearTimeout(timer);
  }, [state, startListening]);

  useEffect(() => {
    if (!api) return;
    // 浮层重用时内存会保留；首次挂载主动读取固定会话，后续 append 才不会覆盖已有历史。
    void loadHistory().catch((err) => advance({ type: "failed", message: errorMessage(err) }));
    // TTS 预热:本地推理服务(OMLX 等)首次生成要加载模型,明显慢于后续请求。浮层一打开就
    // 用一句极短文本触发一次合成并丢弃结果,把冷启动成本挪到用户说话之前。失败静默(预热
    // 只是优化,不能产生任何用户可见错误);renderer 生命周期内只做一次。
    void (async () => {
      if (ttsWarmupDoneRef.current) return;
      ttsWarmupDoneRef.current = true;
      try {
        const config = configRef.current ?? (await loadConfig());
        const engine = config.ttsSettings?.engine;
        if (engine?.kind !== "openai" || !engine.baseUrl || !engine.model) return;
        await api.ttsSynthesize({
          baseUrl: engine.baseUrl,
          apiKey: engine.apiKey,
          model: engine.model,
          voice: engine.voice,
          language: engine.language ?? "zh",
          stream: false,
          text: "你好。",
        });
      } catch {
        /* 预热失败无感知:真正合成时的错误自有主流程提示 */
      }
    })();
    const offCommand = api.onCommand((command) => {
      if (command === "startListening") void startListening();
      else if (command === "stopAndSubmit") void stopAndSubmit();
    });
    const offEvent = api.onCliEvent((runId, event) => {
      if (runId !== runIdRef.current) return;
      if (event.type === "init" && typeof (event as { sessionId?: unknown }).sessionId === "string") {
        // agent 报回自己的会话 id:记下供下一轮 resume,连续对话才有跨轮记忆。
        agentSessionIdsRef.current[activeAgentRef.current] = (event as { sessionId: string }).sessionId;
      } else if (event.type === "text") {
        responseRef.current += event.delta;
        setResponse(responseRef.current);
      } else if (event.type === "result") {
        if (!event.ok) void finishRun(runId, event.error ?? "聊天 Agent 执行失败");
        else if (event.text && !responseRef.current.trim()) {
          responseRef.current = event.text;
          setResponse(event.text);
        }
      }
    });
    const offExit = api.onCliExit((exit) => {
      if (exit.runId !== runIdRef.current) return;
      void finishRun(exit.runId, exit.error ?? (exit.code && exit.code !== 0 ? `聊天 Agent 退出码 ${exit.code}` : undefined));
    });
    const offSpeech = subscribeTtsPlayback((playback) => {
      if (!playback.isSpeaking && stateRef.current.phase === "speaking") advance({ type: "speechFinished" });
    });
    return () => {
      offCommand();
      offEvent();
      offExit();
      offSpeech();
      vadRef.current?.stop();
      vadRef.current = null;
      captureRef.current?.dispose();
      captureRef.current = null;
    };
  }, [advance, api, finishRun, loadHistory, startListening, stopAndSubmit]);

  const onRecord = (): void => {
    if (state.phase === "idle") void startListening();
    else if (state.phase === "recording") void stopAndSubmit();
  };
  const onClose = (): void => {
    // 隐藏窗口后 renderer 仍常驻。先作废在途 getUserMedia，再同步复位 ref，避免下一次快捷键
    // 早于 React effect 时仍把旧的 recording/sending 阶段误判为活动状态。
    recordingAttemptRef.current += 1;
    vadRef.current?.stop();
    vadRef.current = null;
    captureRef.current?.dispose();
    captureRef.current = null;
    const runId = runIdRef.current;
    if (runId) void api?.killCli(runId);
    runIdRef.current = null;
    stopSpeaking();
    responseRef.current = "";
    completedRunRef.current = null;
    setResponse("");
    stateRef.current = initialVoiceChatState;
    advance({ type: "closed" });
    void api?.close();
  };

  const actionable = state.phase === "idle" || state.phase === "recording";
  return (
    <main className="vc-shell">
      <section className="vc-card" aria-live="polite">
        <header className="vc-header">
          <span className="vc-title">语音聊天</span>
          <label className="vc-continuous" title="回复播完后自动继续聆听，说完停顿即发送">
            <input
              type="checkbox"
              checked={continuous}
              onChange={(event) => setContinuous(event.target.checked)}
            />
            连续对话
          </label>
          <button className="vc-close" type="button" aria-label="关闭语音聊天" onClick={onClose}>×</button>
        </header>
        <div className="vc-content">
          <div className="vc-status">
            {state.phase === "recording" && continuous ? "正在聆听，说完停顿会自动发送" : phaseLabel(state)}
          </div>
          <div className="vc-messages" ref={listRef}>
            {messages.map((message, index) => (
              <div key={message.uid ?? index} className={`vc-msg${message.who === "me" ? " is-me" : ""}`}>
                {plainText(message.text)}
              </div>
            ))}
            {response ? <div className="vc-msg is-live">{response}</div> : null}
          </div>
          {state.error ? <div className="vc-error">{state.error}</div> : null}
          <button
            className={`vc-record${state.phase === "recording" ? " is-recording" : ""}`}
            type="button"
            disabled={!actionable}
            onClick={onRecord}
          >
            {state.phase === "recording" ? "发送" : "说话"}
          </button>
          <div className="vc-hint">
            {continuous ? "连续对话中：静音自动发送，快捷键可立即发送" : "全局快捷键再次按下可结束录音并提交"}
          </div>
        </div>
      </section>
    </main>
  );
}

ReactDOM.createRoot(document.getElementById("root")!).render(<VoiceChat />);
