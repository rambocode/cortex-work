// llm:queryUnderstand 的 handler 逻辑测试（handleQueryUnderstand，可注入 deps）。
// 红线：显式引用优先 → 缺省回落全局默认模型 → 连默认也没有返回 no-model；
// 任何异常都结构化返回（ok:false），绝不 throw 过桥——renderer 侧按「未改写」降级。
//
// llm.ts 顶层 import 了 electron 与若干 capabilities，测试环境整体 mock（仿 ask.test.ts）。
import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  ipcMain: { handle: vi.fn() },
}));
vi.mock("./push-sign", () => ({
  audioSpeechPayload: vi.fn(),
  audioSpeechUrl: vi.fn(),
  audioVoiceUrls: vi.fn(),
}));
vi.mock("./openai-chat", () => ({ postChatCompletion: vi.fn() }));
vi.mock("../capabilities/asr/online-transcribe", () => ({
  transcribeOnline: vi.fn(),
  ASR_MAX_BYTES: 1,
}));
vi.mock("../capabilities/asr/transcribe-auth", () => ({ authHeaders: vi.fn() }));
vi.mock("../capabilities/edge-tts/client", () => ({ synthesizeEdgeTts: vi.fn() }));
vi.mock("../capabilities/edge-tts/voices", () => ({ listEdgeTtsVoices: vi.fn() }));
vi.mock("../providers/default-model", () => ({ getDefaultModelRef: vi.fn() }));

import { handleQueryUnderstand, type QueryUnderstandHandlerDeps } from "./llm";

const REQ = { system: "SYSTEM", user: "USER" };

function depsWith(over: Partial<QueryUnderstandHandlerDeps>): QueryUnderstandHandlerDeps {
  return {
    complete: vi.fn(async () => '{"intent":"retrieve","rewrite_query":"q"}'),
    defaultRef: vi.fn(async () => ({ providerId: "default-p", modelId: "default-m" })),
    ...over,
  };
}

describe("handleQueryUnderstand", () => {
  it("显式引用优先：不查默认模型，小额度参数写死（0.3 温 / 200 token / 5s）", async () => {
    const deps = depsWith({});
    const result = await handleQueryUnderstand({ ...REQ, providerId: "p1", modelId: "m1" }, deps);
    expect(result).toEqual({ ok: true, content: '{"intent":"retrieve","rewrite_query":"q"}' });
    expect(deps.defaultRef).not.toHaveBeenCalled();
    expect(deps.complete).toHaveBeenCalledWith({
      providerId: "p1",
      modelId: "m1",
      messages: [
        { role: "system", content: "SYSTEM" },
        { role: "user", content: "USER" },
      ],
      temperature: 0.3,
      maxTokens: 200,
      timeoutMs: 5_000,
    });
  });

  it("缺省引用（含只给一半）→ 回落全局默认模型", async () => {
    const deps = depsWith({});
    await handleQueryUnderstand({ ...REQ, providerId: "p1" }, deps);
    expect(deps.defaultRef).toHaveBeenCalled();
    expect(deps.complete).toHaveBeenCalledWith(
      expect.objectContaining({ providerId: "default-p", modelId: "default-m" }),
    );
  });

  it("无默认模型 → {ok:false, no-model}，不调补全", async () => {
    const deps = depsWith({ defaultRef: vi.fn(async () => null) });
    const result = await handleQueryUnderstand(REQ, deps);
    expect(result).toEqual({ ok: false, reason: "no-model" });
    expect(deps.complete).not.toHaveBeenCalled();
  });

  it("defaultRef 抛错也按 no-model 收敛（不 throw 过桥）", async () => {
    const deps = depsWith({
      defaultRef: vi.fn(async () => {
        throw new Error("store 读坏");
      }),
    });
    await expect(handleQueryUnderstand(REQ, deps)).resolves.toEqual({ ok: false, reason: "no-model" });
  });

  it("补全抛错 → {ok:false, error} 携带原因，不 throw 过桥", async () => {
    const deps = depsWith({
      complete: vi.fn(async () => {
        throw new Error("端点 500");
      }),
    });
    const result = await handleQueryUnderstand({ ...REQ, providerId: "p1", modelId: "m1" }, deps);
    expect(result).toEqual({ ok: false, reason: "error", error: "端点 500" });
  });
});
