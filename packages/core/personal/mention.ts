// @mention 解析器（纯函数，无副作用，无 IPC 依赖）。
// 在用户消息文本中识别 @角色名，映射到内置 shortcut 或自定义角色。
// code fence / inline code 内的 @ 跳过。结果去重保序。

import type { RoleConfig } from "../desktop/types";

// 内置 shortcut：@claude / @codex / @pi 无需创建角色直接可用。
// systemPrompt 为空——内置 agent 不附加额外 persona。
export const BUILTIN_ROLES: Record<string, RoleConfig> = {
  claude: {
    id: "claude",
    label: "Claude",
    agent: "claude",
    systemPrompt: "",
    createdAt: "",
    updatedAt: "",
  },
  codex: {
    id: "codex",
    label: "Codex",
    agent: "codex",
    systemPrompt: "",
    createdAt: "",
    updatedAt: "",
  },
  pi: {
    id: "pi",
    label: "Pi",
    agent: "pi",
    systemPrompt: "",
    createdAt: "",
    updatedAt: "",
  },
};

export interface MentionTarget {
  mention: string; // 原始 @ 后的文本
  role: RoleConfig;
}

// 提取所有不在 code fence / inline code 内的 @mention token。
function extractMentionTokens(text: string): string[] {
  const tokens: string[] = [];

  // 按行处理，跟踪 code fence 状态
  const lines = text.split("\n");
  let inFence = false;

  for (const line of lines) {
    // 检测 code fence 开/关
    if (/^```/.test(line.trimStart())) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

    // 在非 fence 行中提取 @mention，跳过 inline code
    // 先把 inline code 区域替换成占位符
    const masked = line.replace(/`[^`]*`/g, (m) => " ".repeat(m.length));

    // 匹配 @mention（支持 Unicode 字母 + 数字 + 下划线 + 连字符）
    const re = /@([\w\p{L}\p{N}_-]+)/gu;
    let match: RegExpExecArray | null;
    while ((match = re.exec(masked)) !== null) {
      if (match[1]) tokens.push(match[1]);
    }
  }

  return tokens;
}

/**
 * 解析用户消息中的 @mention，返回有序去重的调度目标列表。
 *
 * 解析优先级：① 内置 shortcut (id 完全匹配) → ② 自定义角色 id (exact) → ③ 自定义角色 label (包含匹配)。
 * 未匹配的 mention 静默跳过。
 */
export function parseMentions(text: string, roles: RoleConfig[]): MentionTarget[] {
  const tokens = extractMentionTokens(text);
  const results: MentionTarget[] = [];
  const seenIds = new Set<string>();

  for (const token of tokens) {
    const lower = token.toLowerCase();

    // ① 内置 shortcut
    if (BUILTIN_ROLES[lower]) {
      if (!seenIds.has(BUILTIN_ROLES[lower].id)) {
        seenIds.add(BUILTIN_ROLES[lower].id);
        results.push({ mention: token, role: BUILTIN_ROLES[lower] });
      }
      continue;
    }

    // ② 自定义角色 id 精确匹配
    const byId = roles.find((r) => r.id.toLowerCase() === lower);
    if (byId) {
      if (!seenIds.has(byId.id)) {
        seenIds.add(byId.id);
        results.push({ mention: token, role: byId });
      }
      continue;
    }

    // ③ 自定义角色 label 包含匹配（首个命中）
    const byLabel = roles.find((r) => r.label.toLowerCase() === lower);
    if (byLabel) {
      if (!seenIds.has(byLabel.id)) {
        seenIds.add(byLabel.id);
        results.push({ mention: token, role: byLabel });
      }
      continue;
    }

    // 未匹配，静默跳过
  }

  return results;
}
