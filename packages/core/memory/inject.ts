// 用户记忆注入 prompt 的组装层：三大工作台（会话/写作/设计）发起 agent 回合时各调一次
// buildMemoryAppend()，把语义记忆并入 CliStartRequest.appendSystemPrompt（唯一物理通道，
// claude 走 --append-system-prompt、codex prompt-wrap、pi 每轮前缀，见 personal/messages.ts）。
//
// 纯组装逻辑抽成 composeMemoryAppend（可单测）；buildMemoryAppend 负责读 store（记忆缓存 +
// memoryEnabled 开关），模式对齐 messages.ts 的 buildGlobalAppend。

import { stripUserMemoryComments } from "./markdown";
import {
  USER_MEMORY_SCOPES,
  userMemoryScopeName,
  type UserMemoryState,
} from "./memory";
import { useMemoryStore } from "../store/memory";
import { usePersonalStore } from "../store/personal";

/// 注入内容的总字符预算：记忆是每轮都注入的常驻开销，必须有硬上限。
/// 超出时按分区优先级截断（USER_MEMORY_SCOPES 顺序：画像 > 偏好 > 项目，后面的整段弃）。
export const MEMORY_APPEND_BUDGET = 1500;

const HEADER =
  "以下是跨会话持久的用户记忆（由过往会话自动整理 + 用户手写），供你了解用户背景与偏好；「手写」部分优先级最高，与其它信息冲突时以手写为准：";

/// 纯组装：把记忆状态渲染成注入段。全部分区为空 → undefined（append 数组 filter 掉）。
export function composeMemoryAppend(
  memory: UserMemoryState,
  budget: number = MEMORY_APPEND_BUDGET,
): string | undefined {
  const sections: string[] = [];
  let used = 0;
  for (const scope of USER_MEMORY_SCOPES) {
    const file = memory[scope];
    // 防御半缺结构（正常经 normalizeUserMemory 后不会出现，跨版本 IPC 兜底）。
    if (!file) continue;
    const manual = stripUserMemoryComments(file.manual ?? "");
    const auto = stripUserMemoryComments(file.auto ?? "");
    const parts: string[] = [];
    if (manual.length > 0) parts.push(`手写补充：\n${manual}`);
    if (auto.length > 0) parts.push(`自动整理：\n${auto}`);
    if (parts.length === 0) continue;
    const section = `【${userMemoryScopeName(scope)}】\n${parts.join("\n")}`;
    // 预算截断：整段放不下就弃（分区内部分截断会产生残句，宁缺毋滥）；首个分区超预算时
    // 例外保留（保证手写画像不至于因预算过小完全失效）。
    if (used + section.length > budget && sections.length > 0) break;
    sections.push(section);
    used += section.length;
  }
  if (sections.length === 0) return undefined;
  return `${HEADER}\n\n${sections.join("\n\n")}`;
}

/// 读 store 组装注入段：memoryEnabled 关闭（显式 false）→ undefined；缺省视为开启。
/// 三工作台的 append 组装点各调一次即可（chat 经 buildGlobalAppend 单点覆盖三端 agent）。
export function buildMemoryAppend(): string | undefined {
  // 缺省开启：只有显式 false 才关（旧档无此字段时保持功能可用）。
  if (usePersonalStore.getState().generalSettings.memoryEnabled === false) return undefined;
  return composeMemoryAppend(useMemoryStore.getState().memory);
}
