import type { CanvasFilePort } from "@cortex-work/core/design/canvas/canvas-file-port";
import type { DesktopBridge } from "@cortex-work/core";

const ABSOLUTE_PATH_RE = /^(\/|[A-Za-z]:[\\/]|\\\\)/;

/**
 * 将画布内部的工作区相对路径解析为桌面桥接受的绝对路径。
 *
 * 画布持久化路径由 Cortex 自己生成；仍在此拒绝 `..`，防止未来调用方把文件端口当成任意
 * 路径拼接器。绝对路径只允许图片读取使用，文档读写始终被约束在 `workspaceRoot` 下。
 */
function resolveWorkspacePath(workspaceRoot: string, relativePath: string): string | null {
  const root = workspaceRoot.trim().replace(/[\\/]+$/, "");
  const path = relativePath.trim().replace(/\\/g, "/").replace(/^\/+/, "");
  if (!root || !path || path.split("/").includes("..")) return null;
  return `${root}/${path}`;
}

/**
 * 用 Cortex DesktopBridge 实现会话白板需要的最小文件能力。
 *
 * 返回值中的失败均按画布持久化契约降级为 `null`/`false`，由画布保留内存态并继续工作；
 * 这里不安装或调用任何 Kun 全局端口。
 */
export function createWhiteboardFilePort(bridge: DesktopBridge | null): CanvasFilePort | null {
  if (!bridge) return null;

  return {
    async readText(workspaceRoot, relativePath) {
      const path = resolveWorkspacePath(workspaceRoot, relativePath);
      if (!path) return null;
      try {
        return (await bridge.readFile(path)).content;
      } catch {
        return null;
      }
    },
    async writeText(workspaceRoot, relativePath, content) {
      const path = resolveWorkspacePath(workspaceRoot, relativePath);
      if (!path) return false;
      try {
        await bridge.writeFile(path, content);
        return true;
      } catch {
        return false;
      }
    },
    async readImageDataUrl(workspaceRoot, imagePath) {
      if (!bridge.imageReadAny) return null;
      const trimmedPath = imagePath.trim();
      const path = ABSOLUTE_PATH_RE.test(trimmedPath)
        ? trimmedPath
        : resolveWorkspacePath(workspaceRoot, trimmedPath);
      if (!path) return null;
      try {
        return (await bridge.imageReadAny(path)).dataUrl;
      } catch {
        return null;
      }
    },
  };
}
