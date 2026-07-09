// 编辑重发时同步截断 agent CLI 的会话记忆文件（尽力而为）。
// - claude: ~/.claude/projects/<munged-cwd>/<session-id>.jsonl,append-only 事件流,
//   user 行 message.content 为 prompt 原文（parentUuid 线性链,尾部截断后仍自洽）。
// - codex:  ~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<thread-id>.jsonl,
//   用户轮是 {type:"response_item",payload:{type:"message",role:"user",content:[{type:"input_text",text}]}}。
// 安全策略:严格按「原文 + 同文序号」匹配,找不到/越界一律放弃(返回 false,
// 调用方退化为带旧记忆 resume);截断前写 .bak 备份;格式属 CLI 内部实现,
// 解析失败同样静默放弃。
// 不 import electron,便于单测(同 git-info.ts 模式);IPC 注册在 cli.ts。

import { promises as fsp, existsSync, readdirSync } from "fs";
import { join, dirname, basename } from "path";
import { homedir } from "os";
import { randomUUID } from "crypto";
import type { AgentSessionRequest, TrimSessionRequest } from "./types";

function safeParse(line: string): Record<string, unknown> | null {
  try {
    const o = JSON.parse(line);
    return o && typeof o === "object" ? (o as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

// claude:user 行的 prompt 文本(content 为 string,或块数组里的 text 块拼接)。
function claudeUserText(o: Record<string, unknown>): string | null {
  if (o.type !== "user" || o.isSidechain) return null;
  const message = o.message as Record<string, unknown> | undefined;
  const content = message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const texts = (content as Record<string, unknown>[]).filter((b) => b?.type === "text").map((b) => b.text);
    if (texts.length && texts.every((t) => typeof t === "string")) return texts.join("");
  }
  return null;
}

// codex:response_item 用户轮的 input_text 拼接。
function codexUserText(o: Record<string, unknown>): string | null {
  if (o.type !== "response_item") return null;
  const p = o.payload as Record<string, unknown> | undefined;
  if (p?.type !== "message" || p.role !== "user") return null;
  const content = p.content;
  if (!Array.isArray(content)) return null;
  const texts = (content as Record<string, unknown>[]).filter((b) => b?.type === "input_text").map((b) => b.text);
  if (texts.length && texts.every((t) => typeof t === "string")) return texts.join("");
  return null;
}

function matchIndexes(
  lines: string[],
  promptText: string,
  extract: (o: Record<string, unknown>) => string | null,
  alsoMatch?: (text: string) => boolean,
): number[] {
  const out: number[] = [];
  lines.forEach((line, i) => {
    const o = safeParse(line);
    if (!o) return;
    const text = extract(o);
    if (text === null) return;
    if (text === promptText || (alsoMatch?.(text) ?? false)) out.push(i);
  });
  return out;
}

/** 返回应截断的起始行号;找不到/同文序号越界返回 -1。 */
export function claudeTrimIndex(lines: string[], promptText: string, occurrence: number): number {
  return matchIndexes(lines, promptText, claudeUserText)[occurrence] ?? -1;
}

export function codexTrimIndex(lines: string[], promptText: string, occurrence: number): number {
  // 带附件时 prompt 被包进 <user_request> 块(codex adapter 的 promptWithSkills)。
  const needle = `<user_request>\n${promptText}\n</user_request>`;
  return matchIndexes(lines, promptText, codexUserText, (t) => t.endsWith(needle))[occurrence] ?? -1;
}

function findClaudeSessionFile(sessionId: string, home = homedir()): string | null {
  const root = join(home, ".claude", "projects");
  try {
    for (const dir of readdirSync(root)) {
      const p = join(root, dir, `${sessionId}.jsonl`);
      if (existsSync(p)) return p;
    }
  } catch {
    /* 目录不存在等 */
  }
  return null;
}

function findCodexSessionFile(threadId: string, home = homedir()): string | null {
  const root = join(home, ".codex", "sessions");
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop()!;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.name.endsWith(`${threadId}.jsonl`)) return p;
    }
  }
  return null;
}

/** 只读校验 agent CLI 会话文件是否还在本机;pi 没有外部会话文件,恒返回 true。 */
export function agentSessionExists(req: AgentSessionRequest, home = homedir()): boolean {
  if (req.agent === "pi") return true;
  const path =
    req.agent === "claude"
      ? findClaudeSessionFile(req.agentSessionId, home)
      : findCodexSessionFile(req.agentSessionId, home);
  return path !== null;
}

/** 截断会话文件到 fromLine 之前(写 .bak 备份)。供测试直接调用。 */
export async function trimSessionFile(path: string, raw: string, fromLine: number): Promise<void> {
  await fsp.writeFile(path + ".bak", raw, "utf8");
  const kept = raw.split("\n").slice(0, fromLine).join("\n");
  await fsp.writeFile(path, kept ? kept + "\n" : "", "utf8");
}

// 把单行 JSONL 中的会话 id 改写为 newId(分支复制用):
// - claude:每行事件都带顶层 sessionId 字段;
// - codex:只有 session_meta 行的 payload.id 是 thread id。
// 解析失败/无 id 字段的行原样保留(不破坏未知格式)。
function rewriteSessionIdLine(line: string, agent: "claude" | "codex", newId: string): string {
  const o = safeParse(line);
  if (!o) return line;
  if (agent === "claude") {
    if (typeof o.sessionId === "string") {
      o.sessionId = newId;
      return JSON.stringify(o);
    }
    return line;
  }
  if (o.type === "session_meta") {
    const p = o.payload as Record<string, unknown> | undefined;
    if (p && typeof p.id === "string") {
      p.id = newId;
      return JSON.stringify(o);
    }
  }
  return line;
}

export interface TrimIntoCopyResult {
  newSessionId: string;
}

/**
 * 分支重新生成用:把会话记忆文件「复制为新 id + 截断副本」,源文件原样保留(旧分支据原 resume id 续聊)。
 * 副本逐行改写会话 id(claude 每行 sessionId / codex session_meta.payload.id),否则 CLI resume 校验会拒。
 * 找不到文件/匹配不到截断点/任何 IO 失败 → null(调用方降级为破坏式 trimAgentSession,旧分支转只读)。
 * forcedNewId / home 仅供单测注入确定性 id 与假 HOME。
 */
export async function trimSessionIntoCopy(
  req: TrimSessionRequest,
  forcedNewId?: string,
  home = homedir(),
): Promise<TrimIntoCopyResult | null> {
  if (req.agent !== "claude" && req.agent !== "codex") return null;
  try {
    const path =
      req.agent === "claude" ? findClaudeSessionFile(req.agentSessionId, home) : findCodexSessionFile(req.agentSessionId, home);
    if (!path) return null;
    const raw = await fsp.readFile(path, "utf8");
    const lines = raw.split("\n");
    const idx =
      req.agent === "claude"
        ? claudeTrimIndex(lines, req.promptText, req.occurrence)
        : codexTrimIndex(lines, req.promptText, req.occurrence);
    // idx<=0:找不到、或会清到文件头(首轮刷新走「重开会话」路径,不该到这里)。
    if (idx <= 0) return null;
    const newId = forcedNewId ?? randomUUID();
    const kept = lines.slice(0, idx).map((line) => rewriteSessionIdLine(line, req.agent as "claude" | "codex", newId));
    // 新文件名沿用原命名规则:claude 直接 <newId>.jsonl;codex 保留 rollout-<ts>- 前缀只换 thread id。
    const newPath =
      req.agent === "claude"
        ? join(dirname(path), `${newId}.jsonl`)
        : join(dirname(path), basename(path).replace(`${req.agentSessionId}.jsonl`, `${newId}.jsonl`));
    if (newPath === path || existsSync(newPath)) return null; // 防覆盖(文件名替换失败或 id 撞车)
    await fsp.writeFile(newPath, kept.join("\n") + "\n", "utf8");
    return { newSessionId: newId };
  } catch {
    return null;
  }
}

/** 截断 agent CLI 会话记忆;任何失败返回 false(调用方退化为带旧记忆 resume)。 */
export async function trimAgentSession(req: TrimSessionRequest): Promise<boolean> {
  try {
    const path =
      req.agent === "claude" ? findClaudeSessionFile(req.agentSessionId) : findCodexSessionFile(req.agentSessionId);
    if (!path) return false;
    const raw = await fsp.readFile(path, "utf8");
    const lines = raw.split("\n");
    const idx =
      req.agent === "claude"
        ? claudeTrimIndex(lines, req.promptText, req.occurrence)
        : codexTrimIndex(lines, req.promptText, req.occurrence);
    // idx<=0:找不到、或会清到文件头(首轮编辑走「重开会话」路径,不该到这里)。
    if (idx <= 0) return false;
    await trimSessionFile(path, raw, idx);
    return true;
  } catch {
    return false;
  }
}
