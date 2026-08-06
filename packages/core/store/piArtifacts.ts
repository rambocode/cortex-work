// pi 会话产物（artifacts 工具,pi-web-ui 移植）的渲染端状态（Zustand,仅 core）。
//
// 数据流:worker 内 artifacts 工具执行 → PiSessionEvent{type:"artifact"}（全量快照,契约见
// core/desktop/types.ts）→ personal/messages.ts 的 handlePiEvent 调 applyEvent → 本 store。
// 本 store 是 worker 闭包 Map 的**同构副本**:两端生命周期一致（应用运行期间的 UI 会话）,
// 重启后两端都为空,自洽。命名一律 PiArtifact 前缀——与既有 rightView:"artifact"
// （设计稿/演示文稿的落盘型产物,见 artifactDispatch.ts）是两个概念,勿混用。
//
// ⚠️ 渲染层不做字符串替换:update 事件必带应用后的全量 content（worker 侧已应用 old_str/new_str）。
// reducer 因此天然幂等——同一事件序列 apply 两遍终态一致,为将来接入会话恢复重放留余地。

import { create } from "zustand";
import type { PiSessionEvent } from "../desktop/types";

/** artifact 事件（PiSessionEvent 的 artifact 变体收窄）。 */
export type PiArtifactEvent = Extract<PiSessionEvent, { type: "artifact" }>;

/** 按扩展名归类的渲染形态（面板据此选择视图组件）。 */
export type PiArtifactKind = "html" | "svg" | "markdown" | "text";

/** 单个产物。version 从 1 起,每次 create/update 自增（面板 v{n} 徽标与 iframe 重挂 key）。 */
export interface PiArtifact {
  filename: string;
  content: string;
  kind: PiArtifactKind;
  version: number;
  createdAt: number;
  updatedAt: number;
}

/** 单个 UI 会话的产物集。order 记创建顺序,保证 pill 排序稳定不随更新跳动。 */
export interface PiArtifactSessionState {
  byName: Record<string, PiArtifact>;
  order: string[];
  activeFilename?: string;
}

/** 「请求打开产物面板」信号:nonce 自增驱动 views 层 effect（仿 browser 面板的 openReq 判例）。 */
export interface PiArtifactOpenRequest {
  sessionId: string;
  filename?: string;
  nonce: number;
}

/** 扩展名 → 渲染形态。未知扩展名一律按纯文本兜底展示。 */
export function piArtifactKind(filename: string): PiArtifactKind {
  const ext = filename.toLowerCase().split(".").pop() ?? "";
  if (ext === "html" || ext === "htm") return "html";
  if (ext === "svg") return "svg";
  if (ext === "md" || ext === "markdown") return "markdown";
  return "text";
}

/**
 * 纯 reducer:把一个 artifact 事件应用到会话产物集上,返回新状态（原状态不变）。
 * 幂等性约束:content 是全量快照,重复 apply 只会让 version 多走一格,内容终态不变——
 * version 仅用于展示与 iframe 重挂,不参与内容语义,可接受。
 * now 由调用方注入（store 层传 Date.now）,保持本函数纯粹可测。
 */
export function applyPiArtifactEvent(
  state: PiArtifactSessionState | undefined,
  ev: PiArtifactEvent,
  now: number,
): PiArtifactSessionState {
  const cur: PiArtifactSessionState = state ?? { byName: {}, order: [] };
  if (ev.action === "delete") {
    if (!cur.byName[ev.filename]) return cur;
    const byName = { ...cur.byName };
    delete byName[ev.filename];
    const order = cur.order.filter((f) => f !== ev.filename);
    const next: PiArtifactSessionState = { byName, order };
    // 删的是当前激活项 → 落到最后一个仍存在的产物（无则清空激活态）。
    const active = cur.activeFilename === ev.filename ? order[order.length - 1] : cur.activeFilename;
    if (active) next.activeFilename = active;
    return next;
  }
  // create/update 缺 content 属协议漂移（mapPiEvent 已挡),防御性忽略,不产出半截产物。
  if (typeof ev.content !== "string") return cur;
  const prev = cur.byName[ev.filename];
  const record: PiArtifact = prev
    ? { ...prev, content: ev.content, version: prev.version + 1, updatedAt: now }
    : {
        filename: ev.filename,
        content: ev.content,
        kind: piArtifactKind(ev.filename),
        version: 1,
        createdAt: now,
        updatedAt: now,
      };
  const next: PiArtifactSessionState = {
    byName: { ...cur.byName, [ev.filename]: record },
    order: prev ? cur.order : [...cur.order, ev.filename],
  };
  if (cur.activeFilename) next.activeFilename = cur.activeFilename;
  return next;
}

export interface PiArtifactsStore {
  /** 按 uiSessionId 命名空间的产物集（workspace 串场防护靠会话 id 隔离）。 */
  sessions: Record<string, PiArtifactSessionState>;
  /** 「打开面板」请求信号。views 层（PersonalWorkspace）订阅 nonce 消费。 */
  openReq?: PiArtifactOpenRequest;
  /** 事件入口（messages.ts 的 handlePiEvent 调用）。 */
  applyEvent: (sessionId: string, ev: PiArtifactEvent) => void;
  /** 请求打开面板并定位到 filename（artifact 事件与步骤卡片点击共用）。 */
  requestOpen: (sessionId: string, filename?: string) => void;
  /** 面板内切换激活产物。 */
  setActive: (sessionId: string, filename: string) => void;
  /** 会话删除时清理（pi crashed 不清——重开会话可续用渲染端副本对照恢复）。 */
  clearSession: (sessionId: string) => void;
}

export const usePiArtifactsStore = create<PiArtifactsStore>((set) => ({
  sessions: {},
  applyEvent: (sessionId, ev) =>
    set((s) => ({
      sessions: { ...s.sessions, [sessionId]: applyPiArtifactEvent(s.sessions[sessionId], ev, Date.now()) },
    })),
  requestOpen: (sessionId, filename) =>
    set((s) => {
      const cur = s.sessions[sessionId];
      const openReq: PiArtifactOpenRequest = {
        sessionId,
        ...(filename ? { filename } : {}),
        nonce: (s.openReq?.nonce ?? 0) + 1,
      };
      // 顺带把目标产物置为激活项（面板打开即显示目标,不用二跳）。
      if (filename && cur?.byName[filename]) {
        return { openReq, sessions: { ...s.sessions, [sessionId]: { ...cur, activeFilename: filename } } };
      }
      return { openReq };
    }),
  setActive: (sessionId, filename) =>
    set((s) => {
      const cur = s.sessions[sessionId];
      if (!cur?.byName[filename]) return {};
      return { sessions: { ...s.sessions, [sessionId]: { ...cur, activeFilename: filename } } };
    }),
  clearSession: (sessionId) =>
    set((s) => {
      if (!s.sessions[sessionId]) return {};
      const sessions = { ...s.sessions };
      delete sessions[sessionId];
      return { sessions };
    }),
}));
