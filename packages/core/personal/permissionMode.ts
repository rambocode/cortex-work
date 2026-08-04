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
  AUTOMATION_WRITE_TOOLS,
  CALENDAR_WRITE_TOOLS,
  COMPUTER_USE_WRITE_TOOLS,
  DEFAULT_PI_APPROVAL_TOOLS,
  PI_PLAN_TOOL_WHITELIST,
  DEFAULT_EXEC_PERMISSION,
  type ApprovalPolicy,
  type PermissionMode,
  type ExecPermission,
} from "../desktop/types";

// 自动化 / 日历的写工具:改定时任务、写系统日历,同属「无需再问就会改变用户世界」的一类,
// 与 gui_* 同级红线,故**无条件**进审批集(不看任何开关)。
//
// 为什么可以无条件加:审批集只是 renderApprovalExtension 编出的一个 NEEDS 名字集合,工具没被
// 注入时这些名字永不命中。这样 renderer 不必知道主进程那边的门控结论(自动化的全局开关、日历的
// 四道门),把「要不要真给工具」与「给了要不要审批」解耦,避免两侧判断漂移出「注入了但不审批」
// 这个最坏组合 —— 与下方 gui_* 的处理同构。
const ALWAYS_APPROVE_TOOLS = [...AUTOMATION_WRITE_TOOLS, ...CALENDAR_WRITE_TOOLS];

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
//
// computerUseEnabled:Computer Use 总开关（GeneralSettings.computerUse.enabled,缺省视为 true）。
// 为 true 时 gui_* 写工具**无条件**进审批集,且 auto 档也强制打开审批开关——见下方红线说明。
export function derivePiCapabilities(
  mode: PermissionMode | undefined,
  approval: ApprovalPolicy | undefined,
  prefs?: PiApprovalPrefs,
  computerUseEnabled = true,
): PiPermissionCapabilities {
  // 【安全红线】gui_* 写工具（点击/输入/拖拽/热键/剪贴板写/批量）会真实操作用户的电脑,
  // 一次误点可能发出消息、删除文件、确认付款。因此只要 Computer Use 没被关掉,这些工具就
  // **必须**逐次经用户确认,不接受「用户没开审批开关」这个理由。
  //
  // 这里无条件把工具名加进审批集是安全的:renderApprovalExtension 只是把它编成一个 NEEDS
  // 集合,包没装/没注入时这些名字永不命中。这么做的好处是 renderer 不必知道主进程那边
  // 五门控（平台/开关/已装/swiftc/授权）的结论——把「要不要真给工具」和「给了要不要审批」
  // 解耦,避免两侧判断漂移导致「注入了但不审批」这种最坏组合。
  const guiNeeds = computerUseEnabled ? COMPUTER_USE_WRITE_TOOLS : [];

  // plan(只读) → 只读白名单,无写/执行工具可调,审批无意义关闭。
  // gui_* 写工具不在 PI_PLAN_TOOL_WHITELIST 里,被 --tools 物理拦下,故此处无需审批兜底。
  if (mode === "plan") {
    return { toolWhitelist: [...PI_PLAN_TOOL_WHITELIST], enableToolApproval: false, approvalTools: undefined };
  }
  // ask(询问后执行) → 写/执行类工具前审批(真交互审批,pi RPC 独有)。
  if (approval === "ask") {
    const base = prefs?.approvalTools ?? DEFAULT_PI_APPROVAL_TOOLS;
    // 安全底线:审批集至少覆盖 write/edit/bash(否则空集经 pi-extensions 会放行全部工具)。
    const need = ["write", "edit", "bash", ...guiNeeds, ...ALWAYS_APPROVE_TOOLS];
    const approvalTools = [...new Set([...base, ...need])];
    return { toolWhitelist: undefined, enableToolApproval: true, approvalTools };
  }
  // auto(自动执行):不收窄工具,审批沿用用户设置(toolApproval 关→无审批 extension,= 历史默认)。
  //
  // ⚠️ 例外:Computer Use 开启时,即使用户没开「工具执行审批」,也强制打开审批并把 gui_* 写工具
  // 塞进审批集。否则 auto 档下 gui_click / gui_type 会**无任何确认**直接操作用户电脑——
  // 这是本功能唯一不可让步的行为。用户原有的审批集（若配了）一并保留,不覆盖其选择。
  //
  // 自动化 / 日历写工具（ALWAYS_APPROVE_TOOLS）同理并入。注意这里**不能**再写
  // `if (guiNeeds.length)` —— 用户关掉 Computer Use 时 guiNeeds 为空,整个强制块会被跳过,
  // create_automation / create_calendar_event 在 auto 档就无确认直接落地。
  // forcedNeeds 恒非空,故 auto 档现在恒有审批 extension;但 NEEDS 集只含这些强制工具名,
  // 其余工具一律不命中,对未开审批开关的用户行为等价(不会平白多出审批弹窗)。
  const forcedNeeds = [...guiNeeds, ...ALWAYS_APPROVE_TOOLS];
  if (forcedNeeds.length) {
    const base = prefs?.toolApproval ? (prefs.approvalTools ?? DEFAULT_PI_APPROVAL_TOOLS) : [];
    return {
      toolWhitelist: undefined,
      enableToolApproval: true,
      approvalTools: [...new Set([...base, ...forcedNeeds])],
    };
  }
  return {
    toolWhitelist: undefined,
    enableToolApproval: prefs?.toolApproval || undefined,
    approvalTools: prefs?.toolApproval ? prefs.approvalTools : undefined,
  };
}
