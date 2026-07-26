// CRE 的**端到端贯通测试**：把「renderer 点一次新建研究」这条链路上的真实模块串起来跑一遍。
//
// 与 research-service.test.ts / research-orchestrator.test.ts 的分工：那两套各自替身掉了
// 邻居模块，只验一层的行为；本文件反过来——**尽可能少替身**，只在真正碰外部世界的三个点
// 上放替身，其余全部用生产实现：
//
//   替身（3 个，都是「进程/网络/磁盘」边界）：
//     1. FakeWorkerTransport —— 代替 utilityProcess 管道，但走**真的** ResearchWorkerProcess
//        + ResearchRpcClient + 协议 zod 校验，响应取 core/research/protocol-fixtures 的真实形状；
//     2. fetchFn —— 代替真网络，但走**真的** SearchServerClient（含 request_id 校验与 zod）；
//     3. complete —— 代替模型 HTTP，但走**真的** ResearchModelGateway + Planner + 报告生成。
//   生产实现（不替身）：ResearchService、ResearchOrchestrator、候选选择、worker-mapping、
//     覆盖度评估、Citation Validator、状态机、预算记账。仓储用 InMemory 版（SQLite 版由
//     research-repository.sqlite.test.ts 覆盖，两者实现同一个 ResearchRepository 接口）。
//
// 断言的三条是 M1 的验收线（spec §19.1.1）：终态 completed、**至少一条有效 CitationRef**、
// summary 层级不含正文。任何一环接错（channel 形状、参数形状、注入点没接上）都会在这里炸。
import { describe, expect, it } from "vitest";
import { DEFAULT_RESEARCH_ENGINE_SETTINGS } from "@cortex-work/core/research/settings";
import type { ProviderSettings } from "@cortex-work/core/desktop/types";
import type { ResearchRequest } from "@cortex-work/core/research/types";
import { SearchServerClient } from "./clients/search-server-client";
import { createResearchLlmHooks } from "./planner/llm-hooks";
import { InMemoryResearchRepository } from "./repository-memory";
import type { ResearchWorkerLike } from "./research-orchestrator";
import { ResearchService } from "./research-service";
import { FakeWorkerTransport } from "./worker/fake-transport";
import { ResearchWorkerProcess } from "./worker/process-manager";

/// 与 protocol-fixtures 的 fetch_prepare:response 同一份内容哈希/文本哈希。
const CONTENT_HASH = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08";
const TEXT_HASH = "2c26b46b68ffc68ff99b453c1d30413413422d706483bfa0f98a5e886266e7ae";
const DOC_TEXT = "node:sqlite 自 Node 22 起内置，但文档仍将其标记为实验特性。";

/// renderer 侧 ResearchCreateForm 真正会构造的请求（逐字段对齐它的 submit()）：
/// 没有 token、没有本地路径、没有 provider 信息——这正是 ipc/research.ts 的 .strict() schema
/// 允许的全部字段。形状对不上时 zod 会在 IPC 层拒绝，因此这份常量也是一份契约快照。
const REQUEST: ResearchRequest = {
  consumer: "deep_research",
  objective: "调研 node:sqlite 是否可用于生产",
  mode: "quick",
  sourceScopes: [{ kind: "public_web" }],
  output: { format: "report", requireCitations: true },
};

/// 合法的 SearchBatchResponse（两个域名，满足候选多样性选择）。
/// request_id 必须回显请求里的那个：SearchServerClient 会校验，不回显直接抛 request_mismatch。
function searchPayload(requestId: string): unknown {
  return {
    request_id: requestId,
    results: [
      {
        query_id: "q_1",
        items: [
          {
            url: "https://example.com/a",
            title: "node:sqlite 稳定性说明",
            snippet: "实验特性标记",
            domain: "example.com",
            engines: ["duckduckgo"],
            score: 0.91,
            canonical_url: "https://example.com/a",
          },
          {
            url: "https://other.com/b",
            title: "生产环境的 SQLite 选型",
            domain: "other.com",
            engines: ["brave"],
            score: 0.52,
          },
        ],
        errors: [],
      },
    ],
    stats: {
      provider_count: 2,
      raw_result_count: 2,
      returned_result_count: 2,
      cache_hit: false,
      duration_ms: 118,
    },
  };
}

/// Worker 的 fetch_prepare 结果（形状取自 protocol-fixtures 的 fetch_prepare:response）。
/// candidate_id 必须回显 main 下发的那个，否则「候选 → 查询 → 子问题」的归因链会断，
/// 报告里也就拿不到可回溯的引用。
function fetchPreparePayload(operationId: string, candidateId: string): unknown {
  return {
    operation_id: operationId,
    documents: [
      {
        candidate_id: candidateId,
        url: "https://example.com/a",
        canonical_url: "https://example.com/a",
        title: "node:sqlite 稳定性说明",
        content_hash: CONTENT_HASH,
        simhash: "c3f1a2b4d5e60718",
        media_type: "text/html",
        fetch_method: "http",
        fetched_at: "2026-07-25T09:00:00Z",
        text: DOC_TEXT,
        text_length: DOC_TEXT.length,
        trust_zone: "public_web",
      },
    ],
    chunks: [
      {
        chunk_id: "ch_1",
        content_hash: CONTENT_HASH,
        start_offset: 0,
        end_offset: DOC_TEXT.length,
        heading_path: ["node:sqlite 稳定性说明"],
        text: DOC_TEXT,
        text_hash: TEXT_HASH,
        lexical_score: 0.77,
      },
    ],
    duplicate_clusters: [],
    failures: [],
    stats: { http_fetches: 1, browser_fetches: 0, total_bytes: 2048, duration_ms: 311, skipped_known: 0 },
  };
}

/// 假 transport 的应答脚本：按 method 回一条合协议的 response 行。
///
/// 这里刻意**同步回应**（收到请求行立刻 emitLine），因为 ResearchRpcClient 的 pending 注册
/// 发生在 writeLine 之前，同步回应不会丢消息；异步反而会让测试引入不必要的时序脆弱性。
function scriptTransport(transport: FakeWorkerTransport): void {
  const originalWrite = transport.writeLine.bind(transport);
  transport.writeLine = (line: string): void => {
    originalWrite(line);
    const message = JSON.parse(line) as {
      type: string;
      id: string;
      method: string;
      params?: { operation_id?: string; candidates?: Array<{ candidate_id: string }> };
    };
    if (message.type !== "request") return;

    if (message.method === "hello") {
      transport.emitLine(
        JSON.stringify({
          type: "response",
          id: message.id,
          result: {
            worker_version: "0.1.0",
            max_protocol_version: 1,
            methods: ["hello", "doctor", "fetch_prepare", "rerank", "cancel", "shutdown"],
            browser_available: false,
          },
        }),
      );
      return;
    }
    if (message.method === "fetch_prepare") {
      transport.emitLine(
        JSON.stringify({
          type: "response",
          id: message.id,
          result: fetchPreparePayload(
            message.params!.operation_id!,
            message.params!.candidates![0]!.candidate_id,
          ),
        }),
      );
      return;
    }
    // shutdown / cancel：回一个空 result 即可。
    transport.emitLine(JSON.stringify({ type: "response", id: message.id, result: {} }));
  };
}

/// 模型输出脚本。按 system prompt 分辨用途：规划回一份合法计划 JSON，报告回一段 markdown。
///
/// 报告里的引用标记必须满足两点，缺一条都会让「至少一条有效 CitationRef」变红：
///   1. 词法是 `[^片段ID]`（core/research/citation.ts 的 CITATION_RE，刻意不认别的写法）；
///   2. 片段 ID 是**真实存在的 chunkId**——main 在 worker-mapping 里会给 chunk 重新铸 id，
///      Worker 回的 "ch_1" 并不是最终 id，所以这里必须从证据清单里把真 id 读出来，
///      而不能硬编码。硬编码等于在测试里模拟「模型编造引用」，会被 Citation Validator 删掉。
function modelScript(systemPrompt: string, userPrompt: string): string {
  if (systemPrompt.includes("拆成可独立验证的子问题")) {
    return JSON.stringify({
      schemaVersion: 1,
      objective: REQUEST.objective,
      subquestions: [{ id: "sq_1", text: "node:sqlite 是否仍是实验特性" }],
      initialQueries: [{ queryId: "q_1", subquestionId: "sq_1", text: "node:sqlite 稳定性" }],
    });
  }
  // 证据清单的行格式见 prompts.ts 的 buildReportUserPrompt：`- [<chunkId>]（来源：…`
  const chunkIds = [...userPrompt.matchAll(/^- \[([A-Za-z0-9_][A-Za-z0-9_.:-]*)\]/gmu)].map(
    (match) => match[1]!,
  );
  const markers = chunkIds.map((id) => `[^${id}]`).join("");
  return `## 结论\n\nnode:sqlite 目前仍被标记为实验特性${markers}。\n`;
}

interface Harness {
  service: ResearchService;
  repository: InMemoryResearchRepository;
  /// 出站到搜索服务的请求 URL（用于断言真的走了 SearchServerClient）。
  searchUrls: string[];
  /// 模型调用的 system prompt（用于断言真的走了网关）。
  modelSystemPrompts: string[];
}

/// 装配一套「只在进程/网络/模型三处放替身」的服务实例。
async function makeHarness(): Promise<Harness> {
  const repository = new InMemoryResearchRepository();
  const searchUrls: string[] = [];
  const modelSystemPrompts: string[] = [];
  const blobs = new Map<string, string>();

  // 1. Worker：真 ResearchWorkerProcess + 假管道。
  const transport = new FakeWorkerTransport();
  scriptTransport(transport);
  const workerProcess = new ResearchWorkerProcess({
    createTransport: () => transport,
    desktopVersion: "0.1.48",
  });

  // 2. 搜索：真 SearchServerClient + 假 fetch。
  //
  // **必须从请求体里读回 request_id 再回显**：SearchServerClient 会校验响应的 request_id
  // 与请求一致（防串台/重放），随便回一个固定 id 会被判 request_mismatch 而整笔拒绝。
  const searchFetch: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    searchUrls.push(url);
    const sent = JSON.parse(String(init?.body ?? "{}")) as { request_id?: string };
    return new Response(JSON.stringify(searchPayload(sent.request_id ?? "")), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };

  // 3. 模型：真 ResearchModelGateway + 假 complete。
  // enabled + 非空 models 是 selectResearchModel 认「可用 provider」的硬条件，
  // 少任何一个都会被判 no_provider_configured 并静默降级成确定性摘要（那正是本测试要排除的）。
  const providerSettings: ProviderSettings = {
    providers: [
      {
        id: "cloud",
        name: "Cloud",
        baseUrl: "https://api.example.com/v1",
        apiKey: "sk-test",
        endpointFormat: "chat_completions",
        models: [{ id: "gpt-test" }],
        enabled: true,
      },
    ],
    defaultProviderId: "cloud",
    defaultModel: "gpt-test",
  };

  const service = new ResearchService({
    repository,
    blobStore: {
      putBlob: async (hash, text) => {
        blobs.set(hash, text);
        return `blob:${hash}`;
      },
    },
    settings: () => ({
      ...DEFAULT_RESEARCH_ENGINE_SETTINGS,
      enabled: true,
      deepResearchEnabled: true,
    }),
    createSearchClient: () =>
      new SearchServerClient(
        { baseUrl: "https://search.example.com", workspaceId: "ws_1", token: "pat-secret" },
        { fetchFn: searchFetch, clientVersion: "0.1.48" },
      ),
    workerProvider: {
      ensure: async (): Promise<ResearchWorkerLike> => {
        await workerProcess.start();
        return workerProcess;
      },
      stop: async () => {
        await workerProcess.stop();
      },
    },
    userScope: () => "local",
    llmHooks: () =>
      createResearchLlmHooks({
        providerSettings,
        consumer: "deep_research",
        complete: async (params) => {
          modelSystemPrompts.push(params.messages[0]!.content);
          return modelScript(params.messages[0]!.content, params.messages[1]!.content);
        },
        // 报告走流式：分两段回吐**累计全文**（与真实 postChatCompletionStream 的契约一致），
        // 由网关切成增量、编排层节流后广播成 report_delta。
        completeStream: async (params) => {
          modelSystemPrompts.push(params.messages[0]!.content);
          const text = modelScript(params.messages[0]!.content, params.messages[1]!.content);
          const half = Math.ceil(text.length / 2);
          params.onDelta?.(text.slice(0, half));
          params.onDelta?.(text);
          return text;
        },
      }),
  });

  return { service, repository, searchUrls, modelSystemPrompts };
}

describe("CRE 端到端：create → run → get", () => {
  it("跑通一次完整研究：终态 completed、至少一条有效引用、summary 不含正文", async () => {
    const { service, repository, searchUrls, modelSystemPrompts } = await makeHarness();

    // ── create：等价于 renderer 经 research:create 发来的那一次调用 ──────────────
    const summary = await service.create(REQUEST);
    expect(summary.status).toBe("created");
    expect(summary.consumer).toBe("deep_research");
    // create 必须立刻落一份计划（它是预算的持久化载体），否则重启后拿不回用户的预算覆盖。
    expect((await repository.getSession(summary.sessionId, "full"))!.plan).toBeDefined();

    // ── run：编排全程 ────────────────────────────────────────────────────────
    await service.run(summary.sessionId);
    await service.settled(summary.sessionId);

    // ── get("full")：renderer 选中会话时拉的层级 ──────────────────────────────
    const full = (await service.get(summary.sessionId, "full"))!;

    // 1) 终态 completed
    expect(full.summary.status).toBe("completed");

    // 2) 至少一条**有效** CitationRef —— spec §19.1.1 的验收线。
    //    「有效」= chunkId 能在已提交证据里找到；伪造引用会被 Citation Validator 物理删除，
    //    所以这条断言同时守住了「报告不能凭空编来源」。
    const evidence = (await service.get(summary.sessionId, "evidence"))!;
    const knownChunkIds = new Set(evidence.chunks!.map((chunk) => chunk.chunkId));
    expect(full.report).toBeDefined();
    expect(full.report!.citations.length).toBeGreaterThan(0);
    for (const citation of full.report!.citations) {
      expect(knownChunkIds.has(citation.chunkId)).toBe(true);
    }

    // 3) summary 层级不含正文（spec §19.3.2）：不带 chunks / documents / report / plan。
    const brief = (await service.get(summary.sessionId, "summary"))!;
    expect(brief.chunks).toBeUndefined();
    expect(brief.documents).toBeUndefined();
    expect(brief.report).toBeUndefined();
    expect(brief.plan).toBeUndefined();
    // 兜底：整个 summary 视图序列化后不得出现任何一段抓取到的正文。
    expect(JSON.stringify(brief)).not.toContain(DOC_TEXT.slice(0, 20));

    // ── 链路真的走通了（而不是被某个替身短路） ────────────────────────────────
    expect(searchUrls.some((url) => url.includes("search.example.com"))).toBe(true);
    expect(evidence.documents).toHaveLength(1);
    expect(evidence.rounds!.length).toBeGreaterThan(0);

    // 防「假绿」：报告必须是**模型产出的那一段**，而不是 P7 的确定性降级摘要。
    // 少了这条断言，即使 llmHooks 整条没接上（网关选不到 provider → 静默降级），
    // 上面的 completed + 有效引用也照样会通过 —— 那正是最初这版测试暴露出的问题。
    expect(full.report!.markdown).toContain("node:sqlite 目前仍被标记为实验特性");
    // 规划与报告两次调用都真的经过了网关（system prompt 各自可辨识）。
    expect(modelSystemPrompts.some((p) => p.includes("拆成可独立验证的子问题"))).toBe(true);
    expect(modelSystemPrompts.some((p) => p.includes("撰写一份 Markdown 研究报告"))).toBe(true);
  });

  it("事件回流：orchestrator → broadcast → research:event，且事件里不含正文", async () => {
    const { service } = await makeHarness();
    // 形状取 ResearchEventSender 的三个方法（真实类型是 Electron.WebContents）。
    const received: Array<{ channel: string; payload: unknown }> = [];
    service.addEventSender({
      isDestroyed: () => false,
      send: (channel, payload) => received.push({ channel, payload }),
      once: () => {},
    });

    const summary = await service.create(REQUEST);
    await service.run(summary.sessionId);
    await service.settled(summary.sessionId);

    // 通道名必须是 preload/research-bridge.ts 订阅的那个，写错则 UI 永远收不到事件。
    expect(received.length).toBeGreaterThan(0);
    for (const entry of received) expect(entry.channel).toBe("research:event");

    const types = received.map((entry) => (entry.payload as { type: string }).type);
    expect(types).toContain("stage");
    expect(types).toContain("round");
    // 实时性的三件套：状态变更、执行流水、报告草稿。缺任何一样，界面在几分钟里都是死的。
    expect(types).toContain("status");
    expect(types).toContain("activity");
    expect(types).toContain("report_delta");
    expect(received.at(-1)!.payload).toEqual({
      type: "done",
      sessionId: summary.sessionId,
      status: "completed",
    });

    // 草稿增量拼起来就是模型写的那份正文（增量而非累计，拼接才不会重复）。
    const draft = received
      .map((entry) => entry.payload as { type: string; delta?: string })
      .filter((payload) => payload.type === "report_delta")
      .map((payload) => payload.delta ?? "")
      .join("");
    expect(draft).toContain("node:sqlite 目前仍被标记为实验特性");

    // spec §16：事件里**一个字的抓取正文都不许带**（报告草稿是模型自己写的，不在此列）。
    expect(JSON.stringify(received)).not.toContain(DOC_TEXT.slice(0, 20));
  });
});
