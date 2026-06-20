// Client-only UI state for Cortex Desktop (Zustand). Per floder.md, all
// client/UI state lives here — never server data (that stays in React Query).

import { create } from "zustand";
import type { Density, Palette, SidebarMode, Toast, ToastKind, Tweaks } from "../types";
import { DEFAULT_LOCALE } from "../i18n/locales";

// Which page fills the main content area. "chat" is the default IM view; the
// others are top-level sections reached from the sidebar nav.
export type Section = "chat" | "tasks" | "agents" | "usage" | "settings";

// 顶层工作区：团队（现有 IM 形态）/ 个人（本地项目 + CLI agent，仅桌面端）。
export type WorkspaceKind = "team" | "personal";

export interface CortexUIState {
  workspace: WorkspaceKind;
  currentOrgId: string;
  activeSection: Section;
  activeContactId: string;
  activeFile: string;
  search: string;
  rightOpen: boolean;
  // 个人工作区左栏折叠态（隐藏项目/会话菜单,给中栏让位）。
  leftCollapsed: boolean;
  // 会话搜索弹窗开关。
  sessionSearchOpen: boolean;
  openTabs: string[];
  tweaks: Tweaks;
  toasts: Toast[];

  setWorkspace: (w: WorkspaceKind) => void;
  setCurrentOrg: (id: string) => void;
  setSection: (section: Section) => void;
  setActiveContact: (id: string) => void;
  setActiveFile: (path: string) => void;
  setSearch: (q: string) => void;
  setRightOpen: (open: boolean) => void;
  toggleRight: () => void;
  setLeftCollapsed: (collapsed: boolean) => void;
  toggleLeftCollapsed: () => void;
  setSessionSearchOpen: (open: boolean) => void;
  openFileTab: (path: string) => void;
  closeFileTab: (path: string) => void;
  setTweak: <K extends keyof Tweaks>(key: K, value: Tweaks[K]) => void;
  // 全局通用提醒:text-only 旧签名向后兼容;opts 可携带富内容字段。
  // duration 默认 2400ms,duration:0 表示常驻直到手动关闭。
  pushToast: (
    text: string,
    opts?: {
      kind?: ToastKind;
      duration?: number;
      title?: string;
      description?: string;
      icon?: string;
      dismissible?: boolean;
    },
  ) => void;
  dismissToast: (id: string) => void;
}

// kind → 默认图标名(对应 @cortex-work/ui 的 Icon.*)。调用方可用 opts.icon 覆盖。
const KIND_ICON: Record<ToastKind, string> = {
  info: "Info",
  success: "CheckCircle",
  error: "XCircle",
};

export const DEFAULT_TWEAKS: Tweaks = {
  density: "regular" as Density,
  palette: "clay" as Palette,
  sidebar: "rich" as SidebarMode,
  fontScale: "medium",
  theme: "system",
  language: DEFAULT_LOCALE,
};

let toastSeq = 0;

export const useCortexUIStore = create<CortexUIState>((set) => ({
  workspace: "personal",
  currentOrgId: "dx",
  activeSection: "chat",
  activeContactId: "wangyutong",
  activeFile: "desktop/src/sidebar/ContactList.tsx",
  search: "",
  rightOpen: false,
  leftCollapsed: false,
  sessionSearchOpen: false,
  openTabs: ["desktop/src/sidebar/ContactList.tsx"],
  tweaks: { ...DEFAULT_TWEAKS },
  toasts: [],

  setWorkspace: (w) => set({ workspace: w }),
  setCurrentOrg: (id) => set({ currentOrgId: id }),
  setSection: (section) => set({ activeSection: section }),
  // Selecting a contact always returns to the chat view.
  setActiveContact: (id) => set({ activeContactId: id, activeSection: "chat" }),
  setActiveFile: (path) => set({ activeFile: path }),
  setSearch: (q) => set({ search: q }),
  setRightOpen: (open) => set({ rightOpen: open }),
  toggleRight: () => set((s) => ({ rightOpen: !s.rightOpen })),
  setLeftCollapsed: (collapsed) => set({ leftCollapsed: collapsed }),
  toggleLeftCollapsed: () => set((s) => ({ leftCollapsed: !s.leftCollapsed })),
  setSessionSearchOpen: (open) => set({ sessionSearchOpen: open }),

  openFileTab: (path) =>
    set((s) => (s.openTabs.includes(path) ? { activeFile: path } : { openTabs: [...s.openTabs, path], activeFile: path })),
  closeFileTab: (path) => set((s) => ({ openTabs: s.openTabs.filter((p) => p !== path) })),

  setTweak: (key, value) => set((s) => ({ tweaks: { ...s.tweaks, [key]: value } })),

  pushToast: (text, opts = {}) => {
    toastSeq += 1;
    const id = `toast-${toastSeq}`;
    const kind = opts.kind ?? "info";
    const toast: Toast = {
      id,
      text,
      kind,
      title: opts.title,
      description: opts.description,
      iconName: opts.icon ?? KIND_ICON[kind],
      // 默认显示关闭按钮,贴合图中卡片;调用方可显式关闭。
      dismissible: opts.dismissible ?? true,
      duration: opts.duration,
    };
    set((s) => ({ toasts: [...s.toasts, toast] }));
    // duration:0 表示常驻(需用户手动关闭),不注册自动移除定时器。
    const duration = opts.duration ?? 2400;
    if (duration > 0) {
      setTimeout(() => {
        set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
      }, duration);
    }
  },
  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}));
