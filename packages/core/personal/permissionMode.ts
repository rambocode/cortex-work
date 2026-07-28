// 执行权限单轴派生:UI 单一真源(execPermission)→ adapter 线格式(permissionMode × approvalPolicy)
// → pi RPC 能力二元组。映射集中在本文件,避免散落漂移。
//
// 【UI 单轴 → 线格式】toAdapterPermissions:发送边界唯一派生点。
//   plan → {plan, auto}(只读,审批无意义);ask → {full-auto, ask};auto → {full-auto, auto}。
//   auto/ask 一律 full-auto,不设目录限制(历史的 dirPermission 目录轴已删除)。
//   fromAdapterPermissions 是其逆(有损,目录信息丢弃),仅供 store 老会话迁移用。
//
// 【线格式 → pi 能力】derivePiCapabilities:claude/codex 直接把 permissionMode/approvalPolicy 随
//   CliStartRequest 下传由各 adapter 翻译成原生标志;而 pi 无原生权限标志,需派生成 pi 能兑现的能力
//   (工具白名单 + 审批开关 + 审批集),再塞进 PiOpenRequest:
//     plan(只读) → 只读工具白名单(物理上无 write/edit/bash),审批无意义关闭。
//     ask(询问后执行) → 写/执行类工具前审批(真审批回路,pi RPC 独有)。
//     auto(自动执行) → 沿用用户 piCustomization 审批设置(历史默认行为)。

import {
  DEFAULT_PI_APPROVAL_TOOLS,
  PI_PLAN_TOOL_WHITELIST,
  DEFAULT_EXEC_PERMISSION,
  type ApprovalPolicy,
  type PermissionMode,
  type ExecPermission,
} from "../desktop/types";

// 【UI 单轴 → 线格式】发送边界唯一派生点。塞进 CliStartRequest/编排/pi 请求前调用。
export function toAdapterPermissions(
  exec: ExecPermission | undefined,
): { permissionMode: PermissionMode; approvalPolicy: ApprovalPolicy } {
  const e = exec ?? DEFAULT_EXEC_PERMISSION; // 缺省=auto
  // plan 只读:审批无意义(置 auto)。
  if (e === "plan") return { permissionMode: "plan", approvalPolicy: "auto" };
  // ask/auto 一律 full-auto:ask 的审批由 pi 真审批回路兑现(claude/codex 本就降级同 auto)。
  return { permissionMode: "full-auto", approvalPolicy: e === "ask" ? "ask" : "auto" };
}

// 【线格式 → UI 单轴】toAdapterPermissions 的有损逆,仅供 store 老会话迁移(旧 wire 字段 →
// execPermission)。accept-edits/sandbox 的目录语义丢弃,按审批策略归入 ask/auto。
export function fromAdapterPermissions(
  mode: PermissionMode | undefined,
  approval: ApprovalPolicy | undefined,
): { execPermission: ExecPermission } {
  if (mode === "plan") return { execPermission: "plan" };
  return { execPermission: approval === "ask" ? "ask" : "auto" };
}

// pi 审批相关的用户设置子集（取自 GeneralSettings.piCustomization）。
export interface PiApprovalPrefs {
  toolApproval?: boolean;
  approvalTools?: string[];
}

// 派生后的 pi 能力二元组(工具白名单 + 审批),直接铺进 PiOpenRequest 对应字段。
export interface PiPermissionCapabilities {
  toolWhitelist?: string[];
  enableToolApproval?: boolean;
  approvalTools?: string[];
}

// 【线格式 → pi 能力】把 permissionMode/approvalPolicy 翻译成 pi RPC 可兑现的能力。
export function derivePiCapabilities(
  mode: PermissionMode | undefined,
  approval: ApprovalPolicy | undefined,
  prefs?: PiApprovalPrefs,
): PiPermissionCapabilities {
  // plan(只读) → 只读白名单,无写/执行工具可调,审批无意义关闭。
  if (mode === "plan") {
    return { toolWhitelist: [...PI_PLAN_TOOL_WHITELIST], enableToolApproval: false, approvalTools: undefined };
  }
  // ask(询问后执行) → 写/执行类工具前审批(真交互审批,pi RPC 独有)。
  if (approval === "ask") {
    const base = prefs?.approvalTools ?? DEFAULT_PI_APPROVAL_TOOLS;
    // 安全底线:审批集至少覆盖 write/edit/bash(否则空集经 pi-extensions 会放行全部工具)。
    const need = ["write", "edit", "bash"];
    const approvalTools = [...new Set([...base, ...need])];
    return { toolWhitelist: undefined, enableToolApproval: true, approvalTools };
  }
  // auto(自动执行):不收窄工具,审批沿用用户设置(toolApproval 关→无审批 extension,= 历史默认)。
  return {
    toolWhitelist: undefined,
    enableToolApproval: prefs?.toolApproval || undefined,
    approvalTools: prefs?.toolApproval ? prefs.approvalTools : undefined,
  };
}
