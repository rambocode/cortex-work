// 写作左栏的单个「写作空间」可折叠块(对齐 Kun WriteSidebar 的空间分组形态):
//   空间行 = chevron + folder 图标 + 名字(ellipsis) + 悬浮动作组(新建文件/新建目录/刷新/移除);活跃空间高亮。
//   默认空间(isDefault)在空间行下渲染灰字副标「默认写作空间」。
//   展开时列出该空间的文件树(TreeNode 递归);折叠时不渲染树(扫描/监听由父组件按展开态驱动)。
// 纯展示组件:树状态、展开态、创建/重命名态与全部动作回调都由父 WritingSidebar 注入,便于集中管理
// 每空间的扫描 + watch/unwatch 生命周期。
import { useState, type ReactElement } from "react";
import { Icon } from "@cortex-work/ui/icons";
import type { PromptNode } from "@cortex-work/core";
import type { WritingSpacesState } from "@cortex-work/core/writing/spaces";

// WritingSpace 未从 core 主入口导出,与 WritingAssistantPanel 一致从 store 类型派生。
type WritingSpace = WritingSpacesState["spaces"][number];

// 就地重命名 / 新建目录共用的内联输入行。
function InlineInput({
  value,
  ariaLabel,
  placeholder,
  onChange,
  onCommit,
  onCancel,
}: {
  value: string;
  ariaLabel: string;
  placeholder?: string;
  onChange: (v: string) => void;
  onCommit: () => void;
  onCancel: () => void;
}): ReactElement {
  return (
    <div className="pw-writing-inline-input">
      <input
        autoFocus
        aria-label={ariaLabel}
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") onCommit();
          if (e.key === "Escape") onCancel();
        }}
      />
      <button type="button" className="pw-ftb-btn is-primary" onClick={onCommit} aria-label="确认">
        <Icon.Check size={12} />
      </button>
    </div>
  );
}

// 单个树节点(文件/目录)。目录可折叠;每行常显浅灰动作按钮(hover 加深)。
// 命中重命名态则原地替换为输入框(任意深度)。文件行:选中高亮 + pending 徽标。
function TreeNode({
  node,
  depth,
  currentFile,
  pendingPaths,
  renaming,
  renameName,
  setRenameName,
  commitRename,
  cancelRename,
  onOpen,
  onRename,
  onDelete,
  onCreateFileInDir,
  onCreateDirInDir,
}: {
  node: PromptNode;
  depth: number;
  currentFile: string | null;
  pendingPaths: Record<string, unknown>;
  renaming: string | null;
  renameName: string;
  setRenameName: (v: string) => void;
  commitRename: () => void;
  cancelRename: () => void;
  onOpen: (path: string) => void;
  onRename: (path: string) => void;
  onDelete: (path: string, isDir: boolean) => void;
  onCreateFileInDir: (dir: string) => void;
  onCreateDirInDir: (dir: string) => void;
}): ReactElement {
  // 目录默认折叠(depth>0 的深层目录);顶层目录也折叠,由用户点开。
  const [collapsed, setCollapsed] = useState(true);
  const pad = { paddingLeft: 12 + depth * 14 } as const;
  const isActive = node.kind === "file" && node.path === currentFile;
  const hasPending = node.kind === "file" && node.path in pendingPaths;

  if (renaming === node.path) {
    return (
      <InlineInput
        value={renameName}
        ariaLabel="重命名"
        onChange={setRenameName}
        onCommit={commitRename}
        onCancel={cancelRename}
      />
    );
  }

  // 文件行动作:重命名 + 删除;目录行额外前置 新建文件 / 新建目录。
  const actions = (
    <span className="pw-writing-node-actions">
      {node.kind === "dir" ? (
        <>
          <button
            type="button"
            title="在此目录新建文件"
            aria-label={`在 ${node.name} 新建文件`}
            onClick={(e) => {
              e.stopPropagation();
              onCreateFileInDir(node.path);
            }}
          >
            <Icon.Plus size={12} />
          </button>
          <button
            type="button"
            title="在此目录新建目录"
            aria-label={`在 ${node.name} 新建目录`}
            onClick={(e) => {
              e.stopPropagation();
              onCreateDirInDir(node.path);
            }}
          >
            <Icon.FolderPlus size={12} />
          </button>
        </>
      ) : null}
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
        <span className="pw-tree-lead" aria-hidden />
        <Icon.File size={13} />
        <span className="pw-tree-name">{node.name}</span>
        {hasPending ? (
          <span
            className="pw-writing-pending-badge"
            title="有待审阅的改动"
            aria-label="有待审阅的改动"
          >
            ●
          </span>
        ) : null}
        {actions}
      </div>
    );
  }
  return (
    <>
      <div
        className="pw-tree-row is-dir"
        style={pad}
        onClick={() => setCollapsed((v) => !v)}
        role="button"
        tabIndex={0}
      >
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
              pendingPaths={pendingPaths}
              renaming={renaming}
              renameName={renameName}
              setRenameName={setRenameName}
              commitRename={commitRename}
              cancelRename={cancelRename}
              onOpen={onOpen}
              onRename={onRename}
              onDelete={onDelete}
              onCreateFileInDir={onCreateFileInDir}
              onCreateDirInDir={onCreateDirInDir}
            />
          ))
        : null}
    </>
  );
}

export interface WritingSpaceGroupProps {
  space: WritingSpace;
  active: boolean;
  expanded: boolean;
  canRemove: boolean;
  // 该空间的文件树:undefined=尚未扫描(展开后加载中),null=空间无 bridge,PromptNode=已扫描。
  tree: PromptNode | null | undefined;
  currentFile: string | null;
  pendingPaths: Record<string, unknown>;
  // 新建目录内联输入:命中本空间时在树顶渲染(dir=目标目录)。文件创建走即时 untitled,不用输入行。
  creatingDir: { spaceId: string; dir: string; name: string } | null;
  setCreateDirName: (v: string) => void;
  commitCreateDir: () => void;
  cancelCreateDir: () => void;
  // 重命名态(绝对路径 + 输入值)。
  renaming: string | null;
  renameName: string;
  setRenameName: (v: string) => void;
  commitRename: () => void;
  cancelRename: () => void;
  onToggleExpand: () => void;
  onCreateFile: (dir: string) => void;
  onCreateDir: (dir: string) => void;
  onRefresh: () => void;
  onRemove: () => void;
  onOpenFile: (path: string) => void;
  onStartRename: (path: string) => void;
  onDelete: (path: string, isDir: boolean) => void;
}

export function WritingSpaceGroup({
  space,
  active,
  expanded,
  canRemove,
  tree,
  currentFile,
  pendingPaths,
  creatingDir,
  setCreateDirName,
  commitCreateDir,
  cancelCreateDir,
  renaming,
  renameName,
  setRenameName,
  commitRename,
  cancelRename,
  onToggleExpand,
  onCreateFile,
  onCreateDir,
  onRefresh,
  onRemove,
  onOpenFile,
  onStartRename,
  onDelete,
}: WritingSpaceGroupProps): ReactElement {
  const showCreateDir = expanded && creatingDir?.spaceId === space.id;

  return (
    <div className="pw-writing-space-group">
      {/* 空间行:chevron + folder + 名字 + 悬浮动作组;活跃高亮 */}
      <div
        className={`pw-writing-space-row${active ? " is-active" : ""}`}
        onClick={onToggleExpand}
        role="button"
        tabIndex={0}
        title={space.root}
      >
        <span className="chev" data-collapsed={!expanded}>
          <Icon.Chevron size={11} />
        </span>
        <Icon.Folder size={14} />
        <span className="pw-tree-name">{space.name}</span>
        <span className="pw-writing-space-actions">
          <button
            type="button"
            title="新建文件"
            aria-label={`在空间 ${space.name} 新建文件`}
            onClick={(e) => {
              e.stopPropagation();
              onCreateFile(space.root);
            }}
          >
            <Icon.Plus size={13} />
          </button>
          <button
            type="button"
            title="新建目录"
            aria-label={`在空间 ${space.name} 新建目录`}
            onClick={(e) => {
              e.stopPropagation();
              onCreateDir(space.root);
            }}
          >
            <Icon.FolderPlus size={13} />
          </button>
          <button
            type="button"
            title="刷新"
            aria-label={`刷新空间 ${space.name}`}
            onClick={(e) => {
              e.stopPropagation();
              onRefresh();
            }}
          >
            <Icon.Retry size={13} />
          </button>
          {canRemove ? (
            <button
              type="button"
              title="移除空间"
              aria-label={`移除空间 ${space.name}`}
              onClick={(e) => {
                e.stopPropagation();
                onRemove();
              }}
            >
              <Icon.X size={13} />
            </button>
          ) : null}
        </span>
      </div>

      {/* 默认空间副标 */}
      {space.isDefault ? <div className="pw-writing-space-sub">默认写作空间</div> : null}

      {/* 展开:新建目录输入行 + 文件树 */}
      {expanded ? (
        <div className="pw-writing-space-body">
          {showCreateDir ? (
            <InlineInput
              value={creatingDir!.name}
              ariaLabel="新建目录名"
              placeholder="目录名"
              onChange={setCreateDirName}
              onCommit={commitCreateDir}
              onCancel={cancelCreateDir}
            />
          ) : null}
          {tree === undefined ? (
            <div className="pw-panel-empty">加载中…</div>
          ) : tree === null || (tree.children?.length ?? 0) === 0 ? (
            <div className="pw-empty-hint">空目录,点空间行的 + 新建文件</div>
          ) : (
            tree.children?.map((c) => (
              <TreeNode
                key={c.path}
                node={c}
                depth={0}
                currentFile={currentFile}
                pendingPaths={pendingPaths}
                renaming={renaming}
                renameName={renameName}
                setRenameName={setRenameName}
                commitRename={commitRename}
                cancelRename={cancelRename}
                onOpen={onOpenFile}
                onRename={onStartRename}
                onDelete={onDelete}
                onCreateFileInDir={onCreateFile}
                onCreateDirInDir={onCreateDir}
              />
            ))
          )}
        </div>
      ) : null}
    </div>
  );
}
