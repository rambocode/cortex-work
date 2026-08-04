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
import type { AsrSettings, PersistedState, TtsSettings } from "@cortex-work/core/desktop/types";
import { VoiceCapture, transcribeRecording } from "@cortex-work/views/cortex-desktop/voice-recorder";
import { initialVoiceChatState, transitionVoiceChat, type VoiceChatEvent, type VoiceChatState } from "./voice-chat-state";
import "./voice-chat.css";

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

/** chat:load 兼容 v1 数组与 v2 对象；语音浮层不创建分支，只保留既有消息顺序。 */
function messagesFromLoadedChat(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw === "object" && Array.isArray((raw as { messages?: unknown }).messages)) {
    return (raw as { messages: unknown[] }).messages;
  }
  return [];
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
  const [transcript, setTranscript] = useState("");
  const [response, setResponse] = useState("");
  const configRef = useRef<PersistedState | null>(null);
  const historyRef = useRef<unknown[] | null>(null);
  const captureRef = useRef<VoiceCapture | null>(null);
  const runIdRef = useRef<string | null>(null);
  const responseRef = useRef("");
  const completedRunRef = useRef<string | null>(null);
  const stateRef = useRef(state);

  useEffect(() => { stateRef.current = state; }, [state]);
  const advance = useCallback((event: VoiceChatEvent): void => {
    setState((current) => transitionVoiceChat(current, event));
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
    return history;
  }, [api]);

  /** 追加后保存完整固定会话；专用主进程 handler 会再次锁定该 session ID。 */
  const appendHistoryText = useCallback(async (who: "me" | "assistant", text: string): Promise<void> => {
    if (!api) throw new Error("语音聊天桥不可用");
    const history = historyRef.current ?? await loadHistory();
    const next = [...history, voiceChatTextMessage(who, text)];
    await api.saveChat(next);
    historyRef.current = next;
  }, [api, loadHistory]);

  const speakResponse = useCallback(async (text: string, settings: TtsSettings): Promise<void> => {
    if (!api) return;
    // speakText 的 OpenAI 分支只读取 ttsSynthesize；收窄后断言避免把 personal 全桥暴露给浮层。
    const ttsBridge = { ttsSynthesize: api.ttsSynthesize } as Pick<DesktopBridge, "ttsSynthesize">;
    await speakText(ttsBridge as DesktopBridge, settings, text);
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
      await speakResponse(text, config.ttsSettings ?? DEFAULT_TTS_SETTINGS);
    } catch (err) {
      advance({ type: "failed", message: errorMessage(err) });
    }
  }, [advance, appendHistoryText, loadConfig, speakResponse]);

  const startListening = useCallback(async (): Promise<void> => {
    if (!api || stateRef.current.phase !== "idle") return;
    setTranscript("");
    setResponse("");
    responseRef.current = "";
    completedRunRef.current = null;
    advance({ type: "startListening" });
    try {
      const config = configRef.current ?? await loadConfig();
      const capture = new VoiceCapture();
      await capture.start(config.voiceSettings?.micDeviceId || undefined);
      captureRef.current = capture;
    } catch (err) {
      captureRef.current = null;
      advance({ type: "failed", message: errorMessage(err) });
    }
  }, [advance, api, loadConfig]);

  const stopAndSubmit = useCallback(async (): Promise<void> => {
    if (!api || stateRef.current.phase !== "recording") return;
    const capture = captureRef.current;
    captureRef.current = null;
    advance({ type: "stopAndSubmit" });
    try {
      const blob = await capture?.stop();
      if (!blob) throw new Error("没有录到音频");
      const config = await loadConfig();
      const asr = config.asrSettings as AsrSettings | undefined;
      if (!asr?.enabled) throw new Error("请先在语音设置中启用语音识别");
      const text = (await transcribeRecording({ transcribeSpeech: api.transcribe }, asr, blob, {
        prompt: config.voiceSettings?.dictationDictionary.join("，"),
      })).trim();
      if (!text) throw new Error("没有识别到语音内容");
      setTranscript(text);
      await appendHistoryText("me", text);
      advance({ type: "transcribed" });

      const runId = `voice-chat:${crypto.randomUUID()}`;
      runIdRef.current = runId;
      const agent = config.lastAgent ?? config.generalSettings?.defaultAgent ?? "codex";
      // 屏幕上下文是用户显式开关：helper 只截取前台窗口，主进程写 0600 临时 PNG 后才作为
      // 正常聊天图片附件交给 CLI；关闭开关时完全不请求 Screen Recording 权限。
      const images = config.voiceSettings?.chatScreenContext ? [await api.captureScreen()] : undefined;
      await api.startCli({
        runId,
        sessionId: VOICE_CHAT_SESSION_ID,
        agent,
        model: config.lastModel,
        providerId: config.lastProviderId,
        cwd: config.generalSettings?.workspaceRoot ?? "",
        prompt: `用户的语音转写如下：\n${text}\n\n请用自然、简洁的中文回答。`,
        images,
      });
    } catch (err) {
      advance({ type: "failed", message: errorMessage(err) });
    }
  }, [advance, api, appendHistoryText, loadConfig]);

  useEffect(() => {
    if (!api) return;
    // 浮层重用时内存会保留；首次挂载主动读取固定会话，后续 append 才不会覆盖已有历史。
    void loadHistory().catch((err) => advance({ type: "failed", message: errorMessage(err) }));
    const offCommand = api.onCommand((command) => {
      if (command === "startListening") void startListening();
      else if (command === "stopAndSubmit") void stopAndSubmit();
    });
    const offEvent = api.onCliEvent((runId, event) => {
      if (runId !== runIdRef.current) return;
      if (event.type === "text") {
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
      captureRef.current?.dispose();
      captureRef.current = null;
    };
  }, [advance, api, finishRun, loadHistory, startListening, stopAndSubmit]);

  const onRecord = (): void => {
    if (state.phase === "idle") void startListening();
    else if (state.phase === "recording") void stopAndSubmit();
  };
  const onClose = (): void => {
    captureRef.current?.dispose();
    captureRef.current = null;
    const runId = runIdRef.current;
    if (runId) void api?.killCli(runId);
    runIdRef.current = null;
    stopSpeaking();
    void api?.close();
  };

  const actionable = state.phase === "idle" || state.phase === "recording";
  return (
    <main className="vc-shell">
      <section className="vc-card" aria-live="polite">
        <header className="vc-header">
          <span className="vc-title">语音聊天</span>
          <button className="vc-close" type="button" aria-label="关闭语音聊天" onClick={onClose}>×</button>
        </header>
        <div className="vc-content">
          <div className="vc-status">{phaseLabel(state)}</div>
          {transcript ? <div className="vc-transcript">{transcript}</div> : null}
          {response ? <div className="vc-response">{response}</div> : null}
          {state.error ? <div className="vc-error">{state.error}</div> : null}
          <button
            className={`vc-record${state.phase === "recording" ? " is-recording" : ""}`}
            type="button"
            disabled={!actionable}
            onClick={onRecord}
          >
            {state.phase === "recording" ? "发送" : "说话"}
          </button>
          <div className="vc-hint">全局快捷键再次按下可结束录音并提交</div>
        </div>
      </section>
    </main>
  );
}

ReactDOM.createRoot(document.getElementById("root")!).render(<VoiceChat />);
