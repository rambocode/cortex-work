// 写作工作区 agent 改动归因(U9)单测:覆盖归因三分支 + 自写回声抑制 + cli:exit 尾窗,
// 末尾一条端到端集成回合(sendWritingMessage → tool 事件 → beginReview → 裁决落盘),
// 验证 run-manager × attribution × review-manager × baseline 全链路。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetWritingBaselines, recordSelfWrite, setBaseline } from "./baseline";
import {
  __resetWritingReviews,
  getPendingReview,
  resolveWritingReview,
  useWritingReviewStore,
} from "./review-manager";
import {
  __resetWritingRunManagerForTest,
  installWritingRuntime,
  sendWritingMessage,
} from "./run/writing-run-manager";
import { createWritingAttribution, type WritingAttributionCallbacks } from "./attribution";
import type { DesktopBridge } from "../desktop/bridge";
import type { CliStreamEvent } from "../desktop/types";

const FILE = "/space/a.md";
const OTHER = "/space/b.md";
const RUN = "writing:space-1:r_1";

// 微任务/宏任务刷新:归因内部 readFile 是异步的,handle* 入口 fire-and-forget,需刷完再断言。
function flush(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}

// 造一个归因控制器 + 可控时钟 + 内存盘 + 动作 spy。disk 初值可注入,evaluate 时读 diskRef.current。
function makeCtrl(opts: { current?: string | null; disk?: Record<string, string> } = {}) {
  const files = new Map<string, string>(Object.entries(opts.disk ?? {}));
  let clock = 1000;
  const currentRef = { current: opts.current ?? FILE };
  const cb = {
    getCurrentFile: () => currentRef.current,
    readFile: vi.fn(async (p: string) => {
      if (!files.has(p)) throw new Error(`missing ${p}`);
      return files.get(p) as string;
    }),
    onAgentChange: vi.fn(),
    onExternalChange: vi.fn(),
    onTreeRefresh: vi.fn(),
  } satisfies WritingAttributionCallbacks;
  const ctrl = createWritingAttribution(cb, { exitTailMs: 2000, now: () => clock });
  return {
    ctrl,
    cb,
    files,
    currentRef,
    setClock: (t: number) => {
      clock = t;
    },
    advance: (dt: number) => {
      clock += dt;
    },
  };
}

// 构造一条 tool 事件(默认 Edit 写工具带 file_path)。
function toolEvent(over: Partial<Extract<CliStreamEvent, { type: "tool" }>> = {}): CliStreamEvent {
  return { type: "tool", name: "Edit", phase: "start", input: { file_path: FILE }, ...over };
}

describe("writing attribution(归因判定)", () => {
  beforeEach(() => {
    __resetWritingBaselines();
    __resetWritingReviews();
  });

  it("tool 事件命中当前文件 → agent 改动(读盘新版,onAgentChange 携基线/盘上内容)", async () => {
    setBaseline(FILE, "v1");
    const { ctrl, cb } = makeCtrl({ current: FILE, disk: { [FILE]: "v2" } });
    ctrl.handleCliEvent(RUN, toolEvent());
    await flush();
    expect(cb.onAgentChange).toHaveBeenCalledWith({ path: FILE, baseline: "v1", disk: "v2" });
    expect(cb.onExternalChange).not.toHaveBeenCalled();
    expect(cb.onTreeRefresh).not.toHaveBeenCalled();
  });

  it("Bash 兜底:无路径 tool 事件 + run 活跃期 dirChanged + 盘上≠基线 → agent 改动", async () => {
    setBaseline(FILE, "v1");
    const { ctrl, cb, files } = makeCtrl({ current: FILE, disk: { [FILE]: "v1" } });
    // 无结构化路径的 tool 事件(如 Bash):只标记 run 活跃,不直接触发当前文件归因。
    ctrl.handleCliEvent(RUN, { type: "tool", name: "Bash", phase: "start", input: { command: "sed -i ..." } });
    await flush();
    expect(cb.onAgentChange).not.toHaveBeenCalled();
    // agent 经 Bash 改了盘,watch 迟到推 dirChanged;run 仍活跃 → 归因 agent。
    files.set(FILE, "v2-by-bash");
    ctrl.handleDirChanged();
    await flush();
    expect(cb.onAgentChange).toHaveBeenCalledWith({ path: FILE, baseline: "v1", disk: "v2-by-bash" });
  });

  it("cli:exit 后 1s 到达的 dirChanged 仍归因 agent(尾窗内)", async () => {
    setBaseline(FILE, "v1");
    const { ctrl, cb, files, advance } = makeCtrl({ current: FILE, disk: { [FILE]: "v1" } });
    ctrl.handleCliEvent(RUN, { type: "init", sessionId: "s" } as CliStreamEvent);
    ctrl.handleCliExit({ runId: RUN, code: 0 });
    advance(1000); // 尾窗 2000ms 内
    files.set(FILE, "v2");
    ctrl.handleDirChanged();
    await flush();
    expect(cb.onAgentChange).toHaveBeenCalledWith({ path: FILE, baseline: "v1", disk: "v2" });
    expect(cb.onExternalChange).not.toHaveBeenCalled();
  });

  it("自写回声:自动保存落盘触发的 dirChanged 被忽略(不审阅/不刷新)", async () => {
    setBaseline(FILE, "v1");
    recordSelfWrite(FILE, "v1-saved"); // 本端自动保存的内容
    const { ctrl, cb } = makeCtrl({ current: FILE, disk: { [FILE]: "v1-saved" } });
    // run 活跃时也应被回声抑制先拦下。
    ctrl.handleCliEvent(RUN, { type: "init", sessionId: "s" } as CliStreamEvent);
    ctrl.handleDirChanged();
    await flush();
    expect(cb.onAgentChange).not.toHaveBeenCalled();
    expect(cb.onExternalChange).not.toHaveBeenCalled();
  });

  it("tool 路径命中非当前文件 → 不审阅,仅刷新文件树", async () => {
    setBaseline(FILE, "v1");
    const { ctrl, cb } = makeCtrl({ current: FILE, disk: { [FILE]: "v1", [OTHER]: "x" } });
    ctrl.handleCliEvent(RUN, toolEvent({ input: { file_path: OTHER } }));
    await flush();
    expect(cb.onTreeRefresh).toHaveBeenCalledWith(OTHER);
    expect(cb.onAgentChange).not.toHaveBeenCalled();
    expect(cb.readFile).not.toHaveBeenCalled(); // 非当前文件不重读盘
  });

  it("run 非活跃期外部改动:盘上≠基线 → onExternalChange(交编辑器判定干净/脏)", async () => {
    setBaseline(FILE, "v1");
    const { ctrl, cb, files } = makeCtrl({ current: FILE, disk: { [FILE]: "v1" } });
    // 无任何 run 活跃、无尾窗:纯外部程序改盘。
    files.set(FILE, "edited-externally");
    ctrl.handleDirChanged();
    await flush();
    expect(cb.onExternalChange).toHaveBeenCalledTimes(1);
    expect(cb.onAgentChange).not.toHaveBeenCalled();
  });

  it("尾窗过期后的 dirChanged 归因外部改动", async () => {
    setBaseline(FILE, "v1");
    const { ctrl, cb, files, advance } = makeCtrl({ current: FILE, disk: { [FILE]: "v1" } });
    ctrl.handleCliEvent(RUN, { type: "init", sessionId: "s" } as CliStreamEvent);
    ctrl.handleCliExit({ runId: RUN, code: 0 });
    advance(2500); // 超出 2000ms 尾窗
    files.set(FILE, "v2");
    ctrl.handleDirChanged();
    await flush();
    expect(cb.onExternalChange).toHaveBeenCalledTimes(1);
    expect(cb.onAgentChange).not.toHaveBeenCalled();
  });

  it("非 writing: 前缀的事件被忽略(与个人会话/设计 run 隔离)", async () => {
    setBaseline(FILE, "v1");
    const { ctrl, cb } = makeCtrl({ current: FILE, disk: { [FILE]: "v2" } });
    // design: / 裸 runId 的 tool 事件不应触发写作归因。
    ctrl.handleCliEvent("design:x:1", toolEvent());
    ctrl.handleCliEvent("personal-run-1", toolEvent());
    await flush();
    expect(cb.onAgentChange).not.toHaveBeenCalled();
    expect(cb.onTreeRefresh).not.toHaveBeenCalled();
  });

  it("dispose 后所有入口成为 no-op", async () => {
    setBaseline(FILE, "v1");
    const { ctrl, cb } = makeCtrl({ current: FILE, disk: { [FILE]: "v2" } });
    ctrl.dispose();
    ctrl.handleCliEvent(RUN, toolEvent());
    ctrl.handleDirChanged();
    await flush();
    expect(cb.onAgentChange).not.toHaveBeenCalled();
  });
});

// ── 端到端集成:一个完整改稿回合 ─────────────────────────────────────────────
// 模拟 WritingWorkspace 的转发:同一 bridge 事件既喂 run-manager(消息镜像)也喂 attribution(归因)。
describe("writing 完整回合集成(send → tool → review → resolve)", () => {
  let capturedCliEvent: ((runId: string, ev: CliStreamEvent) => void) | null = null;
  let files: Map<string, string>;
  let writes: { path: string; content: string }[];

  beforeEach(() => {
    __resetWritingBaselines();
    __resetWritingReviews();
    __resetWritingRunManagerForTest();
    capturedCliEvent = null;
    files = new Map([[FILE, "v1"]]);
    writes = [];
  });
  afterEach(() => {
    __resetWritingRunManagerForTest();
  });

  function makeBridge(): DesktopBridge {
    return {
      startCli: vi.fn(async () => {}),
      killCli: vi.fn(async () => {}),
      onCliEvent: vi.fn((cb: (runId: string, ev: CliStreamEvent) => void) => {
        capturedCliEvent = cb;
        return () => {};
      }),
      onCliExit: vi.fn(() => () => {}),
      readFile: vi.fn(async (p: string) => {
        if (!files.has(p)) throw new Error(`missing ${p}`);
        return { content: files.get(p) as string, truncated: false };
      }),
      writeFile: vi.fn(async (p: string, c: string) => {
        files.set(p, c);
        writes.push({ path: p, content: c });
      }),
    } as unknown as DesktopBridge;
  }

  it("发送 → agent tool 写盘 → 进入审阅(基线 v1 / 新版 v2)→ 全部接受落盘", async () => {
    const bridge = makeBridge();
    installWritingRuntime(bridge);
    // 编辑器打开 FILE 并建立基线(= 发送前 flush 后的盘面)。
    setBaseline(FILE, "v1");

    // WritingWorkspace 的归因接线:onAgentChange → review-manager.beginReview。
    const ctrl = createWritingAttribution({
      getCurrentFile: () => FILE,
      readFile: async (p) => (await bridge.readFile(p)).content,
      onAgentChange: ({ path, baseline, disk }) =>
        useWritingReviewStore.getState().beginReview({ path, baseline, next: disk, origin: "agent" }),
      onExternalChange: vi.fn(),
      onTreeRefresh: vi.fn(),
    });

    // 1) 发送一个回合(run-manager 构造 runId=writing:...)。
    const ok = await sendWritingMessage({
      spaceId: "space-1",
      threadId: "t1",
      cwd: "/space",
      prompt: "润色全文",
      agent: "claude",
    });
    expect(ok).toBe(true);
    expect(bridge.startCli).toHaveBeenCalledTimes(1);
    const startedRunId = (bridge.startCli as ReturnType<typeof vi.fn>).mock.calls[0]![0].runId as string;
    expect(startedRunId.startsWith("writing:space-1:")).toBe(true);
    expect(capturedCliEvent).toBeTruthy();

    // 2) agent 起跑(init)。转发给两侧。
    capturedCliEvent!(startedRunId, { type: "init", sessionId: "sess-x" });
    ctrl.handleCliEvent(startedRunId, { type: "init", sessionId: "sess-x" });

    // 3) agent 用 Edit 工具写盘:先改盘,再发 tool 事件。
    files.set(FILE, "v2");
    const edit: CliStreamEvent = { type: "tool", name: "Edit", phase: "start", input: { file_path: FILE } };
    capturedCliEvent!(startedRunId, edit);
    ctrl.handleCliEvent(startedRunId, edit);
    await flush();

    // 4) 进入审阅:pending 命中 FILE,基线 v1 / 新版 v2。
    const pending = getPendingReview(FILE);
    expect(pending).toBeDefined();
    expect(pending?.baseline).toBe("v1");
    expect(pending?.next).toBe("v2");
    expect(pending?.origin).toBe("agent");

    // 5) 用户全部接受 → 落盘新版、推进基线、清 pending。
    await resolveWritingReview(FILE, "v2", (p, c) => bridge.writeFile(p, c));
    expect(writes).toContainEqual({ path: FILE, content: "v2" });
    expect(getPendingReview(FILE)).toBeUndefined();
  });
});
