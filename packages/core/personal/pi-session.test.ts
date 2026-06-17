import { afterEach, describe, expect, it, vi } from "vitest";
import type { DesktopBridge } from "../desktop/bridge";
import type { PiOpenRequest, PiOpenResult } from "../desktop/types";
import {
  IDLE_RECLAIM_MS,
  MAX_PI_SESSIONS,
  __resetPiSessionsForTest,
  __setPiNowForTest,
  abortPi,
  closeAllPiSessions,
  closePiSession,
  ensurePiSession,
  forkPi,
  isPiSessionOpen,
  markPiSessionGone,
  piRpcAvailable,
  promptPi,
  setModelPi,
  steerPi,
  touchPiSession,
} from "./pi-session";

afterEach(() => __resetPiSessionsForTest());

// 仅实现 pi 方法的 fake bridge（其余 DesktopBridge 方法用不到,cast 即可）。
function fakeBridge(over: Partial<DesktopBridge> = {}): DesktopBridge {
  const open = vi.fn(
    async (req: PiOpenRequest): Promise<PiOpenResult> => ({
      uiSessionId: req.uiSessionId,
      sessionId: "pi-abc",
      sessionFile: "/sessions/new.jsonl",
    }),
  );
  return {
    piOpen: open,
    piPrompt: vi.fn(async () => undefined),
    piSteer: vi.fn(async () => undefined),
    piAbort: vi.fn(async () => undefined),
    piFork: vi.fn(async () => undefined),
    piGetForkMessages: vi.fn(async () => []),
    piSetModel: vi.fn(async () => undefined),
    piSwitchSession: vi.fn(async () => ({ cancelled: false })),
    piGetState: vi.fn(async () => ({ sessionId: "pi-restored", sessionFile: "/sessions/old.jsonl", messageCount: 5 })),
    piClose: vi.fn(async () => undefined),
    onPiEvent: vi.fn(() => () => undefined),
    ...over,
  } as unknown as DesktopBridge;
}

const req = (uiSessionId = "s1"): PiOpenRequest => ({ uiSessionId, cwd: "/proj" });

describe("piRpcAvailable", () => {
  it("三件套齐备才算可用", () => {
    expect(piRpcAvailable(fakeBridge())).toBe(true);
    expect(piRpcAvailable(null)).toBe(false);
    expect(piRpcAvailable(fakeBridge({ piOpen: undefined }))).toBe(false);
    expect(piRpcAvailable(fakeBridge({ onPiEvent: undefined }))).toBe(false);
  });
});

describe("ensurePiSession", () => {
  it("首开 spawn 一次并标记就绪,回带 sessionFile", async () => {
    const bridge = fakeBridge();
    const res = await ensurePiSession(bridge, req());
    expect(res.sessionId).toBe("pi-abc");
    expect(res.sessionFile).toBe("/sessions/new.jsonl"); // 阶段4 U1:贯通 sessionFile
    expect(bridge.piOpen).toHaveBeenCalledTimes(1);
    expect(isPiSessionOpen("s1")).toBe(true);
  });

  it("带 resumeFrom 重开 → piOpen + piSwitchSession + 校准 sessionFile（阶段4 U2 恢复）", async () => {
    const bridge = fakeBridge();
    const res = await ensurePiSession(bridge, req(), { resumeFrom: "/sessions/old.jsonl" });
    expect(bridge.piSwitchSession).toHaveBeenCalledWith("s1", "/sessions/old.jsonl");
    expect(res.sessionId).toBe("pi-restored"); // get_state 校准为恢复会话
    expect(res.sessionFile).toBe("/sessions/old.jsonl");
  });

  it("无 resumeFrom → 不 switchSession（全新会话）", async () => {
    const bridge = fakeBridge();
    await ensurePiSession(bridge, req());
    expect(bridge.piSwitchSession).not.toHaveBeenCalled();
  });

  it("switchSession 硬错(cwd 缺失 reject)→ best-effort 保持新会话仍可用", async () => {
    const bridge = fakeBridge({ piSwitchSession: vi.fn(async () => Promise.reject(new Error("MissingSessionCwd"))) });
    const res = await ensurePiSession(bridge, req(), { resumeFrom: "/sessions/old.jsonl" });
    expect(res.sessionId).toBe("pi-abc"); // 回退新会话
    expect(isPiSessionOpen("s1")).toBe(true); // 仍就绪可用,不抛
  });

  it("resumeFrom 等于新会话自身 file → 不重复 switchSession", async () => {
    const bridge = fakeBridge();
    await ensurePiSession(bridge, req(), { resumeFrom: "/sessions/new.jsonl" });
    expect(bridge.piSwitchSession).not.toHaveBeenCalled();
  });

  it("并发 ensure 复用同一在途 Promise,只 spawn 一次", async () => {
    const bridge = fakeBridge();
    const [a, b] = await Promise.all([ensurePiSession(bridge, req()), ensurePiSession(bridge, req())]);
    expect(a.sessionId).toBe("pi-abc");
    expect(b.sessionId).toBe("pi-abc");
    expect(bridge.piOpen).toHaveBeenCalledTimes(1);
  });

  it("已就绪再 ensure 不重复 spawn（同深度定制指纹）", async () => {
    const bridge = fakeBridge();
    await ensurePiSession(bridge, req());
    await ensurePiSession(bridge, req());
    expect(bridge.piOpen).toHaveBeenCalledTimes(1);
  });

  it("深度定制开关变了（指纹漂移）→ 关旧重开,让新 extension 加载（防裸奔）", async () => {
    const bridge = fakeBridge();
    await ensurePiSession(bridge, { ...req() }); // 无审批
    await ensurePiSession(bridge, { ...req(), enableToolApproval: true }); // 中途开审批
    expect(bridge.piClose).toHaveBeenCalledWith("s1"); // 关旧
    expect(bridge.piOpen).toHaveBeenCalledTimes(2); // 重开
    expect(isPiSessionOpen("s1")).toBe(true);
  });

  it("同审批设置再 ensure 仍复用（指纹一致不重开）", async () => {
    const bridge = fakeBridge();
    await ensurePiSession(bridge, { ...req(), enableToolApproval: true });
    await ensurePiSession(bridge, { ...req(), enableToolApproval: true });
    expect(bridge.piOpen).toHaveBeenCalledTimes(1);
    expect(bridge.piClose).not.toHaveBeenCalled();
  });

  it("开启失败摘除登记,下次 ensure 可重试", async () => {
    const open = vi
      .fn<(r: PiOpenRequest) => Promise<PiOpenResult>>()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce({ uiSessionId: "s1", sessionId: "pi-xyz" });
    const bridge = fakeBridge({ piOpen: open });
    await expect(ensurePiSession(bridge, req())).rejects.toThrow("boom");
    expect(isPiSessionOpen("s1")).toBe(false);
    const res = await ensurePiSession(bridge, req());
    expect(res.sessionId).toBe("pi-xyz");
    expect(open).toHaveBeenCalledTimes(2);
  });

  it("缺 piOpen 能力直接抛错", async () => {
    await expect(ensurePiSession(fakeBridge({ piOpen: undefined }), req())).rejects.toThrow(/不支持/);
  });
});

describe("命令包装", () => {
  it("就绪后转发到对应 bridge 方法并带参", async () => {
    const bridge = fakeBridge();
    await ensurePiSession(bridge, req());
    await promptPi(bridge, "s1", "hi");
    await steerPi(bridge, "s1", "go left");
    await abortPi(bridge, "s1");
    await forkPi(bridge, "s1", "entry-7");
    await setModelPi(bridge, "s1", "deepseek", "deepseek-chat");
    expect(bridge.piPrompt).toHaveBeenCalledWith("s1", "hi");
    expect(bridge.piSteer).toHaveBeenCalledWith("s1", "go left");
    expect(bridge.piAbort).toHaveBeenCalledWith("s1");
    expect(bridge.piFork).toHaveBeenCalledWith("s1", "entry-7");
    expect(bridge.piSetModel).toHaveBeenCalledWith("s1", "deepseek", "deepseek-chat");
  });

  it("会话未就绪时命令抛错（不静默吞）", () => {
    const bridge = fakeBridge();
    expect(() => promptPi(bridge, "ghost", "hi")).toThrow(/未就绪/);
    expect(() => abortPi(bridge, "ghost")).toThrow(/未就绪/);
  });
});

describe("关闭与崩溃", () => {
  it("closePiSession 调 piClose 并摘除登记,幂等", async () => {
    const bridge = fakeBridge();
    await ensurePiSession(bridge, req());
    await closePiSession(bridge, "s1");
    expect(bridge.piClose).toHaveBeenCalledWith("s1");
    expect(isPiSessionOpen("s1")).toBe(false);
    await closePiSession(bridge, "s1"); // 二次幂等,不再调
    expect(bridge.piClose).toHaveBeenCalledTimes(1);
  });

  it("closeAllPiSessions 关掉全部", async () => {
    const bridge = fakeBridge();
    await ensurePiSession(bridge, req("s1"));
    await ensurePiSession(bridge, req("s2"));
    await closeAllPiSessions(bridge);
    expect(bridge.piClose).toHaveBeenCalledTimes(2);
    expect(isPiSessionOpen("s1")).toBe(false);
    expect(isPiSessionOpen("s2")).toBe(false);
  });

  it("markPiSessionGone 摘除登记,下次 ensure 重开（不发 piClose）", async () => {
    const bridge = fakeBridge();
    await ensurePiSession(bridge, req());
    markPiSessionGone("s1");
    expect(isPiSessionOpen("s1")).toBe(false);
    await ensurePiSession(bridge, req());
    expect(bridge.piOpen).toHaveBeenCalledTimes(2);
    expect(bridge.piClose).not.toHaveBeenCalled();
  });
});

describe("空闲回收 + LRU 上限（阶段4 U5/U6）", () => {
  it("空闲 IDLE_RECLAIM_MS 后 → closePiSession;活动刷新会重置计时", async () => {
    vi.useFakeTimers();
    const bridge = fakeBridge();
    await ensurePiSession(bridge, req("s1"));
    touchPiSession(bridge, "s1"); // 启动空闲计时
    await vi.advanceTimersByTimeAsync(IDLE_RECLAIM_MS - 1000);
    touchPiSession(bridge, "s1"); // 活动 → 重置
    await vi.advanceTimersByTimeAsync(IDLE_RECLAIM_MS - 1000);
    expect(isPiSessionOpen("s1")).toBe(true); // 因重置过,尚未到期
    await vi.advanceTimersByTimeAsync(2000);
    expect(bridge.piClose).toHaveBeenCalledWith("s1"); // 再无活动 → 到期回收
    expect(isPiSessionOpen("s1")).toBe(false);
    vi.useRealTimers();
  });

  it("达上限 → spawn 新会话前逐出 lastActiveAt 最小的（LRU）", async () => {
    let t = 1000;
    __setPiNowForTest(() => t);
    const bridge = fakeBridge();
    // 开满 MAX 个，各自 lastActiveAt 递增（s1 最旧）。
    for (let i = 0; i < MAX_PI_SESSIONS; i++) {
      t = 1000 + i * 100;
      await ensurePiSession(bridge, req(`s${i}`));
    }
    expect(isPiSessionOpen("s0")).toBe(true);
    // 再开一个 → 触发 LRU 逐出最旧的 s0。
    t = 9999;
    await ensurePiSession(bridge, req("sNew"));
    expect(bridge.piClose).toHaveBeenCalledWith("s0"); // 逐出最久未用
    expect(isPiSessionOpen("sNew")).toBe(true);
  });

  it("逐出/回收后 sessionFile 已在 SessionMeta（调用方持久),下次 ensure resumeFrom 恢复", async () => {
    // 本单元只验进程层逐出不丢恢复能力:逐出走 closePiSession,handle 删除;恢复靠 SessionMeta（renderer 层,
    // 见 personalActions.test）。此处确认逐出后再 ensure(resumeFrom) 会 switchSession。
    const bridge = fakeBridge();
    await ensurePiSession(bridge, req("s1"));
    await closePiSession(bridge, "s1"); // 模拟空闲/LRU 回收
    await ensurePiSession(bridge, req("s1"), { resumeFrom: "/sessions/old.jsonl" });
    expect(bridge.piSwitchSession).toHaveBeenCalledWith("s1", "/sessions/old.jsonl");
  });
});
