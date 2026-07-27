// `/skill:research` 的派发：在会话里发起一次深度研究。
//
// **为什么不并进 artifactDispatch**：后者的契约是「返回喂给 agent 的 outText」——设计稿与
// 演示文稿都要靠 agent 跑一轮才有产物。研究不经 agent，活由 CRE 引擎干，这条路径上
// 根本没有「要发给谁的文本」。硬塞进同一个函数会让它的返回值对一半调用方是谎言。
//
// 调用点先分叉 research，再走 artifact 派发（见 PersonalChatArea / NewSessionLanding）。
import { parseSkillSlash } from "@cortex-work/core";
import type { ConversationResearchRef, DesktopBridge, SessionMeta } from "@cortex-work/core";
import { useResearchBackgroundStore } from "@cortex-work/core/research/background-watch";
import { useResearchUiStore } from "@cortex-work/core/research/ui-store";
import type { NormalizedResearchEngineSettings } from "@cortex-work/core/research/settings";
import type { SourceScope } from "@cortex-work/core/research/types";

/// 解析一条 `/skill:research <目标>`。不是这个 skill 就返回 null。
///
/// objective 允许为空串（只敲了命令还没写目标）：那不是「解析失败」而是一个要给出
/// 人话提示的状态，两者混成 null 的话调用方就没法区分「用户在发普通消息」和
/// 「用户想研究但忘了写目标」。
export function parseResearchSkill(text: string): { objective: string } | null {
  const parsed = parseSkillSlash(text);
  if (parsed?.name !== "research") return null;
  return { objective: parsed.args };
}

/// 把一条研究引用并进会话的列表，按 sessionId 去重。
///
/// 同 id 原地替换而不是追加：同一条研究被重跑/改名时，会话流里不该多出一张卡。
export function upsertConversationResearch(
  list: ConversationResearchRef[] | undefined,
  ref: ConversationResearchRef,
): ConversationResearchRef[] {
  const next = [...(list ?? [])];
  const index = next.findIndex((candidate) => candidate.sessionId === ref.sessionId);
  if (index === -1) next.push(ref);
  else next[index] = ref;
  return next;
}

export interface ResearchDispatch {
  /// 这条消息是否已被研究派发消费掉。false = 交给后面的产物派发按普通消息处理。
  handled: boolean;
  /// 已建出来的研究引用。**run 失败时仍然有值**——会话已经存在了。
  ref?: ConversationResearchRef;
  /// 人话错误，调用方 toast 出来。有 error 时必然没有 ref。
  error?: string;
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/// 发起一次深度研究。
///
/// **步骤顺序是硬约束，不要重排**：`upsertSession` 必须先于 `run`。研究引擎的事件流按
/// sessionId 找会话，找不到就当未知会话丢弃；先 run 后 upsert 会丢掉开头几条事件，
/// 表现为「点了没反应，过一会儿才动」。`seed` 同理要在 run 之前——漏了它，
/// 研究完成时的 toast 拿不到 objective，会弹出一个没有标题的通知。
///
/// run 失败**不翻转结果**：会话已经建出来了，卡片必须留下，用户要能进面板看失败原因。
/// 启动前就能判定的失败（引擎未开、搜索服务未配置）由引擎抛出，那时错误在面板里，
/// 不在这条派发路径上。
export async function prepareResearchDispatch(
  bridge: DesktopBridge,
  session: SessionMeta,
  text: string,
  settings: NormalizedResearchEngineSettings,
): Promise<ResearchDispatch> {
  const parsed = parseResearchSkill(text);
  if (!parsed) return { handled: false };
  if (!parsed.objective) {
    return { handled: true, error: "请在 /skill:research 后写上研究目标" };
  }
  const research = bridge.research;
  if (!research) return { handled: true, error: "当前客户端不支持深度研究" };

  // 个人记忆是可选来源，默认不进——它会把本机记忆正文送进研究流程（见 settings.ts）。
  const sourceScopes: SourceScope[] = settings.includeMemoryScope
    ? [{ kind: "public_web" }, { kind: "memory" }]
    : [{ kind: "public_web" }];

  let summary;
  try {
    summary = await research.create({
      consumer: "deep_research",
      objective: parsed.objective,
      // 档位与来源范围来自全局默认档（原新建表单已移除，见计划阶段 8）。
      mode: settings.defaultMode,
      sourceScopes,
      // 研究的价值在于可核查，报告一律要求带引用。
      output: { format: "report", requireCitations: true },
      // 只传 id 不传路径：主进程按 id 现查项目目录决定报告归档到哪（防「指挥主进程写任意目录」）。
      // 无项目时**整个键都不给**——main 侧 zod schema 是 .strict()，显式 undefined 也会被拒。
      ...(session.projectId ? { projectId: session.projectId } : {}),
    });
  } catch (e) {
    return { handled: true, error: errorText(e) };
  }

  // 先登记再启动（见上方顺序约束）。
  useResearchUiStore.getState().upsertSession(summary);
  useResearchUiStore.getState().selectSession(summary.sessionId);
  useResearchBackgroundStore.getState().seed([summary]);

  try {
    await research.run(summary.sessionId);
  } catch {
    // 启动失败不吞会话：状态与原因经事件流进面板，这里保持沉默比弹个 toast 更准确
    // （引擎可能已经把 failed 状态推过来了，再 toast 一次是重复告知）。
  }

  return {
    handled: true,
    ref: {
      sessionId: summary.sessionId,
      objective: parsed.objective,
      // 用引擎记录的创建时间而非本地 Date.now()：会话流里的排序要与后端对得上。
      createdAt: Date.parse(summary.createdAt) || Date.now(),
      ...(session.projectId ? { projectId: session.projectId } : {}),
    },
  };
}
