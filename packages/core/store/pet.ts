// 桌面宠物的展示态（Zustand,仅 core）。
//
// 这里只存「该显示什么」,不含任何判定逻辑:`state` 的唯一写入方是 core/pet 的状态机
// (由事件产生方窗口的 PetBridge 启动),桌面 overlay 窗口则由 pet:sync-state 广播写入。
// 业务侧要报告「发生了什么」请用 core/pet 的 petActivity,不要直接改这里的 state——
// 绕过状态机写入会被下一次派生覆盖,且拿不到去抖与自动回落。

import { create } from "zustand";
import type { PetSpriteSource } from "../desktop/petdex-types";

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
  /** 当前该渲染哪张 sprite。null = 还没解析出来,按 kind 用内置角色兜底。 */
  sprite: PetSpriteSource | null;
  setKind: (k: PetKind) => void;
  setSprite: (sprite: PetSpriteSource | null) => void;
  setEnabled: (enabled: boolean) => void;
  setSize: (size: number) => void;
}

export const usePetStore = create<PetStore>((set) => ({
  state: "idle",
  kind: "cat",
  enabled: true,
  size: 1,
  sprite: null,
  setKind: (k) => set({ kind: k }),
  setSprite: (sprite) => set({ sprite }),
  setEnabled: (enabled) => set({ enabled }),
  setSize: (size) => set({ size }),
}));
