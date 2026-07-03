// 对话级记忆蒸馏编排器的单测：学习开关门控、空 counterpart 降级、清洗后持久化、
// 失败静默、单飞排队合并（同 key 只蒸馏最新一次）。

import { describe, expect, it, vi } from "vitest";
import { ConversationLearner, type ConversationLearnerDeps } from "./conversation-learner";
import type { ReplySyncSnapshot } from "../ipc/reply-types";
import type { DraftAcceptedInfo } from "./controller";

/// 最小快照工厂：可控学习开关（KTD6 修订后快照不再携带 memory）。
function makeSnapshot(learningEnabled: boolean): ReplySyncSnapshot {
  return {
    settings: {
      draftTrigger: "cmd",
      voiceTrigger: "fn",
      learningEnabled,
      historyEnabled: true,
      userProfile: "",
    },
  };
}

/// 最小写回信息工厂。
function accepted(overrides: Partial<DraftAcceptedInfo> = {}): DraftAcceptedInfo {
  return {
    draft: "刚交了，你查收下",
    conversation: "对方：报销单交了吗？",
    appName: "WeChat",
    appBundleId: "com.tencent.xinWeChat",
    counterpart: "张玲玲",
    candidates: [{ text: "刚交了，你查收下", stance: null }],
    acceptedIndex: 0,
    ...overrides,
  };
}

function makeDeps(overrides: Partial<ConversationLearnerDeps> = {}): ConversationLearnerDeps {
  return {
    getSnapshot: () => makeSnapshot(true),
    generate: vi.fn(async () => "- 财务同事\n- 偏好简短确认"),
    getExistingSummary: vi.fn(async () => ""),
    persistSummary: vi.fn(),
    ...overrides,
  };
}

/// 可手动 resolve 的延迟 Promise（测单飞时序）。
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/// 让微任务队列排空（drain 是纯 promise 链，无定时器）。
const flush = () => new Promise((r) => setTimeout(r, 0));

describe("ConversationLearner", () => {
  it("学习开关关闭 → 零副作用", async () => {
    const deps = makeDeps({ getSnapshot: () => makeSnapshot(false) });
    new ConversationLearner(deps).onDraftAccepted(accepted());
    await flush();
    expect(deps.generate).not.toHaveBeenCalled();
    expect(deps.persistSummary).not.toHaveBeenCalled();
  });

  it("counterpart 为空（key null）→ 零副作用", async () => {
    const deps = makeDeps();
    new ConversationLearner(deps).onDraftAccepted(accepted({ counterpart: "" }));
    await flush();
    expect(deps.generate).not.toHaveBeenCalled();
  });

  it("成功路径：合并旧摘要蒸馏 → 清洗 → persistSummary", async () => {
    const deps = makeDeps({
      getExistingSummary: vi.fn(async () => "- 旧要点"),
      generate: vi.fn(async () => "说明文字\n- 财务同事\n- 偏好简短确认"),
    });
    new ConversationLearner(deps).onDraftAccepted(accepted());
    await flush();
    // 蒸馏 prompt 带上了旧摘要
    const prompt = (deps.generate as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(prompt.user).toContain("旧要点");
    // 清洗后只剩要点行
    expect(deps.persistSummary).toHaveBeenCalledWith(
      expect.objectContaining({
        appBundleId: "com.tencent.xinWeChat",
        counterpart: "张玲玲",
        summary: "- 财务同事\n- 偏好简短确认",
      }),
    );
  });

  it("生成失败 / 清洗后为空 → 静默不持久化", async () => {
    const failing = makeDeps({ generate: vi.fn(async () => Promise.reject(new Error("网络"))) });
    new ConversationLearner(failing).onDraftAccepted(accepted());
    await flush();
    expect(failing.persistSummary).not.toHaveBeenCalled();

    const noisy = makeDeps({ generate: vi.fn(async () => "只有解释没有要点") });
    new ConversationLearner(noisy).onDraftAccepted(accepted());
    await flush();
    expect(noisy.persistSummary).not.toHaveBeenCalled();
  });

  it("单飞排队合并：蒸馏进行中同 key 再写回 → 结束后只再蒸馏一次且用最新样本", async () => {
    const first = deferred<string>();
    const generate = vi
      .fn()
      .mockImplementationOnce(() => first.promise)
      .mockImplementation(async () => "- 后续要点");
    const deps = makeDeps({ generate });
    const learner = new ConversationLearner(deps);

    learner.onDraftAccepted(accepted({ draft: "第一次" }));
    await flush();
    // 第一轮在途，再来两次同 key 写回（应合并为一次待办，且取最新 draft）
    learner.onDraftAccepted(accepted({ draft: "第二次" }));
    learner.onDraftAccepted(accepted({ draft: "第三次" }));
    expect(generate).toHaveBeenCalledTimes(1);

    first.resolve("- 首轮要点");
    await flush();
    expect(generate).toHaveBeenCalledTimes(2);
    const secondPrompt = generate.mock.calls[1]![0];
    expect(secondPrompt.user).toContain("第三次");
    expect(secondPrompt.user).not.toContain("第二次");
  });
});
