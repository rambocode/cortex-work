import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DesktopBridge } from "../desktop/bridge";
import { useChatStore } from "./compat/chat-store";
import {
  ensureDesignAssistantSessionLoaded,
  installDesignAssistantSessionPersistence,
} from "./design-assistant-session";
import { clearDesignResumeSessions } from "./run/design-run-manager";

function bridgeWith(options: Partial<DesktopBridge> = {}): DesktopBridge {
  return {
    readFile: vi.fn(async () => {
      throw new Error("not found");
    }),
    writeFile: vi.fn(async () => undefined),
    deleteEntry: vi.fn(async () => undefined),
    deleteChat: vi.fn(async () => undefined),
    ...options,
  } as unknown as DesktopBridge;
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("design assistant session persistence", () => {
  beforeEach(() => {
    useChatStore.getState().resetMirror();
  });

  it("切换演示文稿前先把来源文稿的聊天镜像写回磁盘", async () => {
    const writeFile = vi.fn(async () => undefined);
    const bridge = bridgeWith({ writeFile });
    installDesignAssistantSessionPersistence(bridge);
    await ensureDesignAssistantSessionLoaded("/workspace", "deck-a", true);
    useChatStore.setState({
      threads: [
        {
          id: "design-deck-a",
          title: "",
          updatedAt: "2026-07-27T00:00:00.000Z",
          model: "",
          mode: "agent",
        },
      ],
      activeThreadId: "design-deck-a",
      blocks: [{ kind: "user", id: "u-a", text: "A 的问题" }],
    });

    await ensureDesignAssistantSessionLoaded("/workspace", "deck-b", true);

    expect(writeFile).toHaveBeenCalledWith(
      expect.stringMatching(/\.cortex-design\/deck-a\/assistant-session\.json$/),
      expect.stringContaining("A 的问题"),
    );
    expect(useChatStore.getState().blocks).toEqual([]);
  });

  it("显式新会话会删除旧快照、附件和内存镜像", async () => {
    const deleteEntry = vi.fn(async () => undefined);
    const deleteChat = vi.fn(async () => undefined);
    const bridge = bridgeWith({ deleteEntry, deleteChat });
    installDesignAssistantSessionPersistence(bridge);
    await ensureDesignAssistantSessionLoaded("/workspace", "deck-a", true);
    useChatStore.setState({
      blocks: [{ kind: "user", id: "u-old", text: "旧问题" }],
    });

    clearDesignResumeSessions("deck-a");

    await vi.waitFor(() => {
      expect(deleteEntry).toHaveBeenCalledWith(
        expect.stringMatching(/\.cortex-design\/deck-a\/assistant-session\.json$/),
      );
      expect(deleteChat).toHaveBeenCalledWith("design-deck-a");
    });
    expect(useChatStore.getState().blocks).toEqual([]);
  });

  it("聊天镜像变化后自动节流保存，避免只能依赖正常回合退出", async () => {
    vi.useFakeTimers();
    const writeFile = vi.fn(async () => undefined);
    const bridge = bridgeWith({ writeFile });
    installDesignAssistantSessionPersistence(bridge);
    await ensureDesignAssistantSessionLoaded("/workspace", "deck-a", true);

    useChatStore.setState({
      blocks: [{ kind: "user", id: "u-live", text: "尚未退出的回合" }],
    });
    await vi.advanceTimersByTimeAsync(300);

    expect(writeFile).toHaveBeenCalledWith(
      expect.stringMatching(/\.cortex-design\/deck-a\/assistant-session\.json$/),
      expect.stringContaining("尚未退出的回合"),
    );
    vi.useRealTimers();
  });

  it("快速切换时不等待旧文稿的慢加载，且旧结果不能覆盖新文稿", async () => {
    const deckA = deferred<{ content: string; truncated: boolean }>();
    const readFile = vi.fn((path: string) => {
      if (path.includes("/deck-a/")) return deckA.promise;
      return Promise.resolve({
        content: JSON.stringify({
          version: 1,
          documentId: "deck-b",
          updatedAt: "2026-07-27T00:00:00.000Z",
          thread: null,
          blocks: [{ kind: "user", id: "u-b", text: "B 会话" }],
          liveAssistant: "",
        }),
        truncated: false,
      });
    });
    const bridge = bridgeWith({ readFile: readFile as unknown as DesktopBridge["readFile"] });
    installDesignAssistantSessionPersistence(bridge);

    const loadingA = ensureDesignAssistantSessionLoaded("/workspace", "deck-a", true);
    await Promise.resolve();
    const loadingB = ensureDesignAssistantSessionLoaded("/workspace", "deck-b", true);
    await Promise.resolve();

    expect(readFile).toHaveBeenCalledWith(expect.stringContaining("/deck-b/"));
    await loadingB;
    deckA.resolve({
      content: JSON.stringify({
        version: 1,
        documentId: "deck-a",
        updatedAt: "2026-07-27T00:00:00.000Z",
        thread: null,
        blocks: [{ kind: "user", id: "u-a", text: "A 会话" }],
        liveAssistant: "",
      }),
      truncated: false,
    });
    await loadingA;

    expect(useChatStore.getState().blocks).toEqual([
      expect.objectContaining({ id: "u-b", text: "B 会话" }),
    ]);
  });

  it("加载时过滤非法块，并把中断中的工具与流式文本恢复为静态历史", async () => {
    const bridge = bridgeWith({
      readFile: vi.fn(async () => ({
        content: JSON.stringify({
          version: 1,
          documentId: "deck-a",
          updatedAt: "2026-07-27T00:00:00.000Z",
          thread: null,
          blocks: [
            { unexpected: true },
            { kind: "tool", id: "tool-running", summary: "MCP", status: "running" },
          ],
          liveAssistant: "中断前已经输出的正文",
        }),
        truncated: false,
      })),
    });
    installDesignAssistantSessionPersistence(bridge);

    await ensureDesignAssistantSessionLoaded("/workspace", "deck-a", true);

    expect(useChatStore.getState().blocks).toEqual([
      expect.objectContaining({ kind: "tool", id: "tool-running", status: "error" }),
      expect.objectContaining({ kind: "assistant", text: "中断前已经输出的正文" }),
    ]);
    expect(useChatStore.getState().busy).toBe(false);
    expect(useChatStore.getState().liveAssistant).toBe("");
  });

  it("一次保存失败不会产生未处理拒绝，后续变更仍会重试", async () => {
    vi.useFakeTimers();
    const writeFile = vi
      .fn<(path: string, content: string) => Promise<void>>()
      .mockRejectedValueOnce(new Error("disk full"))
      .mockResolvedValue(undefined);
    const bridge = bridgeWith({ writeFile });
    installDesignAssistantSessionPersistence(bridge);
    await ensureDesignAssistantSessionLoaded("/workspace", "deck-a", true);

    useChatStore.setState({
      blocks: [{ kind: "user", id: "u-1", text: "第一次" }],
    });
    await vi.advanceTimersByTimeAsync(300);
    useChatStore.setState({
      blocks: [{ kind: "user", id: "u-2", text: "第二次" }],
    });
    await vi.advanceTimersByTimeAsync(300);

    expect(writeFile).toHaveBeenCalledTimes(2);
    expect(writeFile.mock.calls[1]?.[1]).toContain("第二次");
    vi.useRealTimers();
  });
});
