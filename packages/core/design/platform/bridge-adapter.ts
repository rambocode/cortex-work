// 设计工作台的平台装配层：把 cortex 的 DesktopBridge 适配成 design 树所需的
// 注入式端口（cortexGuiPort 文件系统能力 + browserStorage UI 态持久化）。
// 宿主（DesignWorkspaceView 挂载时）调用 installDesignPlatform() 一次性装配；
// web 端 bridge 为 null 时不装配，design 树各调用点经可选链自然降级。
import type { DesktopBridge } from "../../desktop/bridge";
import { setDesignStorage, type BrowserStorageLike } from "../compat/browser-storage";
import { setCortexGuiPort, type CortexGuiPort } from "../compat/cortex-gui-port";
import type {
  WorkspaceDirectoryTarget,
  WorkspaceEntry,
  WorkspaceFileChangePayload,
  WorkspaceFileTarget,
  WorkspaceFileWatchPayload,
  WorkspaceFileWatchResult,
} from "../compat/workspace-file";

// Kun 的 workspace 语义：path 可以是绝对路径，也可以是相对 workspaceRoot 的相对路径。
function resolveWorkspacePath(target: { path?: string; workspaceRoot?: string }): string {
  const path = target.path ?? "";
  if (path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path)) return path;
  const root = (target.workspaceRoot ?? "").replace(/\/+$/, "");
  if (!root) return path;
  return path ? `${root}/${path.replace(/^\/+/, "")}` : root;
}

function dirOf(abs: string): string {
  const i = abs.lastIndexOf("/");
  return i <= 0 ? abs : abs.slice(0, i);
}

// 设计画布「实时刷新」用的按文件内容监听。cortex 只有目录级 watchDir(仅回调 id、不带
// 文件名),故：watch 一个文件 = 监听其所在目录 + 目录变化时重读该文件、内容变了才推送。
// 单一全局 onDirChanged 订阅按 watchId 分发到各文件监听。
type DesignFileWatch = {
  watchId: string;
  absPath: string;
  workspaceRoot: string;
  relPath: string;
  lastContent: string;
};

const fileWatches = new Map<string, DesignFileWatch>();
const changeHandlers = new Set<(payload: WorkspaceFileChangePayload) => void>();
let dirChangedUnsub: (() => void) | null = null;
let watchSeq = 0;

// 首次监听时挂载唯一的 onDirChanged 订阅：目录变 → 重读该 watch 的文件 → 内容有变才推变更。
function ensureDirChangedSubscription(bridge: DesktopBridge): void {
  if (dirChangedUnsub || !bridge.onDirChanged) return;
  dirChangedUnsub = bridge.onDirChanged((id) => {
    const w = fileWatches.get(id);
    if (!w) return;
    void (async () => {
      try {
        const r = await bridge.readFile(w.absPath);
        if (r.content === w.lastContent) return; // 目录内其它文件变化,本文件未变
        w.lastContent = r.content;
        const payload: WorkspaceFileChangePayload = {
          ok: true,
          watchId: w.watchId,
          workspaceRoot: w.workspaceRoot,
          path: w.relPath,
          content: r.content,
          size: r.content.length,
          truncated: r.truncated,
          changedAt: new Date().toISOString(),
        };
        for (const h of changeHandlers) h(payload);
      } catch {
        /* 文件被删/暂不可读:忽略,下次变化再试 */
      }
    })();
  });
}

function extOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** 文件存在性探测:优先轻量 statFile,旧壳无此能力时退化为 readFile;任何异常按不存在。 */
async function probeFileExists(bridge: DesktopBridge, abs: string): Promise<boolean> {
  try {
    if (bridge.statFile) {
      await bridge.statFile(abs);
      return true;
    }
    await bridge.readFile(abs);
    return true;
  } catch {
    return false;
  }
}

// 把 DesktopBridge 装配成 CortexGuiPort。剪贴板/图片挑选三项 cortex 暂无对等桥接，
// 返回 ok:false 让画布图片导入路径优雅降级（后续需要时再补 IPC）。
export function createBridgeCortexGuiPort(bridge: DesktopBridge): CortexGuiPort {
  return {
    // homeDir/platform 未知：expandHomeForMatch 等会降级为不展开（设计根默认走绝对路径，无影响）。
    readWorkspaceFile: async (options: WorkspaceFileTarget) => {
      const abs = resolveWorkspacePath(options);
      try {
        const r = await bridge.readFile(abs);
        return { ok: true as const, path: abs, content: r.content, size: r.content.length, truncated: r.truncated };
      } catch (err) {
        return { ok: false as const, message: message(err) };
      }
    },
    writeWorkspaceFile: async (payload) => {
      const abs = resolveWorkspacePath(payload);
      try {
        await bridge.writeFile(abs, payload.content);
        return { ok: true as const, path: abs, savedAt: new Date().toISOString() };
      } catch (err) {
        return { ok: false as const, message: message(err) };
      }
    },
    readWorkspaceImage: async (options: WorkspaceFileTarget) => {
      const abs = resolveWorkspacePath(options);
      try {
        // imageReadAny 带 realpath/扩展名/体积硬防护；旧壳无此能力时降级失败。
        const r = await bridge.imageReadAny?.(abs);
        if (!r) return { ok: false as const, message: "imageReadAny unavailable" };
        const mimeType = r.dataUrl.slice(5, r.dataUrl.indexOf(";")) || "image/png";
        return { ok: true as const, path: abs, dataUrl: r.dataUrl, mimeType, size: r.dataUrl.length };
      } catch (err) {
        return { ok: false as const, message: message(err) };
      }
    },
    createWorkspaceDirectory: async (payload) => {
      const abs = resolveWorkspacePath(payload);
      try {
        if (!bridge.mkdir) return { ok: false as const, message: "mkdir unavailable" };
        await bridge.mkdir(abs);
        return { ok: true as const, path: abs, createdAt: new Date().toISOString() };
      } catch (err) {
        return { ok: false as const, message: message(err) };
      }
    },
    listWorkspaceDirectory: async (options: WorkspaceDirectoryTarget) => {
      const abs = resolveWorkspacePath(options);
      try {
        // 复用 scanDirTree（递归树），只取第一层子节点作为浅层列表。
        // 设计目录层级浅（docId/artifactId 两层），全树扫描成本可接受；实测慢再加浅层 IPC。
        const tree = await bridge.scanDirTree(abs);
        const entries: WorkspaceEntry[] = (tree.children ?? []).map((node) => ({
          name: node.name,
          path: node.path,
          type: node.kind === "dir" ? ("directory" as const) : ("file" as const),
          ext: node.kind === "dir" ? "" : extOf(node.name),
        }));
        return { ok: true as const, root: abs, entries };
      } catch (err) {
        return { ok: false as const, message: message(err) };
      }
    },
    deleteWorkspaceEntry: async (payload) => {
      const abs = resolveWorkspacePath(payload);
      try {
        if (!bridge.deleteEntry) return { ok: false as const, message: "deleteEntry unavailable" };
        await bridge.deleteEntry(abs);
        return { ok: true as const, path: abs, deletedAt: new Date().toISOString() };
      } catch (err) {
        return { ok: false as const, message: message(err) };
      }
    },
    // —— 以下三项 cortex 暂无对等桥接：显式降级，调用点（画布图片导入/粘贴）会隐藏或提示 ——
    saveWorkspaceClipboardImage: async () => ({ ok: false as const, message: "clipboard image not supported yet" }),
    readClipboardImage: async () => ({ ok: false as const, message: "clipboard image not supported yet" }),
    saveWorkspaceImageBytes: async () => ({ ok: false as const, message: "image bytes save not supported yet" }),
    pickWorkspaceImage: async () => ({ ok: false as const, message: "image picker not supported yet" }),
    authorizeWritePrototype: async (payload) => {
      const abs = resolveWorkspacePath(payload);
      try {
        const fileUrl = await bridge.browserResolveLocalHtml?.(abs);
        if (!fileUrl) {
          // resolveLocalHtml 把「文件不存在」与「不在允许根」统一吞成 null;这里补一次
          // 存在性探测把两种失败区分开 —— 'prototype file not found' 是 PreviewHost
          // 等待-重试分支的哨兵串(文件由主进程异步创建的场景必须可重试,如 bento deck
          // 刚建档时的授权竞态),真正的越权才落 'local html not authorized' 硬错误。
          const exists = await probeFileExists(bridge, abs);
          return {
            ok: false as const,
            message: exists ? "local html not authorized" : "prototype file not found",
          };
        }
        return { ok: true as const, absolutePath: abs, fileUrl };
      } catch (err) {
        return { ok: false as const, message: message(err) };
      }
    },
    // —— 实时刷新的按文件监听（用 cortex watchDir + readFile 实现）——
    watchWorkspaceFile: async (payload: WorkspaceFileWatchPayload): Promise<WorkspaceFileWatchResult> => {
      const abs = resolveWorkspacePath(payload);
      if (!bridge.watchDir || !bridge.onDirChanged) {
        return { ok: false as const, message: "directory watch unavailable" };
      }
      try {
        const initial = await bridge.readFile(abs).catch(() => ({ content: "", truncated: false }));
        const watchId = `designwatch-${(watchSeq += 1)}`;
        ensureDirChangedSubscription(bridge);
        await bridge.watchDir(watchId, dirOf(abs));
        fileWatches.set(watchId, {
          watchId,
          absPath: abs,
          workspaceRoot: payload.workspaceRoot,
          relPath: payload.path,
          lastContent: initial.content,
        });
        return {
          ok: true as const,
          watchId,
          path: payload.path,
          content: initial.content,
          size: initial.content.length,
          truncated: initial.truncated,
          startedAt: new Date().toISOString(),
        };
      } catch (err) {
        return { ok: false as const, message: message(err) };
      }
    },
    unwatchWorkspaceFile: async (watchId: string): Promise<boolean> => {
      const w = fileWatches.get(watchId);
      if (!w) return false;
      fileWatches.delete(watchId);
      bridge.unwatchDir?.(watchId);
      return true;
    },
    onWorkspaceFileChanged: (handler: (payload: WorkspaceFileChangePayload) => void): (() => void) => {
      changeHandlers.add(handler);
      return () => changeHandlers.delete(handler);
    },
  };
}

let installedFor: DesktopBridge | null = null;

// 一次性装配（幂等：同一 bridge 重复调用直接跳过）。
// storage 缺省为 null → browser-storage 用内存 Map；批5/6 由宿主传入
// PersistedState.designUi 分片适配的 BrowserStorageLike 获得跨重启持久化。
export function installDesignPlatform(
  bridge: DesktopBridge | null | undefined,
  storage?: BrowserStorageLike | null,
): void {
  if (!bridge) return;
  if (installedFor !== bridge) {
    setCortexGuiPort(createBridgeCortexGuiPort(bridge));
    installedFor = bridge;
  }
  if (storage !== undefined) setDesignStorage(storage ?? null);
}
