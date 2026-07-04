// 设计工作台的平台装配层：把 cortex 的 DesktopBridge 适配成 design 树所需的
// 注入式端口（kunGuiPort 文件系统能力 + browserStorage UI 态持久化）。
// 宿主（DesignWorkspaceView 挂载时）调用 installDesignPlatform() 一次性装配；
// web 端 bridge 为 null 时不装配，design 树各调用点经可选链自然降级。
import type { DesktopBridge } from "../../desktop/bridge";
import { setDesignStorage, type BrowserStorageLike } from "../compat/browser-storage";
import { setKunGuiPort, type KunGuiPort } from "../compat/kun-gui-port";
import type {
  WorkspaceDirectoryTarget,
  WorkspaceEntry,
  WorkspaceFileTarget,
} from "../compat/workspace-file";

// Kun 的 workspace 语义：path 可以是绝对路径，也可以是相对 workspaceRoot 的相对路径。
function resolveWorkspacePath(target: { path?: string; workspaceRoot?: string }): string {
  const path = target.path ?? "";
  if (path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path)) return path;
  const root = (target.workspaceRoot ?? "").replace(/\/+$/, "");
  if (!root) return path;
  return path ? `${root}/${path.replace(/^\/+/, "")}` : root;
}

function extOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// 把 DesktopBridge 装配成 KunGuiPort。剪贴板/图片挑选三项 cortex 暂无对等桥接，
// 返回 ok:false 让画布图片导入路径优雅降级（后续需要时再补 IPC）。
export function createBridgeKunGuiPort(bridge: DesktopBridge): KunGuiPort {
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
        if (!fileUrl) return { ok: false as const, message: "local html not authorized" };
        return { ok: true as const, absolutePath: abs, fileUrl };
      } catch (err) {
        return { ok: false as const, message: message(err) };
      }
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
    setKunGuiPort(createBridgeKunGuiPort(bridge));
    installedFor = bridge;
  }
  if (storage !== undefined) setDesignStorage(storage ?? null);
}
