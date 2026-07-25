// Deep Research 组件层的文案与可用性映射（个人工作区惯例：硬编码 zh-Hans，不走 i18n 的 t()）。
//
// 这里只做「枚举 → 展示」的翻译，**不含任何业务判定**：按钮能不能点由 core 的状态机
// （canTransition / NON_TERMINAL_RESEARCH_STATUSES）推导，避免 UI 自己发明第二套规则后
// 与编排层漂移——那种漂移的表现是「按钮亮着但点了报错」，最难查。
import { FETCH_FAILURE_CODES, type FetchFailureCode } from "@cortex-work/core/research/evidence";
import {
  TERMINAL_RESEARCH_STATUSES,
  canTransition,
} from "@cortex-work/core/research/session-status";
import type {
  ModelDataPolicy,
  ResearchMode,
  ResearchSessionStatus,
  ResearchStage,
} from "@cortex-work/core/research/types";

/// 状态徽标的展示元数据。tone 是 CSS 修饰词后缀（.pw-res-badge.is-<tone>，见 research.css），
/// 不是颜色值本身——配色随明暗主题由 CSS 变量决定。
export interface ResearchStatusMeta {
  label: string;
  tone: "idle" | "run" | "warn" | "ok" | "bad";
}

/// 11 个 Session 状态的中文标签与配色。Record 类型钉死全覆盖：
/// core 新增状态时这里立刻编译报错，不会出现「UI 显示裸英文枚举」。
export const RESEARCH_STATUS_META: Record<ResearchSessionStatus, ResearchStatusMeta> = {
  created: { label: "待开始", tone: "idle" },
  planning: { label: "规划中", tone: "run" },
  searching: { label: "检索中", tone: "run" },
  fetching: { label: "抓取中", tone: "run" },
  evaluating: { label: "评估中", tone: "run" },
  reporting: { label: "生成报告", tone: "run" },
  completed: { label: "已完成", tone: "ok" },
  paused: { label: "已暂停", tone: "warn" },
  cancelled: { label: "已取消", tone: "idle" },
  failed: { label: "失败", tone: "bad" },
  interrupted: { label: "已中断", tone: "warn" },
};

/// 运行阶段的中文标签（进度条与「当前阶段」文案）。
export const RESEARCH_STAGE_LABELS: Record<ResearchStage, string> = {
  planning: "规划",
  searching: "检索",
  fetching: "抓取",
  evaluating: "评估",
  reporting: "生成报告",
};

/// 三档研究强度的中文标签与一句话说明（新建表单的选项）。
export const RESEARCH_MODE_LABELS: Record<ResearchMode, { label: string; hint: string }> = {
  quick: { label: "快速", hint: "单轮检索，几分钟内给出初步结论" },
  standard: { label: "标准", hint: "多轮补搜，覆盖度不足会自动追问" },
  deep: { label: "深度", hint: "更多轮次与来源，耗时最长、最全面" },
};

/// 三种数据出站策略的中文标签（详细影响由 describeEgress 渲染，见 ResearchPolicyNotice）。
export const MODEL_DATA_POLICY_LABELS: Record<ModelDataPolicy, { label: string; hint: string }> = {
  local_only: { label: "仅本地模型", hint: "任何内容都不出本机；没有本地模型时直接失败" },
  metadata_only: { label: "仅元数据出站", hint: "云端模型只看标题、摘要与域名，不看正文" },
  evidence_allowed: { label: "允许证据出站", hint: "证据正文片段会发给所选模型供应商" },
};

/// 抓取失败码的中文说明（面向用户，解释「为什么这条来源没进证据」）。
export const FETCH_FAILURE_LABELS: Record<FetchFailureCode, string> = {
  blocked_by_policy: "被安全策略拦截（私网地址、非法端口或协议）",
  dns_failure: "域名解析失败",
  connect_failure: "无法建立连接",
  tls_failure: "HTTPS 证书或加密握手失败",
  http_error: "服务器返回错误状态码",
  too_large: "内容体积超过上限",
  timeout: "抓取超时",
  unsupported_media: "不支持的内容类型",
  empty_content: "抓到的正文为空",
  browser_unavailable: "浏览器降级抓取不可用",
  cancelled: "已取消",
  internal_error: "内部错误",
};

/// 未知失败码的兜底文案：跨版本数据里可能出现本端不认识的码，不能让 UI 显示 undefined。
export function fetchFailureLabel(code: string): string {
  return (FETCH_FAILURE_LABELS as Record<string, string>)[code] ?? `抓取失败（${code}）`;
}

/// 运行时可迭代的失败码列表，供设置/调试面板穷举展示。
export const RESEARCH_FETCH_FAILURE_CODES = FETCH_FAILURE_CODES;

/// 是否为终态（不可再操作，只能新建会话重跑）。
export function isTerminalSession(status: ResearchSessionStatus): boolean {
  return (TERMINAL_RESEARCH_STATUSES as readonly ResearchSessionStatus[]).includes(status);
}

/// 「重跑」按钮是否可用。
///
/// 只在终态可用。它不是「继续」而是**用同一批参数新建一个会话**——终态在状态机里
/// 没有出口，就地重置会让旧报告引用的证据凭空消失（见 core/research/session-status 的注释）。
/// 所以按钮文案与语义都要说清楚是「重跑」而不是「重置」。
export function canRerunSession(status: ResearchSessionStatus): boolean {
  return isTerminalSession(status);
}

/// 「开始」按钮是否可用。
///
/// 存在的理由是一个真实踩过的死局：新建研究时前端会自动调一次 `run`，但那一步可能失败
/// （最常见的是搜索服务尚未配好，main 抛 SearchServerNotConfiguredError）。失败后会话停在
/// `created` —— 它既不是运行中（不能暂停）、也不是已暂停或中断（不能恢复）、更不是终态，
/// 于是三个按钮全灰，用户只能删掉重建。
///
/// 不用 canTransition 判定：`created → searching` 这一跳是编排器内部推进的，
/// 状态机描述的是「谁能推到哪」，而这里要回答的是「用户此刻能不能手动起跑」，两者不是一回事。
export function canStartSession(status: ResearchSessionStatus): boolean {
  return status === "created";
}

/// 「暂停」按钮是否可用——直接问状态机能否转到 paused，不另立规则。
export function canPauseSession(status: ResearchSessionStatus): boolean {
  return canTransition(status, "paused");
}

/// 「取消」按钮是否可用——同上，问状态机能否转到 cancelled。
export function canCancelSession(status: ResearchSessionStatus): boolean {
  return canTransition(status, "cancelled");
}

/// 「恢复」按钮是否可用。
///
/// 为什么不能直接用 canTransition：恢复在状态机里是**两跳**——paused → interrupted → 具体阶段
/// （见 session-status 的注释：让「暂停后恢复」与「崩溃后恢复」共用同一段续跑代码）。
/// UI 上这两跳对用户是一个动作，所以这里判定的是「起点是否为可恢复的静止态」。
export function canResumeSession(status: ResearchSessionStatus): boolean {
  return status === "paused" || status === "interrupted";
}
