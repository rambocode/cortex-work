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
export type PetKind = "cat" | "dog" | "mint";

// 行为模式:free 自由放置(可拖动;可叠加「闲时底部走动」开关) / perch 趴在输入框上。
export type PetMode = "free" | "perch";

export interface PetStore {
  state: PetState;
  kind: PetKind;
  /** 行为模式(持久化由 views 层负责)。 */
  mode: PetMode;
  /** 自由放置下的「闲时底部走动」开关(持久化由 views 层负责)。 */
  walk: boolean;
  /** 是否显示宠物(✕ 关闭后为 false;持久化由 views 层负责)。 */
  enabled: boolean;
  /** 显示缩放(1 = 默认,范围约 0.8–2;持久化由 views 层负责)。 */
  size: number;
  /** 自定义主色(hex);null 表示使用造型默认配色。 */
  color: string | null;
  lastActivity: number;
  set: (s: PetState) => void;
  /** 切状态但不刷新 lastActivity(走动唤醒等"非用户事件"用,避免重置安静计时)。 */
  wake: () => void;
  setKind: (k: PetKind) => void;
  setMode: (m: PetMode) => void;
  setWalk: (walk: boolean) => void;
  setEnabled: (enabled: boolean) => void;
  setSize: (size: number) => void;
  setColor: (color: string | null) => void;
}

export const usePetStore = create<PetStore>((set) => ({
  state: "idle",
  kind: "cat",
  mode: "free",
  walk: false,
  enabled: true,
  size: 1,
  color: null,
  lastActivity: Date.now(),
  set: (s) => set({ state: s, lastActivity: Date.now() }),
  wake: () => set({ state: "idle" }),
  setKind: (k) => set({ kind: k }),
  setMode: (mode) => set({ mode }),
  setWalk: (walk) => set({ walk }),
  setEnabled: (enabled) => set({ enabled }),
  setSize: (size) => set({ size }),
  setColor: (color) => set({ color }),
}));
