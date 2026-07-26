// 研究引擎 MCP server：把 CRE 的检索能力暴露给外部 CLI agent（claude / codex / pi）。
//
// **为什么需要它**：应用里的 agent 是外部 CLI 进程，它们能开网页（agent-browser / 内置浏览器
// MCP 都默认注入），但**没有搜索能力**——只能"打开我给的网址"，不能"帮我搜一下"。
// 各家 CLI 自带的 WebSearch 又互不一致（codex 的服务端搜索不回传正文、pi 完全没有），
// 且结果不进 CRE 的证据体系、不受本仓库的 SSRF 与域名策略约束。
//
// 架构复用：完全对照 capabilities/loop-workflows/server.ts 的范式——
//   - 经 createMcpHost('cortex-research') 起独立实例（独立 port/token）；
//   - per-session Map<sessionId, SessionState>：每个 agent session 记录自己的 consumer，
//     决定这次调用受哪个灰度开关约束（chat / slides / writing）；
//   - 注入配置构建在 ./inject（同 capabilities/browser 的拆法）。
//
// 安全决定：
//   1. **不暴露任意 URL 的裸 fetch**。web_read 内部走 QuickRetrieval.prepare，
//      URL 先过 core 的 checkUrlPolicy，再由 Worker 的 safe-request 三道闸把关。
//      直接给 agent 一个 fetch(url) 等于把 SSRF 防线拱手让出。
//   2. **工具集按当前设置动态注册**。registerTools 在每次 HTTP 请求时执行，
//      读的是实时设置快照，所以用户关掉「深度研究」后，deep_research 工具立刻消失，
//      而不是留在列表里等着调用时报错。
//   3. **摘要不是证据**（spec KTD3）。web_search 的 snippet 来自搜索引擎，未经抓取核对，
//      工具描述里明说不得直接当事实引用——要引用必须先 web_read 拿正文。
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ResearchConsumer, ResearchMode } from "@cortex-work/core/research/types";
import { SEARCH_CATEGORIES } from "@cortex-work/core/research/search-api";
import {
  isRetryableSearchError,
  QUICK_RETRIEVAL_LIMITS,
} from "@cortex-work/core/research/quick-types";

import { createMcpHost, type McpHostHandle, type ToolContext } from "../mcp-host/server";
import { createLogger } from "../../log";
import {
  getQuickRetrieval,
  getResearchEngineSettings,
  getResearchService,
} from "../../research/runtime";

const log = createLogger("research-mcp");

/// 注入用 server id（= MCP server 名）。须为 TOML 裸键安全（见 mcp-config.isValidServerId）。
export const RESEARCH_SERVER_ID = "cortex-research";

/// 研究 MCP host 实例（独立 port/token，与浏览器 / 文档抽取 / 媒体生成互不干扰）。
const researchHost = createMcpHost(RESEARCH_SERVER_ID);

// ── 并发会话状态 ─────────────────────────────────────────────────────────────
//
// 每个 agent session 记录它属于哪个 Consumer。这决定两件事：
//   - 受哪个灰度开关约束（chat / slides / writing 各有独立开关）；
//   - CRE 侧的默认预算与信任区上界（core/research/consumer.ts 的 CONSUMER_DEFAULTS）。
// 存 Map 而非全局变量的理由同 loop-workflows：并发 session 会互相覆盖。

interface SessionState {
  consumer: ResearchConsumer;
}

const sessionStateMap = new Map<string, SessionState>();

export function registerResearchSession(sessionId: string, consumer: ResearchConsumer): void {
  sessionStateMap.set(sessionId, { consumer });
}

export function unregisterResearchSession(sessionId: string): void {
  sessionStateMap.delete(sessionId);
}

/// 取本 session 的 Consumer。取不到时回落 "chat"——那是权限最窄的一档
/// （只允许 public_web、quick 预算），未知来源不该拿到更宽的能力。
function consumerOf(ctx: ToolContext): ResearchConsumer {
  return (ctx.sessionId ? sessionStateMap.get(ctx.sessionId)?.consumer : undefined) ?? "chat";
}

// ── 结构化工具结果 ───────────────────────────────────────────────────────────

function makeErrorResult(message: string): {
  content: [{ type: "text"; text: string }];
  isError: true;
} {
  return { content: [{ type: "text", text: message }], isError: true };
}

function makeSuccessResult(
  text: string,
  data?: Record<string, unknown>,
): { content: [{ type: "text"; text: string }] } {
  const fullText = data ? `${text}\n${JSON.stringify(data, null, 2)}` : text;
  return { content: [{ type: "text", text: fullText }] };
}

/// 异常 → 可展示的一句话。**不外泄栈**：错误文本会直接进 agent 的上下文，
/// 栈里可能夹带本地路径。
function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ── 工具注册 ─────────────────────────────────────────────────────────────────

/// 注册研究工具集。**每次 HTTP 请求时调用**（per-request McpServer），
/// 因此这里读到的设置永远是最新的，工具集会随开关实时增减。
export function registerResearchTools(mcp: McpServer, ctx: ToolContext): void {
  const settings = getResearchEngineSettings();

  registerWebSearch(mcp, ctx);
  registerWebRead(mcp, ctx);

  // 深度研究是独立开关：用户可能只想让 agent 能搜一下，不想它自作主张开一个几十分钟的研究任务。
  // 关闭时**不注册**而不是注册了再报错——列在工具表里的东西，模型迟早会去调。
  if (settings.deepResearchEnabled) {
    registerDeepResearch(mcp);
    registerResearchStatus(mcp);
  }
}

/// web_search：只搜不抓。
function registerWebSearch(mcp: McpServer, ctx: ToolContext): void {
  mcp.registerTool(
    "web_search",
    {
      description:
        "联网搜索，返回若干条线索（标题、URL、摘要）。用于查找最新信息、核实事实、发现资料来源。" +
        "\n\n重要：返回的 snippet 是搜索引擎给的摘要，**未经抓取核对，不得直接当作事实引用**。" +
        "要基于某条结果作答，请先用 web_read 取回该 URL 的正文。" +
        `\n单次最多返回 ${QUICK_RETRIEVAL_LIMITS.maxLeads} 条，同一域名最多 3 条。` +
        // 从源头压并发：搜索走的是有配额的第三方 API（免费档常见 1 QPS 量级）。
        // 模型默认倾向于一次甩出四五个查询词，那会直接把配额打满、大半请求被限流。
        // 这句和 maxSearchConcurrency 的闸是一件事的两端——闸兜底，提示减少无效请求。
        "\n\n配额提示：搜索走第三方 API 且有速率限制。请**逐个查询、按需再搜**，" +
        "不要为同一个主题一次性并发多个查询词；先看完上一次的结果再决定要不要继续搜。",
      inputSchema: {
        query: z.string().min(1).max(512).describe("搜索关键词或问题"),
        category: z
          .enum(SEARCH_CATEGORIES)
          .optional()
          .describe("搜索类别：general 通用 / it 技术 / science 科学 / news 新闻"),
        time_range: z
          .enum(["day", "week", "month", "year", "all"])
          .optional()
          .describe("时效范围。查最新动态时用 day/week，查稳定知识时省略"),
        limit: z
          .number()
          .int()
          .min(1)
          .max(QUICK_RETRIEVAL_LIMITS.maxLeads)
          .optional()
          .describe("期望的结果条数"),
      },
    },
    async (args: {
      query: string;
      category?: (typeof SEARCH_CATEGORIES)[number];
      time_range?: "day" | "week" | "month" | "year" | "all";
      limit?: number;
    }) => {
      try {
        const result = await getQuickRetrieval().discover({
          consumer: consumerOf(ctx),
          query: args.query,
          ...(args.category ? { categories: [args.category] } : {}),
          ...(args.time_range ? { timeRange: args.time_range } : {}),
          ...(args.limit !== undefined ? { limit: args.limit } : {}),
        });

        if (result.leads.length === 0) {
          // 「上游故障」与「这个词确实没结果」必须给模型相反的信号：
          //   没命中 → 换个说法再试是合理的下一步；
          //   限流/故障 → 再搜只会加剧，必须让它停下。
          //
          // 曾经两者共用「没有搜到相关结果」+ makeSuccessResult，于是 Brave 免费档被打限流时，
          // 模型换个词继续搜、并发更多、限流更重，用户看到的是一轮对话里反复"没搜到"。
          const upstreamErrors = result.providerErrors ?? [];
          if (upstreamErrors.length > 0) {
            const codes = upstreamErrors.map((e) => `${e.provider}: ${e.code}`).join("；");
            const rateLimited = upstreamErrors.some((e) => isRetryableSearchError(e.code));
            // 已在 QuickRetrieval 里退避重试过（见 searchRetries），走到这里说明重试也没救回来。
            const advice = rateLimited
              ? "上游搜索服务当前被限流或临时不可用（已自动重试仍失败）。请不要立即重复搜索——" +
                "换关键词也一样会被限流。可以先用已有信息作答并如实说明这一点，或改用 web_read 抓取你已知的具体网址。"
              : "上游搜索服务返回了错误，本次搜索未能执行。请不要反复重试同一查询；" +
                "可以先用已有信息作答并如实说明这一点。";
            return makeErrorResult(`web_search 未能取到结果（${codes}）。${advice}`);
          }
          return makeSuccessResult("没有搜到相关结果（搜索未命中）", {
            leads: [],
            warnings: result.warnings,
          });
        }

        const summary = result.leads
          .map((lead, i) => `${i + 1}. ${lead.title}\n   ${lead.url}${lead.snippet ? `\n   ${lead.snippet}` : ""}`)
          .join("\n");
        return makeSuccessResult(`找到 ${result.leads.length} 条线索：\n${summary}`, {
          leads: result.leads,
          ...(result.warnings.length > 0 ? { warnings: result.warnings } : {}),
        });
      } catch (e) {
        log.warn("[web_search] 失败", describeError(e));
        return makeErrorResult(`web_search 失败：${describeError(e)}`);
      }
    },
  );
}

/// web_read：抓取指定 URL 并抽取正文。
function registerWebRead(mcp: McpServer, ctx: ToolContext): void {
  mcp.registerTool(
    "web_read",
    {
      description:
        "抓取指定网页并返回正文（自动去除导航、广告等噪音；支持 HTML 与 PDF）。" +
        "用于在 web_search 之后取回原文以便引用。" +
        `\n单次最多 ${QUICK_RETRIEVAL_LIMITS.maxUrls} 个 URL，每篇正文最多 ${QUICK_RETRIEVAL_LIMITS.maxCharsPerDocument} 字符。` +
        "\n只允许 http/https 的公网地址；本机与内网地址会被拒绝。" +
        "\n需要登录或有强反爬的站点可能抓不到，此时会在 failures 里说明原因。",
      inputSchema: {
        urls: z
          .array(z.string().min(1).max(2048))
          .min(1)
          .max(QUICK_RETRIEVAL_LIMITS.maxUrls)
          .describe("要抓取的网页地址（通常来自 web_search 的结果）"),
        objective: z
          .string()
          .max(500)
          .optional()
          .describe("本次抓取想弄清的问题，用于正文片段的相关性排序"),
      },
    },
    async (args: { urls: string[]; objective?: string }) => {
      try {
        const result = await getQuickRetrieval().prepare({
          consumer: consumerOf(ctx),
          objective: args.objective ?? "",
          urls: args.urls,
        });

        if (result.documents.length === 0) {
          const reasons = result.failures.map((f) => `${f.url}：${f.reason}`).join("\n");
          return makeErrorResult(`全部抓取失败：\n${reasons || "未知原因"}`);
        }

        const body = result.documents
          .map(
            (doc) =>
              `## ${doc.title ?? doc.url}\n来源：${doc.url}${doc.truncated ? "（正文已截断）" : ""}\n\n${doc.text}`,
          )
          .join("\n\n---\n\n");
        const failureNote =
          result.failures.length > 0
            ? `\n\n以下地址未能抓取：\n${result.failures.map((f) => `- ${f.url}：${f.reason}`).join("\n")}`
            : "";
        return makeSuccessResult(`${body}${failureNote}`);
      } catch (e) {
        log.warn("[web_read] 失败", describeError(e));
        return makeErrorResult(`web_read 失败：${describeError(e)}`);
      }
    },
  );
}

/// deep_research：发起一次多轮深度研究。
function registerDeepResearch(mcp: McpServer): void {
  mcp.registerTool(
    "deep_research",
    {
      description:
        "发起一次多轮深度研究：自动拆解子问题、多轮检索、抓取去重、覆盖度评估，最终产出带引用的报告。" +
        "\n**立刻返回 session_id，不等待完成**（standard 档通常数分钟，deep 档可能十几分钟）。" +
        "用 research_status 查询进度与最终报告。" +
        "\n只在用户明确需要成体系的调研时使用；查一两个事实用 web_search + web_read 即可。",
      inputSchema: {
        question: z.string().min(1).max(2000).describe("要研究的问题（越具体越好）"),
        mode: z
          .enum(["quick", "standard", "deep"])
          .optional()
          .describe("研究强度：quick 单轮 / standard 三轮（默认）/ deep 五轮"),
      },
    },
    async (args: { question: string; mode?: ResearchMode }) => {
      try {
        const service = await getResearchService();
        const summary = await service.create({
          // 深度研究会话固定用 deep_research consumer：它受「深度研究」开关约束，
          // 也决定了默认预算与产物形态（带引用的报告，而非证据包）。
          consumer: "deep_research",
          objective: args.question,
          mode: args.mode ?? "standard",
          sourceScopes: [{ kind: "public_web" }],
          output: { format: "report", requireCitations: true },
        });
        // run 启动即返回（不等编排跑完），正是这里需要的语义。
        await service.run(summary.sessionId);

        return makeSuccessResult(
          `已启动深度研究（${summary.mode} 档）。用 research_status 查询进度；` +
            `用户也能在应用侧栏的「研究」里实时看到执行过程。`,
          { session_id: summary.sessionId, status: summary.status },
        );
      } catch (e) {
        log.warn("[deep_research] 失败", describeError(e));
        return makeErrorResult(`deep_research 失败：${describeError(e)}`);
      }
    },
  );
}

/// research_status：查询深度研究的进度与报告。
function registerResearchStatus(mcp: McpServer): void {
  mcp.registerTool(
    "research_status",
    {
      description:
        "查询 deep_research 发起的研究会话的进度；已完成时返回带引用的完整报告 Markdown。" +
        "\n未完成时不要反复高频轮询——研究以分钟计，隔一会儿再查。",
      inputSchema: {
        session_id: z.string().min(1).max(128).describe("deep_research 返回的 session_id"),
      },
    },
    async (args: { session_id: string }) => {
      try {
        const service = await getResearchService();
        // completed 才取 full（含报告正文）；未完成时取 summary，避免把中间态的大对象
        // 拉进 agent 上下文——那既慢又没用。
        // 未知 sessionId 时 service.get 直接抛（"未知的研究 Session：xxx"），
        // 由下面的 catch 转成 isError 结果——不需要在这里再判一次 null。
        const brief = await service.get(args.session_id, "summary");
        const { status, roundCount, documentCount, errorMessage } = brief.summary;
        if (status !== "completed") {
          return makeSuccessResult(
            `研究进行中：状态 ${status}，已完成 ${roundCount} 轮、收集 ${documentCount} 篇文档。` +
              (errorMessage ? `\n错误：${errorMessage}` : ""),
            { session_id: args.session_id, status, round_count: roundCount, document_count: documentCount },
          );
        }

        const full = await service.get(args.session_id, "full");
        const markdown = full.report?.markdown;
        if (!markdown) {
          return makeSuccessResult("研究已完成，但没有生成报告正文。", {
            session_id: args.session_id,
            status,
          });
        }
        return makeSuccessResult(markdown, { session_id: args.session_id, status });
      } catch (e) {
        log.warn("[research_status] 失败", describeError(e));
        return makeErrorResult(`research_status 失败：${describeError(e)}`);
      }
    },
  );
}

// ── host 生命周期 ────────────────────────────────────────────────────────────

export function startResearchHost(): Promise<McpHostHandle> {
  return researchHost.start((mcp, ctx) => {
    registerResearchTools(mcp, ctx);
  });
}

export function stopResearchHost(): void {
  researchHost.stop();
}

export function getResearchHostHandle(): McpHostHandle | null {
  return researchHost.getHandle();
}
