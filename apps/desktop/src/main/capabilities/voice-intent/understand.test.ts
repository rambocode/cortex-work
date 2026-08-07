import { describe, expect, it, vi } from "vitest";

import {
  parseIntentResponse,
  understandVoiceIntent,
  understandVoiceIntentFromSettings,
} from "./understand";

describe("parseIntentResponse", () => {
  it("只接受白名单 function_call，未知函数与非法 JSON 回退普通聊天", () => {
    expect(parseIntentResponse('{"function_call":{"name":"exit_assistant"}}')).toEqual({
      name: "exit_assistant",
      source: "intent_llm",
    });
    expect(parseIntentResponse('```json\n{"function_call":{"name":"new_conversation"}}\n```')).toEqual({
      name: "new_conversation",
      source: "intent_llm",
    });
    expect(parseIntentResponse('{"function_call":{"name":"delete_everything"}}')).toEqual({
      name: "continue_chat",
      source: "fallback",
    });
    expect(parseIntentResponse("不是 JSON")).toEqual({ name: "continue_chat", source: "fallback" });
  });
});

describe("understandVoiceIntent", () => {
  it("精确退出命令优先且不调用模型，疑问句不误退出", async () => {
    const complete = vi.fn();
    await expect(understandVoiceIntent(" 退出语音助手。 ", { mode: "function_call" }, { complete }))
      .resolves.toEqual({ name: "exit_assistant", source: "direct" });
    await expect(understandVoiceIntent("退下", { mode: "function_call" }, { complete }))
      .resolves.toEqual({ name: "exit_assistant", source: "direct" });
    await expect(understandVoiceIntent("退下吧", { mode: "function_call" }, { complete }))
      .resolves.toEqual({ name: "exit_assistant", source: "direct" });
    await expect(understandVoiceIntent("你退下吧。", { mode: "nointent" }, { complete }))
      .resolves.toEqual({ name: "exit_assistant", source: "direct" });
    await expect(understandVoiceIntent("怎么退出语音助手？", { mode: "function_call" }, { complete }))
      .resolves.toEqual({ name: "continue_chat", source: "function_call" });
    await expect(understandVoiceIntent("怎么让语音助手退下？", { mode: "function_call" }, { complete }))
      .resolves.toEqual({ name: "continue_chat", source: "function_call" });
    await expect(understandVoiceIntent("新建对话", { mode: "function_call" }, { complete }))
      .resolves.toEqual({ name: "new_conversation", source: "direct" });
    await expect(understandVoiceIntent("关闭屏幕上下文", { mode: "function_call" }, { complete }))
      .resolves.toEqual({ name: "disable_screen_context", source: "direct" });
    expect(complete).not.toHaveBeenCalled();
  });

  it("intent_llm 以严格函数 JSON 分类本地动作", async () => {
    const complete = vi.fn(async () => '{"function_call":{"name":"enable_screen_context"}}');
    await expect(understandVoiceIntent("以后回答时看一下我的屏幕", {
      mode: "intent_llm",
      modelRef: { providerId: "p", modelId: "m" },
    }, { complete })).resolves.toEqual({ name: "enable_screen_context", source: "intent_llm" });
    expect(complete).toHaveBeenCalledWith(expect.objectContaining({
      providerId: "p",
      modelId: "m",
      timeoutMs: 5_000,
    }));
  });

  it("无模型、模型失败或 nointent 均 fail-open，不吞普通对话", async () => {
    const complete = vi.fn(async () => { throw new Error("offline"); });
    await expect(understandVoiceIntent("你好", { mode: "intent_llm" }, { complete }))
      .resolves.toEqual({ name: "continue_chat", source: "fallback" });
    await expect(understandVoiceIntent("你好", {
      mode: "intent_llm",
      modelRef: { providerId: "p", modelId: "m" },
    }, { complete })).resolves.toEqual({ name: "continue_chat", source: "fallback" });
    await expect(understandVoiceIntent("你好", { mode: "nointent" }, { complete }))
      .resolves.toEqual({ name: "continue_chat", source: "disabled" });
  });

  it("持久化设置优先使用专用模型，未指定时跟随全局默认模型", async () => {
    const complete = vi.fn(async () => '{"function_call":{"name":"new_conversation"}}');
    const defaultRef = vi.fn(async () => ({ providerId: "global", modelId: "fast" }));
    const loadSettings = vi.fn(async () => ({
      intentMode: "intent_llm" as const,
      intentProviderId: "dedicated",
      intentModelId: "intent-model",
    }));
    await expect(understandVoiceIntentFromSettings("我们另起一段空白会话吧", {
      complete,
      defaultRef,
      loadSettings,
    })).resolves.toEqual({ name: "new_conversation", source: "intent_llm" });
    expect(complete).toHaveBeenCalledWith(expect.objectContaining({
      providerId: "dedicated",
      modelId: "intent-model",
    }));
    expect(defaultRef).not.toHaveBeenCalled();

    loadSettings.mockResolvedValueOnce({
      intentMode: "intent_llm",
      intentProviderId: "",
      intentModelId: "",
    });
    await understandVoiceIntentFromSettings("我们另起一段空白会话吧", { complete, defaultRef, loadSettings });
    expect(defaultRef).toHaveBeenCalledTimes(1);
    expect(complete).toHaveBeenLastCalledWith(expect.objectContaining({
      providerId: "global",
      modelId: "fast",
    }));
  });
});
