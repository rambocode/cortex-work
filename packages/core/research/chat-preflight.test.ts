// chat-preflight 编排层的测试（fake complete/gather，全程不出站）。
//
// 红线断言集中在失败矩阵：改写链路上任何一步失败都只能降级为「未改写」（原文照旧进检索），
// 绝不能变成「检索失败」或阻断发送；意图跳过轮不得触碰 gather、不得注入 evidence。
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ResearchEngineSettings } from "./settings";
import type { GatherResult } from "./quick-types";
import type { QueryUnderstandIpcRequest, QueryUnderstandIpcResponse } from "../desktop/types";

import { runChatPreflight, type PreflightStatus } from "./chat-preflight";

const ON: ResearchEngineSettings = {
  enabled: true,
  deepResearchEnabled: false,
  chatAutoRetrieve: true,
  writingEnabled: false,
  memoryEnabled: false,
  searchBackend: "direct",
};

const DOC = {
  url: "https://a.com/p",
  title: "标题",
  text: "网页正文",
  truncated: false,
  fetchMethod: "http" as const,
};

function gatherOk(documents: GatherResult["documents"] = [DOC]) {
  return vi.fn(async () => ({ documents, failures: [], warnings: [] }));
}

function completeWith(content: string) {
  return vi.fn(
    async (_req: QueryUnderstandIpcRequest): Promise<QueryUnderstandIpcResponse> => ({ ok: true, content }),
  );
}

/// 收集状态序列（只留 phase，个别断言另取完整对象）。
function statusCollector() {
  const statuses: PreflightStatus[] = [];
  return { statuses, onStatus: (s: PreflightStatus) => statuses.push(s) };
}

const baseInput = (over: Partial<Parameters<typeof runChatPreflight>[0]>) => ({
  gather: gatherOk(),
  complete: completeWith('{"intent":"retrieve","rewrite_query":"Electron 38 发布时间"}'),
  settings: ON,
  sessionWebSearch: true,
  query: "那它什么时候发布的",
  history: [],
  hasAttachments: false,
  ...over,
});

afterEach(() => {
  vi.useRealTimers();
});

describe("runChatPreflight · 门控（意图理解一等公民，检索是可选下游）", () => {
  it("检索链路不成立但桥存在 → understand 仍跑；终态 done **不带** documentCount（已理解问题）", async () => {
    const { statuses, onStatus } = statusCollector();
    const gather = gatherOk();
    const complete = completeWith('{"intent":"retrieve","rewrite_query":"x y"}');
    const result = await runChatPreflight(
      baseInput({ gather, complete, sessionWebSearch: false, onStatus }),
    );
    expect(complete).toHaveBeenCalled();
    expect(gather).not.toHaveBeenCalled();
    expect(statuses).toEqual([{ phase: "understanding" }, { phase: "done" }]);
    expect(result).toEqual({});
  });

  it("understand 与检索都不具备（无桥 + 三开关不成立）→ 空结果、无状态事件", async () => {
    const { statuses, onStatus } = statusCollector();
    const gather = gatherOk();
    const result = await runChatPreflight(
      baseInput({ gather, complete: undefined, sessionWebSearch: false, onStatus }),
    );
    expect(result).toEqual({});
    expect(gather).not.toHaveBeenCalled();
    expect(statuses).toEqual([]);
  });

  it("gather 缺失（检索链路不成立）→ understand 照跑，done 无 documentCount", async () => {
    const { statuses, onStatus } = statusCollector();
    const result = await runChatPreflight(baseInput({ gather: undefined, onStatus }));
    expect(result).toEqual({});
    expect(statuses).toEqual([{ phase: "understanding" }, { phase: "done" }]);
  });

  it("complete 缺失（web/旧壳）→ 无意图理解，原文直接进检索", async () => {
    const { statuses, onStatus } = statusCollector();
    const gather = gatherOk();
    const result = await runChatPreflight(baseInput({ gather, complete: undefined, onStatus }));
    expect(gather).toHaveBeenCalledWith({ consumer: "chat", query: "那它什么时候发布的" });
    expect(statuses.map((s) => s.phase)).toEqual(["searching", "done"]);
    expect(result.evidenceAppend).toBeDefined();
    expect(result.intentHintAppend).toBeUndefined();
  });

  it.each([
    ["带附件", { hasAttachments: true }],
    ["超长文本", { query: "长".repeat(2001) }],
  ])("%s → 跳过改写，原文直接进检索", async (_name, over) => {
    const { statuses, onStatus } = statusCollector();
    const gather = gatherOk();
    const complete = completeWith("{}");
    const input = baseInput({ gather, complete, onStatus, ...over });
    const result = await runChatPreflight(input);
    expect(complete).not.toHaveBeenCalled();
    expect(gather).toHaveBeenCalledWith({ consumer: "chat", query: input.query.trim() });
    expect(statuses.map((s) => s.phase)).toEqual(["searching", "done"]);
    expect(result.evidenceAppend).toBeDefined();
    expect(result.intentHintAppend).toBeUndefined();
  });

  it("modelRef 有值 → 原样透传给 complete；缺省 → 入参不带 providerId/modelId", async () => {
    const withRef = completeWith('{"intent":"retrieve","rewrite_query":"x y"}');
    await runChatPreflight(
      baseInput({ complete: withRef, modelRef: { providerId: "p1", modelId: "m1" } }),
    );
    expect(withRef).toHaveBeenCalledWith(expect.objectContaining({ providerId: "p1", modelId: "m1" }));

    const withoutRef = completeWith('{"intent":"retrieve","rewrite_query":"x y"}');
    await runChatPreflight(baseInput({ complete: withoutRef }));
    const req = withoutRef.mock.calls[0]![0];
    expect("providerId" in req).toBe(false);
    expect("modelId" in req).toBe(false);
  });
});

describe("runChatPreflight · 改写与意图分流", () => {
  it("retrieve + 改写生效 → gather 收到改写后的查询；状态 understanding→searching→done(N)", async () => {
    const { statuses, onStatus } = statusCollector();
    const gather = gatherOk([DOC]);
    const result = await runChatPreflight(baseInput({ gather, onStatus }));
    expect(gather).toHaveBeenCalledWith({ consumer: "chat", query: "Electron 38 发布时间" });
    expect(statuses.map((s) => s.phase)).toEqual(["understanding", "searching", "done"]);
    expect(statuses[1]).toEqual({ phase: "searching", query: "Electron 38 发布时间", rewritten: true });
    expect(statuses[2]).toEqual({ phase: "done", documentCount: 1 });
    expect(result.evidenceAppend).toBeDefined();
  });

  it("greeting（检索链路成立）→ 不调 gather、状态 skipped、只注 intentHintAppend（干净语义）", async () => {
    const { statuses, onStatus } = statusCollector();
    const gather = gatherOk();
    const result = await runChatPreflight(
      baseInput({ gather, complete: completeWith('{"intent":"greeting","rewrite_query":"你好"}'), onStatus }),
    );
    expect(gather).not.toHaveBeenCalled();
    expect(statuses.map((s) => s.phase)).toEqual(["understanding", "skipped"]);
    expect(statuses[1]).toEqual({ phase: "skipped", intent: "greeting" });
    expect(result.evidenceAppend).toBeUndefined();
    expect(result.intentHintAppend).toContain("[Turn hint — advisory only]");
  });

  it("greeting（检索链路不成立）→ 状态 done 无 documentCount，hint 仍无条件注入", async () => {
    const { statuses, onStatus } = statusCollector();
    const result = await runChatPreflight(
      baseInput({
        gather: undefined,
        complete: completeWith('{"intent":"greeting","rewrite_query":"你好"}'),
        sessionWebSearch: false,
        onStatus,
      }),
    );
    expect(statuses).toEqual([{ phase: "understanding" }, { phase: "done" }]);
    expect(result.evidenceAppend).toBeUndefined();
    expect(result.intentHintAppend).toContain("[Turn hint — advisory only]");
  });

  it.each([
    ["ok:false（no-model）", vi.fn(async (): Promise<QueryUnderstandIpcResponse> => ({ ok: false, reason: "no-model" as const }))],
    ["complete 抛异常", vi.fn(async (): Promise<QueryUnderstandIpcResponse> => { throw new Error("boom"); })],
  ])("understand %s → 按「未改写」降级，原文进检索", async (_name, complete) => {
    const { statuses, onStatus } = statusCollector();
    const gather = gatherOk();
    const result = await runChatPreflight(baseInput({ gather, complete, onStatus }));
    expect(gather).toHaveBeenCalledWith({ consumer: "chat", query: "那它什么时候发布的" });
    expect(statuses.map((s) => s.phase)).toEqual(["understanding", "searching", "done"]);
    expect(statuses[1]).toEqual({ phase: "searching", query: "那它什么时候发布的", rewritten: false });
    expect(result.evidenceAppend).toBeDefined();
  });

  it("解析失败（垃圾输出）→ 未改写 + 原文检索（unknown 归需要检索）", async () => {
    const gather = gatherOk();
    await runChatPreflight(baseInput({ gather, complete: completeWith("sorry, no idea") }));
    expect(gather).toHaveBeenCalledWith({ consumer: "chat", query: "那它什么时候发布的" });
  });

  it("understand IPC 悬挂 → 6.5s 兜底超时后按未改写继续", async () => {
    vi.useFakeTimers();
    const { statuses, onStatus } = statusCollector();
    const gather = gatherOk();
    const hanging = vi.fn(() => new Promise<QueryUnderstandIpcResponse>(() => {}));
    const promise = runChatPreflight(baseInput({ gather, complete: hanging, onStatus }));
    await vi.advanceTimersByTimeAsync(6_500);
    const result = await promise;
    expect(gather).toHaveBeenCalledWith({ consumer: "chat", query: "那它什么时候发布的" });
    expect(statuses.map((s) => s.phase)).toEqual(["understanding", "searching", "done"]);
    expect(result.evidenceAppend).toBeDefined();
  });
});

describe("runChatPreflight · 检索结果与预算", () => {
  it("gather 抛错 → 故障说明照常注入（三语义不被污染），状态 failed", async () => {
    const { statuses, onStatus } = statusCollector();
    const gather = vi.fn(async () => {
      throw new Error("密钥解不开");
    });
    const result = await runChatPreflight(baseInput({ gather, onStatus }));
    expect(statuses.at(-1)).toEqual({ phase: "failed", reason: "retrieval-failed" });
    expect(result.evidenceAppend).toContain("密钥解不开");
    expect(result.intentHintAppend).toBeUndefined();
  });

  it("零结果 → done(0)，append 为零结果说明", async () => {
    const { statuses, onStatus } = statusCollector();
    const result = await runChatPreflight(baseInput({ gather: gatherOk([]), onStatus }));
    expect(statuses.at(-1)).toEqual({ phase: "done", documentCount: 0 });
    expect(result.evidenceAppend).toBeDefined();
  });

  it("剩余预算：understand 耗时 5s + 总预算 20s → gather 15s 后才超时", async () => {
    vi.useFakeTimers();
    const complete = vi.fn(
      () =>
        new Promise<QueryUnderstandIpcResponse>((resolve) =>
          setTimeout(
            () => resolve({ ok: true, content: '{"intent":"retrieve","rewrite_query":"x y"}' }),
            5_000,
          ),
        ),
    );
    const gather = vi.fn(() => new Promise<GatherResult>(() => {}));
    const promise = runChatPreflight(baseInput({ gather, complete, timeoutMs: 20_000 }));
    await vi.advanceTimersByTimeAsync(5_000);
    await vi.advanceTimersByTimeAsync(15_000);
    const result = await promise;
    expect(result.evidenceAppend).toContain("检索超时（15 秒）");
  });

  it("剩余预算下限夹 8s：understand 耗时 4s + 总预算 10s → gather 仍有 8s", async () => {
    vi.useFakeTimers();
    const complete = vi.fn(
      () =>
        new Promise<QueryUnderstandIpcResponse>((resolve) =>
          setTimeout(
            () => resolve({ ok: true, content: '{"intent":"retrieve","rewrite_query":"x y"}' }),
            4_000,
          ),
        ),
    );
    const gather = vi.fn(() => new Promise<GatherResult>(() => {}));
    const promise = runChatPreflight(baseInput({ gather, complete, timeoutMs: 10_000 }));
    await vi.advanceTimersByTimeAsync(4_000);
    await vi.advanceTimersByTimeAsync(8_000);
    const result = await promise;
    expect(result.evidenceAppend).toContain("检索超时（8 秒）");
  });
});
