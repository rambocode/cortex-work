// 团队分身（共享角色）通讯录映射：把服务端 GET /api/avatars 的 ApiAvatar[] 展开成
// 「成员 → 分身」两级 Contact[]（契约 §7 / U7）。纯函数、无副作用，便于就近单测。
//
// 层级形状：每个 owner 产出一条 human Contact（kind:"human"，不可发起会话）+ 其下每个
// 分身一条 avatar Contact（kind:"avatar"，id = runtime_id）。返回的扁平数组按
// [human, avatar, avatar, human, avatar, ...] 顺序排列，供 Sidebar 据 ownerId 做两级嵌套渲染。

import type { ApiAvatar, ApiAvatarStatus, ServerRuntime, ServerWorkspace } from "../api/types";
import type { AgentStatus, Avatar, Contact } from "../types";

// 零分身成员来源（可选）：当消费端能拿到完整成员名单时传入，用于把「已入团但未共享任何分身」
// 的成员也展开成一条 human Contact —— 其下无 avatar 子项，由视图层呈现「暂未共享分身」空态。
// 仅需 id/name/email 三字段，与 ApiAvatar.owner 同形，便于两侧合并去重。
export interface AvatarContactMember {
  id: string;
  name: string;
  email?: string;
}

// 分身两级在线态 → UI AgentStatus 三态映射（契约 §2/§7）：
// online → "online"（可执行）；online_unavailable → "unavailable"（在线但本机 CLI 不可用，
// 须与 offline 区分呈现，见 AE11）；offline → "offline"。
function mapAvatarStatus(status: ApiAvatarStatus): AgentStatus {
  switch (status) {
    case "online":
      return "online";
    case "online_unavailable":
      return "unavailable";
    case "offline":
    default:
      return "offline";
  }
}

// 分身头像底色调色板：无服务端配色时按 id 稳定取色，保证同一分身跨渲染颜色一致（非随机）。
const AVATAR_BG_PALETTE = ["#c96442", "#1f6feb", "#7c3aed", "#0d9488", "#d97706", "#16a34a", "#dc2626", "#475569"];

// 稳定字符和哈希：仅用于从 id 派生调色板下标，无需加密强度。
function stableIndex(seed: string, mod: number): number {
  let sum = 0;
  for (let i = 0; i < seed.length; i++) sum = (sum + seed.charCodeAt(i)) % mod;
  return sum;
}

// 取展示用首字母/缩写：优先取前两个非空字符（兼容中英文），空串回退占位符。
function initialsOf(label: string, fallback: string): string {
  const trimmed = label.trim();
  if (!trimmed) return fallback;
  return trimmed.slice(0, 2);
}

// 构造 human Contact：成员条目，可见但不可聊（kind:"human"，ChatArea 显示降级提示）。
// id = 成员 id，与其名下 avatar Contact 的 ownerId 一致，供 Sidebar 归拢两级。
function toHumanContact(member: AvatarContactMember): Contact {
  const avatar: Avatar = {
    initials: initialsOf(member.name, "?"),
    bg: AVATAR_BG_PALETTE[stableIndex(member.id, AVATAR_BG_PALETTE.length)]!,
  };
  return {
    id: member.id,
    name: member.name,
    group: "team",
    avatar,
    // 真人无 agent 执行态；用 "idle" 占位（视图对 human 行不渲染在线圆点语义）。
    agentStatus: "idle",
    statusText: "",
    last: "",
    time: "",
    unread: 0,
    kind: "human",
    ownerId: member.id,
    ownerName: member.name,
  };
}

// 构造 avatar Contact：分身条目，id = runtime_id（契约硬约定，冗余存入 runtimeId 便于直取）。
// daily_used/daily_limit 作为副标题信息交由视图按需呈现，这里只落基础展示字段。
function toAvatarContact(a: ApiAvatar): Contact {
  const avatar: Avatar = {
    initials: initialsOf(a.role_label, "AI"),
    bg: AVATAR_BG_PALETTE[stableIndex(a.runtime_id, AVATAR_BG_PALETTE.length)]!,
  };
  return {
    id: a.runtime_id,
    name: a.role_label,
    group: "team",
    role: a.role_label,
    avatar,
    agentStatus: mapAvatarStatus(a.status),
    statusText: "",
    last: "",
    time: "",
    unread: 0,
    kind: "avatar",
    runtimeId: a.runtime_id,
    ownerId: a.owner.id,
    ownerName: a.owner.name,
  };
}

// 主映射：ApiAvatar[]（+ 可选完整成员名单）→ 扁平的「成员→分身」两级 Contact[]。
// 排序规则：owner 首次出现的顺序（members 传入时以 members 顺序为准，保证零分身成员也在列）。
// 每个 owner 段内先 human 后其名下 avatars（按入参顺序），Sidebar 据此原地渲染两级。
export function mapAvatarsToContacts(avatars: ApiAvatar[], members?: AvatarContactMember[]): Contact[] {
  // 归拢 owner 元信息与其名下分身，保留稳定的首现顺序。
  const ownerOrder: string[] = [];
  const ownerMeta = new Map<string, AvatarContactMember>();
  const avatarsByOwner = new Map<string, ApiAvatar[]>();

  // 先按 members 顺序播种（含零分身成员），使其恒定出现在通讯录中。
  for (const m of members ?? []) {
    if (!ownerMeta.has(m.id)) {
      ownerOrder.push(m.id);
      ownerMeta.set(m.id, m);
      avatarsByOwner.set(m.id, []);
    }
  }

  // 再按分身归属补全 owner（members 未覆盖时以 avatar.owner 兜底）。
  for (const a of avatars) {
    const ownerId = a.owner.id;
    if (!ownerMeta.has(ownerId)) {
      ownerOrder.push(ownerId);
      ownerMeta.set(ownerId, { id: ownerId, name: a.owner.name, email: a.owner.email });
      avatarsByOwner.set(ownerId, []);
    }
    avatarsByOwner.get(ownerId)!.push(a);
  }

  // 逐 owner 段展开：human 行 + 其名下 avatar 行。
  const result: Contact[] = [];
  for (const ownerId of ownerOrder) {
    result.push(toHumanContact(ownerMeta.get(ownerId)!));
    for (const a of avatarsByOwner.get(ownerId)!) {
      result.push(toAvatarContact(a));
    }
  }
  return result;
}

// ── 服务器工作区 → 通讯录条目 ───────────────────────────────────────────────
// 每个非归档服务器工作区一条 Contact（group:"shared" =「项目 / 共享 Agent」分组），
// kind:"avatar" 复用会话链路，serverWorkspaceId 驱动 sendMessage 走 invokeServerWorkspace。
// runtimeId 取同 daemon 下优先在线的 runtime（全离线取第一个，让服务端给明确错误）。
export function mapServerWorkspacesToContacts(
  workspaces: ServerWorkspace[],
  runtimes: ServerRuntime[],
): Contact[] {
  const byDaemon = new Map<string, ServerRuntime[]>();
  for (const rt of runtimes) {
    const list = byDaemon.get(rt.daemon_id) ?? [];
    list.push(rt);
    byDaemon.set(rt.daemon_id, list);
  }
  const out: Contact[] = [];
  for (const sw of workspaces) {
    if (sw.status === "archived") continue;
    const rts = byDaemon.get(sw.daemon_id) ?? [];
    const runtime = rts.find((r) => r.online) ?? rts[0];
    const online = rts.some((r) => r.online);
    const busy = !!sw.running_task_id;
    const statusText =
      sw.status === "provisioning"
        ? "准备中（clone）…"
        : sw.status === "error"
          ? "创建失败"
          : busy
            ? "执行中"
            : online
              ? sw.mode === "shared"
                ? "共享工作区"
                : "独立工作区"
              : "服务器离线";
    out.push({
      id: sw.id,
      name: sw.name,
      group: "shared",
      role: sw.mode === "shared" ? "共享工作区" : "独立工作区",
      avatar: {
        initials: initialsOf(sw.name, "WS"),
        bg: AVATAR_BG_PALETTE[stableIndex(sw.id, AVATAR_BG_PALETTE.length)]!,
      },
      agentStatus: sw.status !== "ready" ? "idle" : busy ? "working" : online ? "online" : "offline",
      statusText,
      last: "",
      time: "",
      unread: 0,
      kind: "avatar",
      runtimeId: runtime?.id,
      serverWorkspaceId: sw.id,
    });
  }
  return out;
}
