// 桌面宠物状态机（Zustand,仅 core）。各处只负责「报告发生了什么」,
// 衰减类转换（typing→idle、idle→sleeping、happy→idle）由 Pet 组件的节拍器驱动。

import { create } from "zustand";

export type PetState =
  | "idle" // 闲置:呼吸/眨眼/甩尾
  | "typing" // 用户正在输入
  | "thinking" // 已发送,等待 LLM 首个输出
  | "working" // LLM 正在调用工具
  | "replying" // LLM 正在流式回复
  | "sleeping" // 长时间无活动
  | "happy"; // 被点击/任务完成的瞬时开心

// 宠物造型（设置菜单中选择;持久化由 views 层 localStorage 负责）。
export type PetKind = "cat" | "shiba" | "bunny" | "robot";

export interface PetStore {
  state: PetState;
  kind: PetKind;
  lastActivity: number;
  set: (s: PetState) => void;
  setKind: (k: PetKind) => void;
}

export const usePetStore = create<PetStore>((set) => ({
  state: "idle",
  kind: "cat",
  lastActivity: Date.now(),
  set: (s) => set({ state: s, lastActivity: Date.now() }),
  setKind: (k) => set({ kind: k }),
}));
