// 分支回复（刷新重新生成）数据层:纯类型 + 纯函数,不碰 React/bridge/store。
//
// 模型:「tail 归档」——主 Message[] 永远是当前 active 分支的内容;每个被刷新过的用户消息
// (anchor)挂一个 BranchGroup,归档分支各自持有「anchor 之后的整段消息尾」+ 底层 agent 会话
// 指针快照。active 变体的 tail/pointer 恒为 null:其内容即主 messages[]、指针即 SessionMeta
// (agentSessionIds / piSessionFile),这样现有 send/resume 管线零改动。
//
// 嵌套分支天然成立:branchGroups 按 session 扁平存,归档 tail 内部的 anchor 组只是「休眠」
// (anchorUid 暂不在主 messages[] 中,不渲染),切回外层分支后 uid 重现即复活。uid 全局唯一保证不串。
//
// 持久化:chat JSON v2 = { version: 2, messages, branchGroups };无分支时仍写裸数组(v1),
// 保证回滚安全与旧档兼容。

import type { Message } from "../types";
import type { AgentKind } from "../desktop/types";

// 底层 agent 会话指针快照:切换分支时与 SessionMeta 交换。
export interface BranchSessionPointer {
  // claude/codex:该分支专属 resume id(定位 CLI 侧磁盘 JSONL);pi 分支不用此字段。
  agentSessionIds?: Partial<Record<AgentKind, string>>;
  // pi:该分支会话文件快照的绝对路径(~/.cortex-desktop/chat-branches/<sessionId>/<branchId>.jsonl)。
  piSessionFile?: string;
  // 该分支是否只读(会话指针快照失败/trim-into-copy 降级时置真):可查看,不可续聊。
  readOnly?: boolean;
}

// 单个分支变体:anchor 用户消息「之后」的整段消息尾(可含后续多轮) + 指针快照。
// active 变体的 tail/pointer 恒为 null(见文件头注释)。
export interface BranchVariant {
  id: string;
  createdAt: number;
  tail: Message[] | null;
  pointer: BranchSessionPointer | null;
}

// 挂在某个用户消息 uid 上的分支组。variants 顺序即分页器「‹ i/n ›」的展示顺序。
export interface BranchGroup {
  anchorUid: string;
  activeId: string;
  variants: BranchVariant[];
}

// chat JSON v2 格式。v1 = 裸 Message[](历史格式,无分支会话仍沿用)。
export interface ChatFileV2 {
  version: 2;
  messages: Message[];
  branchGroups: BranchGroup[];
}
export type LoadedChat = Message[] | ChatFileV2 | null | undefined;

// v2 对象判定:主进程按 unknown 读写,加载侧据此归一。
function isChatFileV2(raw: unknown): raw is ChatFileV2 {
  return (
    typeof raw === "object" &&
    raw !== null &&
    !Array.isArray(raw) &&
    (raw as ChatFileV2).version === 2 &&
    Array.isArray((raw as ChatFileV2).messages)
  );
}

// 加载归一:v1 裸数组 → {messages, branchGroups:[]};v2 → 拆字段;非法/空 → 全空。
export function normalizeLoadedChat(raw: LoadedChat): { messages: Message[]; branchGroups: BranchGroup[] } {
  if (Array.isArray(raw)) return { messages: raw, branchGroups: [] };
  if (isChatFileV2(raw)) {
    return { messages: raw.messages, branchGroups: Array.isArray(raw.branchGroups) ? raw.branchGroups : [] };
  }
  return { messages: [], branchGroups: [] };
}

// anchor 用户消息在 messages 中的下标(找不到返回 -1)。
export function anchorIndex(messages: Message[], anchorUid: string): number {
  return messages.findIndex((m) => m.uid === anchorUid);
}

// 按 anchor 切分:head = anchor 及其之前(含 anchor 本身),tail = anchor 之后的整段。
// anchor 不存在返回 null。
export function splitAtAnchor(messages: Message[], anchorUid: string): { head: Message[]; tail: Message[] } | null {
  const idx = anchorIndex(messages, anchorUid);
  if (idx < 0) return null;
  return { head: messages.slice(0, idx + 1), tail: messages.slice(idx + 1) };
}

// head + tail 归并回主消息数组(切换分支时恢复 target tail 用)。
export function mergeTail(head: Message[], tail: Message[]): Message[] {
  return [...head, ...tail];
}

// 给定某条 agent 文本消息,向前找最近的用户(who==="me")文本消息 uid —— 即它归属的 anchor。
export function anchorForAgentMessage(messages: Message[], agentMsgUid: string): string | undefined {
  const idx = anchorIndex(messages, agentMsgUid);
  if (idx < 0) return undefined;
  for (let i = idx - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.kind === "text" && m.who === "me") return m.uid;
  }
  return undefined;
}

// 该 agent 消息是否是所属 anchor 之后的「第一条」agent 文本回复——分页器只挂在这一条上,
// 避免归档 tail 含多轮时每条回复都出现分页器。
export function isFirstAgentReplyOfTail(messages: Message[], agentMsgUid: string): boolean {
  const idx = anchorIndex(messages, agentMsgUid);
  if (idx < 0) return false;
  for (let i = idx - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.kind !== "text") continue;
    // 先遇到用户消息 → 中间无其它 agent 文本回复,是第一条。
    if (m.who === "me") return true;
    // 先遇到另一条 agent 文本 → 不是第一条。
    return false;
  }
  return false;
}

// 分页器定位:active 变体在组内的序号(1-based)与总数。
export function pagerPosition(group: BranchGroup): { index: number; total: number } {
  const i = group.variants.findIndex((v) => v.id === group.activeId);
  return { index: i < 0 ? 1 : i + 1, total: group.variants.length };
}

// 刷新建/扩组:把「当前 live 分支的物化形态」archived 写回组内(首刷时作为首个变体建组),
// 追加新 live 变体 newLive(tail/pointer 为 null),activeId 指向它。
// 约定:组已存在时 archived.id 必须等于原 activeId(物化的是当前 active 变体)。
export function upsertRegenerate(
  groups: BranchGroup[],
  anchorUid: string,
  archived: BranchVariant,
  newLive: BranchVariant,
): BranchGroup[] {
  const g = groups.find((x) => x.anchorUid === anchorUid);
  if (!g) return [...groups, { anchorUid, activeId: newLive.id, variants: [archived, newLive] }];
  return groups.map((x) =>
    x !== g
      ? x
      : {
          ...x,
          activeId: newLive.id,
          variants: [...x.variants.map((v) => (v.id === archived.id ? archived : v)), newLive],
        },
  );
}

export interface SwitchResult {
  groups: BranchGroup[];
  // 物化前的 target 变体(含 tail/pointer),调用方据此恢复消息尾与会话指针。
  target: BranchVariant;
}

// 切换分支(纯数据部分):当前 active 变体以物化形态 materializedActive 写回(tail/pointer 已填),
// target 变体转为 live(tail/pointer 置 null),activeId 指向 target。
// target 不存在 / 已是 active / materializedActive.id 不符 → null(调用方放弃切换)。
export function applySwitch(
  groups: BranchGroup[],
  anchorUid: string,
  materializedActive: BranchVariant,
  targetId: string,
): SwitchResult | null {
  const g = groups.find((x) => x.anchorUid === anchorUid);
  if (!g || g.activeId === targetId || g.activeId !== materializedActive.id) return null;
  const target = g.variants.find((v) => v.id === targetId);
  if (!target) return null;
  const nextGroups = groups.map((x) =>
    x !== g
      ? x
      : {
          ...x,
          activeId: targetId,
          variants: x.variants.map((v) =>
            v.id === materializedActive.id ? materializedActive : v.id === targetId ? { ...v, tail: null, pointer: null } : v,
          ),
        },
  );
  return { groups: nextGroups, target };
}

// 落盘打包:有分支写 v2 对象,无分支仍写 v1 裸数组(回滚安全;旧客户端可读)。
export function packChatForSave(messages: Message[], branchGroups: BranchGroup[]): Message[] | ChatFileV2 {
  if (!branchGroups.length) return messages;
  return { version: 2, messages, branchGroups };
}

// 归档 tail 落盘清理:分支 tail 与主消息流同标准(剥离瞬态/过程块),sanitize 函数由调用方注入
// (sanitizeForSave 在 messages.ts,避免反向依赖)。
export function sanitizeBranchGroups(groups: BranchGroup[], sanitize: (m: Message[]) => Message[]): BranchGroup[] {
  return groups.map((g) => ({
    ...g,
    variants: g.variants.map((v) => (v.tail ? { ...v, tail: sanitize(v.tail) } : v)),
  }));
}
