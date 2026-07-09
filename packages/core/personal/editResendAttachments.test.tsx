// @vitest-environment jsdom
// 编辑重发沿用引用文件/图片（需求 A）回归测试。走真实 usePersonalActions（不打桩 send），
// 只 mock bridge 的 CLI 边界（startCli 等），断言 presavedDocs 通道端到端生效：
// 重发后的用户消息带原 files/images，且 doc system prompt 被重新注入 startCli。
// core 通例是 node 纯函数测试，但 usePersonalActions 依赖 React context + bridge 注入，
// 故本文件照 taskDelegate.test.tsx 的 per-file jsdom + renderHook/CoreProvider 写法。

import { renderHook, act } from "@testing-library/react";
import { QueryClient } from "@tanstack/react-query";
import { describe, it, expect, beforeEach, vi } from "vitest";
import type { ReactNode } from "react";
import { CoreProvider } from "../provider";
import { usePersonalStore } from "../store/personal";
import { usePersonalActions, personalChatKeys } from "./messages";
import type { DesktopBridge } from "../desktop/bridge";
import type { SessionMeta, CliStartRequest } from "../desktop/types";
import type { Message, ChatFileRef, ChatImageRef } from "../types";

const FILES: ChatFileRef[] = [{ path: "/docs/copy-zh.md", name: "copy-zh.md", mimeType: "text/markdown", sizeBytes: 10 }];
const IMAGES: ChatImageRef[] = [{ path: "/imgs/a.png", name: "a.png", mimeType: "image/png" }];

const session: SessionMeta = {
  id: "s1",
  projectId: "p1",
  title: "会话标题", // 非默认占位标题 → autoTitle 早退，不触发 oneshotCli
  agent: "claude",
  createdAt: 1,
  updatedAt: 1,
};

// 历史：带文档+图的用户消息 + 一条 agent 回复。
function seedMessages(): Message[] {
  return [
    { kind: "text", who: "me", time: "11:39", text: "v2ex 没有邀请码如何使用", uid: "u1", images: IMAGES, files: FILES },
    { kind: "text", who: "claude", time: "11:39", text: "旧回复", uid: "a1" },
  ];
}

// 最小 bridge：只覆盖 editResend→send（claude 单发路径）沿途会触碰的方法。
function fakeBridge() {
  const startCli = vi.fn(async (_req: CliStartRequest) => {});
  const bridge = {
    loadChat: async () => [],
    saveChat: vi.fn(async () => {}),
    startCli,
    onCliEvent: () => () => {},
  } as unknown as DesktopBridge;
  return { bridge, startCli };
}

function wrapper(bridge: DesktopBridge, queryClient: QueryClient) {
  const W = ({ children }: { children: ReactNode }) => (
    <CoreProvider wsId="ws" identity={{ userId: "me", name: "我" }} desktopBridge={bridge} queryClient={queryClient}>
      {children}
    </CoreProvider>
  );
  W.displayName = "TestWrapper";
  return W;
}

beforeEach(() => {
  usePersonalStore.setState({ sessions: [session], runningBySession: {}, piRuntimeBySession: {} });
});

describe("editResend 沿用原消息引用文件/图片（presavedDocs 通道）", () => {
  it("编辑重发后：用户消息带原 files+images，doc prompt 重新注入 startCli", async () => {
    const qc = new QueryClient();
    const key = personalChatKeys.detail(session.id);
    qc.setQueryData<Message[]>(key, seedMessages());
    const { bridge, startCli } = fakeBridge();
    const { result } = renderHook(() => usePersonalActions(), { wrapper: wrapper(bridge, qc) });

    await act(async () => {
      await result.current.editResend(session, "/proj", "u1", "编辑后的新问题", []);
    });

    // startCli 被调用，且 doc system prompt（extract_document 提示 + 文件路径）随重发注入。
    expect(startCli).toHaveBeenCalledTimes(1);
    const req = startCli.mock.calls[0]![0] as CliStartRequest;
    expect(req.prompt).toBe("编辑后的新问题");
    expect(req.appendSystemPrompt).toContain("copy-zh.md");
    expect(req.appendSystemPrompt).toContain("/docs/copy-zh.md");
    // 图片路径照旧透传（presavedImages 通道回归护栏）。
    expect(req.images?.map((i) => i.path)).toEqual(["/imgs/a.png"]);

    // 重发后的用户消息完整携带原引用文件与图片（气泡回显不丢）。
    const messages = qc.getQueryData<Message[]>(key) ?? [];
    const user = messages.find((m) => m.kind === "text" && m.who === "me");
    expect(user?.kind === "text" && user.files).toEqual(FILES);
    expect(user?.kind === "text" && user.images).toEqual(IMAGES);
    // 旧回复已被截断（编辑=覆盖语义不变）。
    expect(messages.some((m) => m.uid === "a1")).toBe(false);
  });

  it("send 直接带 presavedDocs：不经 docSave 重新落盘，消息 files 原样挂载", async () => {
    const qc = new QueryClient();
    const key = personalChatKeys.detail(session.id);
    qc.setQueryData<Message[]>(key, []);
    const { bridge, startCli } = fakeBridge();
    const { result } = renderHook(() => usePersonalActions(), { wrapper: wrapper(bridge, qc) });

    await act(async () => {
      await result.current.send(session, "/proj", "重发", [], undefined, undefined, undefined, undefined, undefined, FILES);
    });

    expect(startCli).toHaveBeenCalledTimes(1);
    const req = startCli.mock.calls[0]![0] as CliStartRequest;
    expect(req.appendSystemPrompt).toContain("/docs/copy-zh.md");
    const messages = qc.getQueryData<Message[]>(key) ?? [];
    const user = messages.find((m) => m.kind === "text" && m.who === "me");
    expect(user?.kind === "text" && user.files).toEqual(FILES);
  });
});
