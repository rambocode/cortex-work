import { describe, it, expect, vi } from "vitest";

// draft-generator 顶层 import 了 ../workflow/run-prompt-headless，该模块又经 cli.ts / store.ts
// 传递依赖 electron。测试用注入的假 runPrompt，从不触碰真实实现，故整段 mock 掉以避免
// 在 node 环境加载 electron / spawn 真进程。stub 仅为满足 import 绑定，永不被调用。
vi.mock("../workflow/run-prompt-headless", () => ({
  runPromptHeadless: vi.fn(),
  resolveDefaultWorkspaceRoot: vi.fn(),
}));

import {
  resolveReplyProviderId,
  generateDraft,
  EmptyDraftError,
  type DraftGeneratorDeps,
} from "./draft-generator";
import type { ReplySyncSnapshot } from "../ipc/reply-types";
import type { ReplyPrompt } from "@cortex-work/core/reply/prompt-builder";

// 构造最小 ReplySyncSnapshot：只关心 providerId / defaultAgent 两字段，其余用占位值填满类型。
function makeSnapshot(
  partial: Partial<Pick<ReplySyncSnapshot, "providerId" | "defaultAgent">>,
): ReplySyncSnapshot {
  return {
    settings: {} as ReplySyncSnapshot["settings"],
    memory: {} as ReplySyncSnapshot["memory"],
    defaultAgent: (partial.defaultAgent ?? "claude") as ReplySyncSnapshot["defaultAgent"],
    providerId: partial.providerId,
  };
}

const PROMPT: ReplyPrompt = { system: "SYS", user: "USER" };

// 组装一个返回固定文本的假 runPrompt，并记录收到的 options 以断言拼接 / 透传行为。
function makeDeps(
  text: string,
  opts?: { workspaceRoot?: string; onCall?: (o: unknown) => void },
): DraftGeneratorDeps {
  return {
    runPrompt: (async (o: unknown) => {
      opts?.onCall?.(o);
      return { text };
    }) as DraftGeneratorDeps["runPrompt"],
    resolveWorkspaceRoot: async () => opts?.workspaceRoot ?? "/ws",
  };
}

describe("resolveReplyProviderId 三分支", () => {
  it("snapshot 为 null → 返回 null（触发未配置错误态）", () => {
    expect(resolveReplyProviderId(null)).toBeNull();
  });

  it("显式 providerId 存在 → 优先返回 providerId", () => {
    const snap = makeSnapshot({ providerId: "pi-custom-123", defaultAgent: "claude" });
    expect(resolveReplyProviderId(snap)).toBe("pi-custom-123");
  });

  it("providerId 仅空白字符 → 视为缺失，回落 defaultAgent", () => {
    const snap = makeSnapshot({ providerId: "   ", defaultAgent: "codex" });
    expect(resolveReplyProviderId(snap)).toBe("codex");
  });

  it("无 providerId 但有 defaultAgent → 返回 defaultAgent", () => {
    const snap = makeSnapshot({ defaultAgent: "claude" });
    expect(resolveReplyProviderId(snap)).toBe("claude");
  });

  it("回落 defaultAgent 且为空串 → null", () => {
    const snap = makeSnapshot({ defaultAgent: "" as ReplySyncSnapshot["defaultAgent"] });
    expect(resolveReplyProviderId(snap)).toBeNull();
  });
});

describe("generateDraft happy path", () => {
  it("runPrompt 返回文本 → 清洗后返回候选", async () => {
    const deps = makeDeps("你好，我稍后回复你。");
    const result = await generateDraft({ prompt: PROMPT, providerId: "claude" }, deps);
    expect(result).toBe("你好，我稍后回复你。");
  });

  it("拼接 system+user 下发，并透传 providerId / model / workspaceRoot", async () => {
    let captured: Record<string, unknown> | undefined;
    const deps = makeDeps("ok", {
      workspaceRoot: "/repo/root",
      onCall: (o) => (captured = o as Record<string, unknown>),
    });
    await generateDraft(
      { prompt: PROMPT, providerId: "pi-custom", model: "gpt-x" },
      deps,
    );
    expect(captured?.prompt).toBe("SYS\n\nUSER");
    expect(captured?.providerId).toBe("pi-custom");
    expect(captured?.model).toBe("gpt-x");
    expect(captured?.workspaceRoot).toBe("/repo/root");
  });

  it("透传 AbortSignal 供取消", async () => {
    let captured: Record<string, unknown> | undefined;
    const deps = makeDeps("ok", { onCall: (o) => (captured = o as Record<string, unknown>) });
    const controller = new AbortController();
    await generateDraft(
      { prompt: PROMPT, providerId: "claude", signal: controller.signal },
      deps,
    );
    expect(captured?.signal).toBe(controller.signal);
  });
});

describe("generateDraft sad path（清洗后为空 → EmptyDraftError）", () => {
  it("纯空白输出 → 抛 EmptyDraftError", async () => {
    const deps = makeDeps("   \n\n  ");
    await expect(
      generateDraft({ prompt: PROMPT, providerId: "claude" }, deps),
    ).rejects.toBeInstanceOf(EmptyDraftError);
  });

  it("只有 markdown 空围栏 → 清洗为空 → EmptyDraftError", async () => {
    const deps = makeDeps("```\n\n```");
    await expect(
      generateDraft({ prompt: PROMPT, providerId: "claude" }, deps),
    ).rejects.toBeInstanceOf(EmptyDraftError);
  });
});

describe("generateDraft 输出清洗代表性用例（经 cleanAgentOutput）", () => {
  it("剥 markdown 代码围栏，返回内层正文", async () => {
    const deps = makeDeps("```text\n今天下午三点见。\n```");
    const result = await generateDraft({ prompt: PROMPT, providerId: "claude" }, deps);
    expect(result).toBe("今天下午三点见。");
  });

  it("剥常见开场白行（好的，这是回复：）后保留正文", async () => {
    const deps = makeDeps("好的，这是回复：\n没问题，我马上处理。");
    const result = await generateDraft({ prompt: PROMPT, providerId: "claude" }, deps);
    expect(result).toBe("没问题，我马上处理。");
  });

  it("脱去成对包裹引号", async () => {
    const deps = makeDeps('"收到，谢谢！"');
    const result = await generateDraft({ prompt: PROMPT, providerId: "claude" }, deps);
    expect(result).toBe("收到，谢谢！");
  });

  it("截断特殊 token 残渣", async () => {
    const deps = makeDeps("明天见<|im_end|>多余内容");
    const result = await generateDraft({ prompt: PROMPT, providerId: "claude" }, deps);
    expect(result).toBe("明天见");
  });
});
