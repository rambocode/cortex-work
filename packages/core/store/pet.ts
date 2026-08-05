// 桌面宠物状态机（Zustand,仅 core）。各处只负责「报告发生了什么」,
// 衰减类转换（typing→idle、idle→sleeping、happy→idle）由 Pet 组件的节拍器驱动。

import { create } from "zustand";

export type PetState =
  | "idle" // 闲置:呼吸/眨眼/甩尾
  | "typing" // 用户正在输入
  | "thinking" // 已发送,等待 LLM 首个输出
  | "working" // LLM 正在调用工具
  | "replying" // LLM 正在流式回复
  | "waiting" // 有挂起的审批/确认,等用户点一下
  | "sleeping" // 长时间无活动
  | "happy" // 被点击/任务完成的瞬时开心
  | "failed"; // 本轮运行失败的瞬时反馈

// 宠物造型（设置菜单中选择;持久化由 views 层 localStorage 负责）。
export type PetKind = "cat" | "dog" | "mint";

export interface PetStore {
  state: PetState;
  kind: PetKind;
  /** 是否显示宠物(✕ 关闭后为 false;持久化由 views 层负责)。 */
  enabled: boolean;
  /** 显示缩放(1 = 默认,范围约 0.8–2;持久化由 views 层负责)。 */
  size: number;
  lastActivity: number;
  set: (s: PetState) => void;
  /** 切状态但不刷新 lastActivity(非用户事件用,避免重置安静计时)。 */
  wake: () => void;
  setKind: (k: PetKind) => void;
  setEnabled: (enabled: boolean) => void;
  setSize: (size: number) => void;
}

export const usePetStore = create<PetStore>((set) => ({
  state: "idle",
  kind: "cat",
  enabled: true,
  size: 1,
  lastActivity: Date.now(),
  set: (s) => set({ state: s, lastActivity: Date.now() }),
  wake: () => set({ state: "idle" }),
  setKind: (k) => set({ kind: k }),
  setEnabled: (enabled) => set({ enabled }),
  setSize: (size) => set({ size }),
}));
