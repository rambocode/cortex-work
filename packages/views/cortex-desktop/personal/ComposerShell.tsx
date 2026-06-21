// 个人工作区输入框内核：不依赖 session 的纯输入壳。支持 Prompt/Todo 拖入（skill/todo
// 附件 pill）、模型切换、语音输入（ASR）、Skills 开关、slash 命令、编辑重发、运行中停止。
// 会话页（PersonalComposer 薄封装）与新会话落地页（草稿态）共用。复用 cortex-desktop.css
// 的 composer 类名体系。

import { useEffect, useRef, useState } from "react";
import { Icon } from "@cortex-work/ui/icons";
import {
  AGENT_MODELS,
  PI_THINKING_LEVELS,
  useDesktopBridge,
  usePersonalStore,
  usePetStore,
} from "@cortex-work/core";
import { useTranslation } from "@cortex-work/core/i18n";
import type { AgentKind, PendingImage, PersonalAttachment, ThinkingLevel } from "@cortex-work/core";
import { PROMPT_DRAG_MIME } from "./PromptPanel";
import { TODO_DRAG_MIME } from "./TodosView";
import { FILE_DRAG_MIME } from "./FilesView";
import {
  MAX_IMAGES_PER_MESSAGE,
  checkImageFile,
  fileToPendingImage,
  imageDedupeKey,
  rejectReasonText,
} from "./imageIntake";

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

/**
 * slash 命令项。kind 决定选中语义(KTD4):
 *  - "builtin"(默认):选中即执行(onSend(cmd)),如 /clear、/compact。
 *  - "skill":选中插入 `cmd ` 到输入框、保留焦点、不发送,供用户填 argHint 参数后再发。
 * argHint 为 pi skill frontmatter 的 argument-hint(如 `<url>` / `[branch]`),展示在命令名后。
 */
export type SlashCommand = { cmd: string; desc: string; argHint?: string; kind?: "builtin" | "skill" };

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
  thinkingLevel,
  onChangePiThinking,
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
  slashCommands?: SlashCommand[];
  /** 是否订阅全局 composerInsert(文件预览「发送到 Chat」),仅会话页启用。 */
  acceptComposerInsert?: boolean;
  /** 注入根 .composer-wrap 的附加类名(如落地页 pw-landing-composer)。 */
  className?: string;
  /** 覆盖非运行态占位文案;缺省用「给 {agent名} 发消息…」。 */
  placeholder?: string;
  // 返回是否「已消费」(真正发出):composer 据此决定清空待发图(未消费则保留供重试,KTD9)。
  // /clear 返回 false（保留待发图）;真正 send 返回 core send 的 Promise<boolean>。
  onSend: (
    text: string,
    attachments: PersonalAttachment[],
    images?: PendingImage[],
  ) => void | boolean | Promise<void | boolean>;
  onStop?: () => void;
  /** pi 运行中插话:把引导注入当前轮（仅 pi + 提供时启用;非 pi/单发不传 → 运行中只能停止）。 */
  onSteer?: (text: string) => void;
  onChangeModel: (model: string) => void;
  // pi 多供应商:同时切换 provider 与模型。
  onChangePiModel: (providerId: string, model: string) => void;
  // pi 思考强度:会话级切换（运行时即时生效;非 pi / 未提供 → 隐藏入口）。
  thinkingLevel?: ThinkingLevel;
  onChangePiThinking?: (level: ThinkingLevel) => void;
  onToggleSkills: () => void;
  /** 闪记图标入口:唤起闪记浮层(桌面端由壳注入,web 端缺省 → 隐藏入口)。 */
  onOpenFlashNote?: () => void;
  onCancelEdit?: () => void;
  onToast: (text: string) => void;
}) {
  const { t } = useTranslation("chat");
  const bridge = useDesktopBridge();
  const [text, setText] = useState("");
  const [attachments, setAttachments] = useState<PersonalAttachment[]>([]);
  const [images, setImages] = useState<PendingImage[]>([]);
  const [sending, setSending] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [recording, setRecording] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  // slash 命令下拉:当前键盘高亮项 + 是否被 Esc 临时收起（下次编辑文本即重开）。
  const [slashSel, setSlashSel] = useState(0);
  const [slashDismissed, setSlashDismissed] = useState(false);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<BlobPart[]>([]);

  const providerSettings = usePersonalStore((s) => s.providerSettings);
  // 会话未单独设 thinkingLevel 时,下拉回退全局默认（与 sendPiTurn 的实际生效值一致,避免「显关闭、实际用默认」）。
  const piThinkingDefault = usePersonalStore((s) => s.generalSettings.piThinkingDefault);
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

  // 以显式文本发送（「插入并运行」自动提交用）:不读闭包 text state,避免 setText 异步后发到旧值。
  const sendText = async (textToSend: string) => {
    if ((!textToSend.trim() && images.length === 0) || running || sending) return; // 纯图(无文本)允许发送
    setSending(true);
    try {
      // onSend 返回「是否已消费」(真正发出);未消费(/clear、pi 不可用、落盘失败)则保留待发图供重试。
      const consumed = await onSend(textToSend, attachments, images.length ? images : undefined);
      setText("");
      setAttachments([]);
      if (consumed) setImages([]); // KTD9:仅真正消费才清待发图
    } finally {
      setSending(false);
    }
  };
  const send = () => sendText(text);

  // 采集图片:格式/大小校验(toast 原因)→ 读成 PendingImage → 去重 + 张数上限以 prev 为准
  // (放进 setImages 函数式更新,避免快速连续采集时过期闭包 images 导致越限/漏去重)。
  const addImageFiles = async (files: File[]) => {
    if (files.length === 0) return;
    const accepted: File[] = [];
    for (const f of files) {
      const reason = checkImageFile(f);
      if (reason) onToast(rejectReasonText(reason, f.name));
      else accepted.push(f);
    }
    if (accepted.length === 0) return;
    let pending: PendingImage[];
    try {
      pending = await Promise.all(accepted.map((f) => fileToPendingImage(f)));
    } catch (err) {
      onToast(t("composer.readImageFailed", { error: err instanceof Error ? err.message : String(err) }));
      return;
    }
    let overflow = false;
    setImages((prev) => {
      const seen = new Set(prev.map((i) => imageDedupeKey(i.name, i.data.byteLength)));
      const merged = [...prev];
      for (const img of pending) {
        const key = imageDedupeKey(img.name, img.data.byteLength);
        if (seen.has(key)) continue; // 同名同尺寸去重
        if (merged.length >= MAX_IMAGES_PER_MESSAGE) {
          overflow = true;
          continue;
        }
        seen.add(key);
        merged.push(img);
      }
      return merged;
    });
    if (overflow) onToast(t("composer.maxImages", { count: MAX_IMAGES_PER_MESSAGE }));
  };

  // 粘贴:剪贴板含图片 → 加入待发(并拦截默认粘贴);纯文本走原行为(不拦截)。
  const onPaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(e.clipboardData?.items ?? [])
      .filter((it) => it.kind === "file" && it.type.startsWith("image/"))
      .map((it) => it.getAsFile())
      .filter((f): f is File => !!f);
    if (files.length === 0) return;
    e.preventDefault();
    void addImageFiles(files);
  };

  // 文件选择:选完即清空 input.value,允许重复选同一文件。
  const onPickFiles = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    e.target.value = "";
    void addImageFiles(files);
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
  // 镜像 text 供插入 effect 读取,避免在 setText 更新函数里做副作用计算最终文本（自动提交需显式文本）。
  const composerInsert = usePersonalStore((s) => s.composerInsert);
  const consumedNonceRef = useRef(composerInsert?.nonce ?? 0);
  const textRef = useRef(text);
  textRef.current = text;
  useEffect(() => {
    if (!acceptComposerInsert) return;
    if (!composerInsert || composerInsert.nonce === consumedNonceRef.current) return;
    consumedNonceRef.current = composerInsert.nonce;
    const prev = textRef.current;
    const finalText = !prev.trim()
      ? composerInsert.text
      : `${prev}${prev.endsWith("\n") ? "" : "\n"}${composerInsert.text}`;
    setText(finalText);
    // submit 且空闲:以显式文本直接提交（tasks「插入并运行」);running 时退化为仅插入。
    if (composerInsert.submit && !running) {
      void sendText(finalText);
    } else {
      requestAnimationFrame(() => taRef.current?.focus());
    }
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
    const instruction = t("composer.todoInstruction", { title });
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
      onToast(t("composer.noLocalAsr"));
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      onToast(t("composer.noRecording"));
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
          onToast(t("composer.noAudio"));
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
            onToast(t("composer.transcribeFailed", { error: err instanceof Error ? err.message : String(err) }));
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
      onToast(t("composer.recordFailed", { error: err instanceof Error ? err.message : String(err) }));
    }
  };

  const toggleRecording = () => {
    if (running || transcribing) return;
    if (recording) stopRecording();
    else void startRecording();
  };

  // slash 命令:输入 "/" 前缀即时匹配;↑/↓ 选择、Enter/Tab 执行高亮项、Esc 收起。
  // 触发收紧(KTD7):仅当文本以 "/" 开头且**尚无空格**(还在键入命令 token)时打开。
  // 否则 skill 项插入 "/skill:name " 后,菜单会立刻重开覆盖输入、Enter 又被拦为重执行——
  // 有空格即视为「已选定命令、正在填参数」,菜单关闭,Enter 正常发送。
  // afterSlash 保留尾随空格(不做 trimEnd):插入 "/skill:name " 后它含空格 → 视为「已选定、填参中」→ slashQuery=null → 菜单关闭。
  const afterSlash = text.trimStart();
  const slashQuery =
    slashCommands.length > 0 && afterSlash.startsWith("/") && !afterSlash.includes(" ") && !afterSlash.includes("\n")
      ? afterSlash
      : null;
  const slashMatches = slashQuery ? slashCommands.filter((c) => c.cmd.startsWith(slashQuery)) : [];
  const slashOpen = !!slashQuery && slashMatches.length > 0 && !slashDismissed;
  // 查询变化（输入/删除字符）→ 高亮回到首项并撤销 Esc 收起;纯方向键导航不改 query,选择得以保持。
  useEffect(() => {
    setSlashSel(0);
    setSlashDismissed(false);
  }, [slashQuery]);

  // 选中命令:内建立即执行;skill 插入 `cmd ` 并保留焦点供填参(KTD4)。
  const runCommand = (c: SlashCommand) => {
    if (c.kind === "skill") {
      setText(`${c.cmd} `);
      taRef.current?.focus();
      return;
    }
    onSend(c.cmd, []);
    setText("");
  };

  const onKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (slashOpen && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
      e.preventDefault();
      const n = slashMatches.length;
      setSlashSel((i) => (e.key === "ArrowDown" ? (i + 1) % n : (i - 1 + n) % n));
      return;
    }
    if (slashOpen && e.key === "Escape") {
      e.preventDefault();
      setSlashDismissed(true);
      return;
    }
    // Tab / Enter:执行当前高亮的命令（高亮项可能因过滤变化越界,故 clamp）。
    if (slashOpen && (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing))) {
      e.preventDefault();
      runCommand(slashMatches[Math.min(slashSel, slashMatches.length - 1)]!);
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
    const rawFile = e.dataTransfer.getData(FILE_DRAG_MIME);
    // 应用内 MIME(skill/todo/file)优先;否则当作系统图片文件拖入(图片无需 bridge,走 FileReader)。
    if (!rawPrompt && !rawTodo && !rawFile) {
      const files = Array.from(e.dataTransfer.files ?? []).filter((f) => f.type.startsWith("image/"));
      if (files.length) void addImageFiles(files);
      return;
    }
    if (!bridge) return;
    try {
      // 文件预览拖入(U6):复用 kind:"prompt" 附件通道,但直接用文件名(不跑 deriveSkillName,
      // 避免含 name: frontmatter 的普通文件被改成无关 skill 名)。同路径已存在则去重 no-op。
      if (rawFile) {
        const { path, name } = JSON.parse(rawFile) as { path: string; name: string };
        if (attachments.some((a) => a.path === path)) return;
        const { content, truncated } = await bridge.readFile(path);
        if (truncated) onToast(t("composer.fileTruncated", { name }));
        attachSeq += 1;
        setAttachments((prev) => [...prev, { id: `pa-${attachSeq}`, name, path, kind: "prompt", content }]);
        return;
      }
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
        if (truncated) onToast(t("composer.todoTruncated", { title }));
        setAttachments((prev) => [...prev, { id, name: title, path: detailPath, kind: "todo", projectName, content }]);
        appendTodoInstruction(title);
        return;
      }
      const { path, name } = JSON.parse(rawPrompt) as { path: string; name: string };
      if (attachments.some((a) => a.path === path)) return;
      const { content, truncated } = await bridge.readFile(path);
      if (truncated) onToast(t("composer.skillTruncated", { name }));
      attachSeq += 1;
      const skillName = deriveSkillName(path, name, content);
      setAttachments((prev) => [...prev, { id: `pa-${attachSeq}`, name: skillName, path, kind: "prompt", content }]);
    } catch (err) {
      onToast(t("composer.readAttachmentFailed", { error: err instanceof Error ? err.message : String(err) }));
    }
  };

  return (
    <div className={`composer-wrap${className ? ` ${className}` : ""}`}>
      <div
        className={`composer ${dragOver ? "pw-drop-target" : ""}`}
        onDragOver={(e) => {
          // 应用内 skill/todo 或系统文件(图片)拖入都给高亮反馈。
          if (
            e.dataTransfer.types.includes(PROMPT_DRAG_MIME) ||
            e.dataTransfer.types.includes(TODO_DRAG_MIME) ||
            e.dataTransfer.types.includes(FILE_DRAG_MIME) ||
            e.dataTransfer.types.includes("Files")
          ) {
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
                  title={t("composer.remove")}
                >
                  <Icon.X size={11} />
                </button>
              </span>
            ))}
          </div>
        ) : null}
        {images.length > 0 ? (
          <div className="img-attach-row">
            {images.map((img) => (
              <span key={img.id} className="img-attach">
                <img src={img.dataUrl} alt={img.name} className="img-attach-thumb" />
                <button
                  type="button"
                  className="img-attach-x"
                  aria-label={t("composer.removeImage", { name: img.name })}
                  title={t("composer.remove")}
                  onClick={() => setImages((prev) => prev.filter((x) => x.id !== img.id))}
                >
                  <Icon.X size={11} />
                </button>
              </span>
            ))}
            {running ? <span className="img-attach-hint">{t("composer.imagesHint")}</span> : null}
          </div>
        ) : null}
        {/* slash 命令匹配提示:↑/↓ 选择、Enter/Tab 执行高亮项、点击亦可执行 */}
        {slashOpen ? (
          <div className="pw-slash-hint" role="listbox">
            {slashMatches.map((c, i) => {
              const active = i === Math.min(slashSel, slashMatches.length - 1);
              return (
                <button
                  key={c.cmd}
                  role="option"
                  aria-selected={active}
                  className={`pw-slash-item ${active ? "is-active" : ""}`}
                  onMouseEnter={() => setSlashSel(i)}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    runCommand(c);
                  }}
                >
                  <code>{c.cmd}</code>
                  {c.argHint ? <span className="pw-slash-arg">{c.argHint}</span> : null}
                  {/* 描述单行省略:skill 的 SKILL.md 描述可能很长,全显会撑爆菜单(title 给悬停全文)。 */}
                  <span className="pw-slash-desc" title={c.desc}>{c.desc}</span>
                  {/* 动作提示按 kind 区分(KTD4):skill 为「插入」(选中填参),内建为「运行」(立即执行)。 */}
                  {active ? (
                    <kbd className="pw-slash-kbd">
                      {c.kind === "skill" ? t("composer.slashInsert") : t("composer.slashRun")}
                    </kbd>
                  ) : null}
                </button>
              );
            })}
          </div>
        ) : null}
        {editing ? (
          <div className="pw-edit-bar">
            <Icon.Edit size={12} />
            <span>{t("composer.editBar")}</span>
            <button type="button" onClick={cancelEdit}>
              {t("composer.cancel")}
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
            onPaste={onPaste}
            placeholder={
              canSteer
                ? t("composer.steerPlaceholder")
                : running
                ? t("composer.runningPlaceholder")
                : placeholder ?? t("composer.defaultPlaceholder", { name: AGENT_PLACEHOLDER_NAME[agent] })
            }
            rows={1}
          />
        </div>
        <div className="comp-foot">
          <button
            className={`pill ${useOwnSkills ? "is-on" : ""}`}
            onClick={onToggleSkills}
            title={useOwnSkills ? t("composer.skillsOnTitle") : t("composer.skillsOffTitle")}
          >
            <Icon.Sparkle size={13} color="#7c5cff" />
            {t("composer.skills")} {useOwnSkills ? t("composer.skillsOn") : t("composer.skillsOff")}
          </button>
          <button
            className={`pill pw-mic-btn ${recording ? "is-recording" : ""} ${transcribing ? "is-busy" : ""}`}
            onClick={toggleRecording}
            disabled={running || transcribing}
            title={recording ? t("composer.micStopTitle") : transcribing ? t("composer.micBusyTitle") : t("composer.micTitle")}
          >
            {transcribing ? <Icon.Clock size={13} /> : <Icon.Mic size={13} />}
          </button>
          {onOpenFlashNote ? (
            <button className="pill" onClick={onOpenFlashNote} title={t("composer.flashNote")}>
              <Icon.Pin size={13} color="#7c5cff" />
            </button>
          ) : null}
          <button
            className="pill"
            type="button"
            onClick={() => fileInputRef.current?.click()}
            title={t("composer.uploadImage")}
            aria-label={t("composer.uploadImage")}
          >
            <Icon.Image size={13} />
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/png,image/jpeg,image/gif,image/webp"
            multiple
            style={{ display: "none" }}
            onChange={onPickFiles}
          />
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
                  <option value="::">{t("composer.noProvider")}</option>
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
          {isPi && onChangePiThinking ? (
            <span className="pill pw-model-pill" title={t("composer.thinkingStrength")}>
              <select
                className="pw-model-select"
                value={thinkingLevel ?? piThinkingDefault ?? "off"}
                onChange={(e) => onChangePiThinking(e.target.value as ThinkingLevel)}
              >
                {PI_THINKING_LEVELS.map((lv) => (
                  <option key={lv} value={lv}>
                    {t(`composer.thinkingLevel.${lv}`)}
                  </option>
                ))}
              </select>
            </span>
          ) : null}
          {running ? (
            <>
              {canSteer && text.trim() ? (
                <button className="send" onClick={steer} title={t("composer.steerSend")}>
                  <Icon.Send size={15} />
                </button>
              ) : null}
              <button className="send pw-stop-btn" onClick={onStop} title={t("composer.stop")}>
                <Icon.Stop size={15} />
              </button>
            </>
          ) : (
            <button
              className={`send ${text.trim() || images.length ? "" : "muted"}`}
              onClick={() => void send()}
              disabled={(!text.trim() && images.length === 0) || sending}
              title={t("composer.send")}
            >
              <Icon.Send size={15} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
