// 转写 LLM 纠错的失败回退契约:任何环节不可用都必须原文返回,绝不 reject。

import { describe, expect, it, vi } from "vitest";
import { polishTranscript } from "./polish";
import { DEFAULT_POLISH_PROMPT } from "../../ipc/types";

const REF = { providerId: "p1", modelId: "m1" };

// deps.complete 的参数形状(与 polish.ts 的 PolishDeps 对齐);显式标注让 mock.calls 有元组类型。
type CompleteParams = {
  providerId: string;
  modelId: string;
  messages: { role: "user"; content: string }[];
  timeoutMs: number;
};

describe("polishTranscript", () => {
  it("正常修正:指令在前、词典与转写文本追加在后,输出修正文", async () => {
    const complete = vi.fn(async (_params: CompleteParams) => "修正后的文本。");
    const out = await polishTranscript(
      "修正前的文本",
      { dictionary: ["Cortex"], ref: REF },
      { complete, defaultRef: async () => null },
    );
    expect(out).toBe("修正后的文本。");
    const content = complete.mock.calls[0]![0].messages[0]!.content;
    expect(content.startsWith(DEFAULT_POLISH_PROMPT)).toBe(true);
    expect(content).toContain("Cortex");
    expect(content.endsWith("修正前的文本")).toBe(true);
  });

  it("自定义 prompt 替换内置指令", async () => {
    const complete = vi.fn(async (_params: CompleteParams) => "好的文本");
    await polishTranscript("原文本", { prompt: "自定义纠错指令", ref: REF }, { complete, defaultRef: async () => null });
    expect(complete.mock.calls[0]![0].messages[0]!.content.startsWith("自定义纠错指令")).toBe(true);
  });

  it("未指定专用模型时回落全局默认模型;两者皆无则原文返回且不发请求", async () => {
    const complete = vi.fn(async (_params: CompleteParams) => "x");
    await polishTranscript("文本", {}, { complete, defaultRef: async () => REF });
    expect(complete.mock.calls[0]![0].providerId).toBe("p1");

    const noModel = vi.fn(async (_params: CompleteParams) => "x");
    const out = await polishTranscript("文本", {}, { complete: noModel, defaultRef: async () => null });
    expect(out).toBe("文本");
    expect(noModel).not.toHaveBeenCalled();
  });

  it("LLM 抛错 / 输出为空 / 输出长度悬殊(疑似答题或改写)时回退原文", async () => {
    const boom = vi.fn(async () => {
      throw new Error("network");
    });
    expect(await polishTranscript("原文", { ref: REF }, { complete: boom, defaultRef: async () => null })).toBe("原文");

    const empty = vi.fn(async () => "   ");
    expect(await polishTranscript("原文", { ref: REF }, { complete: empty, defaultRef: async () => null })).toBe("原文");

    const rant = vi.fn(async () => "好的,我来帮你修正这段文本:".repeat(20));
    expect(await polishTranscript("原文", { ref: REF }, { complete: rant, defaultRef: async () => null })).toBe("原文");
  });

  it("超长转写不送修正(延迟与改写风险反超收益)", async () => {
    const complete = vi.fn(async (_params: CompleteParams) => "x");
    const long = "字".repeat(600);
    expect(await polishTranscript(long, { ref: REF }, { complete, defaultRef: async () => null })).toBe(long);
    expect(complete).not.toHaveBeenCalled();
  });
});
