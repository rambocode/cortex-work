// 工具名清洗的单一实现:消息层(状态文案/过程流)与过程归档共用,避免两处各写一份而漂移。
// 独立成文件是为了打断 messages.ts ↔ process-archive.ts 的模块环。

/**
 * 展示用工具名:claude 把内置 MCP 工具写成 mcp__<server>__<tool>,去前缀让用户一眼看出用了
 * 哪个内置能力(文档抽取 extract_document / 浏览器 browser_*);非 MCP 工具(bash 等)原样。
 */
export function cleanToolName(name: string): string {
  const m = /^mcp__.+?__(.+)$/.exec(name);
  return m ? m[1]! : name;
}

/** 配对/归类用的归一名:MCP 工具名(a__b__c)取末段并转小写,非 MCP 工具只转小写。 */
export function normalizedToolName(name: string | undefined): string {
  const raw = name?.trim().toLowerCase() ?? "";
  const mcpParts = raw.split("__").filter(Boolean);
  return mcpParts.length > 1 ? mcpParts[mcpParts.length - 1]! : raw;
}
