// 权限两轴派生:UI 单一真源(execPermission × dirPermission)↔ adapter 线格式(permissionMode × approvalPolicy)
// ↔ pi RPC 能力三元组。三层映射集中在本文件,避免散落漂移。
//
// 【UI 两轴 → 线格式】toAdapterPermissions:发送边界唯一派生点。execPermission=plan → 线格式 plan(只读,
//   忽略目录轴);否则 dirPermission 决定访问范围(workspace→accept-edits / all→full-auto / sandbox→sandbox),
//   execPermission 决定审批(ask→ask / auto→auto)。fromAdapterPermissions 是其逆,供老会话迁移用。
//
// 【线格式 → pi 能力】derivePiCapabilities:claude/codex 直接把 permissionMode/approvalPolicy 随 CliStartRequest
//   下传由各 adapter 翻译成原生标志;而 pi 无原生权限/沙箱标志,需把两轴派生成 pi 能兑现的能力三元组
//   (工具白名单 + 审批开关 + 审批集),再塞进 PiOpenRequest。两轴正交:
//     访问范围 plan(只读) → 只读工具白名单(物理上无 write/edit/bash),审批无意义关闭。
//            其它(可写工作区/访问所有/外部沙箱) → 不收窄工具(pi 无原生沙箱,sandbox 降级=不收窄)。
//     执行审批 ask(询问后执行) → 写/执行类工具前审批(真审批回路,pi RPC 独有)。
//            auto(自动执行) → 沿用用户 piCustomization 审批设置(历史默认行为)。

import {
  DEFAULT_PI_APPROVAL_TOOLS,
  PI_PLAN_TOOL_WHITELIST,
  DEFAULT_EXEC_PERMISSION,
  DEFAULT_DIR_PERMISSION,
  type ApprovalPolicy,
  type PermissionMode,
  type ExecPermission,
  type DirPermission,
} from "../desktop/types";

// 目录档 → 线格式访问范围(仅 exec≠plan 时用)。
function dirToMode(dir: DirPermission): PermissionMode {
  switch (dir) {
    case "workspace":
      return "accept-edits";
    case "all":
      return "full-auto";
    case "sandbox":
      return "sandbox";
  }
}

// 【UI 两轴 → 线格式】发送边界唯一派生点。塞进 CliStartRequest/编排/pi 请求前调用。
export function toAdapterPermissions(
  exec: ExecPermission | undefined,
  dir: DirPermission | undefined,
): { permissionMode: PermissionMode; approvalPolicy: ApprovalPolicy } {
  const e = exec ?? DEFAULT_EXEC_PERMISSION; // 缺省=auto
  const d = dir ?? DEFAULT_DIR_PERMISSION; // 缺省=all(历史 full-auto)
  // plan 只读:目录轴无意义,审批无意义(置 auto)。
  if (e === "plan") return { permissionMode: "plan", approvalPolicy: "auto" };
  return { permissionMode: dirToMode(d), approvalPolicy: e === "ask" ? "ask" : "auto" };
}

// 【线格式 → UI 两轴】toAdapterPermissions 的逆,供老会话无损迁移。
// plan 只读:目录轴落新会话默认 workspace(不暴露 all),approvalPolicy 无意义被丢弃(语义无损)。
export function fromAdapterPermissions(
  mode: PermissionMode | undefined,
  approval: ApprovalPolicy | undefined,
): { execPermission: ExecPermission; dirPermission: DirPermission } {
  const m = mode ?? "full-auto"; // 缺省 permissionMode = full-auto(历史)
  if (m === "plan") return { execPermission: "plan", dirPermission: "workspace" };
  const dir: DirPermission = m === "accept-edits" ? "workspace" : m === "sandbox" ? "sandbox" : "all";
  return { execPermission: approval === "ask" ? "ask" : "auto", dirPermission: dir };
}

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
  // 目录执行权限「仅工作目录」/「外部沙箱」→ true:pi 无原生沙箱,主进程据此注入 cwd 路径闸 extension
  // (pi-extensions writePathJailExtension),把内置文件工具(read/write/edit/ls/grep/find)限制在 cwd 内。
  // 「所有文件」(full-auto)→ false 不限制;plan 走只读白名单(读全盘,与 codex read-only 一致),不闸。
  confineToCwd?: boolean;
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
  // 目录执行权限:accept-edits(仅工作目录)/ sandbox(外部沙箱)→ 注入 cwd 路径闸;full-auto(所有文件)不闸。
  const confineToCwd = mode === "accept-edits" || mode === "sandbox";
  // 执行审批:ask(询问后执行) → 写/执行类工具前审批(真交互审批,pi RPC 独有)。
  if (approval === "ask") {
    const base = prefs?.approvalTools ?? DEFAULT_PI_APPROVAL_TOOLS;
    // 安全底线:审批集至少覆盖 write/edit/bash(否则空集经 pi-extensions 会放行全部工具)。
    const need = ["write", "edit", "bash"];
    const approvalTools = [...new Set([...base, ...need])];
    return { toolWhitelist: undefined, enableToolApproval: true, approvalTools, confineToCwd };
  }
  // auto(自动执行)+ 非 plan:不收窄工具,审批沿用用户设置(toolApproval 关→无审批 extension,= 历史默认)。
  return {
    toolWhitelist: undefined,
    enableToolApproval: prefs?.toolApproval || undefined,
    approvalTools: prefs?.toolApproval ? prefs.approvalTools : undefined,
    confineToCwd,
  };
}
