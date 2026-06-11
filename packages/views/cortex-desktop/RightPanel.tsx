import { Fragment } from "react";
import { useQuery } from "@tanstack/react-query";
import { Icon } from "@cortex-work/ui/icons";
import { fileDiffOptions, FILE_DIFFS, useWorkspaceId } from "@cortex-work/core";
import type { Contact } from "@cortex-work/core/types";

export interface RightPanelProps {
  contact: Contact | undefined;
  activeFile: string;
  openTabs: string[];
  onSelectTab: (path: string) => void;
  onCloseTab: (path: string) => void;
  onClose: () => void;
  onToast: (text: string) => void;
}

export function RightPanel({
  contact,
  activeFile,
  openTabs,
  onSelectTab,
  onCloseTab,
  onClose,
  onToast,
}: RightPanelProps) {
  const wsId = useWorkspaceId();
  const hasDiff = contact?.id === "wangyutong";

  const fallback = "desktop/src/sidebar/ContactList.tsx";
  const currentFile = activeFile && FILE_DIFFS[activeFile] ? activeFile : openTabs[0] || fallback;
  const { data: diff } = useQuery({ ...fileDiffOptions(wsId, currentFile), enabled: hasDiff });

  const click = (label: string) => () => onToast(label);

  if (!hasDiff) {
    return (
      <aside className="right">
        <div className="r-tabs">
          <div className="r-tab is-active">
            <Icon.File size={13} />
            审查
          </div>
          <button className="r-tab-add" onClick={click("打开文件 · 暂未实现")}>
            <Icon.Plus size={13} />
          </button>
          <div className="spacer" />
          <button className="ic-btn" onClick={click("放大面板")}>
            <Icon.Expand size={13} />
          </button>
          <button className="ic-btn" onClick={onClose} title="关闭面板">
            <Icon.X size={13} />
          </button>
        </div>
        <div
          style={{
            flex: 1,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            flexDirection: "column",
            gap: 8,
            color: "var(--text-3)",
            fontSize: 12.5,
            padding: 40,
            textAlign: "center",
          }}
        >
          <Icon.File size={28} />
          <div>暂无待审查的产出</div>
          <div style={{ fontSize: 11.5, color: "var(--text-4)" }}>
            当 {contact?.name || "联系人"} 的 Agent 有文件、代码或操作结果
            <br />
            产出时,会在这里实时显示。
          </div>
        </div>
      </aside>
    );
  }

  const resolved = diff ?? FILE_DIFFS[fallback]!;

  return (
    <aside className="right">
      <div className="r-tabs">
        <div className="r-tab" onClick={click("已切换到审查列表")} style={{ cursor: "pointer" }}>
          <Icon.Diff size={13} />
          <span>审查</span>
          <span
            style={{
              fontSize: 10,
              color: "#fff",
              background: "var(--accent)",
              borderRadius: 8,
              padding: "0 5px",
              marginLeft: 2,
              fontWeight: 600,
            }}
          >
            {openTabs.length}
          </span>
        </div>
        {openTabs.map((path) => {
          const name = path.split("/").pop();
          const isActive = path === currentFile;
          return (
            <div
              key={path}
              className={`r-tab ${isActive ? "is-active" : ""}`}
              onClick={() => onSelectTab(path)}
              style={{ cursor: "pointer" }}
            >
              <span className="file-ic">
                <Icon.File size={13} />
              </span>
              <span style={{ fontFamily: "var(--mono)", fontSize: 12 }}>{name}</span>
              <button
                className="close"
                onClick={(e) => {
                  e.stopPropagation();
                  onCloseTab(path);
                  onToast("已关闭: " + name);
                }}
              >
                <Icon.X size={12} />
              </button>
            </div>
          );
        })}
        <button className="r-tab-add" onClick={click("打开新文件 · 选择文件树中的文件")}>
          <Icon.Plus size={13} />
        </button>
        <div className="spacer" />
        <button className="ic-btn" title="在编辑器中打开" onClick={click("已在 VS Code 中打开")}>
          <Icon.Share size={13} />
        </button>
        <button
          className="ic-btn"
          title="复制路径"
          onClick={() => {
            if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
              navigator.clipboard.writeText(currentFile).catch(() => {});
            }
            onToast("已复制路径");
          }}
        >
          <Icon.Code size={13} />
        </button>
        <button className="ic-btn" title="放大" onClick={click("已放大")}>
          <Icon.Expand size={13} />
        </button>
        <button className="ic-btn" title="关闭面板" onClick={onClose}>
          <Icon.X size={13} />
        </button>
      </div>

      <div className="r-crumbs">
        {resolved.crumbs.map((c, i) => (
          <Fragment key={i}>
            <span className={`seg ${i === resolved.crumbs.length - 1 ? "cur" : ""}`}>{c}</span>
            {i < resolved.crumbs.length - 1 ? <Icon.ChevronRight size={11} /> : null}
          </Fragment>
        ))}
        <div className="spacer" />
        <span className="diff-stat">
          <span className="a">+{resolved.stat.add}</span>
          <span className="d">−{resolved.stat.del}</span>
        </span>
      </div>

      <div className="code">
        {resolved.lines.map((ln, i) => (
          <div
            key={i}
            className={`ln ${ln.side === "add" ? "add" : ln.side === "del" ? "del" : ln.side === "hunk" ? "hunk" : ""}`}
          >
            <span className="num">{ln.side === "hunk" ? "" : ln.num}</span>
            <span className="gut">{ln.side === "add" ? "+" : ln.side === "del" ? "−" : ""}</span>
            <span className="src">
              {ln.tokens.map((t, j) =>
                t.c ? (
                  <span key={j} className={`tk-${t.c}`}>
                    {t.t}
                  </span>
                ) : (
                  <span key={j}>{t.t}</span>
                ),
              )}
            </span>
          </div>
        ))}
      </div>
    </aside>
  );
}
