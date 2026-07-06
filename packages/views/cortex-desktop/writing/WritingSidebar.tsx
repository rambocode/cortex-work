// 写作工作区左栏:写作空间选择(下拉 + 添加/移除)+ 文件树(新建文件/目录、重命名、删除)。
// 树节点 key 一律绝对路径。空间切换时:重扫树 + unwatch 旧根 / watch 新根 + 关闭旧空间打开的文件。
// core/views 硬边界:不直接碰 window.desktopAPI,一律经注入的 DesktopBridge(useDesktopBridge)。
import { useCallback, useEffect, useMemo, useState, type ReactElement } from "react";
import { Icon } from "@cortex-work/ui/icons";
import { useDesktopBridge } from "@cortex-work/core/provider";
import type { DesktopBridge, PromptNode } from "@cortex-work/core";
import { useWritingSpacesStore } from "@cortex-work/core/writing/spaces";
import { useWritingWorkspaceStore } from "@cortex-work/core/writing/workspace-store";
import {
  basename,
  createDir,
  createFile,
  deleteNode,
  renameNode,
  type FsActionResult,
} from "@cortex-work/core/writing/file-tree";

// CRUD 失败原因 → 用户可读提示(zh-Hans)。
function actionErrorText(res: FsActionResult): string {
  switch (res.error) {
    case "exists":
      return "已存在同名文件或目录";
    case "invalid":
      return "名称不能为空或包含路径分隔符";
    case "unsupported":
      return "当前环境不支持此操作";
    default:
      return res.message ? `操作失败: ${res.message}` : "操作失败";
  }
}

// 就地重命名输入行:任意深度节点复用。
function RenameInput({
  value,
  onChange,
  onCommit,
  onCancel,
}: {
  value: string;
  onChange: (v: string) => void;
  onCommit: () => void;
  onCancel: () => void;
}): ReactElement {
  return (
    <div className="pw-writing-inline-input">
      <input
        autoFocus
        aria-label="重命名"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") onCommit();
          if (e.key === "Escape") onCancel();
        }}
      />
      <button type="button" className="pw-ftb-btn is-primary" onClick={onCommit}>
        <Icon.Check size={12} />
      </button>
    </div>
  );
}

// 单个树节点(文件/目录)。目录可折叠;每行悬浮出重命名/删除动作按钮;
// 命中重命名态则原地替换为输入框(任意深度)。
function TreeNode({
  node,
  depth,
  currentFile,
  renaming,
  renameName,
  setRenameName,
  commitRename,
  cancelRename,
  onOpen,
  onRename,
  onDelete,
}: {
  node: PromptNode;
  depth: number;
  currentFile: string | null;
  renaming: string | null;
  renameName: string;
  setRenameName: (v: string) => void;
  commitRename: () => void;
  cancelRename: () => void;
  onOpen: (path: string) => void;
  onRename: (path: string) => void;
  onDelete: (path: string, isDir: boolean) => void;
}): ReactElement {
  const [collapsed, setCollapsed] = useState(depth > 0);
  const pad = { paddingLeft: 12 + depth * 14 } as const;
  const isActive = node.kind === "file" && node.path === currentFile;

  if (renaming === node.path) {
    return <RenameInput value={renameName} onChange={setRenameName} onCommit={commitRename} onCancel={cancelRename} />;
  }

  const actions = (
    <span className="pw-writing-node-actions">
      <button
        type="button"
        title="重命名"
        aria-label={`重命名 ${node.name}`}
        onClick={(e) => {
          e.stopPropagation();
          onRename(node.path);
        }}
      >
        <Icon.Edit size={12} />
      </button>
      <button
        type="button"
        title="删除"
        aria-label={`删除 ${node.name}`}
        onClick={(e) => {
          e.stopPropagation();
          onDelete(node.path, node.kind === "dir");
        }}
      >
        <Icon.Trash size={12} />
      </button>
    </span>
  );

  if (node.kind === "file") {
    return (
      <div
        className={`pw-tree-row is-file${isActive ? " is-active" : ""}`}
        style={pad}
        onClick={() => onOpen(node.path)}
        title={node.path}
        role="button"
        tabIndex={0}
      >
        <Icon.File size={13} />
        <span className="pw-tree-name">{node.name}</span>
        {actions}
      </div>
    );
  }
  return (
    <>
      <div className="pw-tree-row is-dir" style={pad} onClick={() => setCollapsed((v) => !v)} role="button" tabIndex={0}>
        <span className="chev" data-collapsed={collapsed}>
          <Icon.Chevron size={11} />
        </span>
        <Icon.Folder size={13} />
        <span className="pw-tree-name">{node.name}</span>
        {actions}
      </div>
      {!collapsed
        ? node.children?.map((c) => (
            <TreeNode
              key={c.path}
              node={c}
              depth={depth + 1}
              currentFile={currentFile}
              renaming={renaming}
              renameName={renameName}
              setRenameName={setRenameName}
              commitRename={commitRename}
              cancelRename={cancelRename}
              onOpen={onOpen}
              onRename={onRename}
              onDelete={onDelete}
            />
          ))
        : null}
    </>
  );
}

export function WritingSidebar({ onToast }: { onToast?: (msg: string) => void }): ReactElement {
  const bridge = useDesktopBridge();
  const spaces = useWritingSpacesStore((s) => s.spaces);
  const activeSpaceId = useWritingSpacesStore((s) => s.activeSpaceId);
  const addSpace = useWritingSpacesStore((s) => s.addSpace);
  const removeSpace = useWritingSpacesStore((s) => s.removeSpace);
  const setActiveSpace = useWritingSpacesStore((s) => s.setActiveSpace);

  const currentFile = useWritingWorkspaceStore((s) => s.currentFile);
  const setCurrentFile = useWritingWorkspaceStore((s) => s.setCurrentFile);
  const renameCurrentFile = useWritingWorkspaceStore((s) => s.renameCurrentFile);
  const handlePathRemoved = useWritingWorkspaceStore((s) => s.handlePathRemoved);

  const activeSpace = useMemo(() => spaces.find((s) => s.id === activeSpaceId) ?? null, [spaces, activeSpaceId]);
  const [tree, setTree] = useState<PromptNode | null>(null);
  // 新建输入行:kind 决定建文件还是目录;为 null 时不显示。目标目录固定为空间根(U4 骨架)。
  const [creating, setCreating] = useState<"file" | "dir" | null>(null);
  const [createName, setCreateName] = useState("");
  // 重命名输入:renaming=目标绝对路径;renameName=输入框值(默认原名)。
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameName, setRenameName] = useState("");
  const toast = useCallback((m: string) => onToast?.(m), [onToast]);

  // 扫描当前空间根的文件树(空间为空则清树)。
  const refresh = useCallback(async () => {
    if (!bridge || !activeSpace) {
      setTree(null);
      return;
    }
    try {
      setTree(await bridge.scanDirTree(activeSpace.root));
    } catch (err) {
      toast(`加载文件树失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, [bridge, activeSpace, toast]);

  // 切空间 → 重扫树 + 重置正在进行的新建/重命名输入。
  useEffect(() => {
    setCreating(null);
    setRenaming(null);
    void refresh();
  }, [refresh]);

  // 目录实时监听:watchId = 空间 id,切空间时 cleanup 自动 unwatch 旧根、订阅新根。
  // 主进程已做噪声过滤 + 250ms 去抖,收到信号直接重扫(U9 将在此基础上接入 agent 改动归因)。
  useEffect(() => {
    if (!bridge?.watchDir || !activeSpace) return;
    const watchId = activeSpace.id;
    void bridge.watchDir(watchId, activeSpace.root).catch(() => {
      /* 监听失败(权限等):保留手动刷新 */
    });
    const off = bridge.onDirChanged?.((id) => {
      if (id === watchId) void refresh();
    });
    return () => {
      off?.();
      bridge.unwatchDir?.(watchId);
    };
  }, [bridge, activeSpace, refresh]);

  const b = bridge as DesktopBridge | null;

  // 提交新建:在空间根下建文件/目录,重名/非法由 core 预检拦截并提示。
  const commitCreate = async () => {
    if (!b || !activeSpace || !creating) return;
    const res = creating === "file"
      ? await createFile(b, activeSpace.root, createName)
      : await createDir(b, activeSpace.root, createName);
    if (!res.ok) {
      toast(actionErrorText(res));
      return; // 保留输入行让用户改名重试
    }
    setCreating(null);
    setCreateName("");
    await refresh();
    if (creating === "file" && res.path) setCurrentFile(res.path);
  };

  // 提交重命名:成功后同步当前打开文件的 key + 重扫树。
  const commitRename = async () => {
    if (!b || !renaming) return;
    const res = await renameNode(b, renaming, renameName);
    if (!res.ok) {
      toast(actionErrorText(res));
      return;
    }
    if (res.path && res.path !== renaming) renameCurrentFile(renaming, res.path);
    setRenaming(null);
    setRenameName("");
    await refresh();
  };

  // 删除:命中当前打开文件(或其祖先目录)先二次确认,避免静默丢未保存内容(R8 的树侧联动)。
  const onDelete = async (path: string) => {
    if (!b) return;
    const affectsCurrent = currentFile != null && (currentFile === path || currentFile.startsWith(`${path}/`));
    if (affectsCurrent && !window.confirm("该文件正在编辑,确认删除?")) return;
    const res = await deleteNode(b, path);
    if (!res.ok) {
      toast(actionErrorText(res));
      return;
    }
    handlePathRemoved(path);
    await refresh();
  };

  // 添加空间:经系统目录选择器(取消/重复由 store 兜底回 null)。
  const onAddSpace = async () => {
    const space = await addSpace(bridge);
    if (space) setCurrentFile(null); // 新空间无打开文件
  };

  // 移除当前空间:仅移出列表不删盘;先关闭其下打开文件(unwatch 由 watch effect cleanup 处理)。
  const onRemoveSpace = () => {
    if (!activeSpace) return;
    if (!window.confirm(`移除写作空间「${activeSpace.name}」?(仅移出列表,不删除磁盘文件)`)) return;
    if (currentFile && currentFile.startsWith(`${activeSpace.root}/`)) setCurrentFile(null);
    removeSpace(activeSpace.id);
  };

  const startRename = (path: string) => {
    setRenaming(path);
    setRenameName(basename(path));
  };

  return (
    <div className="pw-writing-sidebar">
      {/* 空间选择区:下拉切换 + 添加/移除 */}
      <div className="pw-writing-space-bar">
        <select
          className="pw-writing-space-select"
          aria-label="写作空间"
          value={activeSpaceId ?? ""}
          onChange={(e) => setActiveSpace(e.target.value)}
        >
          {spaces.length === 0 ? <option value="">(无空间)</option> : null}
          {spaces.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
        {b?.pickDirectory ? (
          <button type="button" className="pw-icon-btn" title="添加写作空间" aria-label="添加写作空间" onClick={() => void onAddSpace()}>
            <Icon.Plus size={14} />
          </button>
        ) : null}
        {activeSpace ? (
          <button type="button" className="pw-icon-btn" title="移除当前空间" aria-label="移除当前空间" onClick={onRemoveSpace}>
            <Icon.X size={14} />
          </button>
        ) : null}
      </div>

      {/* 文件树工具栏:新建文件/目录 + 刷新 */}
      <div className="pw-writing-tree-tools">
        <button
          type="button"
          className="pw-icon-btn"
          title="新建文件"
          aria-label="新建文件"
          disabled={!activeSpace}
          onClick={() => {
            setCreating("file");
            setCreateName("");
          }}
        >
          <Icon.Plus size={13} />
        </button>
        {b?.mkdir ? (
          <button
            type="button"
            className="pw-icon-btn"
            title="新建目录"
            aria-label="新建目录"
            disabled={!activeSpace}
            onClick={() => {
              setCreating("dir");
              setCreateName("");
            }}
          >
            <Icon.FolderPlus size={13} />
          </button>
        ) : null}
        <div className="spacer" />
        <button type="button" className="pw-icon-btn" title="刷新" aria-label="刷新文件树" onClick={() => void refresh()}>
          <Icon.Workflow size={13} />
        </button>
      </div>

      {/* 新建输入行 */}
      {creating ? (
        <div className="pw-writing-inline-input">
          <input
            autoFocus
            aria-label={creating === "file" ? "新建文件名" : "新建目录名"}
            placeholder={creating === "file" ? "文件名(如 draft.md)" : "目录名"}
            value={createName}
            onChange={(e) => setCreateName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void commitCreate();
              if (e.key === "Escape") setCreating(null);
            }}
          />
          <button type="button" className="pw-ftb-btn is-primary" onClick={() => void commitCreate()}>
            <Icon.Check size={12} />
          </button>
        </div>
      ) : null}

      {/* 文件树主体 */}
      <div className="pw-tree pw-writing-tree">
        {!activeSpace ? (
          <div className="pw-empty-hint">尚无写作空间,点上方 + 添加一个目录</div>
        ) : !tree ? (
          <div className="pw-panel-empty">加载中…</div>
        ) : (tree.children?.length ?? 0) === 0 ? (
          <div className="pw-empty-hint">空目录</div>
        ) : (
          tree.children?.map((c) => (
            <TreeNode
              key={c.path}
              node={c}
              depth={0}
              currentFile={currentFile}
              renaming={renaming}
              renameName={renameName}
              setRenameName={setRenameName}
              commitRename={() => void commitRename()}
              cancelRename={() => setRenaming(null)}
              onOpen={setCurrentFile}
              onRename={startRename}
              onDelete={(p) => void onDelete(p)}
            />
          ))
        )}
      </div>
    </div>
  );
}
