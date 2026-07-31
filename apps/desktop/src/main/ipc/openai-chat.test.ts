// 文本补全适配层直测：锁定收编后仍然对上游成立的那几条**旧契约**——
//   · 采样参数未传则不下发（llm:openaiComplete 依赖，间接覆盖不到）；
//   · 成功返回原始文本，不 trim（trim 责任在调用方）；
//   · 失败抛错，且取消态的 err.name 仍是 AbortError（研究引擎按它归类）；
//   · 截断以 TRUNCATED_MARKER 尾标记表达，单发与流式两条路径都要保住。
//
// 出站替身放在 pi 运行时层（见 __fixtures__/fake-pi-runtime.ts 的说明），本文件因此零网络。

import { beforeEach, describe, expect, it, vi } from "vitest";

let catalog: ReturnType<typeof fakeCatalog> | undefined;
vi.mock("../providers/catalog", () => ({ getProviderCatalog: () => catalog }));
vi.mock("electron", () => ({ safeStorage: { isEncryptionAvailable: () => false } }));

import {
  createFakePiRuntime,
  fakeAssistantMessage,
  fakeCatalog,
} from "../providers/__fixtures__/fake-pi-runtime";
import { postChatCompletion, postChatCompletionStream, stripTruncationMarker, TRUNCATED_MARKER } from "./openai-chat";

const REF = { providerId: "p1", modelId: "m1" };

beforeEach(() => {
  catalog = fakeCatalog();
});

describe("postChatCompletion", () => {
  it("temperature / maxTokens 未传时不下发（llm:openaiComplete 旧契约）", async () => {
    const runtime = createFakePiRuntime();
    await postChatCompletion({ ...REF, messages: [{ role: "user", content: "hi" }], runtime });
    const options = runtime.calls[0]!.options!;
    expect(options).not.toHaveProperty("temperature");
    expect(options).not.toHaveProperty("maxTokens");
  });

  it("temperature 传入时原样下发（reply 温度分层依赖）", async () => {
    const runtime = createFakePiRuntime();
    await postChatCompletion({
      ...REF,
      messages: [
        { role: "system", content: "s" },
        { role: "user", content: "u" },
      ],
      temperature: 0.3,
      runtime,
    });
    expect(runtime.calls[0]!.options!.temperature).toBe(0.3);
    // system 归到 Context.systemPrompt，不再作为一条 message 出现。
    expect(runtime.calls[0]!.context.systemPrompt).toBe("s");
    expect(runtime.calls[0]!.context.messages.map((m) => m.role)).toEqual(["user"]);
  });

  it("maxTokens 传入时下发（写作续写长度约束）", async () => {
    const runtime = createFakePiRuntime();
    await postChatCompletion({ ...REF, messages: [], maxTokens: 96, runtime });
    expect(runtime.calls[0]!.options!.maxTokens).toBe(96);
  });

  it("返回原始正文，不 trim（trim 责任在调用方）", async () => {
    const runtime = createFakePiRuntime({ texts: ["  hello  "] });
    const out = await postChatCompletion({ ...REF, messages: [{ role: "user", content: "hi" }], runtime });
    expect(out).toBe("  hello  ");
  });

  it("供应商报错时抛出带状态码的错误（研究引擎按 /HTTP (\\d{3})/ 归类）", async () => {
    const runtime = createFakePiRuntime({
      respond: () => {
        throw new Error("模型接口 HTTP 500:boom");
      },
    });
    await expect(
      postChatCompletion({ ...REF, messages: [{ role: "user", content: "hi" }], runtime }),
    ).rejects.toThrow(/HTTP 500/);
  });

  it("空白正文抛「模型未返回内容」（上游按这句文案分支）", async () => {
    const runtime = createFakePiRuntime({ texts: ["   "] });
    await expect(
      postChatCompletion({ ...REF, messages: [{ role: "user", content: "hi" }], runtime }),
    ).rejects.toThrow("模型未返回内容");
  });

  it("取消态抛出的错误 name 仍是 AbortError（研究引擎据此区分「取消/超时」）", async () => {
    const runtime = createFakePiRuntime({
      respond: () => fakeAssistantMessage("", { stopReason: "aborted", errorMessage: "aborted" }),
    });
    await expect(postChatCompletion({ ...REF, messages: [], runtime })).rejects.toMatchObject({
      name: "AbortError",
    });
  });

  it("模型引用悬空时抛错且不回退（计划 §5）", async () => {
    const runtime = createFakePiRuntime();
    await expect(
      postChatCompletion({ providerId: "ghost", modelId: "m1", messages: [], runtime }),
    ).rejects.toThrow(/模型引用无效/);
    expect(runtime.calls).toHaveLength(0);
  });

  it("stopReason=length 时正文尾部带截断标记，可被 stripTruncationMarker 还原", async () => {
    const runtime = createFakePiRuntime({
      respond: () => fakeAssistantMessage("未完计划", { stopReason: "length" }),
    });
    const out = await postChatCompletion({ ...REF, messages: [], runtime });
    expect(out).toBe(`未完计划${TRUNCATED_MARKER}`);
    expect(stripTruncationMarker(out)).toEqual({ text: "未完计划", truncated: true });
  });
});

describe("postChatCompletionStream", () => {
  it("onDelta 给的是**累计全文**（这一层的历史契约，研究引擎自己再切增量）", async () => {
    const runtime = createFakePiRuntime({ texts: ["报告正文"], chunk: (t) => [...t] });
    const seen: string[] = [];
    const out = await postChatCompletionStream({
      ...REF,
      messages: [{ role: "user", content: "生成长报告" }],
      maxTokens: 8_000,
      runtime,
      onDelta: (accumulated) => seen.push(accumulated),
    });
    expect(out).toBe("报告正文");
    expect(seen).toEqual(["报", "报告", "报告正", "报告正文"]);
    expect(runtime.calls[0]!.options!.maxTokens).toBe(8_000);
  });

  it("流式以 stopReason=length 结束时同样保留截断标记", async () => {
    const runtime = createFakePiRuntime({
      respond: () => fakeAssistantMessage("未完报告", { stopReason: "length" }),
    });
    const output = await postChatCompletionStream({ ...REF, messages: [], maxTokens: 8_000, runtime });
    expect(output).toBe(`未完报告${TRUNCATED_MARKER}`);
  });
});
