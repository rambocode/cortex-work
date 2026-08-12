// 写作工作区左栏(结构对齐 Kun WriteSidebar):
//   顶部两个整行按钮:「新建文件」(在活跃空间根即时建 untitled.md,重名自动递增,建后打开并进入就地重命名)、
//     「添加写作空间」(系统目录选择器,取消不加);
//   「写作空间」分组标题行(右侧:排序与显示菜单 + 添加空间);
//   空间列表:每个空间一个可折叠块(WritingSpaceGroup)——空间行 + 悬浮动作(新建文件/目录/刷新/移除)、
//     默认空间副标、展开后的文件树。
// 关键契约:
//   - 树节点 key 一律绝对路径;每空间独立树 state(treesBySpace),展开时扫描 + watch(watchId=空间 id),
//     折叠时 unwatch 并清树(下次展开重扫)。多空间可同时展开。
//   - core/views 硬边界:不直接碰 window.desktopAPI,一律经注入的 DesktopBridge(useDesktopBridge)。
//   - 点击任意空间的文件 → setActiveSpace(该空间) + setCurrentFile(path),修复「非活跃空间文件点不到」。
//   - 文件名展示去掉 md 系后缀(写作空间默认 md);重命名输入/提交经 doc-list 的
//     writingDisplayName / applyWritingRenameName 成对换算,保证磁盘上后缀不丢。
//   - 文稿列表偏好(排序键/序 + 显示创建时间/概要)在 spaces store,随 writingUi 分片持久化;
//     时间与概要经 writing:docMeta 批量拉取,仅在「需要」时拉(见 needsMeta)。
import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { FilePlus2, FolderOpen, Plus } from "lucide-react";
import { useDesktopBridge } from "@cortex-work/core/provider";
import type { DesktopBridge, PromptNode } from "@cortex-work/core";
import type { WritingDocMetaItem } from "@cortex-work/core/desktop/writing-doc-meta-types";
import { useWritingSpacesStore } from "@cortex-work/core/writing/spaces";
import { useWritingWorkspaceStore } from "@cortex-work/core/writing/workspace-store";
import { useWritingReviewStore } from "@cortex-work/core/writing/review-manager";
import {
  basename,
  createDir,
  createFile,
  deleteNode,
  filterWritingTree,
  firstMarkdownFile,
  renameNode,
  type FsActionResult,
} from "@cortex-work/core/writing/file-tree";
import {
  applyWritingRenameName,
  collectWritingFilePaths,
  findWritingDirNode,
  sortWritingTree,
  writingDisplayName,
  writingHiddenExt,
} from "@cortex-work/core/writing/doc-list";
import { WritingSpaceGroup } from "./WritingSpaceGroup";
import { WritingRenameDialog } from "./WritingRenameDialog";
import { WritingListPrefsMenu } from "./WritingListPrefsMenu";

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

// 归一化根路径(仅去尾部分隔符),判断 path 是否归属某空间根用。
function normalizeRoot(root: string): string {
  return root.replace(/[/\\]+$/, "");
}

export function WritingSidebar({
  onToast,
  onRegisterRefresh,
}: {
  onToast?: (msg: string) => void;
  // U9 归因接线:把「重扫文件树」能力注册给上层(WritingWorkspace),供 agent 改「非当前文件」时
  // 即时刷新树(不必等 watch 去抖)。这里刷新全部已展开空间。
  onRegisterRefresh?: (refresh: () => void) => void;
}): ReactElement {
  const bridge = useDesktopBridge();
  const b = bridge as DesktopBridge | null;
  const spaces = useWritingSpacesStore((s) => s.spaces);
  const activeSpaceId = useWritingSpacesStore((s) => s.activeSpaceId);
  const addSpace = useWritingSpacesStore((s) => s.addSpace);
  const removeSpace = useWritingSpacesStore((s) => s.removeSpace);
  const setActiveSpace = useWritingSpacesStore((s) => s.setActiveSpace);

  // 文稿列表偏好(排序 + 显示项,跨空间共享、随 writingUi 分片持久化)。
  const docSortKey = useWritingSpacesStore((s) => s.docSortKey);
  const docSortOrder = useWritingSpacesStore((s) => s.docSortOrder);
  const docShowCreatedAt = useWritingSpacesStore((s) => s.docShowCreatedAt);
  const docShowExcerpt = useWritingSpacesStore((s) => s.docShowExcerpt);
  const setDocSort = useWritingSpacesStore((s) => s.setDocSort);
  const setDocShowCreatedAt = useWritingSpacesStore((s) => s.setDocShowCreatedAt);
  const setDocShowExcerpt = useWritingSpacesStore((s) => s.setDocShowExcerpt);

  // 待审阅文件集合(U6):pending 文件在树上显示徽标。
  const pendingPaths = useWritingReviewStore((s) => s.pending);

  const currentFile = useWritingWorkspaceStore((s) => s.currentFile);
  const setCurrentFile = useWritingWorkspaceStore((s) => s.setCurrentFile);
  const renameCurrentFile = useWritingWorkspaceStore((s) => s.renameCurrentFile);
  const handlePathRemoved = useWritingWorkspaceStore((s) => s.handlePathRemoved);

  const toast = useCallback((m: string) => onToast?.(m), [onToast]);

  // ── 左栏本地态 ─────────────────────────────────────────────────────────
  // 每空间展开态(id → bool);每空间文件树(缺省=未扫描/加载中,null=无 bridge,PromptNode=已扫描)。
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [treesBySpace, setTreesBySpace] = useState<Record<string, PromptNode | null>>({});
  // 每空间的「当前所在目录」(缺省=空间根):左栏是逐级进入式列表,不是递归树——
  // 点子目录即进入并只显示其内容,面包屑回上级。目录被删/改名时由 dirNodeFor 兜底回落。
  const [cwdBySpace, setCwdBySpace] = useState<Record<string, string>>({});
  // 新建目录内联输入(文件创建走即时 untitled,不用输入行):spaceId 定位归属、dir 目标目录、name 输入值。
  const [creatingDir, setCreatingDir] = useState<{ spaceId: string; dir: string; name: string } | null>(null);
  // 重命名弹窗:renaming=目标(路径 + 是否目录,null=未打开);renameError=上次提交失败原因(弹窗内就地展示)。
  // 输入值由弹窗自持(WritingRenameDialog),这里只管「改谁」与「失败了没」。
  const [renaming, setRenaming] = useState<{ path: string; isDir: boolean } | null>(null);
  const [renameError, setRenameError] = useState<string | null>(null);
  // 文稿元信息(创建/修改时间 + 概要):按绝对路径归集,跨空间共用一张表(绝对路径全局唯一)。
  // 只增量合并、不随树收缩清理——过期条目最多占点内存,清掉反而会让折叠再展开时闪一下空白。
  const [metaByPath, setMetaByPath] = useState<Record<string, WritingDocMetaItem>>({});

  // 稳定 ref:供 effect 内的回调读最新 spaces / expanded(避免把易变值塞进 effect 依赖导致频繁重订阅)。
  const spacesRef = useRef(spaces);
  spacesRef.current = spaces;
  const expandedRef = useRef(expanded);
  expandedRef.current = expanded;

  // path → 归属空间 id(path === 根 或 在根下)。用于重命名/删除后精确重扫对应空间树。
  const spaceIdForPath = useCallback((path: string): string | null => {
    for (const s of spacesRef.current) {
      const root = normalizeRoot(s.root);
      if (path === root || path.startsWith(`${root}/`)) return s.id;
    }
    return null;
  }, []);

  // 扫描单个空间的文件树(无 bridge → 置 null)。
  const scanSpace = useCallback(
    async (spaceId: string): Promise<void> => {
      const space = spacesRef.current.find((s) => s.id === spaceId);
      if (!bridge || !space) {
        setTreesBySpace((t) => ({ ...t, [spaceId]: null }));
        return;
      }
      try {
        // 树只显示写作相关文件(md 系 + pdf),图片等杂文件与无内容目录滤掉(见 filterWritingTree)。
        const node = await bridge.scanDirTree(space.root);
        setTreesBySpace((t) => ({ ...t, [spaceId]: filterWritingTree(node) }));
      } catch (err) {
        toast(`加载文件树失败: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
    [bridge, toast],
  );

  // 活跃空间自动展开(首次进入 ensureDefaultSpace 落定 activeSpaceId、切换活跃空间时)。
  // 用户手动折叠活跃空间后不会被强制展开(activeSpaceId 未变则本 effect 不触发)。
  useEffect(() => {
    if (activeSpaceId) {
      setExpanded((e) => (e[activeSpaceId] ? e : { ...e, [activeSpaceId]: true }));
    }
  }, [activeSpaceId]);

  // 展开态差分驱动 watch/scan 生命周期:新展开的空间 watch + 首扫;被折叠的空间 unwatch + 清树。
  const watchedRef = useRef<Set<string>>(new Set());
  const expandedKey = useMemo(
    () => Object.keys(expanded).filter((id) => expanded[id]).sort().join(","),
    [expanded],
  );
  useEffect(() => {
    if (!bridge) return;
    const want = new Set(expandedKey ? expandedKey.split(",") : []);
    const have = watchedRef.current;
    for (const id of want) {
      if (!have.has(id)) {
        const space = spacesRef.current.find((s) => s.id === id);
        if (space) void bridge.watchDir?.(id, space.root).catch(() => {});
        void scanSpace(id);
      }
    }
    for (const id of have) {
      if (!want.has(id)) {
        bridge.unwatchDir?.(id);
        setTreesBySpace((t) => {
          const n = { ...t };
          delete n[id];
          return n;
        });
      }
    }
    watchedRef.current = want;
  }, [bridge, expandedKey, scanSpace]);

  // 目录变化订阅(稳定):主进程去抖后推 onDirChanged(id),命中已展开空间则重扫。
  useEffect(() => {
    if (!bridge?.onDirChanged) return;
    const off = bridge.onDirChanged((id) => {
      if (expandedRef.current[id]) void scanSpace(id);
    });
    return off;
  }, [bridge, scanSpace]);

  // 卸载(关覆盖层)时 unwatch 全部已监听空间。
  useEffect(() => {
    const current = watchedRef.current;
    return () => {
      if (bridge) for (const id of current) bridge.unwatchDir?.(id);
    };
  }, [bridge]);

  // 把「刷新全部已展开空间」注册给上层(U9 归因命中非当前文件时即时刷新)。
  useEffect(() => {
    onRegisterRefresh?.(() => {
      for (const id of Object.keys(expandedRef.current)) {
        if (expandedRef.current[id]) void scanSpace(id);
      }
    });
  }, [onRegisterRefresh, scanSpace]);

  // ── 文稿元信息(时间 + 概要)与排序 ────────────────────────────────────────
  // 仅在「显示创建时间 / 显示概要 / 按时间排序」任一成立时才拉元信息:纯名称排序且两个显示项都关时零额外 IO。
  const metaSupported = !!b?.writingDocMeta;
  const needsMeta = docShowCreatedAt || docShowExcerpt || docSortKey !== "name";

  // 树或偏好变化 → 批量拉一次当前已展开空间内全部文件的元信息(单次 IPC,非逐文件)。
  // 主进程按 path+mtime+size 缓存摘要,故 watch 去抖重扫触发的重复拉取不会重复读盘。
  useEffect(() => {
    const docMeta = b?.writingDocMeta;
    if (!needsMeta || !docMeta) return;
    const paths = Object.values(treesBySpace).flatMap((t) => collectWritingFilePaths(t));
    if (paths.length === 0) return;
    let alive = true;
    void docMeta({ paths, withExcerpt: docShowExcerpt })
      .then((res) => {
        if (!alive) return;
        setMetaByPath((prev) => {
          const next = { ...prev };
          for (const item of res.items) next[item.path] = item;
          return next;
        });
      })
      .catch(() => {
        // 元信息拉取失败静默降级:列表照常可用,只是没有时间/概要(不打断左栏,也不弹 toast 骚扰)。
      });
    return () => {
      alive = false;
    };
  }, [b, needsMeta, docShowExcerpt, treesBySpace]);

  // 渲染用的排序后树:纯函数派生,依赖树 + 排序偏好 + 元信息(时间排序要读 metaByPath)。
  const sortedTrees = useMemo(() => {
    const out: Record<string, PromptNode | null> = {};
    for (const [id, tree] of Object.entries(treesBySpace)) {
      out[id] = tree
        ? sortWritingTree(tree, { key: docSortKey, order: docSortOrder, metaByPath })
        : tree;
    }
    return out;
  }, [treesBySpace, docSortKey, docSortOrder, metaByPath]);

  // 某空间当前所在目录:未导航过 → 空间根。
  const cwdOf = useCallback(
    (spaceId: string, root: string): string => cwdBySpace[spaceId] ?? normalizeRoot(root),
    [cwdBySpace],
  );

  // 进入目录 / 面包屑跳转。切目录只改本地视图,不动活跃空间与当前打开文件。
  const navigateDir = useCallback((spaceId: string, dir: string): void => {
    setCwdBySpace((m) => ({ ...m, [spaceId]: dir }));
  }, []);

  // 当前目录对应的树节点:目录已被删/改名(找不到)时,逐级回落到仍存在的祖先,
  // 最终兜底到空间根——否则左栏会卡在一个不存在的目录上,永远空列表。
  const dirNodeFor = useCallback(
    (spaceId: string, root: string): PromptNode | null | undefined => {
      const tree = sortedTrees[spaceId];
      if (tree === undefined) return undefined; // 尚未扫描
      if (tree === null) return null; // 无 bridge
      const base = normalizeRoot(root);
      let dir = cwdOf(spaceId, root);
      while (dir !== base) {
        const hit = findWritingDirNode(tree, dir);
        if (hit) return hit;
        dir = dir.slice(0, dir.lastIndexOf("/")) || base;
      }
      return tree;
    },
    [sortedTrees, cwdOf],
  );

  // 树刷新后,若当前目录已不存在则把 cwd 收敛回仍存在的祖先(与 dirNodeFor 的回落保持一致,
  // 否则面包屑还停在已删除的路径上)。
  useEffect(() => {
    setCwdBySpace((m) => {
      let changed = false;
      const next = { ...m };
      for (const space of spacesRef.current) {
        const tree = treesBySpace[space.id];
        const base = normalizeRoot(space.root);
        let dir = next[space.id];
        if (!tree || !dir || dir === base) continue;
        while (dir !== base && !findWritingDirNode(tree, dir)) {
          dir = dir.slice(0, dir.lastIndexOf("/")) || base;
        }
        if (dir !== next[space.id]) {
          next[space.id] = dir;
          changed = true;
        }
      }
      return changed ? next : m;
    });
  }, [treesBySpace]);

  // 打开重命名弹窗(双击行 / 新建文件后自动唤起)。isDir 决定弹窗标题与后缀提示。
  const startRename = useCallback((path: string, isDir = false): void => {
    setRenaming({ path, isDir });
    setRenameError(null);
  }, []);

  // 新建文件:在 dir 下建 untitled.md(重名自动递增 untitled-2.md…),建后展开+设活跃+打开+就地重命名。
  const createNewFile = useCallback(
    async (spaceId: string, dir: string): Promise<void> => {
      if (!b) return;
      let created: FsActionResult | null = null;
      // 递增探名:createFile 已做重名预检,遇 exists 就换下一个序号。上限防御性封顶。
      for (let i = 1; i <= 999; i++) {
        const name = i === 1 ? "untitled.md" : `untitled-${i}.md`;
        created = await createFile(b, dir, name);
        if (created.ok) break;
        if (created.error !== "exists") {
          toast(actionErrorText(created));
          return;
        }
      }
      if (!created?.ok || !created.path) return;
      const target = created.path;
      setActiveSpace(spaceId);
      setExpanded((e) => ({ ...e, [spaceId]: true }));
      // 新文件建在 dir 里,列表也切到 dir——否则在子目录建的文件当场看不见。
      setCwdBySpace((m) => ({ ...m, [spaceId]: dir }));
      await scanSpace(spaceId);
      setCurrentFile(target);
      startRename(target);
    },
    [b, scanSpace, setActiveSpace, setCurrentFile, startRename, toast],
  );

  // 顶部「新建文件」:在活跃空间根建文件;无活跃空间则提示先加空间。
  const onTopCreateFile = useCallback((): void => {
    const active = spaces.find((s) => s.id === activeSpaceId);
    if (!active) {
      toast("请先添加一个写作空间");
      return;
    }
    void createNewFile(active.id, active.root);
  }, [spaces, activeSpaceId, createNewFile, toast]);

  // 打开新建目录输入行(定位到 spaceId 的 dir 目录);确保该空间已展开,并把列表切到该目录——
  // 输入行渲染在「当前目录」顶部,不先切进去的话用户看不到自己正在哪儿建。
  const startCreateDir = useCallback((spaceId: string, dir: string): void => {
    setExpanded((e) => ({ ...e, [spaceId]: true }));
    setCwdBySpace((m) => ({ ...m, [spaceId]: dir }));
    setCreatingDir({ spaceId, dir, name: "" });
  }, []);

  const commitCreateDir = useCallback(async (): Promise<void> => {
    if (!b || !creatingDir) return;
    const res = await createDir(b, creatingDir.dir, creatingDir.name);
    if (!res.ok) {
      toast(actionErrorText(res));
      return; // 保留输入行让用户改名重试
    }
    const spaceId = creatingDir.spaceId;
    setCreatingDir(null);
    await scanSpace(spaceId);
  }, [b, creatingDir, scanSpace, toast]);

  // 提交重命名(弹窗「确定」/回车):成功后关弹窗 + 同步当前打开文件 key + 重扫归属空间树。
  // 失败不关弹窗——把原因就地显示在弹窗里,用户可直接改名重试(关掉再重来会丢输入)。
  const commitRename = useCallback(
    async (input: string): Promise<void> => {
      if (!b || !renaming) return;
      const from = renaming.path;
      // 弹窗里是去后缀名,提交前补回原后缀,否则 `笔记` 会把 `笔记.md` 改成无后缀文件。
      const res = await renameNode(b, from, applyWritingRenameName(basename(from), input));
      if (!res.ok) {
        setRenameError(actionErrorText(res));
        return;
      }
      if (res.path && res.path !== from) renameCurrentFile(from, res.path);
      const spaceId = spaceIdForPath(from);
      setRenaming(null);
      setRenameError(null);
      if (spaceId) await scanSpace(spaceId);
    },
    [b, renaming, renameCurrentFile, spaceIdForPath, scanSpace],
  );

  // 删除:命中当前打开文件(或其祖先目录)先二次确认,避免静默丢未保存内容(R8 树侧联动)。
  const onDelete = useCallback(
    async (path: string): Promise<void> => {
      if (!b) return;
      const affectsCurrent =
        currentFile != null && (currentFile === path || currentFile.startsWith(`${path}/`));
      if (affectsCurrent && !window.confirm("该文件正在编辑,确认删除?")) return;
      const res = await deleteNode(b, path);
      if (!res.ok) {
        toast(actionErrorText(res));
        return;
      }
      handlePathRemoved(path);
      const spaceId = spaceIdForPath(path);
      if (spaceId) await scanSpace(spaceId);
    },
    [b, currentFile, handlePathRemoved, spaceIdForPath, scanSpace, toast],
  );

  // 添加空间:经系统目录选择器(取消/重复由 store 兜底回 null)。新空间由 addSpace 设为活跃 → 自动展开。
  // 自动带入:扫描所选目录,直接打开其中第一个 md 文档(按树展示顺序;目录里没有 md 则留空)。
  const onAddSpace = useCallback(async (): Promise<void> => {
    const space = await addSpace(bridge);
    if (!space) return;
    let first: string | null = null;
    if (bridge) {
      try {
        first = firstMarkdownFile(filterWritingTree(await bridge.scanDirTree(space.root)));
      } catch {
        // 扫描失败不阻断添加流程:展开 effect 会再扫一次并给出 toast,这里静默留空。
      }
    }
    setCurrentFile(first);
  }, [addSpace, bridge, setCurrentFile]);

  // 移除空间:仅移出列表不删盘;先关闭其下打开文件与折叠(unwatch 由 watch 差分 effect 处理)。
  const onRemoveSpace = useCallback(
    (spaceId: string): void => {
      const space = spacesRef.current.find((s) => s.id === spaceId);
      if (!space) return;
      if (spacesRef.current.length <= 1) {
        toast("至少保留一个写作空间");
        return;
      }
      if (!window.confirm(`移除写作空间「${space.name}」?(仅移出列表,不删除磁盘文件)`)) return;
      if (currentFile && currentFile.startsWith(`${normalizeRoot(space.root)}/`)) setCurrentFile(null);
      setExpanded((e) => {
        const n = { ...e };
        delete n[spaceId];
        return n;
      });
      removeSpace(spaceId);
    },
    [currentFile, removeSpace, setCurrentFile, toast],
  );

  // 切换空间展开/折叠。
  const toggleExpand = useCallback((spaceId: string): void => {
    setExpanded((e) => ({ ...e, [spaceId]: !e[spaceId] }));
  }, []);

  // 点击任意空间的文件:切活跃空间 + 打开(修复非活跃空间文件点不到)。
  const onOpenFile = useCallback(
    (spaceId: string, path: string): void => {
      if (spaceId !== activeSpaceId) setActiveSpace(spaceId);
      setCurrentFile(path);
    },
    [activeSpaceId, setActiveSpace, setCurrentFile],
  );

  return (
    <div className="pw-writing-sidebar">
      {/* 顶部两个整行按钮 */}
      <div className="pw-writing-top">
        <button
          type="button"
          className="pw-writing-newbtn"
          onClick={onTopCreateFile}
          disabled={!b}
        >
          {/* Kun writeCreateFile:FilePlus2 h-4 w-4(16px) strokeWidth 1.9 */}
          <span className="pw-writing-cmd-icon">
            <FilePlus2 size={16} strokeWidth={1.9} />
          </span>
          <span>新建文件</span>
        </button>
        {b?.pickDirectory ? (
          <button type="button" className="pw-writing-addbtn" onClick={() => void onAddSpace()}>
            {/* Kun writeAddWorkspace:FolderOpen h-4 w-4(16px) strokeWidth 1.75 */}
            <span className="pw-writing-cmd-icon">
              <FolderOpen size={16} strokeWidth={1.75} />
            </span>
            <span>添加写作空间</span>
          </button>
        ) : null}
      </div>

      {/* 「写作空间」分组标题行 + 添加按钮 */}
      <div className="pw-writing-spaces-head">
        <span className="pw-writing-spaces-title">写作空间</span>
        <span className="pw-writing-spaces-head-actions">
          {/* 文稿排序 + 列表显示模式(创建时间 / 概要)配置 */}
          <WritingListPrefsMenu
            sortKey={docSortKey}
            sortOrder={docSortOrder}
            showCreatedAt={docShowCreatedAt}
            showExcerpt={docShowExcerpt}
            metaSupported={metaSupported}
            onSort={setDocSort}
            onToggleCreatedAt={setDocShowCreatedAt}
            onToggleExcerpt={setDocShowExcerpt}
          />
          {b?.pickDirectory ? (
            <button
              type="button"
              className="pw-writing-head-btn"
              title="添加写作空间"
              aria-label="添加写作空间"
              onClick={() => void onAddSpace()}
            >
              {/* Kun SidebarSectionHeader 右侧 SidebarIconButton:Plus h-3.5 w-3.5(14px) strokeWidth 1.75 */}
              <Plus size={14} strokeWidth={1.75} />
            </button>
          ) : null}
        </span>
      </div>

      {/* 空间列表 */}
      <div className="pw-writing-spaces">
        {spaces.length === 0 ? (
          <div className="pw-empty-hint">尚无写作空间,点上方「添加写作空间」</div>
        ) : (
          spaces.map((space) => (
            <WritingSpaceGroup
              key={space.id}
              space={space}
              active={space.id === activeSpaceId}
              expanded={expanded[space.id] === true}
              canRemove={spaces.length > 1}
              dirNode={dirNodeFor(space.id, space.root)}
              cwd={cwdOf(space.id, space.root)}
              currentFile={currentFile}
              pendingPaths={pendingPaths}
              metaByPath={metaByPath}
              // 宿主壳不支持元信息通道时,时间/概要一律不渲染(开关在菜单里也已置灰)。
              showCreatedAt={docShowCreatedAt && metaSupported}
              showExcerpt={docShowExcerpt && metaSupported}
              creatingDir={creatingDir}
              setCreateDirName={(v) =>
                setCreatingDir((c) => (c ? { ...c, name: v } : c))
              }
              commitCreateDir={() => void commitCreateDir()}
              cancelCreateDir={() => setCreatingDir(null)}
              onToggleExpand={() => toggleExpand(space.id)}
              onNavigate={(dir) => navigateDir(space.id, dir)}
              onCreateFile={(dir) => void createNewFile(space.id, dir)}
              onCreateDir={(dir) => startCreateDir(space.id, dir)}
              onRefresh={() => void scanSpace(space.id)}
              onRemove={() => onRemoveSpace(space.id)}
              onOpenFile={(path) => onOpenFile(space.id, path)}
              onStartRename={(path, isDir) => startRename(path, isDir)}
              onDelete={(path) => void onDelete(path)}
            />
          ))
        )}
      </div>

      {/* 重命名弹窗(双击行唤起):挂 body 的 portal,不受左栏滚动容器裁切。 */}
      {renaming ? (
        <WritingRenameDialog
          key={renaming.path}
          initialName={writingDisplayName(basename(renaming.path))}
          keptExt={writingHiddenExt(basename(renaming.path))}
          isDir={renaming.isDir}
          error={renameError}
          onCommit={(name) => void commitRename(name)}
          onCancel={() => {
            setRenaming(null);
            setRenameError(null);
          }}
        />
      ) : null}
    </div>
  );
}
