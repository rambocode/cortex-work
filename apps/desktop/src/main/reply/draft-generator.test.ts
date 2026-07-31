// 草稿生成器单测。阶段③·4.1 收编后，出站口从「自拼 URL + fetch」变成 Pi Model Gateway，
// 替身随之下移到 pi 运行时层（见 __fixtures__/fake-pi-runtime.ts 的说明），本文件仍是零网络。
//
// 随之删掉的两组用例（**不是覆盖率倒退**）：
//   · 「SSE 半行跨 chunk 拼接」「供应商无视 stream:true 回普通 JSON 的回退解析」——
//     SSE 分帧与厂商兼容性现在由 pi 的各 api 实现负责，Cortex 侧已无 SSE 解析代码可测；
//   · 「拼 URL / Authorization 头」—— 本模块已经拿不到 baseUrl/apiKey，这正是收编的目的。
// 保留下来的是本模块自己的职责：温度分层、输出清洗、立场标记解析、取消、空草稿判定。

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ReplyPrompt } from "@cortex-work/core/reply/prompt-builder";

let catalog: ReturnType<typeof fakeCatalog> | undefined;
vi.mock("../providers/catalog", () => ({ getProviderCatalog: () => catalog }));
vi.mock("electron", () => ({ safeStorage: { isEncryptionAvailable: () => false } }));

import {
  createFakePiRuntime,
  fakeAssistantMessage,
  fakeCatalog,
} from "../providers/__fixtures__/fake-pi-runtime";
import {
  displayableStreamText,
  EmptyDraftError,
  generateDraft,
  generateDraftStream,
} from "./draft-generator";
import type { ResolvedReplyModel } from "./resolve-model";

const PROMPT: ReplyPrompt = { system: "SYS", user: "USER" };
const TARGET: ResolvedReplyModel = { providerId: "reply", modelId: "m1" };

/** 一次返回固定正文的运行时替身。 */
const runtimeReturning = (text: string) => createFakePiRuntime({ texts: [text] });

/** 流式：把正文按给定分片下发。 */
const streamingRuntime = (text: string, chunk: (t: string) => string[]) =>
  createFakePiRuntime({ texts: [text], chunk });

beforeEach(() => {
  catalog = fakeCatalog("reply", "m1");
});

describe("REPLY_TEMPERATURES 温度分层", () => {
  it("锁定源项目契约值 0.3/0.9/0.2,漂移即报红", async () => {
    const { REPLY_TEMPERATURES } = await import("./draft-generator");
    expect(REPLY_TEMPERATURES).toEqual({ first: 0.3, variant: 0.9, distill: 0.2 });
  });
});

describe("generateDraft 请求构造", () => {
  it("按模型引用寻址、system+user 两条消息、temperature 透传", async () => {
    const runtime = runtimeReturning("你好，稍后回复你。");
    const result = await generateDraft({ prompt: PROMPT, target: TARGET, temperature: 0.3 }, { runtime });
    expect(result).toEqual({ text: "你好，稍后回复你。", stance: null });

    const call = runtime.calls[0]!;
    expect(call.model.provider).toBe("reply");
    expect(call.model.id).toBe("m1");
    expect(call.options!.temperature).toBe(0.3);
    // system 走 pi 的 Context.systemPrompt 独立通道，不拼进 user。
    expect(call.context.systemPrompt).toBe("SYS");
    expect(call.context.messages).toEqual([
      expect.objectContaining({ role: "user", content: "USER" }),
    ]);
  });

  it("reply 场景的 30s 超时仍然下发（比日报的 60s 短）", async () => {
    const runtime = runtimeReturning("x");
    await generateDraft({ prompt: PROMPT, target: TARGET, temperature: 0.3 }, { runtime });
    expect(runtime.calls[0]!.options!.timeoutMs).toBe(30_000);
  });
});

describe("generateDraft sad path", () => {
  it("供应商报错 → 抛错含状态码", async () => {
    const runtime = createFakePiRuntime({
      respond: () => {
        throw new Error("模型接口 HTTP 429:rate limited");
      },
    });
    await expect(
      generateDraft({ prompt: PROMPT, target: TARGET, temperature: 0.3 }, { runtime }),
    ).rejects.toThrow(/HTTP 429/);
  });

  it("正文缺失/空白 → 抛「模型未返回内容」", async () => {
    const runtime = runtimeReturning("   ");
    await expect(
      generateDraft({ prompt: PROMPT, target: TARGET, temperature: 0.3 }, { runtime }),
    ).rejects.toThrow("模型未返回内容");
  });

  it("清洗后为空（只有空围栏）→ EmptyDraftError", async () => {
    const runtime = runtimeReturning("```\n\n```");
    await expect(
      generateDraft({ prompt: PROMPT, target: TARGET, temperature: 0.3 }, { runtime }),
    ).rejects.toBeInstanceOf(EmptyDraftError);
  });

  it("模型引用悬空 → 抛错且一个字节都没出站（计划 §5，不回退）", async () => {
    const runtime = runtimeReturning("x");
    await expect(
      generateDraft(
        { prompt: PROMPT, target: { providerId: "ghost", modelId: "m1" }, temperature: 0.3 },
        { runtime },
      ),
    ).rejects.toThrow(/模型引用无效/);
    expect(runtime.calls).toHaveLength(0);
  });
});

describe("generateDraft 输出清洗（经 cleanAgentOutput）", () => {
  it("剥 markdown 围栏返回内层正文", async () => {
    const runtime = runtimeReturning("```text\n今天下午三点见。\n```");
    const res = await generateDraft({ prompt: PROMPT, target: TARGET, temperature: 0.9 }, { runtime });
    expect(res.text).toBe("今天下午三点见。");
  });

  it("脱去成对包裹引号", async () => {
    const runtime = runtimeReturning('"收到，谢谢！"');
    const res = await generateDraft({ prompt: PROMPT, target: TARGET, temperature: 0.9 }, { runtime });
    expect(res.text).toBe("收到，谢谢！");
  });
});

describe("generateDraft 立场标记行解析", () => {
  it("首行立场标记 → 剥离并回填 stance，正文不含标记", async () => {
    const runtime = runtimeReturning("[stance:agree]\n好，这块我们来承接。");
    const res = await generateDraft({ prompt: PROMPT, target: TARGET, temperature: 0.3 }, { runtime });
    expect(res).toEqual({ text: "好，这块我们来承接。", stance: "agree" });
  });

  it("围栏包裹的标记行也可解析（先剥围栏再剥标记）", async () => {
    const runtime = runtimeReturning("```\n[stance:unsure]\n量级大概多少？\n```");
    const res = await generateDraft({ prompt: PROMPT, target: TARGET, temperature: 0.3 }, { runtime });
    expect(res).toEqual({ text: "量级大概多少？", stance: "unsure" });
  });

  it("标记后正文整体被引号包裹 → 剥标记后再清洗脱壳", async () => {
    const runtime = runtimeReturning('[stance:reject]\n"这个暂时接不了。"');
    const res = await generateDraft({ prompt: PROMPT, target: TARGET, temperature: 0.3 }, { runtime });
    expect(res).toEqual({ text: "这个暂时接不了。", stance: "reject" });
  });

  it("[stance:none] 归一为 null", async () => {
    const runtime = runtimeReturning("[stance:none]\n哈哈好的");
    const res = await generateDraft({ prompt: PROMPT, target: TARGET, temperature: 0.3 }, { runtime });
    expect(res).toEqual({ text: "哈哈好的", stance: null });
  });

  it("剥标记后无正文 → EmptyDraftError", async () => {
    const runtime = runtimeReturning("[stance:agree]");
    await expect(
      generateDraft({ prompt: PROMPT, target: TARGET, temperature: 0.3 }, { runtime }),
    ).rejects.toBeInstanceOf(EmptyDraftError);
  });
});

describe("generateDraft 取消信号", () => {
  it("调用方 signal 已 abort → 请求不出站并抛 AbortError", async () => {
    const controller = new AbortController();
    controller.abort();
    const runtime = runtimeReturning("x");
    await expect(
      generateDraft(
        { prompt: PROMPT, target: TARGET, temperature: 0.3, signal: controller.signal },
        { runtime },
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(runtime.calls).toHaveLength(0);
  });

  it("在途请求被 pi 判为 aborted → 同样抛 AbortError", async () => {
    const runtime = createFakePiRuntime({
      respond: () => fakeAssistantMessage("", { stopReason: "aborted", errorMessage: "aborted" }),
    });
    await expect(
      generateDraft({ prompt: PROMPT, target: TARGET, temperature: 0.3 }, { runtime }),
    ).rejects.toMatchObject({ name: "AbortError" });
  });
});

// ── 流式生成 ──────────────────────────────────────────────────────────────────

describe("generateDraftStream 流式生成", () => {
  it("增量回调给剥立场行的可外显文本 + 已解析立场；最终返回清洗结果", async () => {
    const runtime = streamingRuntime("[stance:agree]\n好，这块我们来承接。", (t) => [
      "[stance:agree]\n",
      "好，",
      t.slice("[stance:agree]\n好，".length),
    ]);
    const updates: Array<[string, string | null]> = [];
    const res = await generateDraftStream(
      { prompt: PROMPT, target: TARGET, temperature: 0.3 },
      (text, stance) => updates.push([text, stance]),
      { runtime },
    );
    expect(res).toEqual({ text: "好，这块我们来承接。", stance: "agree" });
    // 增量文本不含标记行，且随流增长
    expect(updates).toEqual([
      ["好，", "agree"],
      ["好，这块我们来承接。", "agree"],
    ]);
  });

  it("标记行首行未收齐时按住不外显（不闪现半截 [stan...）", async () => {
    const runtime = streamingRuntime("[stance:none]\n哈哈好的", () => ["[stan", "ce:none]\n哈哈", "好的"]);
    const updates: string[] = [];
    const res = await generateDraftStream(
      { prompt: PROMPT, target: TARGET, temperature: 0.3 },
      (text) => updates.push(text),
      { runtime },
    );
    expect(updates).toEqual(["哈哈", "哈哈好的"]);
    expect(res).toEqual({ text: "哈哈好的", stance: null });
  });

  it("流为空 → 抛「模型未返回内容」", async () => {
    const runtime = streamingRuntime("", () => []);
    await expect(
      generateDraftStream({ prompt: PROMPT, target: TARGET, temperature: 0.3 }, () => {}, { runtime }),
    ).rejects.toThrow("模型未返回内容");
  });
});

describe("displayableStreamText 增量外显", () => {
  it("首行未完整且疑似标记/围栏前缀 → null（按住）", () => {
    expect(displayableStreamText("[stan")).toBeNull();
    expect(displayableStreamText("【同")).toBeNull();
    expect(displayableStreamText("```")).toBeNull();
    expect(displayableStreamText("  ")).toBeNull();
  });

  it("普通正文直接外显；标记行/开头围栏行被剥", () => {
    expect(displayableStreamText("好，接了")).toBe("好，接了");
    expect(displayableStreamText("[stance:agree]\n好，接了")).toBe("好，接了");
    expect(displayableStreamText("```text\n今天下午")).toBe("今天下午");
  });
});
