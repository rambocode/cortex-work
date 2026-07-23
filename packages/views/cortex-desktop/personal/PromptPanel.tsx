// 个人工作区右栏「Skills」面板:用户自选根目录,递归扫描全部文件成树(不再限 .md)。
// 两栏交互:左侧文件树常驻(可拖入聊天输入框),点文件在右侧内置预览(SkillFilePreview);
// 打开文件时给 .pw-rp-view 加 is-fileopen —— 复用既有 CSS 让面板自动向中栏延展并显示左缘拖拽条。

import { useEffect, useState } from "react";
import { Icon } from "@cortex-work/ui/icons";
import { useDesktopBridge, usePersonalStore } from "@cortex-work/core";
import type { PromptNode } from "@cortex-work/core";
import { FileIcon, fileIconSpec } from "./fileIcons";
import { SkillFilePreview } from "./SkillFilePreview";

export const PROMPT_DRAG_MIME = "application/x-cortex-prompt";

// 文件树行图标:SKILL.md 用 Sparkle 强调;其余按扩展名取专属徽章(json/py 等),无则通用文件图标。
function RowIcon({ name, isSkill }: { name: string; isSkill: boolean }) {
  if (isSkill) return <Icon.Sparkle size={13} />;
  return fileIconSpec(name) ? <FileIcon name={name} size={13} /> : <Icon.File size={13} />;
}

function TreeNode({
  node,
  depth,
  activePath,
  onOpenFile,
}: {
  node: PromptNode;
  depth: number;
  activePath: string | null;
  onOpenFile: (node: PromptNode) => void;
}) {
  const [collapsed, setCollapsed] = useState(depth > 1);

  if (node.kind === "file") {
    // SKILL.md 是 skill 定义文件,单独用 skill 图标(Sparkle)+ 强调色高亮,与普通文件区分。
    const isSkill = /^skill\.md$/i.test(node.name);
    return (
      <button
        className={`pw-tree-row is-file ${isSkill ? "is-skill" : ""} ${activePath === node.path ? "is-active" : ""}`}
        style={{ paddingLeft: 12 + depth * 14 }}
        draggable
        onDragStart={(e) => {
          e.dataTransfer.setData(PROMPT_DRAG_MIME, JSON.stringify({ path: node.path, name: node.name }));
          e.dataTransfer.effectAllowed = "copy";
        }}
        onClick={() => onOpenFile(node)}
        title={`${node.path}（可拖入聊天输入框）`}
      >
        <RowIcon name={node.name} isSkill={isSkill} />
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
            <TreeNode key={child.path} node={child} depth={depth + 1} activePath={activePath} onOpenFile={onOpenFile} />
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
      const tree = await bridge.scanDirTree(root);
      setPromptRoot(root, tree);
      setOpenFile(null);
      onToast("Skills 库已加载");
    } catch (err) {
      onToast(`加载失败：${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const refresh = async () => {
    if (!bridge || !promptRoot) return;
    try {
      setPromptTree(await bridge.scanDirTree(promptRoot));
      onToast("已刷新文件列表");
    } catch {
      onToast("刷新失败,目录可能已移动,请重新选择");
    }
  };

  // 在系统文件管理器(访达)中打开当前 Skills 库目录。
  const openInFinder = () => {
    if (!bridge?.openPath || !promptRoot) return;
    void bridge.openPath(promptRoot).catch(() => onToast("打开目录失败"));
  };

  // 目录实时监听:外部增删/改文件后自动重扫,无需手动刷新或关闭重开
  // (复用 FilesView 同款 watchDir/onDirChanged;主进程已做噪声过滤 + 去抖)。静默刷新,不弹 toast。
  useEffect(() => {
    if (!bridge?.watchDir || !promptRoot) return;
    const watchId = "prompt-panel";
    void bridge.watchDir(watchId, promptRoot).catch(() => {
      /* 监听失败(权限等):保留手动刷新 */
    });
    const off = bridge.onDirChanged?.((id) => {
      if (id !== watchId) return;
      void bridge.scanDirTree(promptRoot).then(
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
        <Icon.Sparkle size={14} />
        <span className="pw-panel-title">Skills 库</span>
        <div className="spacer" />
        {promptRoot ? (
          <>
            <button className="pw-icon-btn" title="在访达中打开目录" onClick={openInFinder}>
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

      {!promptRoot ? (
        <div className="pw-panel-empty">
          <Icon.Folder size={22} />
          <div>选择一个本地文件夹作为 Skills 库,递归加载其中的全部文件</div>
          <button className="btn primary" onClick={pickRoot} disabled={!bridge}>
            <Icon.FolderPlus size={13} />
            选择目录
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
        // 两栏:左树常驻(保留列表),右侧仅在选中文件时渲染预览。
        <div className="pw-skills-body">
          <div className="pw-skills-tree pw-tree">
            <div className="pw-tree-root" title={promptRoot}>
              {promptTree.name}
            </div>
            {promptTree.children && promptTree.children.length > 0 ? (
              promptTree.children.map((child) => (
                <TreeNode
                  key={child.path}
                  node={child}
                  depth={0}
                  activePath={openFile?.path ?? null}
                  onOpenFile={(n) => setOpenFile({ path: n.path, name: n.name })}
                />
              ))
            ) : (
              <div className="pw-empty-hint">该目录为空</div>
            )}
          </div>
          {openFile && bridge ? (
            <div className="pw-skills-preview">
              <SkillFilePreview
                key={openFile.path}
                path={openFile.path}
                name={openFile.name}
                bridge={bridge}
                onToast={onToast}
                onClose={() => setOpenFile(null)}
              />
            </div>
          ) : null}
        </div>
      )}
    </>
  );

  // bare: 作为 PersonalRightPanel 的子视图嵌入,不渲染自己的 aside 外壳。
  // openFile 时加 is-fileopen —— 触发既有 CSS 让 aside 自动向中栏延展 + 显示左缘拖拽条。
  if (bare) return <div className={`pw-rp-view pw-skills-view ${openFile ? "is-fileopen" : ""}`}>{inner}</div>;
  return <aside className="right pw-prompts">{inner}</aside>;
}
