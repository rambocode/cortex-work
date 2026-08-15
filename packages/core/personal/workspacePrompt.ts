// 会话工作目录（workspace）的系统提示块。
//
// 为什么需要它：会话的 cwd 一路传到了 agent 进程（pi 经 createAgentSessionServices、
// claude/codex 经 spawn 的 cwd），但 Cortex 自己从不把它写进提示词，全靠各端底层 CLI/SDK
// 自带那一行——pi 的默认 system prompt 只在**最末尾**追加一行裸的
// `Current working directory: <path>`，容易被淹没。这里把它显式写成一段独立的块。
//
// **刻意不写任何范围限制**（不写「只在该目录内检索」「不要越出上层」之类）：那会削掉 agent
// 本来就有的能力——跨目录查找、读取系统级配置、访问用户明确提到的其它路径都是正常需求。
// 这里只陈述事实，让模型知道自己在哪、相对路径怎么解析，剩下的交给它自己判断。
//
// claude / codex / pi 三端共用同一份文本，避免各端行为漂移。
//
// 块的正文用**英文**：这是全局约定 —— 发给 LLM 的系统提示一律英文（遵循度更稳、token 更省），
// 与「和用户用中文交流」「代码注释用中文」互不冲突。改这里时别顺手翻回中文。

/**
 * 渲染会话工作目录的系统提示块。
 *
 * 刻意做成纯函数、不读 store：调用方（发送链路）手上的 cwd 已经是最终值
 * （`artifact?.workspaceRoot ?? projectPath`，其中 projectPath 对无项目会话是
 * `session.noProjectDir`），这里再去 store 里推一次只会引入第二个真相。
 * @param cwd - 会话的工作目录绝对路径；空值（无项目且缺 noProjectDir 的旧会话）返回 undefined。
 * @returns 提示块文本；cwd 为空时返回 undefined（此时 cwd 由主进程 resolveSpawnCwd 兜底，
 *   渲染端并不知道最终落在哪，宁可不写也不能写一个错的路径）。
 */
export function buildWorkspaceSystemPrompt(cwd: string | undefined): string | undefined {
  const path = cwd?.trim();
  if (!path) return undefined;
  return [
    "<workspace>",
    `Current working directory (workspace root): ${path}`,
    "Relative paths resolve against this directory.",
    "</workspace>",
  ].join("\n");
}
