// /skill:research 派发的测试。
//
// **这里最重要的断言是顺序，不是结果**：`upsertSession` 必须先于 `run`。
// 研究引擎的事件流按 sessionId 找会话，找不到就当未知会话丢弃——先 run 后 upsert
// 会丢掉开头几条事件，表现为「点了没反应，过一会儿才动」。这个坑历史上踩过，
// 所以用一个共享的 calls 数组把调用顺序钉死，而不是各自断言「被调用过」。
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useResearchUiStore } from "@cortex-work/core/research/ui-store";
import { useResearchBackgroundStore } from "@cortex-work/core/research/background-watch";
import { DEFAULT_RESEARCH_ENGINE_SETTINGS } from "@cortex-work/core/research/settings";
import type { NormalizedResearchEngineSettings } from "@cortex-work/core/research/settings";
import type { ResearchRequest, ResearchSessionSummary } from "@cortex-work/core/research/types";
import type { DesktopBridge, SessionMeta } from "@cortex-work/core";

import {
  parseResearchSkill,
  prepareResearchDispatch,
  upsertConversationResearch,
} from "./researchDispatch";

const SESSION: SessionMeta = {
  id: "s1",
  projectId: "p1",
  title: "Session 1",
  agent: "claude",
  createdAt: 1,
  updatedAt: 1,
};

const SUMMARY: ResearchSessionSummary = {
  sessionId: "res-1",
  consumer: "deep_research",
  objective: "调研向量数据库选型",
  mode: "standard",
  status: "created",
  createdAt: "2026-07-27T00:00:00.000Z",
  updatedAt: "2026-07-27T00:00:00.000Z",
  roundCount: 0,
  documentCount: 0,
  chunkCount: 0,
};

/// 桩桥 + 共享调用序列。create/run 都往同一个数组里记，顺序断言直接看这个数组。
function stub(options: { createRejects?: Error; runRejects?: Error } = {}) {
  const calls: string[] = [];
  const requests: ResearchRequest[] = [];
  const create = vi.fn(async (request: ResearchRequest) => {
    calls.push("create");
    requests.push(request);
    if (options.createRejects) throw options.createRejects;
    return SUMMARY;
  });
  const run = vi.fn(async () => {
    calls.push("run");
    if (options.runRejects) throw options.runRejects;
  });
  // store 的写入也记进同一序列：它们与 run 的先后关系正是本文件要守的东西。
  const upsertSession = vi.fn(() => calls.push("upsertSession"));
  const selectSession = vi.fn(() => calls.push("selectSession"));
  const seed = vi.fn(() => calls.push("seed"));
  useResearchUiStore.setState({ upsertSession, selectSession } as never);
  useResearchBackgroundStore.setState({ seed } as never);

  const bridge = { research: { create, run } } as unknown as DesktopBridge;
  return { bridge, calls, requests, create, run, upsertSession, selectSession, seed };
}

const SETTINGS: NormalizedResearchEngineSettings = {
  ...DEFAULT_RESEARCH_ENGINE_SETTINGS,
  enabled: true,
  deepResearchEnabled: true,
};

beforeEach(() => vi.clearAllMocks());

describe("parseResearchSkill", () => {
  it("识别 /skill:research 并取出目标", () => {
    expect(parseResearchSkill("/skill:research 调研向量数据库选型")).toEqual({
      objective: "调研向量数据库选型",
    });
  });

  it("多行目标原样保留（用户可能粘一段背景进来）", () => {
    const parsed = parseResearchSkill("/skill:research 第一行\n第二行");
    expect(parsed?.objective).toBe("第一行\n第二行");
  });

  it("只有命令没有目标时 objective 为空串（由派发给出人话提示）", () => {
    expect(parseResearchSkill("/skill:research")).toEqual({ objective: "" });
  });

  it("别的 skill 与普通文本一律不认", () => {
    expect(parseResearchSkill("/skill:slides 做份 PPT")).toBeNull();
    expect(parseResearchSkill("帮我查一下向量数据库")).toBeNull();
  });
});

describe("upsertConversationResearch", () => {
  const ref = { sessionId: "res-1", objective: "甲", createdAt: 1 };

  it("空列表追加", () => {
    expect(upsertConversationResearch(undefined, ref)).toEqual([ref]);
  });

  it("同 sessionId 原地替换而不是追加（重跑同一条不该多出一张卡）", () => {
    const updated = { ...ref, objective: "乙" };
    expect(upsertConversationResearch([ref], updated)).toEqual([updated]);
  });

  it("不同 sessionId 追加在后（保持发起顺序）", () => {
    const other = { sessionId: "res-2", objective: "乙", createdAt: 2 };
    expect(upsertConversationResearch([ref], other)).toEqual([ref, other]);
  });
});

describe("prepareResearchDispatch", () => {
  it("非 research 文本不消费，交给后面的产物派发", async () => {
    const { bridge, create } = stub();
    const out = await prepareResearchDispatch(bridge, SESSION, "/skill:slides 做份 PPT", SETTINGS);
    expect(out.handled).toBe(false);
    expect(create).not.toHaveBeenCalled();
  });

  it("空目标：消费掉并给人话提示，不建会话", async () => {
    const { bridge, create } = stub();
    const out = await prepareResearchDispatch(bridge, SESSION, "/skill:research", SETTINGS);
    expect(out.handled).toBe(true);
    expect(out.error).toContain("研究目标");
    expect(out.ref).toBeUndefined();
    expect(create).not.toHaveBeenCalled();
  });

  it("桥不支持研究：消费掉并报错，不静默吞掉", async () => {
    const bridge = {} as unknown as DesktopBridge;
    const out = await prepareResearchDispatch(bridge, SESSION, "/skill:research 甲", SETTINGS);
    expect(out.handled).toBe(true);
    expect(out.error).toBeTruthy();
    expect(out.ref).toBeUndefined();
  });

  /// 本文件的核心断言：先登记会话，再启动。反过来会丢开头几条事件。
  it("调用顺序：create → upsertSession → selectSession → seed → run", async () => {
    const { bridge, calls } = stub();
    await prepareResearchDispatch(bridge, SESSION, "/skill:research 调研向量数据库选型", SETTINGS);
    expect(calls).toEqual(["create", "upsertSession", "selectSession", "seed", "run"]);
  });

  it("create 抛错时不启动（没有会话可跑），并回报错误", async () => {
    const { bridge, run, calls } = stub({ createRejects: new Error("引擎未开启") });
    const out = await prepareResearchDispatch(bridge, SESSION, "/skill:research 甲", SETTINGS);
    expect(out.handled).toBe(true);
    expect(out.error).toContain("引擎未开启");
    expect(out.ref).toBeUndefined();
    expect(run).not.toHaveBeenCalled();
    expect(calls).toEqual(["create"]);
  });

  /// run 失败不能让会话凭空消失：它已经建出来了，卡片得在、面板得能进去看失败原因。
  it("run 抛错仍返回 ref（会话已建出来，卡片必须留下）", async () => {
    const { bridge } = stub({ runRejects: new Error("搜索服务未配置") });
    const out = await prepareResearchDispatch(bridge, SESSION, "/skill:research 甲", SETTINGS);
    expect(out.ref?.sessionId).toBe("res-1");
    expect(out.error).toBeUndefined();
  });

  it("会话绑了项目就把 projectId 透传给引擎（报告归档到项目目录）", async () => {
    const { bridge, requests } = stub();
    const out = await prepareResearchDispatch(bridge, SESSION, "/skill:research 甲", SETTINGS);
    expect(requests[0]?.projectId).toBe("p1");
    expect(out.ref?.projectId).toBe("p1");
  });

  it("无项目会话不带 projectId 键（main 侧 schema 是 strict 的）", async () => {
    const { bridge, requests } = stub();
    const noProject = { ...SESSION, projectId: undefined } as unknown as SessionMeta;
    const out = await prepareResearchDispatch(bridge, noProject, "/skill:research 甲", SETTINGS);
    expect("projectId" in (requests[0] ?? {})).toBe(false);
    expect(out.ref && "projectId" in out.ref).toBe(false);
  });

  it("档位取自设置的默认档，不写死", async () => {
    const { bridge, requests } = stub();
    await prepareResearchDispatch(bridge, SESSION, "/skill:research 甲", {
      ...SETTINGS,
      defaultMode: "deep",
    });
    expect(requests[0]?.mode).toBe("deep");
  });

  it("默认只查公开网络", async () => {
    const { bridge, requests } = stub();
    await prepareResearchDispatch(bridge, SESSION, "/skill:research 甲", SETTINGS);
    expect(requests[0]?.sourceScopes).toEqual([{ kind: "public_web" }]);
  });

  it("设置里开了个人记忆才把 memory 加进来源范围", async () => {
    const { bridge, requests } = stub();
    await prepareResearchDispatch(bridge, SESSION, "/skill:research 甲", {
      ...SETTINGS,
      includeMemoryScope: true,
    });
    expect(requests[0]?.sourceScopes).toEqual([{ kind: "public_web" }, { kind: "memory" }]);
  });

  it("产出带引用的报告（研究的价值在于可核查）", async () => {
    const { bridge, requests } = stub();
    await prepareResearchDispatch(bridge, SESSION, "/skill:research 甲", SETTINGS);
    expect(requests[0]?.consumer).toBe("deep_research");
    expect(requests[0]?.output).toEqual({ format: "report", requireCitations: true });
  });

  it("ref 的时间取引擎记录的创建时间（与后端对得上）", async () => {
    const { bridge } = stub();
    const out = await prepareResearchDispatch(bridge, SESSION, "/skill:research 甲", SETTINGS);
    expect(out.ref?.createdAt).toBe(Date.parse(SUMMARY.createdAt));
    expect(out.ref?.objective).toBe("甲");
  });
});
