// 用户记忆（user memory）的类型真源与分区元数据。
//
// 概念模型（模仿人类记忆分层）：
//   - 情景记忆（episodic）= 已落盘的会话历史（~/.cortex-desktop/chats/*.json），不在此新建存储；
//   - 语义记忆（semantic）= 本模块描述的三分区 markdown 文件（~/.cortex-desktop/memory/*.md），
//     由后台「做梦」任务从情景记忆蒸馏固化，跨会话/写作/设计共享；
//   - 做梦（dream）= 主进程的定时/空闲/手动整理管线（apps/desktop/src/main/memory/dreamer.ts）。
//
// 与 reply 域（core/reply/memory.ts）平行且独立：形状借鉴其成熟实现，但类型/分区完全
// 分离——reply 的记忆服务于「快捷回复的语气」，本模块服务于「用户是谁」的全局记忆。

/// 语义记忆分区：用户画像 / 稳定偏好 / 项目背景。union 预留扩展位（未来可加工作台专区）。
export type UserMemoryScope = "profile" | "preferences" | "projects";

/// 全部分区，顺序即设置页展示顺序与注入 prompt 的优先级顺序（预算截断时后面的先弃）。
export const USER_MEMORY_SCOPES: readonly UserMemoryScope[] = ["profile", "preferences", "projects"];

/// 一个分区的三段内容（spec §14.2）：
///   - manual：手写区，用户直接编辑，**优先级最高**；
///   - auto：自动学习区，做梦从会话历史蒸馏而来；
///   - research：已批准的研究记忆，来自深度研究结论，**每条都有来源可查**。
///
/// research 单列一段而不是并进 auto 的理由：两者的产出者与撤销方式完全不同。
/// 做梦每轮**整段覆盖** auto；research 是用户逐条批准的，绝不能被做梦顺手抹掉
/// （红线见 apps/desktop/src/main/memory/dreamer.ts 与 core/research/knowledge.ts KTD10）。
export interface UserMemoryFile {
  manual: string;
  auto: string;
  research: string;
}

/// 全部分区的记忆状态；主进程 memory-store 与渲染端只读缓存都以此为单一形状。
export type UserMemoryState = Record<UserMemoryScope, UserMemoryFile>;

/// 分区静态元数据：中文名（UI/prompt 标注）+ 做梦蒸馏采集目标（喂给 dream prompt）。
interface ScopeMeta {
  chineseName: string;
  dreamTarget: string;
}

const SCOPE_META: Record<UserMemoryScope, ScopeMeta> = {
  profile: {
    chineseName: "用户画像",
    dreamTarget: "关于用户本人的稳定事实（身份、角色、公司、背景、关键的人与关系）",
  },
  preferences: {
    chineseName: "偏好习惯",
    dreamTarget: "用户的稳定偏好（沟通风格、语言习惯、技术栈与工具偏好、工作方式）",
  },
  projects: {
    chineseName: "项目背景",
    dreamTarget: "用户正在进行的项目与长期目标（项目名称、目标、关键约束、重要进展）",
  },
};

/// 取分区中文名（设置页 tab 与注入 prompt 的分区标注共用）。
export function userMemoryScopeName(scope: UserMemoryScope): string {
  return SCOPE_META[scope].chineseName;
}

/// 做梦 prompt 里向模型描述该分区的采集目标。
export function userMemoryDreamTarget(scope: UserMemoryScope): string {
  return SCOPE_META[scope].dreamTarget;
}

/// 生成全空记忆状态（每分区 manual/auto 均为空串），供 store hydrate 与主进程兜底。
export function emptyUserMemoryState(): UserMemoryState {
  return {
    profile: { manual: "", auto: "", research: "" },
    preferences: { manual: "", auto: "", research: "" },
    projects: { manual: "", auto: "", research: "" },
  };
}

/// 字段级兜底归一：跨 IPC/旧档的半缺结构（分区缺失、manual/auto 为 undefined）补成
/// 恒为字符串的完整 UserMemoryState，保证下游 .trim() 安全（契约同 reply mergeMemory）。
export function normalizeUserMemory(memory: Partial<UserMemoryState> | undefined): UserMemoryState {
  const base = emptyUserMemoryState();
  if (!memory) return base;
  for (const scope of USER_MEMORY_SCOPES) {
    const file = memory[scope] as Partial<UserMemoryFile> | undefined;
    if (file) {
      // research 缺省空串：旧档（三段化之前写的）没有这个字段，必须补齐，
      // 否则下游 .trim() 会在 undefined 上炸。
      base[scope] = { manual: file.manual ?? "", auto: file.auto ?? "", research: file.research ?? "" };
    }
  }
  return base;
}

// MARK: - 做梦水位与结果（主进程 dream-state.json 与 IPC 返回共用的契约类型）

/// 做梦触发来源：手动（设置页按钮）/ 定时（每日深睡）/ 补跑（启动或唤醒超期）/ 空闲（会话结束小睡）。
export type DreamTrigger = "manual" | "scheduled" | "catchup" | "idle";

/// 单会话的已消化水位：做梦成功后推进到采样时的消息数，下次只消化新增部分。
export interface DreamSourceWatermark {
  digestedMsgCount: number;
  digestedAt: number;
}

/// sessionId → 水位。会话删除后残留的键无害（不再匹配任何文件，做梦时自然忽略）。
export type DreamSources = Record<string, DreamSourceWatermark>;

/// 一次做梦的历史记录（设置页「做梦历史」展示，主进程只保留最近若干条）。
export interface MemoryDreamRecord {
  at: number;
  trigger: DreamTrigger;
  /// 本次消化的会话数（0 = 没有新内容）。
  sessionsScanned: number;
  /// 本次成功写入 auto 区的分区数。
  learnedScopes: number;
  ok: boolean;
  error?: string;
}

/// 做梦状态摘要（IPC memory:getDreamState 返回,设置页展示）。
export interface DreamStateSummary {
  lastDreamAt: number | null;
  history: MemoryDreamRecord[];
}

/// 手动「立即整理」的返回结果。error 取值：
///   "in-flight"=已有整理进行中；"no-episodes"=没有新会话内容；
///   "model-not-configured"=LLM 供应商未配置；其余为底层错误信息。
export interface MemoryDreamResult {
  ok: boolean;
  sessionsScanned?: number;
  learnedScopes?: number;
  error?: string;
}
