// 快捷回复助手（reply）客户端态 Zustand store（U5/KTD6）。
//
// 为何独立文件：store/personal.ts 已逼近 1200 行硬上限，禁止再塞；reply 三分片
// （设置 / 分区记忆 / 渠道）自成一域，仿 store/pet.ts、store/ui.ts 建独立 store。
// 持久化由 desktop/usePersonalPersistence.ts 订阅本 store 并合并进 PersistedState 序列化。

import { create } from "zustand";
import type {
  PersistedState,
  ReplySettings,
  ReplyMemoryState,
  ReplyChannelsState,
  ReplyChannelCredential,
} from "../desktop/types";
import { DEFAULT_REPLY_SETTINGS, DEFAULT_REPLY_CHANNELS } from "../desktop/types";
import type { MemoryScope, MemoryFile } from "../reply/memory";
import { emptyMemoryState } from "../reply/memory";
import type { ChannelId, ChannelConnectionState } from "../reply/channels";

/// 从 PersistedState 中读取的三分片子集（hydrate 入参）。全部可选：旧档/缺失时回落默认。
type ReplyPersisted = Pick<PersistedState, "replySettings" | "replyMemory" | "replyChannels">;

export interface ReplyStore {
  /// 是否已从磁盘 hydrate；未 hydrate 前不触发保存，避免空态覆盖磁盘。
  hydrated: boolean;
  settings: ReplySettings;
  memory: ReplyMemoryState;
  channels: ReplyChannelsState;

  /// 从 PersistedState 装填（缺失/半缺分片补空默认，往返安全）。
  hydrateReply: (s: ReplyPersisted) => void;
  /// 合并式更新设置（触发键 / 学习开关 / 档案）。
  setSettings: (patch: Partial<ReplySettings>) => void;
  /// 写入某分区的手写区或自动区（其余分区不动，修复源项目自动区共用变量的缺陷）。
  setMemoryFile: (scope: MemoryScope, patch: Partial<MemoryFile>) => void;
  /// 清空全部记忆（手写 + 自动，数据清理用）。
  clearAllMemory: () => void;
  /// 只清全部分区的自动学习要点，保留手写笔记（数据清理「清空学习要点」）。
  clearAutoRules: () => void;
  /// 渠道连接态流转：校验成功后写入身份/连接时间。
  setChannelConnection: (id: ChannelId, connection: ChannelConnectionState) => void;
  /// 写入渠道加密凭据密文（main 侧 safeStorage 加密后回传）。
  setChannelCredential: (id: ChannelId, credential: ReplyChannelCredential) => void;
  /// 断开渠道：同时清连接态与凭据密文（备注保留）。
  disconnectChannel: (id: ChannelId) => void;
  /// 设置某渠道备注。
  setChannelNote: (id: ChannelId, note: string) => void;
  /// 清空全部渠道备注（数据清理）。
  clearChannelNotes: () => void;
}

// 记忆分片兜底合并：先铺满 5 分区空默认，再覆盖已有分区，处理「半缺分片」（某些 scope 缺失）不抛。
function mergeMemory(memory: ReplyMemoryState | undefined): ReplyMemoryState {
  const base = emptyMemoryState();
  if (!memory) return base;
  return { ...base, ...memory };
}

// 渠道分片兜底合并：三个子表各自缺失时补空对象。
function mergeChannels(channels: ReplyChannelsState | undefined): ReplyChannelsState {
  if (!channels) return { connections: {}, credentials: {}, notes: {} };
  return {
    connections: channels.connections ?? {},
    credentials: channels.credentials ?? {},
    notes: channels.notes ?? {},
  };
}

export const useReplyStore = create<ReplyStore>((set) => ({
  hydrated: false,
  settings: DEFAULT_REPLY_SETTINGS,
  memory: emptyMemoryState(),
  channels: DEFAULT_REPLY_CHANNELS,

  hydrateReply: (s) =>
    set({
      hydrated: true,
      settings: s.replySettings ?? DEFAULT_REPLY_SETTINGS,
      memory: mergeMemory(s.replyMemory),
      channels: mergeChannels(s.replyChannels),
    }),

  setSettings: (patch) => set((state) => ({ settings: { ...state.settings, ...patch } })),

  setMemoryFile: (scope, patch) =>
    set((state) => ({
      memory: { ...state.memory, [scope]: { ...state.memory[scope], ...patch } },
    })),

  clearAllMemory: () => set({ memory: emptyMemoryState() }),

  // 逐分区保留 manual、清空 auto —— 用新对象重建，保证引用变化触发持久化订阅。
  clearAutoRules: () =>
    set((state) => {
      const next = emptyMemoryState();
      for (const scope of Object.keys(next) as MemoryScope[]) {
        next[scope] = { manual: state.memory[scope].manual, auto: "" };
      }
      return { memory: next };
    }),

  setChannelConnection: (id, connection) =>
    set((state) => ({
      channels: { ...state.channels, connections: { ...state.channels.connections, [id]: connection } },
    })),

  setChannelCredential: (id, credential) =>
    set((state) => ({
      channels: { ...state.channels, credentials: { ...state.channels.credentials, [id]: credential } },
    })),

  // 断开：从 connections/credentials 删该 id（备注不清，便于重连后沿用）。
  disconnectChannel: (id) =>
    set((state) => {
      const connections = { ...state.channels.connections };
      const credentials = { ...state.channels.credentials };
      delete connections[id];
      delete credentials[id];
      return { channels: { ...state.channels, connections, credentials } };
    }),

  setChannelNote: (id, note) =>
    set((state) => ({
      channels: { ...state.channels, notes: { ...state.channels.notes, [id]: note } },
    })),

  clearChannelNotes: () => set((state) => ({ channels: { ...state.channels, notes: {} } })),
}));

// ── 持久化辅助（纯函数，供 usePersonalPersistence 合并序列化与节流判定）──────────────

/// 把 reply store 三分片投影为 PersistedState 子集（合并进整体序列化）。
export function replyToPersisted(s: ReplyStore): ReplyPersisted {
  return { replySettings: s.settings, replyMemory: s.memory, replyChannels: s.channels };
}

/// reply 分片的保存紧迫度：三分片均为节流（无 fs 白名单类即时落盘需求）。
/// 未 hydrate 或无分片引用变化时返回 none。
export function replySaveUrgency(s: ReplyStore, prev: ReplyStore): "none" | "throttled" {
  if (!s.hydrated) return "none";
  if (s.settings !== prev.settings || s.memory !== prev.memory || s.channels !== prev.channels) {
    return "throttled";
  }
  return "none";
}
