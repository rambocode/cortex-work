// 个人工作区输入框内核：不依赖 session 的纯输入壳。支持 Prompt/Todo 拖入（skill/todo
// 附件 pill）、模型切换、语音输入（ASR）、Skills 开关、slash 命令、编辑重发、运行中停止。
// 会话页（PersonalComposer 薄封装）与新会话落地页（草稿态）共用。复用 cortex-desktop.css
// 的 composer 类名体系。

import { useEffect, useRef, useState } from "react";
import { Icon } from "@cortex-work/ui/icons";
import { AGENT_MODELS, useDesktopBridge, usePersonalStore, usePetStore } from "@cortex-work/core";
import type { AgentKind, PersonalAttachment } from "@cortex-work/core";
import { PROMPT_DRAG_MIME } from "./PromptPanel";
import { TODO_DRAG_MIME } from "./TodosView";

// 输入框占位文案中的 agent 展示名。
const AGENT_PLACEHOLDER_NAME: Record<AgentKind, string> = { claude: "Claude Code", codex: "Codex", pi: "Pi" };

let attachSeq = 0;

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

// 从 skill 文件提取展示名,让用户明确知道拖入的是哪个 skill:
// 1) 优先 frontmatter 的 name 字段;
// 2) 文件名是通用 SKILL.md 时,退用所在目录名(skill 目录约定);
// 3) 否则用去扩展名的文件名。
function deriveSkillName(path: string, fileName: string, content: string): string {
  const fm = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const frontmatter = fm?.[1];
  if (frontmatter) {
    const m = frontmatter.match(/^\s*name\s*:\s*(.+?)\s*$/m);
    const raw = m?.[1];
    if (raw) {
      const v = raw.replace(/^['"]|['"]$/g, "").trim();
      if (v) return v;
    }
  }
  const base = fileName.replace(/\.md$/i, "");
  if (base.toLowerCase() === "skill") {
    const parts = path.split(/[/\\]/).filter(Boolean);
    const dir = parts[parts.length - 2];
    if (dir) return dir;
  }
  return base;
}

export function ComposerShell({
  agent,
  model,
  providerId,
  useOwnSkills,
  running,
  editing,
  slashCommands = [],
  acceptComposerInsert = false,
  className,
  placeholder,
  onSend,
  onStop,
  onSteer,
  onChangeModel,
  onChangePiModel,
  onToggleSkills,
  onOpenFlashNote,
  onCancelEdit,
  onToast,
}: {
  agent: AgentKind;
  model: string | undefined;
  providerId: string | undefined;
  useOwnSkills: boolean;
  running: boolean;
  /** 编辑重发:正在编辑的历史用户消息(原文填入输入框,顶部出提示条)。 */
  editing?: { uid: string; text: string } | null;
  /** slash 命令注册表;留空则不启用 slash 提示(如新会话落地页)。 */
  slashCommands?: { cmd: string; desc: string }[];
  /** 是否订阅全局 composerInsert(文件预览「发送到 Chat」),仅会话页启用。 */
  acceptComposerInsert?: boolean;
  /** 注入根 .composer-wrap 的附加类名(如落地页 pw-landing-composer)。 */
  className?: string;
  /** 覆盖非运行态占位文案;缺省用「给 {agent名} 发消息…」。 */
  placeholder?: string;
  onSend: (text: string, attachments: PersonalAttachment[]) => void;
  onStop?: () => void;
  /** pi 运行中插话:把引导注入当前轮（仅 pi + 提供时启用;非 pi/单发不传 → 运行中只能停止）。 */
  onSteer?: (text: string) => void;
  onChangeModel: (model: string) => void;
  // pi 多供应商:同时切换 provider 与模型。
  onChangePiModel: (providerId: string, model: string) => void;
  onToggleSkills: () => void;
  /** 闪记图标入口:唤起闪记浮层(桌面端由壳注入,web 端缺省 → 隐藏入口)。 */
  onOpenFlashNote?: () => void;
  onCancelEdit?: () => void;
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

  const providerSettings = usePersonalStore((s) => s.providerSettings);
  const isPi = agent === "pi";
  const models = AGENT_MODELS[agent];
  // pi:模型下拉来自已启用 provider,选项编码 `${providerId}::${modelId}`,展示「供应商 · 模型」。
  const piModelOptions = isPi
    ? providerSettings.providers
        .filter((p) => p.enabled)
        .flatMap((p) =>
          p.models.map((m) => ({ value: `${p.id}::${m.id}`, label: `${p.name} · ${m.label ?? m.id}` })),
        )
    : [];
  const piModelValue = `${providerId ?? ""}::${model ?? ""}`;

  useEffect(() => {
    if (!taRef.current) return;
    taRef.current.style.height = "auto";
    taRef.current.style.height = Math.min(140, taRef.current.scrollHeight) + "px";
  }, [text]);

  // pi 运行中可插话（steer）:把引导注入当前轮。仅 pi + 提供 onSteer 时启用。
  const canSteer = !!onSteer && isPi && running;

  const send = () => {
    if (!text.trim() || running) return;
    onSend(text, attachments);
    setText("");
    setAttachments([]);
  };

  const steer = () => {
    if (!text.trim() || !onSteer) return;
    onSteer(text);
    setText("");
  };

  // Enter:运行中可插话则 steer,否则 send（send 内部对 running 短路）。
  const submit = () => (canSteer ? steer() : send());

  // 进入编辑重发:原文替换输入框内容并聚焦。
  useEffect(() => {
    if (!editing) return;
    setText(editing.text);
    requestAnimationFrame(() => taRef.current?.focus());
  }, [editing]);

  const cancelEdit = () => {
    setText("");
    onCancelEdit?.();
  };

  useEffect(() => {
    return () => {
      if (recorderRef.current && recorderRef.current.state !== "inactive") recorderRef.current.stop();
      streamRef.current?.getTracks().forEach((track) => track.stop());
    };
  }, []);

  // 文件预览「发送到 Chat」:片段插入输入框（不直接发送,让用户补一句再回车）。
  // nonce 去重:composer 随会话切换重挂载时,旧 insert 不能再次插入。
  const composerInsert = usePersonalStore((s) => s.composerInsert);
  const consumedNonceRef = useRef(composerInsert?.nonce ?? 0);
  useEffect(() => {
    if (!acceptComposerInsert) return;
    if (!composerInsert || composerInsert.nonce === consumedNonceRef.current) return;
    consumedNonceRef.current = composerInsert.nonce;
    setText((prev) => {
      if (!prev.trim()) return composerInsert.text;
      return `${prev}${prev.endsWith("\n") ? "" : "\n"}${composerInsert.text}`;
    });
    requestAnimationFrame(() => taRef.current?.focus());
  }, [composerInsert, acceptComposerInsert]);

  const appendTranscript = (transcript: string) => {
    setText((prev) => {
      const clean = transcript.trim();
      if (!prev.trim()) return clean;
      return `${prev}${prev.endsWith("\n") ? "" : "\n"}${clean}`;
    });
    requestAnimationFrame(() => taRef.current?.focus());
  };

  const appendTodoInstruction = (title: string) => {
    const instruction = `请根据拖入的 Task「${title}」继续实现这个需求，先理解详情，再在当前项目中完成实现、验证并汇报结果。`;
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
  const slashQuery =
    slashCommands.length > 0 && text.trimStart().startsWith("/") && !text.includes("\n") ? text.trim() : null;
  const slashMatches = slashQuery ? slashCommands.filter((c) => c.cmd.startsWith(slashQuery)) : [];

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
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
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
      const skillName = deriveSkillName(path, name, content);
      setAttachments((prev) => [...prev, { id: `pa-${attachSeq}`, name: skillName, path, kind: "prompt", content }]);
    } catch (err) {
      onToast(`读取附件失败：${err instanceof Error ? err.message : String(err)}`);
    }
  };

  return (
    <div className={`composer-wrap${className ? ` ${className}` : ""}`}>
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
        {editing ? (
          <div className="pw-edit-bar">
            <Icon.Edit size={12} />
            <span>编辑重发：发送后将清除这条消息之后的所有内容</span>
            <button type="button" onClick={cancelEdit}>
              取消
            </button>
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
              canSteer
                ? "插话:输入引导回车注入当前轮,或点击右侧停止…"
                : running
                ? "Agent 正在运行,可点击右侧停止…"
                : placeholder ?? `给 ${AGENT_PLACEHOLDER_NAME[agent]} 发消息,可从右侧拖入 Prompt 作为 skill…`
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
          {onOpenFlashNote ? (
            <button className="pill" onClick={onOpenFlashNote} title="闪记">
              <Icon.Pin size={13} />
            </button>
          ) : null}
          <div className="spacer" />
          <span className="pill pw-model-pill">
            <span className="lightning">
              <Icon.Lightning size={11} />
            </span>
            {isPi ? (
              <select
                className="pw-model-select"
                value={piModelValue}
                onChange={(e) => {
                  const [providerId, model] = e.target.value.split("::");
                  onChangePiModel(providerId ?? "", model ?? "");
                }}
                disabled={piModelOptions.length === 0}
              >
                {piModelOptions.length === 0 ? (
                  <option value="::">未配置供应商（去设置 → 供应商）</option>
                ) : (
                  piModelOptions.map((m) => (
                    <option key={m.value} value={m.value}>
                      {m.label}
                    </option>
                  ))
                )}
              </select>
            ) : (
              <select
                className="pw-model-select"
                value={model || models[0]?.value || ""}
                onChange={(e) => onChangeModel(e.target.value)}
                disabled={models.length === 0}
              >
                {models.map((m) => (
                  <option key={m.value} value={m.value}>
                    {m.label}
                  </option>
                ))}
              </select>
            )}
          </span>
          {running ? (
            <>
              {canSteer ? (
                <button
                  className={`send ${text.trim() ? "" : "muted"}`}
                  onClick={steer}
                  disabled={!text.trim()}
                  title="插话:注入当前轮 (Enter)"
                >
                  <Icon.Send size={15} />
                </button>
              ) : null}
              <button className="send pw-stop-btn" onClick={onStop} title="停止">
                <Icon.Stop size={15} />
              </button>
            </>
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
