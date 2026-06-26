// 访问范围 × 执行审批 → pi RPC 能力派生。
// claude/codex 直接把 permissionMode/approvalPolicy 随 CliStartRequest 下传,由各 adapter 翻译成
// 原生标志;而 pi 无原生权限/沙箱标志,需在 core 侧把两轴派生成 pi 能兑现的能力三元组
//(工具白名单 + 审批开关 + 审批集),再塞进 PiOpenRequest。两轴正交:
//   访问范围 plan(只读) → 只读工具白名单(物理上无 write/edit/bash),审批无意义关闭。
//          其它(可写工作区/访问所有/外部沙箱) → 不收窄工具(pi 无原生沙箱,sandbox 降级=不收窄)。
//   执行审批 ask(询问后执行) → 写/执行类工具前审批(真审批回路,pi RPC 独有)。
//          auto(自动执行) → 沿用用户 piCustomization 审批设置(历史默认行为)。

import { DEFAULT_PI_APPROVAL_TOOLS, PI_PLAN_TOOL_WHITELIST, type ApprovalPolicy, type PermissionMode } from "../desktop/types";

// pi 审批相关的用户设置子集（取自 GeneralSettings.piCustomization）。
export interface PiApprovalPrefs {
  toolApproval?: boolean;
  approvalTools?: string[];
}

// 派生后的 pi 能力三元组,直接铺进 PiOpenRequest 对应字段。
export interface PiPermissionCapabilities {
  toolWhitelist?: string[];
  enableToolApproval?: boolean;
  approvalTools?: string[];
}

export function derivePiCapabilities(
  mode: PermissionMode | undefined,
  approval: ApprovalPolicy | undefined,
  prefs?: PiApprovalPrefs,
): PiPermissionCapabilities {
  // 访问范围:plan(只读) → 只读白名单,无写/执行工具可调,审批无意义关闭。
  if (mode === "plan") {
    return { toolWhitelist: [...PI_PLAN_TOOL_WHITELIST], enableToolApproval: false, approvalTools: undefined };
  }
  // 执行审批:ask(询问后执行) → 写/执行类工具前审批(真交互审批,pi RPC 独有)。
  if (approval === "ask") {
    const base = prefs?.approvalTools ?? DEFAULT_PI_APPROVAL_TOOLS;
    // 安全底线:审批集至少覆盖 write/edit/bash(否则空集经 pi-extensions 会放行全部工具)。
    const need = ["write", "edit", "bash"];
    const approvalTools = [...new Set([...base, ...need])];
    return { toolWhitelist: undefined, enableToolApproval: true, approvalTools };
  }
  // auto(自动执行)+ 非 plan:不收窄工具,审批沿用用户设置(toolApproval 关→无审批 extension,= 历史默认)。
  return {
    toolWhitelist: undefined,
    enableToolApproval: prefs?.toolApproval || undefined,
    approvalTools: prefs?.toolApproval ? prefs.approvalTools : undefined,
  };
}
