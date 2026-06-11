// 右栏「文件」视图：当前项目目录的全部文件树,可切到「最近变更」
// （git status;非 git 仓库回退按 mtime 的最近修改）。点击文件预览内容,
// 变更文件优先显示 git diff（+/− 着色）。

import { useCallback, useEffect, useState } from "react";
import { Icon } from "@cortex-work/ui/icons";
import { useDesktopBridge, usePersonalStore } from "@cortex-work/core";
import type { ChangedFile, GitChangesResult, PromptNode } from "@cortex-work/core";

type Mode = "all" | "changes";

interface Preview {
  name: string;
  content: string;
  isDiff: boolean;
}

function FileTreeNode({ node, depth, onOpen }: { node: PromptNode; depth: number; onOpen: (n: PromptNode) => void }) {
  const [collapsed, setCollapsed] = useState(depth > 0);
  if (node.kind === "file") {
    return (
      <button className="pw-tree-row is-file" style={{ paddingLeft: 12 + depth * 14 }} onClick={() => onOpen(node)} title={node.path}>
        <Icon.File size={13} />
        <span className="pw-tree-name">{node.name}</span>
      </button>
    );
  }
  return (
    <>
      <button className="pw-tree-row is-dir" style={{ paddingLeft: 12 + depth * 14 }} onClick={() => setCollapsed((v) => !v)}>
        <span className="chev" data-collapsed={collapsed}>
          <Icon.Chevron size={11} />
        </span>
        <Icon.Folder size={13} />
        <span className="pw-tree-name">{node.name}</span>
        <span className="count">{node.children?.length ?? 0}</span>
      </button>
      {!collapsed ? node.children?.map((c) => <FileTreeNode key={c.path} node={c} depth={depth + 1} onOpen={onOpen} />) : null}
    </>
  );
}

function DiffText({ content }: { content: string }) {
  return (
    <pre className="pw-file-pre">
      {content.split("\n").map((line, i) => {
        const cls = line.startsWith("+") && !line.startsWith("+++")
          ? "diff-add"
          : line.startsWith("-") && !line.startsWith("---")
            ? "diff-del"
            : line.startsWith("@@")
              ? "diff-hunk"
              : "";
        return (
          <span key={i} className={cls}>
            {line}
            {"\n"}
          </span>
        );
      })}
    </pre>
  );
}

const STATUS_LABEL: Record<string, string> = { "??": "新增", A: "新增", M: "修改", D: "删除", R: "重命名" };

export function FilesView({ onToast }: { onToast: (text: string) => void }) {
  const bridge = useDesktopBridge();
  const projects = usePersonalStore((s) => s.projects);
  const activeProjectId = usePersonalStore((s) => s.activeProjectId);
  const project = projects.find((p) => p.id === activeProjectId);

  const [mode, setMode] = useState<Mode>("all");
  const [tree, setTree] = useState<PromptNode | null>(null);
  const [changes, setChanges] = useState<GitChangesResult | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);

  const refresh = useCallback(async () => {
    if (!bridge || !project) return;
    try {
      if (mode === "all") setTree(await bridge.scanDirTree(project.path));
      else setChanges(await bridge.gitChanges(project.path));
    } catch (err) {
      onToast(`加载失败：${err instanceof Error ? err.message : String(err)}`);
    }
  }, [bridge, project, mode, onToast]);

  useEffect(() => {
    setPreview(null);
    void refresh();
  }, [refresh]);

  const openFile = async (path: string, name: string) => {
    if (!bridge) return;
    try {
      const { content, truncated } = await bridge.readFile(path);
      setPreview({ name, content: truncated ? content + "\n\n…（文件过大,已截断）" : content, isDiff: false });
    } catch (err) {
      onToast(`读取失败：${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const openChange = async (f: ChangedFile) => {
    if (!bridge || !project) return;
    if (f.status === "D") {
      setPreview({ name: f.rel, content: "（文件已删除）", isDiff: false });
      return;
    }
    if (f.status !== "??") {
      const diff = await bridge.gitDiff(project.path, f.rel).catch(() => "");
      if (diff.trim()) {
        setPreview({ name: f.rel, content: diff, isDiff: true });
        return;
      }
    }
    await openFile(f.path, f.rel);
  };

  if (!project) return <div className="pw-panel-empty">先在左侧选择一个项目</div>;

  if (preview) {
    return (
      <div className="pw-rp-view">
        <div className="pw-editor-h">
          <button className="pw-icon-btn" title="返回" onClick={() => setPreview(null)}>
            <Icon.Back size={14} />
          </button>
          <span className="pw-editor-name">{preview.name}</span>
          <div className="spacer" />
          {preview.isDiff ? <span className="pw-readonly">diff</span> : null}
        </div>
        {preview.isDiff ? <DiffText content={preview.content} /> : <pre className="pw-file-pre">{preview.content}</pre>}
      </div>
    );
  }

  return (
    <div className="pw-rp-view">
      <div className="pw-panel-h">
        <div className="pw-rp-seg">
          <button className={mode === "all" ? "is-active" : ""} onClick={() => setMode("all")}>
            全部文件
          </button>
          <button className={mode === "changes" ? "is-active" : ""} onClick={() => setMode("changes")}>
            最近变更
          </button>
        </div>
        <div className="spacer" />
        <button className="pw-icon-btn" title="刷新" onClick={() => void refresh()}>
          <Icon.Workflow size={13} />
        </button>
      </div>
      {mode === "all" ? (
        !tree ? (
          <div className="pw-panel-empty">加载中…</div>
        ) : (
          <div className="pw-tree">
            <div className="pw-tree-root" title={project.path}>
              {tree.name}
            </div>
            {tree.children?.length ? (
              tree.children.map((c) => (
                <FileTreeNode key={c.path} node={c} depth={0} onOpen={(n) => void openFile(n.path, n.name)} />
              ))
            ) : (
              <div className="pw-empty-hint">空目录</div>
            )}
          </div>
        )
      ) : !changes ? (
        <div className="pw-panel-empty">加载中…</div>
      ) : (
        <div className="pw-tree">
          {!changes.isRepo ? <div className="pw-empty-hint">非 git 仓库 · 按修改时间显示</div> : null}
          {changes.files.length === 0 ? (
            <div className="pw-empty-hint">没有未提交的变更</div>
          ) : (
            changes.files.map((f) => (
              <button key={f.path} className="pw-tree-row is-file" onClick={() => void openChange(f)} title={f.path}>
                <span className={`pw-change-badge s-${f.status === "??" ? "new" : f.status[0]}`}>
                  {STATUS_LABEL[f.status] ?? STATUS_LABEL[f.status?.[0] ?? "M"] ?? f.status}
                </span>
                <span className="pw-tree-name">{f.rel}</span>
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}
