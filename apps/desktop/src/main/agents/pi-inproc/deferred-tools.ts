// Pi 会话的延迟工具目录：工具仍完整注册、审批与执行链不变，但首轮只向模型暴露一小组高频工具。
// 模型需要浏览器、自动化、日历、delegate、用户 MCP 等能力时，先调用 tool_search；该调用在
// 同一 agent turn 内激活匹配工具，并通过 addedToolNames 让支持原生 deferred tools 的 provider
// 只在当前位置加载 schema。其它 provider 会在下一次模型调用收到新激活工具的完整 schema。

import type { ExtensionAPI, InlineExtension, ToolDefinition } from "@earendil-works/pi-coding-agent";

import { PI_TOOL_SEARCH_NAME } from "./tools";

const DEFAULT_RESULT_LIMIT = 8;
const MAX_RESULT_LIMIT = 12;
const RESULT_DESCRIPTION_LIMIT = 180;
const SCHEMA_SEARCH_LIMIT = 6_000;

type ToolInfo = ReturnType<ExtensionAPI["getAllTools"]>[number];

export interface DeferredToolsOptions {
  /**
   * 物理准入名单。undefined 表示所有已注册工具均可发现；plan 模式传真实 toolWhitelist，
   * tool_search 只能激活名单内工具，不能把只读模式重新扩成 write/bash/gui_*。
   */
  allowedToolNames?: readonly string[];
  /** 首次 provider request 直接携带的高频工具；不存在或不在 allowedToolNames 的名字会被忽略。 */
  initialToolNames: readonly string[];
}

function asToolSchema(schema: Record<string, unknown>): ToolDefinition["parameters"] {
  return schema;
}

const TOOL_SEARCH_SCHEMA = asToolSchema({
  type: "object",
  additionalProperties: false,
  properties: {
    query: {
      type: "string",
      minLength: 2,
      maxLength: 160,
      description: "A concise capability, action, or exact tool name to find.",
    },
    limit: {
      type: "integer",
      minimum: 1,
      maximum: MAX_RESULT_LIMIT,
      description: `Maximum tools to activate (default ${DEFAULT_RESULT_LIMIT}).`,
    },
  },
  required: ["query"],
});

function normalized(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[_./:-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const SEARCH_STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "for",
  "in",
  "of",
  "on",
  "please",
  "the",
  "to",
  "tool",
  "tools",
  "use",
  "with",
]);

// 目录搜索不能假设用户措辞、模型查询词与工具描述使用同一种语言。别名只参与本地评分，
// 不进入 system prompt 或 provider payload；因此可以覆盖常见产品概念而不增加首轮 token。
const CAPABILITY_ALIASES: readonly (readonly string[])[] = [
  ["browser", "browse", "webpage", "website", "url", "浏览器", "网页"],
  ["automation", "schedule", "timer", "reminder", "自动化", "定时", "提醒"],
  ["calendar", "event", "meeting", "reminder", "日历", "日程", "会议"],
  ["computer", "desktop", "screen", "gui", "mouse", "keyboard", "电脑", "桌面", "屏幕", "鼠标", "键盘"],
  ["knowledge", "wiki", "memory", "知识库", "知识", "记忆"],
  ["media", "image", "video", "audio", "图片", "图像", "视频", "音频"],
  ["document", "pdf", "docx", "extract", "文档", "提取"],
  ["workflow", "pipeline", "flow", "工作流", "流程"],
  ["delegate", "subagent", "collaborator", "委派", "协作者", "子代理"],
  ["research", "search", "web", "internet", "联网", "检索", "搜索"],
];

function aliasMatches(term: string, alias: string): boolean {
  if (term === alias) return true;
  const minPrefix = /[\u3400-\u9fff]/u.test(term + alias) ? 2 : 4;
  return term.length >= minPrefix && alias.length >= minPrefix &&
    (term.includes(alias) || alias.includes(term));
}

function queryTerms(query: string): string[] {
  const terms = normalized(query).match(/[\p{L}\p{N}]+/gu) ?? [];
  const useful = terms.filter((term) => term.length > 1 && !SEARCH_STOP_WORDS.has(term));
  const expanded = new Set(useful.length ? useful : terms);
  for (const aliases of CAPABILITY_ALIASES) {
    if ([...expanded].some((term) => aliases.some((alias) => aliasMatches(term, alias)))) {
      for (const alias of aliases) expanded.add(alias);
    }
  }
  return [...expanded];
}

function schemaSearchText(tool: ToolInfo): string {
  try {
    return normalized(JSON.stringify(tool.parameters).slice(0, SCHEMA_SEARCH_LIMIT));
  } catch {
    // 第三方扩展可能交出不可序列化的 schema；搜索降级不能阻断整个会话建立。
    return "";
  }
}

function scoreTool(tool: ToolInfo, query: string, terms: readonly string[]): number {
  const name = normalized(tool.name);
  const description = normalized(String(tool.description ?? ""));
  const schema = schemaSearchText(tool);
  const compactName = name.replace(/\s/g, "");
  const compactQuery = normalized(query).replace(/\s/g, "");
  const nameParts = name.split(" ");
  let score = 0;

  if (compactName === compactQuery) score += 1_000;
  else if (compactQuery.length >= 2 && compactName.includes(compactQuery)) score += 320;
  if (description.includes(normalized(query))) score += 180;

  for (const term of terms) {
    if (nameParts.includes(term)) score += 100;
    else if (name.includes(term)) score += 70;
    else if (
      term.length >= 5 &&
      nameParts.some((part) => part.length >= 5 && part.slice(0, 5) === term.slice(0, 5))
    ) {
      // browse/browsing/browser 这类自然词形不值得引入词干依赖；五字符前缀已足够且确定。
      score += 45;
    }
    if (description.includes(term)) score += 32;
    if (schema.includes(term)) score += 12;
  }
  return score;
}

function conciseDescription(value: string | undefined): string {
  const text = (value ?? "").replace(/\s+/g, " ").trim();
  if (!text) return "No description.";
  return text.length > RESULT_DESCRIPTION_LIMIT ? `${text.slice(0, RESULT_DESCRIPTION_LIMIT)}…` : text;
}

function clampedLimit(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_RESULT_LIMIT;
  return Math.max(1, Math.min(MAX_RESULT_LIMIT, Math.trunc(value)));
}

function uniqueKnownNames(
  names: readonly string[],
  known: ReadonlySet<string>,
  allowed: ReadonlySet<string> | undefined,
): string[] {
  return [...new Set(names)].filter((name) => known.has(name) && (!allowed || allowed.has(name)));
}

/**
 * 创建一份延迟工具目录扩展。
 *
 * Interface 只有准入名单和首轮常驻名单；工具索引、搜索排序、provider deferred 标记与激活状态
 * 全部封装在本模块内。调用方仍照常注册工具，不需要知道具体 provider 是否支持原生延迟 schema。
 */
export function createDeferredToolsExtension(options: DeferredToolsOptions): InlineExtension {
  const allowed = options.allowedToolNames ? new Set(options.allowedToolNames) : undefined;

  return {
    name: "cortex-deferred-tools",
    factory: (pi: ExtensionAPI) => {
      pi.registerTool({
        name: PI_TOOL_SEARCH_NAME,
        label: "Tool Search",
        description:
          "Search the registered Cortex tool catalog and activate relevant tools without restarting the session. Use this before saying a capability is unavailable.",
        promptSnippet:
          "tool_search - find and activate browser, automation, calendar, knowledge, media, delegate, and other deferred tools",
        promptGuidelines: [
          "When the active tools cannot perform the user's request, call tool_search with a concise capability phrase before claiming the capability is unavailable.",
          "After tool_search succeeds, use the newly activated tools in the same turn. Search again with a narrower phrase if another step is still missing.",
        ],
        parameters: TOOL_SEARCH_SCHEMA,
        // 同一 assistant message 若并行发两次搜索，后完成者会用旧 active 快照覆盖先完成者；
        // 强制串行后每次都在上一批新增工具之上取并集，避免能力随机丢失。
        executionMode: "sequential",
        async execute(_toolCallId, rawParams) {
          const params = rawParams && typeof rawParams === "object"
            ? rawParams as { query?: unknown; limit?: unknown }
            : {};
          const query = typeof params.query === "string" ? params.query.trim().slice(0, 160) : "";
          const terms = queryTerms(query);
          if (!query || terms.length === 0) {
            throw new Error("tool_search requires a non-empty capability query.");
          }

          const active = pi.getActiveTools();
          const activeSet = new Set(active);
          const candidates = pi
            .getAllTools()
            .filter((tool) => tool.name !== PI_TOOL_SEARCH_NAME && (!allowed || allowed.has(tool.name)))
            .map((tool) => ({ tool, score: scoreTool(tool, query, terms) }))
            .filter((item) => item.score > 0)
            .sort((a, b) => b.score - a.score || a.tool.name.localeCompare(b.tool.name));
          // 搜索的目的是真正补齐 deferred 能力；已 active 的高分工具不能吃掉结果上限，
          // 否则“read document, limit=1”会只返回 read，永远激活不了 extract_document。
          const inactive = candidates.filter((item) => !activeSet.has(item.tool.name));
          const matched = (inactive.length ? inactive : candidates).slice(0, clampedLimit(params.limit));
          const added = matched.map((item) => item.tool.name).filter((name) => !activeSet.has(name));

          if (added.length > 0) pi.setActiveTools([...active, ...added]);

          const lines = matched.map(
            ({ tool }) => `- ${tool.name}: ${conciseDescription(tool.description)}`,
          );
          const text = matched.length
            ? [
                `Matched ${matched.length} tool(s); activated ${added.length} new tool(s).`,
                ...lines,
                "Use the activated tools now. Search again with a narrower query if a required action is still missing.",
              ].join("\n")
            : `No deferred tools matched "${query}". Try a shorter capability phrase or an exact tool name.`;

          return {
            content: [{ type: "text" as const, text }],
            details: { query, matches: matched.map((item) => item.tool.name), added },
            // 显式回传而不只依赖 Pi 的 extension wrapper 差分：这让 provider 原生 deferred
            // 序列化语义在未来 wrapper 调整后仍稳定；wrapper 会对重复名字自动去重。
            ...(added.length ? { addedToolNames: added } : {}),
          };
        },
      });

      pi.on("session_start", () => {
        const known = new Set(pi.getAllTools().map((tool) => tool.name));
        const initial = uniqueKnownNames(
          [PI_TOOL_SEARCH_NAME, ...options.initialToolNames],
          known,
          allowed,
        );
        // tool_search 是只改变本会话 active set 的控制面，即使 plan 白名单不含它也必须保留；
        // execute 内仍以 allowed 做二次过滤，所以它无法借搜索激活任何越权工具。
        if (known.has(PI_TOOL_SEARCH_NAME) && !initial.includes(PI_TOOL_SEARCH_NAME)) {
          initial.unshift(PI_TOOL_SEARCH_NAME);
        }
        pi.setActiveTools(initial);
      });
    },
  };
}
