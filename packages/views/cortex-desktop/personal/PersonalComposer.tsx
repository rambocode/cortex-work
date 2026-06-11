// 个人工作区输入框：支持 Prompt 文件拖入（作为 skill 附件 pill）、模型切换、
// 运行中停止。复用 cortex-desktop.css 的 composer 类名体系。

import { useEffect, useRef, useState } from "react";
import { Icon } from "@cortex-work/ui/icons";
import { AGENT_MODELS, useDesktopBridge, usePetStore } from "@cortex-work/core";
import type { PersonalAttachment, SessionMeta } from "@cortex-work/core";
import { PROMPT_DRAG_MIME } from "./PromptPanel";
import { TODO_DRAG_MIME } from "./TodosView";

let attachSeq = 0;

// slash 命令注册表（发送拦截在 PersonalChatArea.onSend）。
const SLASH_COMMANDS: { cmd: string; desc: string }[] = [
  { cmd: "/clear", desc: "隐藏当前历史记录（可展开）" },
];

const DEFAULT_ASR = {
  baseUrl: "http://127.0.0.1:8000",
  model: "Qwen3-ASR-1.7B-bf16",
  language: "zh",
};

function pickRecordingMimeType(): string {
  if (typeof MediaRecorder === "undefined") return "";
  for (const type of ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"]) {
    if (MediaRecorder.isTypeSupported(type)) return type;
  }
  return "";
}

function extensionForMimeType(mimeType: string): string {
  if (mimeType.includes("mp4")) return "m4a";
  if (mimeType.includes("webm")) return "webm";
  return "wav";
}

export function PersonalComposer({
  session,
  running,
  onSend,
  onStop,
  onChangeModel,
  onToggleSkills,
  onToast,
}: {
  session: SessionMeta;
  running: boolean;
  onSend: (text: string, attachments: PersonalAttachment[]) => void;
  onStop: () => void;
  onChangeModel: (model: string) => void;
  onToggleSkills: () => void;
  onToast: (text: string) => void;
}) {
  const bridge = useDesktopBridge();
  const [text, setText] = useState("");
  const [attachments, setAttachments] = useState<PersonalAttachment[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const [recording, setRecording] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<BlobPart[]>([]);

  const models = AGENT_MODELS[session.agent];
  const useOwnSkills = session.useOwnSkills !== false;

  useEffect(() => {
    if (!taRef.current) return;
    taRef.current.style.height = "auto";
    taRef.current.style.height = Math.min(140, taRef.current.scrollHeight) + "px";
  }, [text]);

  const send = () => {
    if (!text.trim() || running) return;
    onSend(text, attachments);
    setText("");
    setAttachments([]);
  };

  useEffect(() => {
    return () => {
      if (recorderRef.current && recorderRef.current.state !== "inactive") recorderRef.current.stop();
      streamRef.current?.getTracks().forEach((track) => track.stop());
    };
  }, []);

  const appendTranscript = (transcript: string) => {
    setText((prev) => {
      const clean = transcript.trim();
      if (!prev.trim()) return clean;
      return `${prev}${prev.endsWith("\n") ? "" : "\n"}${clean}`;
    });
    requestAnimationFrame(() => taRef.current?.focus());
  };

  const appendTodoInstruction = (title: string) => {
    const instruction = `请根据拖入的 Todo「${title}」继续实现这个需求，先理解详情，再在当前项目中完成实现、验证并汇报结果。`;
    setText((prev) => {
      if (!prev.trim()) return instruction;
      if (prev.includes(instruction)) return prev;
      return `${prev}${prev.endsWith("\n") ? "" : "\n"}${instruction}`;
    });
    requestAnimationFrame(() => taRef.current?.focus());
  };

  const stopRecording = () => {
    if (recorderRef.current && recorderRef.current.state !== "inactive") recorderRef.current.stop();
  };

  const startRecording = async () => {
    if (!bridge) {
      onToast("当前环境不支持本地 ASR");
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      onToast("当前浏览器不支持录音");
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      chunksRef.current = [];
      const mimeType = pickRecordingMimeType();
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      recorderRef.current = recorder;
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunksRef.current.push(event.data);
      };
      recorder.onstop = () => {
        const stoppedStream = streamRef.current;
        stoppedStream?.getTracks().forEach((track) => track.stop());
        streamRef.current = null;
        recorderRef.current = null;
        setRecording(false);
        const type = recorder.mimeType || mimeType || "audio/webm";
        const blob = new Blob(chunksRef.current, { type });
        chunksRef.current = [];
        if (blob.size === 0) {
          onToast("没有录到音频");
          return;
        }
        setTranscribing(true);
        blob
          .arrayBuffer()
          .then((audio) =>
            bridge.asrTranscribe({
              ...DEFAULT_ASR,
              fileName: `recording.${extensionForMimeType(type)}`,
              mimeType: type,
              audio,
            }),
          )
          .then((result) => {
            appendTranscript(result.text);
          })
          .catch((err) => {
            onToast(`转写失败：${err instanceof Error ? err.message : String(err)}`);
          })
          .finally(() => setTranscribing(false));
      };
      recorder.start();
      setRecording(true);
    } catch (err) {
      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
      recorderRef.current = null;
      setRecording(false);
      onToast(`录音失败：${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const toggleRecording = () => {
    if (running || transcribing) return;
    if (recording) stopRecording();
    else void startRecording();
  };

  // slash 命令:输入 "/" 前缀即时匹配;唯一匹配时 Tab 直接执行。
  const slashQuery = text.trimStart().startsWith("/") && !text.includes("\n") ? text.trim() : null;
  const slashMatches = slashQuery ? SLASH_COMMANDS.filter((c) => c.cmd.startsWith(slashQuery)) : [];

  const runCommand = (cmd: string) => {
    onSend(cmd, []);
    setText("");
  };

  const onKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Tab" && slashQuery && slashMatches.length > 0) {
      e.preventDefault();
      if (slashMatches.length === 1) runCommand(slashMatches[0]!.cmd);
      else setText(slashMatches[0]!.cmd); // 多个匹配:补全第一个
      return;
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  const onDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const rawPrompt = e.dataTransfer.getData(PROMPT_DRAG_MIME);
    const rawTodo = e.dataTransfer.getData(TODO_DRAG_MIME);
    if ((!rawPrompt && !rawTodo) || !bridge) return;
    try {
      if (rawTodo) {
        const { id, detailPath, title, projectName } = JSON.parse(rawTodo) as {
          id: string;
          detailPath: string;
          title: string;
          projectName: string;
        };
        if (attachments.some((a) => a.kind === "todo" && a.id === id)) {
          appendTodoInstruction(title);
          return;
        }
        const { content, truncated } = await bridge.readFile(detailPath);
        if (truncated) onToast(`${title} 过大,已截断注入`);
        setAttachments((prev) => [...prev, { id, name: title, path: detailPath, kind: "todo", projectName, content }]);
        appendTodoInstruction(title);
        return;
      }
      const { path, name } = JSON.parse(rawPrompt) as { path: string; name: string };
      if (attachments.some((a) => a.path === path)) return;
      const { content, truncated } = await bridge.readFile(path);
      if (truncated) onToast(`${name} 过大,已截断注入`);
      attachSeq += 1;
      setAttachments((prev) => [...prev, { id: `pa-${attachSeq}`, name, path, kind: "prompt", content }]);
    } catch (err) {
      onToast(`读取附件失败：${err instanceof Error ? err.message : String(err)}`);
    }
  };

  return (
    <div className="composer-wrap">
      <div
        className={`composer ${dragOver ? "pw-drop-target" : ""}`}
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes(PROMPT_DRAG_MIME) || e.dataTransfer.types.includes(TODO_DRAG_MIME)) {
            e.preventDefault();
            e.dataTransfer.dropEffect = "copy";
            setDragOver(true);
          }
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
      >
        {attachments.length > 0 ? (
          <div className="attach-row">
            {attachments.map((a) => (
              <span key={a.id} className="attach-pill">
                <span
                  className="ap-thumb"
                  style={{
                    background:
                      a.kind === "todo" ? "linear-gradient(135deg,#4f7f62,#2d5c45)" : "linear-gradient(135deg,#c96442,#a84e30)",
                  }}
                >
                  {a.kind === "todo" ? "TD" : "SK"}
                </span>
                <span>{a.name}</span>
                <button
                  className="attach-x"
                  onClick={() => setAttachments((prev) => prev.filter((x) => x.id !== a.id))}
                  title="移除"
                >
                  <Icon.X size={11} />
                </button>
              </span>
            ))}
          </div>
        ) : null}
        {/* slash 命令匹配提示:唯一匹配 Tab 直接执行,点击亦可执行 */}
        {slashQuery && slashMatches.length > 0 ? (
          <div className="pw-slash-hint">
            {slashMatches.map((c) => (
              <button
                key={c.cmd}
                className="pw-slash-item"
                onMouseDown={(e) => {
                  e.preventDefault();
                  runCommand(c.cmd);
                }}
              >
                <code>{c.cmd}</code>
                <span>{c.desc}</span>
                {slashMatches.length === 1 ? <kbd className="pw-slash-kbd">Tab 执行</kbd> : null}
              </button>
            ))}
          </div>
        ) : null}
        <div className="input-area">
          <textarea
            ref={taRef}
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              // 宠物:进入「看你打字」状态（停止输入后由节拍器衰减回 idle）。
              const pet = usePetStore.getState();
              if (pet.state === "idle" || pet.state === "sleeping" || pet.state === "typing") pet.set("typing");
            }}
            onKeyDown={onKey}
            placeholder={
              running
                ? "Agent 正在运行,可点击右侧停止…"
                : `给 ${session.agent === "claude" ? "Claude Code" : "Codex"} 发消息,可从右侧拖入 Prompt 作为 skill…`
            }
            rows={1}
          />
        </div>
        <div className="comp-foot">
          <button
            className={`pill ${useOwnSkills ? "is-on" : ""}`}
            onClick={onToggleSkills}
            title={useOwnSkills ? "已加载 agent 自身 skills,点击禁用" : "已禁用 agent 自身 skills,点击启用"}
          >
            <Icon.Sparkle size={13} />
            Skills {useOwnSkills ? "开" : "关"}
          </button>
          <button
            className={`pill pw-mic-btn ${recording ? "is-recording" : ""} ${transcribing ? "is-busy" : ""}`}
            onClick={toggleRecording}
            disabled={running || transcribing}
            title={recording ? "停止录音并转写" : transcribing ? "正在转写" : "语音输入"}
          >
            {transcribing ? <Icon.Clock size={13} /> : <Icon.Mic size={13} />}
          </button>
          <div className="spacer" />
          <span className="pill pw-model-pill">
            <span className="lightning">
              <Icon.Lightning size={11} />
            </span>
            <select
              className="pw-model-select"
              value={session.model || models[0]?.value || ""}
              onChange={(e) => onChangeModel(e.target.value)}
              disabled={models.length === 0}
            >
              {models.map((m) => (
                <option key={m.value} value={m.value}>
                  {m.label}
                </option>
              ))}
            </select>
          </span>
          {running ? (
            <button className="send" onClick={onStop} title="停止">
              <Icon.Stop size={15} />
            </button>
          ) : (
            <button
              className={`send ${text.trim() ? "" : "muted"}`}
              onClick={send}
              disabled={!text.trim()}
              title="发送 (Enter)"
            >
              <Icon.Send size={15} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
