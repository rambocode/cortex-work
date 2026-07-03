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
import { emptyMemoryState, MEMORY_SCOPES } from "../reply/memory";
import type { ChannelId, ChannelConnectionState } from "../reply/channels";

/// 从 PersistedState 中读取的分片子集（hydrate 入参）。全部可选：旧档/缺失时回落默认。
/// KTD6 修订：replyMemory 已迁 main-owned memory.json，不再随 PersistedState 往返。
type ReplyPersisted = Pick<PersistedState, "replySettings" | "replyChannels">;

export interface ReplyStore {
  /// 是否已从磁盘 hydrate；未 hydrate 前不触发保存，避免空态覆盖磁盘。
  hydrated: boolean;
  settings: ReplySettings;
  /// 分区记忆的**只读缓存**（KTD6 修订）：真源在 main 侧 memory.json，经 bridge.replyGetMemory
  /// 装填、onReplyMemoryChanged 刷新；本 store 的 memory 变更不触发持久化保存。
  memory: ReplyMemoryState;
  channels: ReplyChannelsState;

  /// 从 PersistedState 装填（缺失/半缺分片补空默认，往返安全）。
  hydrateReply: (s: ReplyPersisted) => void;
  /// 装填/刷新记忆缓存（来源：bridge.replyGetMemory 或 onReplyMemoryChanged 推送）。
  hydrateMemory: (memory: ReplyMemoryState) => void;
  /// 合并式更新设置（触发键 / 学习开关 / 档案）。
  setSettings: (patch: Partial<ReplySettings>) => void;
  /// 写入某分区手写区/自动区的本地缓存（真源写入由设置页同步调 bridge.replySetMemoryFile）。
  setMemoryFile: (scope: MemoryScope, patch: Partial<MemoryFile>) => void;
  /// 清空全部记忆的本地缓存（真源清空由设置页调 bridge.replyClearMemory("all")）。
  clearAllMemory: () => void;
  /// 只清自动学习要点的本地缓存（真源清空由设置页调 bridge.replyClearMemory("auto")）。
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

// 记忆分片兜底合并：逐分区深合并，处理两级「半缺」——
//  1) scope 级缺失（某些分区整块不存在）；
//  2) 字段级半缺（某分区只有 manual 或只有 auto，另一字段为 undefined）。
// 必须做字段级兜底：下游 main 侧 composeUserProfile 对 file.auto/manual 直接 .trim()，
// 若字段为 undefined 会抛 TypeError，故此处保证每个 MemoryFile 的 manual/auto 恒为字符串。
function mergeMemory(memory: ReplyMemoryState | undefined): ReplyMemoryState {
  const base = emptyMemoryState();
  if (!memory) return base;
  for (const scope of MEMORY_SCOPES) {
    const file = memory[scope] as Partial<MemoryFile> | undefined;
    if (file) {
      // 字段级兜底：缺失的 manual/auto 回落空串，保证下游 .trim() 安全。
      base[scope] = {
        manual: file.manual ?? "",
        auto: file.auto ?? "",
      };
    }
  }
  return base;
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
      // 字段级兜底：旧档缺新字段（如后加的 historyEnabled）时回落默认，避免 undefined
      // 被当 false 误关功能。
      settings: { ...DEFAULT_REPLY_SETTINGS, ...s.replySettings },
      channels: mergeChannels(s.replyChannels),
    }),

  // 记忆缓存装填：来自 main 的数据同样过字段级兜底（防旧版 main 推来半缺结构）。
  hydrateMemory: (memory) => set({ memory: mergeMemory(memory) }),

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

/// 把 reply store 持久化分片投影为 PersistedState 子集（合并进整体序列化）。
/// KTD6 修订：memory 是 main-owned 缓存，不入投影（personal-workspace.json 不再写 replyMemory）。
export function replyToPersisted(s: ReplyStore): ReplyPersisted {
  return { replySettings: s.settings, replyChannels: s.channels };
}

/// reply 分片的保存紧迫度：持久化分片均为节流（无 fs 白名单类即时落盘需求）。
/// memory 缓存变化不触发保存（真源在 main）。未 hydrate 或无分片引用变化时返回 none。
export function replySaveUrgency(s: ReplyStore, prev: ReplyStore): "none" | "throttled" {
  if (!s.hydrated) return "none";
  if (s.settings !== prev.settings || s.channels !== prev.channels) {
    return "throttled";
  }
  return "none";
}
