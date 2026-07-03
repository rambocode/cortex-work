import { describe, it, expect, vi } from "vitest";
import { ReplyDistiller, extractMineSamples } from "./distill";
import { emptyMemoryState, type MemoryState } from "@cortex-work/core/reply/memory";
import type { ReplySyncSnapshot } from "../ipc/reply-types";
import type { DraftAcceptedInfo } from "./controller";

// 构造一个最小 ReplySyncSnapshot：可控学习开关与分区 memory。
function makeSnapshot(params: {
  learningEnabled: boolean;
  memory?: MemoryState;
}): ReplySyncSnapshot {
  return {
    settings: {
      draftTrigger: "cmd",
      voiceTrigger: "fn",
      learningEnabled: params.learningEnabled,
      userProfile: "",
    },
    memory: params.memory ?? emptyMemoryState(),
    defaultAgent: "claude",
    providerId: undefined,
    model: undefined,
  };
}

// IM 类应用捕获信息（channelScopeForCapturedApp → "im"）。
function imDraft(overrides: Partial<DraftAcceptedInfo> = {}): DraftAcceptedInfo {
  return {
    draft: "好的，明天见",
    conversation: "对方：明天有空吗？\n我：应该可以\n对方：那约上午",
    appName: "WeChat",
    appBundleId: "com.tencent.xinWeChat",
    ...overrides,
  };
}

// 一个可手动 resolve 的延迟 Promise，用于测「单飞」时序。
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("extractMineSamples", () => {
  it("只抽取「我：」侧行、剥前缀去空白，对方行与空行丢弃", () => {
    const transcript = "对方：在吗\n我：在的\n我：稍等\n对方：好\n我：  ";
    expect(extractMineSamples(transcript)).toEqual(["在的", "稍等"]);
  });

  it("无「我：」结构（AX 原文）时返回空数组", () => {
    expect(extractMineSamples("这是一段没有说话人前缀的文本")).toEqual([]);
  });
});

describe("ReplyDistiller.onDraftAccepted", () => {
  it("学习开关关闭 → 零副作用（不生成、不持久化）", () => {
    const generate = vi.fn(async () => "- 规则A");
    const persistLearned = vi.fn();
    const distiller = new ReplyDistiller({
      getSnapshot: () => makeSnapshot({ learningEnabled: false }),
      generate,
      persistLearned,
    });
    distiller.onDraftAccepted(imDraft());
    expect(generate).not.toHaveBeenCalled();
    expect(persistLearned).not.toHaveBeenCalled();
  });

  it("开关开：样本（我：侧 + 草稿）入队并按 im 路由，清洗后覆盖 auto", async () => {
    let capturedUser = "";
    const generate = vi.fn(async (prompt: { system: string; user: string }) => {
      capturedUser = prompt.user;
      // 模型输出夹带解释文字，清洗应只留 bullet 行。
      return "分析如下：\n- 句子简短\n- 少用寒暄\n随便一句解释";
    });
    const persistLearned = vi.fn();
    const distiller = new ReplyDistiller({
      getSnapshot: () => makeSnapshot({ learningEnabled: true }),
      generate,
      persistLearned,
    });

    distiller.onDraftAccepted(imDraft());
    // 等待后台 drain 完成。
    await vi.waitFor(() => expect(persistLearned).toHaveBeenCalledTimes(1));

    // 路由到 im 分区；持久化的是清洗后的要点（不含解释文字）。
    expect(persistLearned).toHaveBeenCalledWith("im", "- 句子简短\n- 少用寒暄");
    // 样本原文（我：侧「应该可以」+ 草稿）进入 prompt，但持久化只落要点、不落样本。
    expect(capturedUser).toContain("应该可以");
    expect(capturedUser).toContain("好的，明天见");
    const persistedAuto = persistLearned.mock.calls[0][1];
    expect(persistedAuto).not.toContain("应该可以");
    expect(persistedAuto).not.toContain("好的，明天见");
  });

  it("邮件类应用路由到 email 分区", async () => {
    const generate = vi.fn(async () => "- 用称呼与署名");
    const persistLearned = vi.fn();
    const distiller = new ReplyDistiller({
      getSnapshot: () => makeSnapshot({ learningEnabled: true }),
      generate,
      persistLearned,
    });
    distiller.onDraftAccepted(
      imDraft({ appName: "Mail", appBundleId: "com.apple.mail" }),
    );
    await vi.waitFor(() => expect(persistLearned).toHaveBeenCalledTimes(1));
    expect(persistLearned.mock.calls[0][0]).toBe("email");
  });

  it("清洗后为空（模型只吐解释）→ 不覆盖 auto（不调 persist）", async () => {
    const generate = vi.fn(async () => "这是一段没有任何要点的解释文字");
    const persistLearned = vi.fn();
    const distiller = new ReplyDistiller({
      getSnapshot: () => makeSnapshot({ learningEnabled: true }),
      generate,
      persistLearned,
    });
    distiller.onDraftAccepted(imDraft());
    await vi.waitFor(() => expect(generate).toHaveBeenCalledTimes(1));
    // 让微任务跑完。
    await Promise.resolve();
    expect(persistLearned).not.toHaveBeenCalled();
  });

  it("生成失败 → 静默（不抛、不持久化）", async () => {
    const generate = vi.fn(async () => {
      throw new Error("agent 不可用");
    });
    const persistLearned = vi.fn();
    const warn = vi.fn();
    const distiller = new ReplyDistiller({
      getSnapshot: () => makeSnapshot({ learningEnabled: true }),
      generate,
      persistLearned,
      logger: { warn },
    });
    distiller.onDraftAccepted(imDraft());
    await vi.waitFor(() => expect(warn).toHaveBeenCalled());
    expect(persistLearned).not.toHaveBeenCalled();
  });

  it("蒸馏进行中再次写回 → 排队不并发（单飞），且第二轮合并新样本", async () => {
    const first = deferred<string>();
    const second = deferred<string>();
    const calls: string[][] = [];
    let n = 0;
    const generate = vi.fn(async (prompt: { user: string }) => {
      // 记录每次蒸馏看到的样本快照（prompt.user 含编号样本行）。
      calls.push(prompt.user.split("\n"));
      n += 1;
      return n === 1 ? first.promise : second.promise;
    });
    const persistLearned = vi.fn();
    const distiller = new ReplyDistiller({
      getSnapshot: () => makeSnapshot({ learningEnabled: true }),
      generate,
      persistLearned,
    });

    // 第一次写回 → 启动蒸馏(在途，await first)。
    distiller.onDraftAccepted(imDraft({ draft: "回复一" }));
    await vi.waitFor(() => expect(generate).toHaveBeenCalledTimes(1));

    // 在途中第二次写回：不应立刻发起第二个 generate（单飞）。
    distiller.onDraftAccepted(imDraft({ draft: "回复二" }));
    await Promise.resolve();
    expect(generate).toHaveBeenCalledTimes(1);

    // 放行第一轮 → drain 续跑第二轮。
    first.resolve("- 要点一");
    await vi.waitFor(() => expect(generate).toHaveBeenCalledTimes(2));
    second.resolve("- 要点二");
    await vi.waitFor(() => expect(persistLearned).toHaveBeenCalledTimes(2));

    // 第二轮 prompt 应包含两次写回累积的草稿样本（合并，非丢弃）。
    const secondPromptText = calls[1].join("\n");
    expect(secondPromptText).toContain("回复一");
    expect(secondPromptText).toContain("回复二");
  });

  it("连续蒸馏用本地 auto 覆盖累积（existingAuto 传上一轮产出）", async () => {
    const seenExistingAuto: string[] = [];
    let n = 0;
    const generate = vi.fn(async (prompt: { user: string }) => {
      // buildDistillPrompt 把 existingAuto 放在「已学到的规则：」段。
      const match = prompt.user.includes("已学到的规则：");
      seenExistingAuto.push(match ? "has-existing" : "no-existing");
      n += 1;
      return `- 第${n}轮要点`;
    });
    const persistLearned = vi.fn();
    const distiller = new ReplyDistiller({
      getSnapshot: () => makeSnapshot({ learningEnabled: true }),
      generate,
      persistLearned,
    });

    distiller.onDraftAccepted(imDraft());
    await vi.waitFor(() => expect(persistLearned).toHaveBeenCalledTimes(1));
    distiller.onDraftAccepted(imDraft());
    await vi.waitFor(() => expect(persistLearned).toHaveBeenCalledTimes(2));

    // 第一轮无既有 auto；第二轮应带上第一轮蒸馏产出作为 existingAuto。
    expect(seenExistingAuto[0]).toBe("no-existing");
    expect(seenExistingAuto[1]).toBe("has-existing");
  });
});
