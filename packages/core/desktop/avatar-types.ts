// 团队分身/服务器工作区会话协议契约 —— 纯类型，无运行时逻辑。
// 与服务端任务终态落库规则对齐（done/unanswerable → CompleteTask；canceled → CancelTask；
// 其余 → FailTask + failure_reason）。
// 注：桌面端执行节点（team-node）与本机审批链路未移植，相关类型（TeamNodeStatus/
// AvatarApprovalRequest/AvatarShareConfig）已随之裁掉；执行点在服务器侧 daemon。

// 分身审批策略：auto = 受理即执行；manual = 拥有者侧审批，批准后才跑。
export type AvatarApprovalPolicy = "auto" | "manual";

// 分身会话终态（8 值）。
export type AvatarSessionOutcome =
  | "done"
  | "unanswerable"
  | "rejected_quota"
  | "rejected_approval"
  | "timeout_approval"
  | "canceled"
  | "interrupted"
  | "failed";

// 分身会话非终态阶段：受理 → 等待审批（manual）→ 运行中。
// queued：服务器共享工作区被占用时的排队态（本仓新增，服务端 invoke 受理但未 dispatch）。
export type AvatarSessionPhase = "accepted" | "waiting_approval" | "running" | "queued";
