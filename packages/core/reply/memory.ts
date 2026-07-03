// 分区记忆的纯逻辑层:数据模型、语气蒸馏 prompt 构建/清洗,以及注入 user profile 的组合规则。
//
// 与源项目(ReplyClone `MemoryStore`)的差异(KTD6):本项目不落 markdown 文件,记忆改由 store 分片持久化,
// 因此源项目「## ⟨auto⟩」标记的 parse/render 往返不迁移——每个分区直接用 `{manual, auto}` 双字段结构承载,
// 顺带修复源项目多个自动区共用同一变量的缺陷(此处每个分区独立字段,天然隔离)。

/// 记忆分区:档案(你是谁)+ 四个语气分区(通用/IM/邮件/公开)。
/// 手写补充(manual)优先级高于自动学到(auto),注入 prompt 时显式标注。
export type MemoryScope = "profile" | "core" | "im" | "email" | "publicVoice";

/// 全部分区,顺序即设置页展示顺序;数量固定 5(有测试保证,防解包缺口)。
export const MEMORY_SCOPES: readonly MemoryScope[] = [
  "profile",
  "core",
  "im",
  "email",
  "publicVoice",
];

/// 每个分区最多保留的学习样本数,超过后 FIFO 淘汰最旧的(仅内存态,KTD8:样本不落盘)。
export const SAMPLE_LIMIT = 30;

/// 分区的静态元数据:中文名(UI 寻址)与蒸馏采集目标(喂给蒸馏 prompt 描述该分区学什么)。
interface ScopeMeta {
  chineseName: string;
  distillTarget: string;
}

const SCOPE_META: Record<MemoryScope, ScopeMeta> = {
  profile: {
    chineseName: "档案",
    distillTarget: "关于用户本人的事实（角色、公司、项目、关键的人）",
  },
  core: {
    chineseName: "通用",
    distillTarget: "所有渠道通用的核心写法（句长、语气、用词习惯、中英混用等）",
  },
  im: {
    chineseName: "IM",
    distillTarget: "IM 场景的形态规则（短、随意、是否用称呼/署名/emoji）",
  },
  email: {
    chineseName: "邮件",
    distillTarget: "邮件场景的形态规则（称呼、署名、分段、正式程度）",
  },
  publicVoice: {
    chineseName: "公开",
    distillTarget: "公开平台发言的形态规则（面向受众、简洁有观点）",
  },
};

/// 一个分区的两段内容:手写区 + 自动学习区。
export interface MemoryFile {
  manual: string;
  auto: string;
}

/// 全部分区的记忆状态,持久化(store 分片)与注入组合都以此为单一来源。
export type MemoryState = Record<MemoryScope, MemoryFile>;

/// 取分区中文名(设置页 tab 与 UI 寻址用)。
export function scopeChineseName(scope: MemoryScope): string {
  return SCOPE_META[scope].chineseName;
}

/// 蒸馏 prompt 里向模型描述该分区的采集目标。
export function scopeDistillTarget(scope: MemoryScope): string {
  return SCOPE_META[scope].distillTarget;
}

/// 由中文名反查分区(UI 迁移/寻址用);未命中返回 undefined。
export function scopeFromChineseName(name: string): MemoryScope | undefined {
  return MEMORY_SCOPES.find((scope) => SCOPE_META[scope].chineseName === name);
}

/// 生成一个全空的记忆状态(每个分区 manual/auto 均为空),供 store hydrate 兜底。
export function emptyMemoryState(): MemoryState {
  return {
    profile: { manual: "", auto: "" },
    core: { manual: "", auto: "" },
    im: { manual: "", auto: "" },
    email: { manual: "", auto: "" },
    publicVoice: { manual: "", auto: "" },
  };
}

// MARK: - 学习样本(内存态)

/// 追加一条学习样本并返回新数组(纯函数,不改入参)。
/// 空白样本忽略;超过上限时 FIFO 淘汰最旧的,避免样本无限增长。
export function appendSample(
  samples: readonly string[],
  text: string,
  limit = SAMPLE_LIMIT,
): string[] {
  const trimmed = text.trim();
  if (trimmed.length === 0) return [...samples];
  const next = [...samples, trimmed];
  // 超限时从头部(最旧)截断,只保留最近 limit 条
  if (next.length > limit) {
    return next.slice(next.length - limit);
  }
  return next;
}

// MARK: - 语气蒸馏

/// 蒸馏 prompt 的输出形态(system/user 两段),交给默认 agent 单发执行(U10 接线)。
/// 形状与 U1 的 ReplyPrompt 一致;此处独立声明避免 U1/U2 并行时的模块耦合。
export interface DistillPrompt {
  system: string;
  user: string;
}

/// 构造「从用户发出的消息蒸馏语气规则」的 prompt。
/// 输入某分区历史样本 + 已学规则,要求模型合并成一份新的要点清单(≤10 条)。
export function buildDistillPrompt(
  scope: MemoryScope,
  samples: readonly string[],
  existingAuto: string,
): DistillPrompt {
  const system = `你是一个写作风格分析器。根据用户真实发出的消息,总结${scopeDistillTarget(
    scope,
  )}。
要求：
- 只输出要点列表,每行一条,以「- 」开头,不超过 10 条
- 总结的是稳定的写作习惯,不是单条消息的内容;忽略偶发情况
- 与「已学到的规则」合并:仍然成立的保留,矛盾的以新样本为准
- 不要输出任何解释、标题或多余文字`;

  const sections: string[] = [];
  const trimmedAuto = existingAuto.trim();
  if (trimmedAuto.length > 0) {
    sections.push(`已学到的规则：\n${trimmedAuto}`);
  }
  const numbered = samples
    .map((sample, index) => `${index + 1}. ${sample}`)
    .join("\n");
  sections.push(`用户最近发出的消息样本：\n${numbered}`);
  return { system, user: sections.join("\n\n") };
}

/// 清理模型输出:只保留要点行(`- ` 或 `• ` 开头),防止小模型夹带解释性文字污染记忆。
export function cleanDistilledRules(output: string): string {
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("- ") || line.startsWith("• "))
    .join("\n");
}

// MARK: - 注入 user profile

/// 按捕获到的目标应用判断语气分区:邮件类应用归「邮件」,其余按 IM 处理。
/// (源项目 `channelScopeForCapturedApp`:自动样本采集只路由 im/email,publicVoice 本期不自动命中。)
export function channelScopeForCapturedApp(app: {
  bundleId?: string;
  name?: string;
}): "im" | "email" {
  const haystack = `${app.bundleId ?? ""} ${app.name ?? ""}`.toLowerCase();
  const mailMarkers = ["mail", "gmail", "outlook", "spark", "airmail", "邮件"];
  return mailMarkers.some((marker) => haystack.includes(marker)) ? "email" : "im";
}

/// 组合 prompt 的 user profile:基础档案 + 记忆分区(档案/通用恒注入,IM/邮件按捕获应用二选一)。
/// 每个分区手写在前、自动学到的在后;手写内容明确标注「优先级最高」,冲突时让模型以手写为准。
export function composeUserProfile(params: {
  userProfile?: string;
  memory: MemoryState;
  capturedApp: { bundleId?: string; name?: string };
}): string {
  const { userProfile, memory, capturedApp } = params;
  const parts: string[] = [];
  const trimmedProfile = (userProfile ?? "").trim();
  if (trimmedProfile.length > 0) {
    parts.push(trimmedProfile);
  }
  // 恒注入 profile+core,再按捕获应用类别追加 im 或 email(publicVoice 不参与自动注入)
  const scopes: MemoryScope[] = ["profile", "core", channelScopeForCapturedApp(capturedApp)];
  for (const scope of scopes) {
    const file = memory[scope];
    const manual = file.manual.trim();
    const auto = file.auto.trim();
    if (manual.length > 0) {
      parts.push(
        `「${scopeChineseName(scope)}」手写补充（优先级最高，与其他信息冲突时以此为准）：\n${manual}`,
      );
    }
    if (auto.length > 0) {
      parts.push(`「${scopeChineseName(scope)}」从用户历史消息学到的写法：\n${auto}`);
    }
  }
  return parts.join("\n\n");
}
