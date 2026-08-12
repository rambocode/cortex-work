// 写作左栏的单个「写作空间」可折叠块(视觉逐像素对齐 Kun WriteSidebar 的空间分组形态):
//   空间行 = chevron + folder 图标 + 名字(ellipsis) + hover 才浮出的动作组(新建文件/新建目录/刷新/移除);活跃空间高亮胶囊。
//   默认空间(isDefault)在空间行下渲染灰字副标「默认写作空间」。
//   展开时列出**当前目录**的直接子级(不是递归树):点子目录即「进入」该目录、只显示其内容,
//   顶部面包屑回上级。因此所有行左缩进恒定,不随层级递增——文稿卡片左边缘始终对齐。
//   文件行按左栏「排序与显示」偏好可附带概要与创建时间(元信息由父组件经 writing:docMeta 批量拉取)。
// 图标全部用 lucide-react,与 Kun 源码逐个对齐(FilePlus2/FolderPlus/RefreshCw/Trash2/
//   Folder/FolderOpen/ChevronRight/ChevronDown),尺寸/描边照 Kun className(h-3=12px、h-3.5=14px)映射到 size prop。
// 纯展示组件:树状态、展开态、当前目录、新建目录态与全部动作回调都由父 WritingSidebar 注入
//(重命名弹窗同样由父组件持有并渲染)。
import { type ReactElement } from "react";
import {
  Check,
  ChevronDown,
  ChevronRight,
  ChevronLeft,
  FilePlus2,
  Folder,
  FolderOpen,
  FolderPlus,
  RefreshCw,
  Trash2,
} from "lucide-react";
import type { PromptNode } from "@cortex-work/core";
import type { WritingDocMetaItem } from "@cortex-work/core/desktop/writing-doc-meta-types";
import type { WritingSpacesState } from "@cortex-work/core/writing/spaces";
import {
  countWritingDocs,
  formatWritingDocTime,
  writingCrumbSegments,
  writingDisplayName,
} from "@cortex-work/core/writing/doc-list";

// WritingSpace 未从 core 主入口导出,与 WritingAssistantPanel 一致从 store 类型派生。
type WritingSpace = WritingSpacesState["spaces"][number];

// 新建目录的内联输入行(渲染在当前目录列表顶部)。
// 注:重命名已改为双击唤起弹窗(WritingRenameDialog),不再复用本输入行。
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
        <Check size={14} strokeWidth={1.9} />
      </button>
    </div>
  );
}

// 目录行:点击进入该目录(不再原地展开);hover 浮出 新建文件 / 新建目录 / 删除;双击改名。
function DirRow({
  node,
  onEnter,
  onRename,
  onDelete,
  onCreateFileInDir,
  onCreateDirInDir,
}: {
  node: PromptNode;
  onEnter: (path: string) => void;
  onRename: (path: string, isDir: boolean) => void;
  onDelete: (path: string, isDir: boolean) => void;
  onCreateFileInDir: (dir: string) => void;
  onCreateDirInDir: (dir: string) => void;
}): ReactElement {
  const docCount = countWritingDocs(node);
  return (
    <div
      className="pw-tree-row is-dir"
      onClick={() => onEnter(node.path)}
      onDoubleClick={(e) => {
        e.stopPropagation();
        onRename(node.path, true);
      }}
      role="button"
      tabIndex={0}
      title={node.path}
    >
      <Folder size={14} strokeWidth={1.75} className="pw-w-folder" />
      <span className="pw-tree-name">{node.name}</span>
      {/* 目录内文档数(递归含子目录):不进去也知道里面有没有东西。空目录显示 0。 */}
      <span className="pw-writing-dir-count" aria-label={`${docCount} 篇文档`}>
        {docCount}
      </span>
      <span className="pw-writing-node-actions">
        <button
          type="button"
          title="在此目录新建文件"
          aria-label={`在 ${node.name} 新建文件`}
          onClick={(e) => {
            e.stopPropagation();
            onCreateFileInDir(node.path);
          }}
        >
          <FilePlus2 size={14} strokeWidth={1.8} />
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
          <FolderPlus size={14} strokeWidth={1.8} />
        </button>
        <button
          type="button"
          className="is-danger"
          title="删除"
          aria-label={`删除 ${node.name}`}
          onClick={(e) => {
            e.stopPropagation();
            onDelete(node.path, true);
          }}
        >
          <Trash2 size={14} strokeWidth={1.85} />
        </button>
      </span>
      {/* 进入指示:右侧小箭头(动作组 hover 时会盖在其上,不冲突) */}
      <ChevronRight size={12} strokeWidth={2} className="pw-w-chev pw-writing-enter-chev" />
    </div>
  );
}

// 文档行:无前置图标、无层级缩进;标题同行最右是删除按钮,下面按偏好排概要与创建时间。
// 单击打开,双击唤起重命名弹窗。
function FileRow({
  node,
  isActive,
  hasPending,
  meta,
  showCreatedAt,
  showExcerpt,
  onOpen,
  onRename,
  onDelete,
}: {
  node: PromptNode;
  isActive: boolean;
  hasPending: boolean;
  meta: WritingDocMetaItem | undefined;
  showCreatedAt: boolean;
  showExcerpt: boolean;
  onOpen: (path: string) => void;
  onRename: (path: string, isDir: boolean) => void;
  onDelete: (path: string, isDir: boolean) => void;
}): ReactElement {
  // 概要空串(空文档 / 非 markdown)时不占位,避免整列出现一排空行。
  const excerpt = showExcerpt ? (meta?.excerpt ?? "") : "";
  const createdText = showCreatedAt ? formatWritingDocTime(meta?.birthtimeMs) : "";
  const hasMetaLines = !!excerpt || !!createdText;
  return (
    <div
      className={`pw-tree-row is-file${isActive ? " is-active" : ""}${hasMetaLines ? " has-meta" : ""}`}
      onClick={() => onOpen(node.path)}
      // 双击文件名唤起重命名弹窗(替代常显的编辑图标)。
      onDoubleClick={(e) => {
        e.stopPropagation();
        onRename(node.path, false);
      }}
      title={node.path}
      role="button"
      tabIndex={0}
    >
      {/* 删除按钮放在标题同一行的最右侧:概要与时间因此能占满整行宽度,不被右侧动作列挤窄。 */}
      <span className="pw-writing-file-main">
        <span className="pw-writing-file-head">
          <span className="pw-tree-name">{writingDisplayName(node.name)}</span>
          {hasPending ? (
            <span
              className="pw-writing-pending-badge"
              title="有待审阅的改动"
              aria-label="有待审阅的改动"
            >
              ●
            </span>
          ) : null}
          <span className="pw-writing-node-actions">
            <button
              type="button"
              className="is-danger"
              title="删除"
              aria-label={`删除 ${node.name}`}
              onClick={(e) => {
                e.stopPropagation();
                onDelete(node.path, false);
              }}
            >
              <Trash2 size={14} strokeWidth={1.85} />
            </button>
          </span>
        </span>
        {excerpt ? <span className="pw-writing-file-excerpt">{excerpt}</span> : null}
        {createdText ? (
          <span
            className="pw-writing-file-time"
            title={`创建于 ${createdText}\n修改于 ${formatWritingDocTime(meta?.mtimeMs)}`}
          >
            {createdText}
          </span>
        ) : null}
      </span>
    </div>
  );
}

export interface WritingSpaceGroupProps {
  space: WritingSpace;
  active: boolean;
  expanded: boolean;
  canRemove: boolean;
  // 当前目录节点:undefined=尚未扫描(展开后加载中),null=无 bridge / 目录已不存在,PromptNode=已扫描。
  // 由父组件按「当前目录路径」从整棵树里取出(见 WritingSidebar 的 dirNodeFor)。
  dirNode: PromptNode | null | undefined;
  // 当前目录绝对路径(=空间根时表示在根层,不显示面包屑)。
  cwd: string;
  currentFile: string | null;
  pendingPaths: Record<string, unknown>;
  // 文稿列表显示模式(左栏「排序与显示」菜单):元信息表 + 是否显示创建时间 / 概要。
  metaByPath: Record<string, WritingDocMetaItem | undefined>;
  showCreatedAt: boolean;
  showExcerpt: boolean;
  // 新建目录内联输入(dir=目标目录):目标等于当前目录时在列表顶部渲染输入行。
  // 文件创建走即时 untitled,不用输入行。
  creatingDir: { spaceId: string; dir: string; name: string } | null;
  setCreateDirName: (v: string) => void;
  commitCreateDir: () => void;
  cancelCreateDir: () => void;
  onToggleExpand: () => void;
  // 进入某个目录 / 跳到面包屑上的某一级(传空间根即回到根层)。
  onNavigate: (dir: string) => void;
  onCreateFile: (dir: string) => void;
  onCreateDir: (dir: string) => void;
  onRefresh: () => void;
  onRemove: () => void;
  onOpenFile: (path: string) => void;
  onStartRename: (path: string, isDir: boolean) => void;
  onDelete: (path: string, isDir: boolean) => void;
}

export function WritingSpaceGroup({
  space,
  active,
  expanded,
  canRemove,
  dirNode,
  cwd,
  currentFile,
  pendingPaths,
  metaByPath,
  showCreatedAt,
  showExcerpt,
  creatingDir,
  setCreateDirName,
  commitCreateDir,
  cancelCreateDir,
  onToggleExpand,
  onNavigate,
  onCreateFile,
  onCreateDir,
  onRefresh,
  onRemove,
  onOpenFile,
  onStartRename,
  onDelete,
}: WritingSpaceGroupProps): ReactElement {
  // 新建目录输入行只在「目标目录 === 当前目录」时渲染:进入子目录后点它的新建目录，
  // 父组件会先把当前目录切进去，输入行随之出现在该目录列表顶部（所见即所得）。
  const creatingInSpace = creatingDir?.spaceId === space.id ? creatingDir : null;
  const showCreateDir = expanded && !!creatingInSpace && creatingInSpace.dir === cwd;
  // 面包屑层级(相对空间根);空数组=在根层,不渲染面包屑行。
  const segments = writingCrumbSegments(space.root, cwd);
  const parentDir = cwd.slice(0, cwd.lastIndexOf("/")) || space.root;
  const children = dirNode?.children ?? [];

  return (
    <div className="pw-writing-space-group">
      {/* 空间行:chevron + folder + 名字 + hover 浮出的动作组;活跃高亮胶囊 */}
      <div
        className={`pw-writing-space-row${active ? " is-active" : ""}`}
        onClick={onToggleExpand}
        role="button"
        tabIndex={0}
        title={space.root}
      >
        {expanded ? (
          <ChevronDown size={12} strokeWidth={2} className="pw-w-chev" />
        ) : (
          <ChevronRight size={12} strokeWidth={2} className="pw-w-chev" />
        )}
        {expanded ? (
          <FolderOpen size={14} strokeWidth={1.75} className="pw-w-folder" />
        ) : (
          <Folder size={14} strokeWidth={1.75} className="pw-w-folder" />
        )}
        <span className="pw-tree-name">{space.name}</span>
        <span className="pw-writing-node-actions pw-writing-space-actions">
          <button
            type="button"
            title="新建文件"
            aria-label={`在空间 ${space.name} 新建文件`}
            onClick={(e) => {
              e.stopPropagation();
              // 在「当前所在目录」新建,而不是恒定空间根——用户进了子目录多半想在那里建。
              onCreateFile(cwd);
            }}
          >
            <FilePlus2 size={14} strokeWidth={1.75} />
          </button>
          <button
            type="button"
            title="新建目录"
            aria-label={`在空间 ${space.name} 新建目录`}
            onClick={(e) => {
              e.stopPropagation();
              onCreateDir(cwd);
            }}
          >
            <FolderPlus size={14} strokeWidth={1.75} />
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
            <RefreshCw size={14} strokeWidth={1.75} />
          </button>
          {canRemove ? (
            <button
              type="button"
              className="is-danger"
              title="移除空间"
              aria-label={`移除空间 ${space.name}`}
              onClick={(e) => {
                e.stopPropagation();
                onRemove();
              }}
            >
              <Trash2 size={14} strokeWidth={1.85} />
            </button>
          ) : null}
        </span>
      </div>

      {/* 默认空间副标 */}
      {space.isDefault ? <div className="pw-writing-space-sub">默认写作空间</div> : null}

      {/* 展开:面包屑(非根层)+ 新建目录输入行 + 当前目录的直接子级 */}
      {expanded ? (
        <div className="pw-writing-space-body">
          {segments.length > 0 ? (
            <div className="pw-writing-crumbs">
              <button
                type="button"
                className="pw-writing-crumb-back"
                title="返回上级"
                aria-label="返回上级"
                onClick={() => onNavigate(parentDir)}
              >
                <ChevronLeft size={13} strokeWidth={2} />
              </button>
              <button type="button" className="pw-writing-crumb" onClick={() => onNavigate(space.root)}>
                {space.name}
              </button>
              {segments.map((seg, idx) => (
                <span className="pw-writing-crumb-item" key={`${seg}-${idx}`}>
                  <span className="pw-writing-crumb-sep">/</span>
                  <button
                    type="button"
                    className={`pw-writing-crumb${idx === segments.length - 1 ? " is-current" : ""}`}
                    onClick={() =>
                      onNavigate(`${space.root}/${segments.slice(0, idx + 1).join("/")}`)
                    }
                  >
                    {seg}
                  </button>
                </span>
              ))}
            </div>
          ) : null}

          {showCreateDir ? (
            <InlineInput
              value={creatingInSpace!.name}
              ariaLabel="新建目录名"
              placeholder="目录名"
              onChange={setCreateDirName}
              onCommit={commitCreateDir}
              onCancel={cancelCreateDir}
            />
          ) : null}

          {dirNode === undefined ? (
            <div className="pw-panel-empty">加载中…</div>
          ) : children.length === 0 ? (
            <div className="pw-empty-hint">空目录,点空间行的 + 新建文件</div>
          ) : (
            children.map((c) =>
              c.kind === "dir" ? (
                <DirRow
                  key={c.path}
                  node={c}
                  onEnter={onNavigate}
                  onRename={onStartRename}
                  onDelete={onDelete}
                  onCreateFileInDir={onCreateFile}
                  onCreateDirInDir={onCreateDir}
                />
              ) : (
                <FileRow
                  key={c.path}
                  node={c}
                  isActive={c.path === currentFile}
                  hasPending={c.path in pendingPaths}
                  meta={metaByPath[c.path]}
                  showCreatedAt={showCreatedAt}
                  showExcerpt={showExcerpt}
                  onOpen={onOpenFile}
                  onRename={onStartRename}
                  onDelete={onDelete}
                />
              ),
            )
          )}
        </div>
      ) : null}
    </div>
  );
}
