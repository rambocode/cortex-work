// 运行模式（权限松紧）→ pi RPC 能力派生。
// claude/codex 直接把 permissionMode 随 CliStartRequest 下传,由各 adapter 翻译成原生标志;
// 而 pi 无原生权限/沙箱标志,需在 core 侧把模式派生成 pi 能兑现的能力三元组（工具白名单 +
// 审批开关 + 审批集），再塞进 PiOpenRequest。
//   plan        → 只读工具白名单(物理上无 write/edit/bash),无需审批
//   accept-edits → 自动接受编辑:从审批集剔除 write/edit(放行),其余(bash 等)仍审批
//   full-auto   → 不收窄工具,审批沿用用户 piCustomization 设置(回归保护:与历史行为一致)

import {
  DEFAULT_PERMISSION_MODE,
  DEFAULT_PI_APPROVAL_TOOLS,
  PI_PLAN_TOOL_WHITELIST,
  type PermissionMode,
} from "../desktop/types";

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
  prefs?: PiApprovalPrefs,
): PiPermissionCapabilities {
  const m = mode ?? DEFAULT_PERMISSION_MODE;
  if (m === "plan") {
    // 只读白名单 → 没有写/执行类工具可调,审批无意义,显式关闭。
    return { toolWhitelist: [...PI_PLAN_TOOL_WHITELIST], enableToolApproval: false, approvalTools: undefined };
  }
  if (m === "accept-edits") {
    // 从审批集剔除 write/edit(自动放行编辑),保留 bash 等执行类仍走审批。
    const base = prefs?.approvalTools ?? DEFAULT_PI_APPROVAL_TOOLS;
    const filtered = base.filter((t) => t !== "write" && t !== "edit");
    // 安全底线:剔除后必须保留 bash 审批。否则用户自定义审批集恰为 ["write","edit"] 时
    // filtered=[],经 pi-extensions 的 NEEDS=Set([]) 会放行全部工具 → bash 零审批穿透,
    // 与「自动改文件但 bash 仍受限」的承诺相悖。强制并入 bash 兜住执行类硬底。
    const approvalTools = filtered.includes("bash") ? filtered : [...filtered, "bash"];
    return { toolWhitelist: undefined, enableToolApproval: true, approvalTools };
  }
  // full-auto:不收窄工具,审批沿用用户设置(toolApproval 关→无审批 extension,= 历史默认)。
  return {
    toolWhitelist: undefined,
    enableToolApproval: prefs?.toolApproval || undefined,
    approvalTools: prefs?.toolApproval ? prefs.approvalTools : undefined,
  };
}
