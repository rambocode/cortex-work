// 个人工作区右栏：Prompt 库（用户自选根目录，递归 .md 树）。
// 文件可点击进入编辑器，也可拖入聊天输入框（dataTransfer 自定义协议）。

import { useEffect, useState } from "react";
import { Icon } from "@cortex-work/ui/icons";
import { useDesktopBridge, usePersonalStore } from "@cortex-work/core";
import type { PromptNode } from "@cortex-work/core";
import { PromptEditor } from "./PromptEditor";

export const PROMPT_DRAG_MIME = "application/x-cortex-prompt";

function TreeNode({
  node,
  depth,
  onOpenFile,
}: {
  node: PromptNode;
  depth: number;
  onOpenFile: (node: PromptNode) => void;
}) {
  const [collapsed, setCollapsed] = useState(depth > 1);

  if (node.kind === "file") {
    // SKILL.md 是 skill 定义文件,单独用 skill 图标(Sparkle)+ 强调色高亮,与普通 .md 区分。
    const isSkill = /^skill\.md$/i.test(node.name);
    return (
      <button
        className={`pw-tree-row is-file ${isSkill ? "is-skill" : ""}`}
        style={{ paddingLeft: 12 + depth * 14 }}
        draggable
        onDragStart={(e) => {
          e.dataTransfer.setData(PROMPT_DRAG_MIME, JSON.stringify({ path: node.path, name: node.name }));
          e.dataTransfer.effectAllowed = "copy";
        }}
        onClick={() => onOpenFile(node)}
        title={`${node.path}（可拖入聊天输入框）`}
      >
        {isSkill ? <Icon.Sparkle size={13} /> : <Icon.File size={13} />}
        <span className="pw-tree-name">{node.name}</span>
      </button>
    );
  }

  return (
    <>
      <button
        className="pw-tree-row is-dir"
        style={{ paddingLeft: 12 + depth * 14 }}
        onClick={() => setCollapsed((v) => !v)}
      >
        <span className="chev" data-collapsed={collapsed}>
          <Icon.Chevron size={11} />
        </span>
        <Icon.Folder size={13} />
        <span className="pw-tree-name">{node.name}</span>
        <span className="count">{node.children?.length ?? 0}</span>
      </button>
      {!collapsed
        ? node.children?.map((child) => (
            <TreeNode key={child.path} node={child} depth={depth + 1} onOpenFile={onOpenFile} />
          ))
        : null}
    </>
  );
}

export function PromptPanel({ onToast, bare = false }: { onToast: (text: string) => void; bare?: boolean }) {
  const bridge = useDesktopBridge();
  const promptRoot = usePersonalStore((s) => s.promptRoot);
  const promptTree = usePersonalStore((s) => s.promptTree);
  const setPromptRoot = usePersonalStore((s) => s.setPromptRoot);
  const setPromptTree = usePersonalStore((s) => s.setPromptTree);
  const [openFile, setOpenFile] = useState<{ path: string; name: string } | null>(null);

  const pickRoot = async () => {
    if (!bridge) return;
    const root = await bridge.pickDirectory();
    if (!root) return;
    try {
      const tree = await bridge.scanPromptTree(root);
      setPromptRoot(root, tree);
      setOpenFile(null);
      onToast("Prompt 库已加载");
    } catch (err) {
      onToast(`加载失败：${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const refresh = async () => {
    if (!bridge || !promptRoot) return;
    try {
      setPromptTree(await bridge.scanPromptTree(promptRoot));
      onToast("已刷新 Prompt 列表");
    } catch {
      onToast("刷新失败,目录可能已移动,请重新选择");
    }
  };

  // 在系统文件管理器(访达)中打开当前 Prompt 库目录。
  const openInFinder = () => {
    if (!bridge?.openPath || !promptRoot) return;
    void bridge.openPath(promptRoot).catch(() => onToast("打开目录失败"));
  };

  // Prompt 目录实时监听:外部增删/改 .md 文件后自动重扫,无需手动刷新或关闭重开
  // (复用 FilesView 同款 watchDir/onDirChanged;主进程已做噪声过滤 + 去抖)。静默刷新,不弹 toast。
  useEffect(() => {
    if (!bridge?.watchDir || !promptRoot) return;
    const watchId = "prompt-panel";
    void bridge.watchDir(watchId, promptRoot).catch(() => {
      /* 监听失败(权限等):保留手动刷新 */
    });
    const off = bridge.onDirChanged?.((id) => {
      if (id !== watchId) return;
      void bridge.scanPromptTree!(promptRoot).then(
        (tree) => setPromptTree(tree),
        () => {
          /* 重扫失败(目录已移动等):保持现状,用户可手动刷新/更换目录 */
        },
      );
    });
    return () => {
      off?.();
      bridge.unwatchDir?.(watchId);
    };
  }, [bridge, promptRoot, setPromptTree]);

  const inner = (
    <>
      <div className="pw-panel-h">
        <Icon.File size={14} />
        <span className="pw-panel-title">Prompt 库</span>
        <div className="spacer" />
        {promptRoot ? (
          <>
            <button className="pw-icon-btn" title="在访达中打开 Prompt 目录" onClick={openInFinder}>
              <Icon.Expand size={13} />
            </button>
            <button className="pw-icon-btn" title="刷新" onClick={refresh}>
              <Icon.Retry size={13} />
            </button>
            <button className="pw-icon-btn" title="更换目录" onClick={pickRoot}>
              <Icon.Folder size={13} />
            </button>
          </>
        ) : null}
      </div>

      {openFile ? (
        <PromptEditor path={openFile.path} name={openFile.name} onBack={() => setOpenFile(null)} onToast={onToast} />
      ) : !promptRoot ? (
        <div className="pw-panel-empty">
          <Icon.Folder size={22} />
          <div>选择一个本地文件夹作为 Prompt 库,递归加载其中的 .md 文件</div>
          <button className="btn primary" onClick={pickRoot} disabled={!bridge}>
            <Icon.FolderPlus size={13} />
            选择 Prompt 目录
          </button>
        </div>
      ) : !promptTree ? (
        <div className="pw-panel-empty">
          <div>目录不可用,请重新选择</div>
          <button className="btn primary" onClick={pickRoot}>
            重新选择
          </button>
        </div>
      ) : (
        <div className="pw-tree">
          <div className="pw-tree-root" title={promptRoot}>
            {promptTree.name}
          </div>
          {promptTree.children && promptTree.children.length > 0 ? (
            promptTree.children.map((child) => (
              <TreeNode key={child.path} node={child} depth={0} onOpenFile={(n) => setOpenFile({ path: n.path, name: n.name })} />
            ))
          ) : (
            <div className="pw-empty-hint">该目录下没有 .md 文件</div>
          )}
        </div>
      )}
    </>
  );

  // bare: 作为 PersonalRightPanel 的子视图嵌入,不渲染自己的 aside 外壳。
  if (bare) return <div className="pw-rp-view">{inner}</div>;
  return <aside className="right pw-prompts">{inner}</aside>;
}
