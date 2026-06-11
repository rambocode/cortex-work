// agent 会话日志解析的纯函数（与 agent-projects.ts 分离,便于单测——本文件
// 不 import electron）。

// 从会话日志文件头文本抓第一个 "cwd":"..." 字段并解码 JSON 转义。
// Claude Code / Codex 的 jsonl 首行（session 元数据）都带该字段。
export function extractCwd(headText: string): string | null {
  const m = headText.match(/"cwd"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  if (!m) return null;
  try {
    return JSON.parse('"' + m[1] + '"') as string;
  } catch {
    return null;
  }
}
