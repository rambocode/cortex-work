// 个人工作区输入框：支持 Prompt 文件拖入（作为 skill 附件 pill）、模型切换、
// 运行中停止。复用 cortex-desktop.css 的 composer 类名体系。

import { useEffect, useRef, useState } from "react";
import { Icon } from "@cortex-work/ui/icons";
import { AGENT_MODELS, useDesktopBridge, usePetStore } from "@cortex-work/core";
import type { PromptAttachment, SessionMeta } from "@cortex-work/core";
import { PROMPT_DRAG_MIME } from "./PromptPanel";

let attachSeq = 0;

// slash 命令注册表（发送拦截在 PersonalChatArea.onSend）。
const SLASH_COMMANDS: { cmd: string; desc: string }[] = [
  { cmd: "/clear", desc: "隐藏当前历史记录（可展开）" },
];

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
  onSend: (text: string, attachments: PromptAttachment[]) => void;
  onStop: () => void;
  onChangeModel: (model: string) => void;
  onToggleSkills: () => void;
  onToast: (text: string) => void;
}) {
  const bridge = useDesktopBridge();
  const [text, setText] = useState("");
  const [attachments, setAttachments] = useState<PromptAttachment[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const taRef = useRef<HTMLTextAreaElement>(null);

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
    const raw = e.dataTransfer.getData(PROMPT_DRAG_MIME);
    if (!raw || !bridge) return;
    try {
      const { path, name } = JSON.parse(raw) as { path: string; name: string };
      if (attachments.some((a) => a.path === path)) return;
      const { content, truncated } = await bridge.readFile(path);
      if (truncated) onToast(`${name} 过大,已截断注入`);
      attachSeq += 1;
      setAttachments((prev) => [...prev, { id: `pa-${attachSeq}`, name, path, kind: "prompt", content }]);
    } catch (err) {
      onToast(`读取 Prompt 失败：${err instanceof Error ? err.message : String(err)}`);
    }
  };

  return (
    <div className="composer-wrap">
      <div
        className={`composer ${dragOver ? "pw-drop-target" : ""}`}
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes(PROMPT_DRAG_MIME)) {
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
                <span className="ap-thumb" style={{ background: "linear-gradient(135deg,#c96442,#a84e30)" }}>
                  SK
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
