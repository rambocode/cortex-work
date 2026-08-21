/**
 * @vitest-environment jsdom
 */
import { createElement, type ReactNode } from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, it, expect, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { getConversation } from "../mock/api";
import {
  applySendMessage,
  applyApproveDecision,
  applyAvatarPollingSnapshot,
  loadAvatarPollingSnapshot,
  restoreAvatarBusySession,
  useCortexActions,
} from "./mutations";
import {
  getAvatarSession,
  initAvatarSession,
  isSessionBusy,
  withAvatarSession,
  type AvatarSessionState,
  type AvatarTaskMessageFrame,
} from "./session-stream";
import type { ApiClient } from "../api/client";
import type { Contact, Conversation } from "../types";
import { conversationKeys } from "./queries";
import { CoreProvider } from "../provider";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function wangyutong(): Promise<Conversation> {
  const c = await getConversation("wangyutong");
  if (!c) throw new Error("fixture missing");
  return c;
}

describe("applySendMessage", () => {
  it("appends my message and drops any standing typing indicator", async () => {
    const convo = await wangyutong();
    expect(convo.messages.some((m) => m.kind === "typing")).toBe(true);

    const next = applySendMessage(convo, "看起来不错,继续", "09:25");

    expect(next.messages.some((m) => m.kind === "typing")).toBe(false);
    const last = next.messages[next.messages.length - 1]!;
    expect(last.kind).toBe("text");
    if (last.kind === "text") {
      expect(last.who).toBe("me");
      expect(last.text).toBe("看起来不错,继续");
    }
  });
});

describe("applyApproveDecision", () => {
  it("marks the upstream diff card applied and turns the approve card into an active log", async () => {
    const convo = await wangyutong();
    const approve = convo.messages.find((m) => m.kind === "approve")!;

    const next = applyApproveDecision(convo, approve.uid!, "approve", "09:26");

    const diff = next.messages.find((m) => m.kind === "diff");
    expect(diff && diff.kind === "diff" && diff.status).toBe("applied");

    const converted = next.messages.find((m) => m.uid === approve.uid)!;
    expect(converted.kind).toBe("agentLog");
    if (converted.kind === "agentLog") {
      expect(converted.active).toBe(true);
      expect(converted.title).toContain("已批准");
    }
  });

  it("marks the diff rejected and resets the work tree on reject", async () => {
    const convo = await wangyutong();
    const approve = convo.messages.find((m) => m.kind === "approve")!;

    const next = applyApproveDecision(convo, approve.uid!, "reject", "09:26");

    const diff = next.messages.find((m) => m.kind === "diff");
    expect(diff && diff.kind === "diff" && diff.status).toBe("rejected");
    const converted = next.messages.find((m) => m.uid === approve.uid)!;
    expect(converted.kind).toBe("agentLog");
    if (converted.kind === "agentLog") {
      expect(converted.completed).toBe(true);
    }
  });
});

describe("applyAvatarPollingSnapshot", () => {
  function avatarConvo(): Conversation {
    const base: Conversation = {
      headerStatus: { dot: "online", text: "" },
      metaRow: [],
      messages: [{ kind: "text", who: "me", time: "09:30", text: "帮我看下", uid: "u1" }],
    };
    return withAvatarSession(base, {
      ...initAvatarSession(1),
      taskId: "task-1",
      phase: "running",
      replyAnchor: 1,
    });
  }

  it("终态 summary 到达时清掉 busy，并返回 conversationId 供调用方刷新权威历史", () => {
    const result = applyAvatarPollingSnapshot(avatarConvo(), {
      contact: undefined,
      generation: 1,
      frames: [],
      next: {
        taskId: "task-1",
        phase: "running",
        outcome: "done",
        conversationId: "conv-1",
      },
    });

    const session = getAvatarSession(result.conversation);
    expect(result.terminal).toBe(true);
    expect(result.terminalConversationId).toBe("conv-1");
    expect(session?.conversationId).toBe("conv-1");
    expect(isSessionBusy(session)).toBe(false);
    expect(session?.taskId).toBeNull();
    expect(session?.phase).toBeNull();
    expect(session?.outcome).toBe("done");
  });

  it("旧代际终态不会覆盖当前在途会话", () => {
    const current = withAvatarSession(avatarConvo(), {
      ...initAvatarSession(2),
      taskId: "task-2",
      phase: "running",
      replyAnchor: 1,
    });

    const result = applyAvatarPollingSnapshot(current, {
      contact: undefined,
      generation: 1,
      frames: [],
      next: {
        taskId: "task-1",
        phase: "running",
        outcome: "done",
        conversationId: "conv-old",
      },
    });

    const session = getAvatarSession(result.conversation);
    expect(result.terminal).toBe(false);
    expect(result.terminalConversationId).toBeUndefined();
    expect(session?.taskId).toBe("task-2");
    expect(session?.outcome).toBeNull();
    expect(isSessionBusy(session)).toBe(true);
  });
});

describe("loadAvatarPollingSnapshot", () => {
  it("从用户侧 conversation turn API 读取增量帧和终态", async () => {
    const api = {
      getAvatarConversationTurn: vi.fn().mockResolvedValue({
        conversation_id: "conv-1",
        turn: {
          turn_id: "turn-1",
          prompt: "帮我看下",
          phase: "running",
          outcome: "done",
          created_at: "",
          messages: [{ turn_id: "turn-1", seq: 9, type: "text", content: "完成" }],
        },
      }),
    } as unknown as ApiClient;

    const snapshot = await loadAvatarPollingSnapshot(api, "conv-1", "turn-1", 8);

    expect(api.getAvatarConversationTurn).toHaveBeenCalledWith("conv-1", "turn-1", 8);
    expect(snapshot.frames).toEqual([{ turn_id: "turn-1", seq: 9, type: "text", content: "完成" }]);
    expect(snapshot.conversationId).toBe("conv-1");
    expect(snapshot.turn.outcome).toBe("done");
  });
});

describe("useCortexActions avatar invoke error handling", () => {
  const avatarContact: Contact = {
    id: "rt-busy",
    runtimeId: "rt-busy",
    kind: "avatar",
    name: "日常问答",
    group: "team",
    role: "日常问答",
    avatar: { initials: "日", bg: "#7c3aed" },
    agentStatus: "online",
    statusText: "在线",
    last: "",
    time: "",
    unread: 0,
  };

  it("conversation_busy 且旧缓存不存在时清掉乐观 busy，避免会话卡住且无法取消", async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ code: "conversation_busy" }), { status: 409, statusText: "Conflict" })),
    );

    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(
        CoreProvider,
        {
          wsId: "ws-1",
          identity: { userId: "me", name: "我" },
          apiConfig: { enabled: true, baseUrl: "https://api.test", workspaceId: "ws-1" },
          queryClient: qc,
          children,
        },
        children,
      );
    const { result } = renderHook(() => useCortexActions("ws-1", qc), { wrapper });

    act(() => {
      result.current.sendMessage("rt-busy", avatarContact, "继续问");
    });

    await waitFor(() => {
      const convo = qc.getQueryData<Conversation | null>(conversationKeys.detail("ws-1", "rt-busy"));
      const session = getAvatarSession(convo);
      expect(isSessionBusy(session)).toBe(false);
      expect(session?.phase).not.toBe("accepted");
    });
  });
});

describe("restoreAvatarBusySession", () => {
  function busyWithRows(rows: AvatarTaskMessageFrame[]): AvatarSessionState {
    return {
      ...initAvatarSession(1),
      taskId: "task-1",
      phase: "running",
      rows,
      replyAnchor: 1,
      lastSeq: rows.reduce((max, r) => Math.max(max, r.seq), 0),
    };
  }

  it("上一轮已有可见回答但服务端仍未终态时，恢复 busy 以阻止下一轮误发", () => {
    const convo = withAvatarSession(
      {
        headerStatus: { dot: "online", text: "" },
        metaRow: [],
        messages: [
          { kind: "text", who: "me", time: "09:30", text: "第一问", uid: "u1" },
          { kind: "text", who: "日常问答", time: "", text: "答案已返回", uid: "av-answer" },
        ],
      },
      { ...busyWithRows([{ task_id: "task-1", seq: 1, type: "text", content: "答案已返回" }]), phase: null },
    );

    const restored = restoreAvatarBusySession(convo);
    expect(restored).toBeTruthy();
    if (!restored) throw new Error("expected restored conversation");
    const session = getAvatarSession(restored);

    expect(restored.messages.map((m) => (m.kind === "text" ? m.text : ""))).toEqual(["第一问", "答案已返回"]);
    expect(session?.taskId).toBe("task-1");
    expect(session?.phase).toBe("running");
    expect(isSessionBusy(session)).toBe(true);
  });

  it("已终态或没有 taskId 的历史会话不恢复 busy", () => {
    const base: Conversation = { headerStatus: { dot: "online", text: "" }, metaRow: [], messages: [] };
    const terminal = withAvatarSession(base, { ...busyWithRows([]), taskId: null, phase: null, outcome: "done" });
    const noTask = withAvatarSession(base, { ...busyWithRows([]), taskId: null, phase: null });

    expect(getAvatarSession(restoreAvatarBusySession(terminal))?.phase).toBeNull();
    expect(getAvatarSession(restoreAvatarBusySession(noTask))?.phase).toBeNull();
  });
});
