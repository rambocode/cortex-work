import { dayKey, type DesktopBridge, type SessionMeta } from "@cortex-work/core";

/**
 * 解析会话白板的持久化根目录。
 *
 * 新会话直接使用项目路径或创建时保存的 `noProjectDir`。旧无项目会话可能没有该字段，
 * 此时经桌面桥补建创建日目录并回写会话，使画布 UI、Agent cwd 与后续重启使用同一位置。
 * 项目会话若项目记录已经丢失则返回空串，不能悄悄把项目白板迁到无项目目录。
 */
export async function ensureWhiteboardWorkspaceRoot(options: {
  session: SessionMeta;
  workspaceRoot: string | null | undefined;
  bridge: DesktopBridge | null;
  updateSession: (sessionId: string, patch: Partial<SessionMeta>) => void;
}): Promise<string> {
  // 右栏的 project 映射可能比 store 回写晚一个 render；直接读取 session.noProjectDir 可避免
  // 旧会话补目录后再次创建并触发无效的状态更新循环。
  const existing = options.workspaceRoot?.trim() || options.session.noProjectDir?.trim();
  if (existing) return existing;
  if (options.session.projectId || !options.bridge?.ensureNoProjectDir) return "";

  try {
    const createdAt = Number.isFinite(options.session.createdAt) ? options.session.createdAt : Date.now();
    const root = (await options.bridge.ensureNoProjectDir(dayKey(createdAt))).trim();
    if (!root) return "";
    options.updateSession(options.session.id, { noProjectDir: root });
    return root;
  } catch {
    // 路径创建失败时保持白板不可写，调用方显示不可用态；不能退到进程 cwd 污染程序目录。
    return "";
  }
}
