// 写作工作区左栏(结构对齐 Kun WriteSidebar):
//   顶部两个整行按钮:「新建文件」(在活跃空间根即时建 untitled.md,重名自动递增,建后打开并进入就地重命名)、
//     「添加写作空间」(系统目录选择器,取消不加);
//   「写作空间」分组标题行(右侧 + = 添加空间);
//   空间列表:每个空间一个可折叠块(WritingSpaceGroup)——空间行 + 悬浮动作(新建文件/目录/刷新/移除)、
//     默认空间副标、展开后的文件树。
// 关键契约:
//   - 树节点 key 一律绝对路径;每空间独立树 state(treesBySpace),展开时扫描 + watch(watchId=空间 id),
//     折叠时 unwatch 并清树(下次展开重扫)。多空间可同时展开。
//   - core/views 硬边界:不直接碰 window.desktopAPI,一律经注入的 DesktopBridge(useDesktopBridge)。
//   - 点击任意空间的文件 → setActiveSpace(该空间) + setCurrentFile(path),修复「非活跃空间文件点不到」。
import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { Icon } from "@cortex-work/ui/icons";
import { useDesktopBridge } from "@cortex-work/core/provider";
import type { DesktopBridge, PromptNode } from "@cortex-work/core";
import { useWritingSpacesStore } from "@cortex-work/core/writing/spaces";
import { useWritingWorkspaceStore } from "@cortex-work/core/writing/workspace-store";
import { useWritingReviewStore } from "@cortex-work/core/writing/review-manager";
import {
  basename,
  createDir,
  createFile,
  deleteNode,
  renameNode,
  type FsActionResult,
} from "@cortex-work/core/writing/file-tree";
import { WritingSpaceGroup } from "./WritingSpaceGroup";

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
  // 新建目录内联输入(文件创建走即时 untitled,不用输入行):spaceId 定位归属、dir 目标目录、name 输入值。
  const [creatingDir, setCreatingDir] = useState<{ spaceId: string; dir: string; name: string } | null>(null);
  // 就地重命名:renaming=目标绝对路径;renameName=输入框值(默认原名)。
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameName, setRenameName] = useState("");

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
        const node = await bridge.scanDirTree(space.root);
        setTreesBySpace((t) => ({ ...t, [spaceId]: node }));
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

  const startRename = useCallback((path: string): void => {
    setRenaming(path);
    setRenameName(basename(path));
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

  // 打开新建目录输入行(定位到 spaceId 的 dir 目录);同时确保该空间已展开。
  const startCreateDir = useCallback((spaceId: string, dir: string): void => {
    setExpanded((e) => ({ ...e, [spaceId]: true }));
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

  // 提交重命名:成功后同步当前打开文件 key + 重扫归属空间树。
  const commitRename = useCallback(async (): Promise<void> => {
    if (!b || !renaming) return;
    const res = await renameNode(b, renaming, renameName);
    if (!res.ok) {
      toast(actionErrorText(res));
      return;
    }
    if (res.path && res.path !== renaming) renameCurrentFile(renaming, res.path);
    const spaceId = spaceIdForPath(renaming);
    setRenaming(null);
    setRenameName("");
    if (spaceId) await scanSpace(spaceId);
  }, [b, renaming, renameName, renameCurrentFile, spaceIdForPath, scanSpace, toast]);

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
  const onAddSpace = useCallback(async (): Promise<void> => {
    const space = await addSpace(bridge);
    if (space) setCurrentFile(null); // 新空间无打开文件
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
          <Icon.Plus size={15} />
          <span>新建文件</span>
        </button>
        {b?.pickDirectory ? (
          <button type="button" className="pw-writing-addbtn" onClick={() => void onAddSpace()}>
            <Icon.Folder size={15} />
            <span>添加写作空间</span>
          </button>
        ) : null}
      </div>

      {/* 「写作空间」分组标题行 + 添加按钮 */}
      <div className="pw-writing-spaces-head">
        <span className="pw-writing-spaces-title">写作空间</span>
        {b?.pickDirectory ? (
          <button
            type="button"
            className="pw-icon-btn"
            title="添加写作空间"
            aria-label="添加写作空间"
            onClick={() => void onAddSpace()}
          >
            <Icon.Plus size={14} />
          </button>
        ) : null}
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
              tree={treesBySpace[space.id]}
              currentFile={currentFile}
              pendingPaths={pendingPaths}
              creatingDir={creatingDir}
              setCreateDirName={(v) =>
                setCreatingDir((c) => (c ? { ...c, name: v } : c))
              }
              commitCreateDir={() => void commitCreateDir()}
              cancelCreateDir={() => setCreatingDir(null)}
              renaming={renaming}
              renameName={renameName}
              setRenameName={setRenameName}
              commitRename={() => void commitRename()}
              cancelRename={() => setRenaming(null)}
              onToggleExpand={() => toggleExpand(space.id)}
              onCreateFile={(dir) => void createNewFile(space.id, dir)}
              onCreateDir={(dir) => startCreateDir(space.id, dir)}
              onRefresh={() => void scanSpace(space.id)}
              onRemove={() => onRemoveSpace(space.id)}
              onOpenFile={(path) => onOpenFile(space.id, path)}
              onStartRename={startRename}
              onDelete={(path) => void onDelete(path)}
            />
          ))
        )}
      </div>
    </div>
  );
}
