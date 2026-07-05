// window.kunGui 的注入式端口：core 禁止直接触碰 window 全局与平台 API，
// design 树内所有原 window.kunGui.* 调用已被 codemod 改写为经此端口。
// 宿主（views/app 壳）在挂载设计工作台前调用 setKunGuiPort() 注入
// DesktopBridge 适配实现（批2/批7 提供）；web 端不注入 → 功能自动降级。
import type {
  ClipboardImageReadResult,
  WorkspaceDirectoryCreatePayload,
  WorkspaceDirectoryCreateResult,
  WorkspaceDirectoryListResult,
  WorkspaceDirectoryTarget,
  WorkspaceEntryDeletePayload,
  WorkspaceEntryDeleteResult,
  WorkspaceClipboardImageSavePayload,
  WorkspaceClipboardImageSaveResult,
  WorkspaceFileChangePayload,
  WorkspaceFileReadResult,
  WorkspaceFileTarget,
  WorkspaceFileWatchPayload,
  WorkspaceFileWatchResult,
  WorkspaceFileWritePayload,
  WorkspaceFileWriteResult,
  WorkspaceImageBytesSavePayload,
  WorkspaceImageBytesSaveResult,
  WorkspaceImagePickPayload,
  WorkspaceImagePickResult,
  WorkspaceImageReadResult,
} from "./workspace-file";

// design 树实际消费的 kunGui 能力子集（签名与 Kun kun-gui-api 保持一致）。
export interface KunGuiPort {
  homeDir?: string;
  // 运行平台标识("darwin"/"win32"/"linux");路径默认值推导用,未注入时按非 linux 处理。
  platform?: string;
  readWorkspaceFile: (options: WorkspaceFileTarget) => Promise<WorkspaceFileReadResult>;
  writeWorkspaceFile: (payload: WorkspaceFileWritePayload) => Promise<WorkspaceFileWriteResult>;
  readWorkspaceImage: (options: WorkspaceFileTarget) => Promise<WorkspaceImageReadResult>;
  createWorkspaceDirectory: (
    payload: WorkspaceDirectoryCreatePayload,
  ) => Promise<WorkspaceDirectoryCreateResult>;
  listWorkspaceDirectory: (options: WorkspaceDirectoryTarget) => Promise<WorkspaceDirectoryListResult>;
  deleteWorkspaceEntry: (payload: WorkspaceEntryDeletePayload) => Promise<WorkspaceEntryDeleteResult>;
  saveWorkspaceClipboardImage: (
    payload: WorkspaceClipboardImageSavePayload,
  ) => Promise<WorkspaceClipboardImageSaveResult>;
  readClipboardImage: () => Promise<ClipboardImageReadResult>;
  saveWorkspaceImageBytes: (
    payload: WorkspaceImageBytesSavePayload,
  ) => Promise<WorkspaceImageBytesSaveResult>;
  pickWorkspaceImage: (payload: WorkspaceImagePickPayload) => Promise<WorkspaceImagePickResult>;
  // 授权本地 HTML 以内嵌预览（cortex 侧由 browserResolveLocalHtml 适配）。
  authorizeWritePrototype: (payload: {
    path: string;
    workspaceRoot: string;
  }) => Promise<{ ok: true; absolutePath: string; fileUrl: string } | { ok: false; message: string }>;
  // 实时刷新的按文件监听（可选：宿主 bridge 无目录监听时不装配 → design 回退到仅终态刷新）。
  watchWorkspaceFile?: (payload: WorkspaceFileWatchPayload) => Promise<WorkspaceFileWatchResult>;
  unwatchWorkspaceFile?: (watchId: string) => Promise<boolean>;
  onWorkspaceFileChanged?: (handler: (payload: WorkspaceFileChangePayload) => void) => () => void;
}

let installed: KunGuiPort | null = null;

// 宿主注入实现；传 null 卸载（测试用）。
export function setKunGuiPort(port: KunGuiPort | null): void {
  installed = port;
}

// 可选获取：对应原 window.kunGui?.xxx 调用（未注入时返回 undefined，调用点自然短路）。
export function kunGuiPort(): KunGuiPort | undefined {
  return installed ?? undefined;
}

// 必选获取：对应原 window.kunGui.xxx 调用（Kun 里未注入会直接 TypeError，此处显式抛错更可诊断）。
export function requireKunGui(): KunGuiPort {
  if (!installed) {
    throw new Error("design kunGuiPort 未注入：请先经 setKunGuiPort() 安装桌面桥接实现");
  }
  return installed;
}
