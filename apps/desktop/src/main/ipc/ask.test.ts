// ask.ts 临时流式应答通道单测。验证:
//   · text 多行按序发 ask:event;
//   · ask:cancel kill + 删表 + 幂等;killAllAsk 全清;
//   · 非零退出发携带 error 的 result 终止事件,不抛;
//   · pi + provider:buildArgs 含 -e <extension> 且注入 PI key;无 provider 不加;
//   · tightenTools=true:claude/codex 去掉跳审批/bypass 标志(R9,显式标志);
//   · 正常结束补发 result(FIX-1);终止后迟到 stdout 行不再发事件。
// electron / child_process / fs 在测试环境整体 mock(仿 cli.test.ts)。

import { EventEmitter } from "node:events";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

const spawnMock = vi.fn();
// cwd 兜底测试:默认 existsSync 返回 true(让 baseReq 的 /proj 直通);兜底用例里改返回 false。
const existsSyncMock = vi.fn((_p: string) => true);
// ipcMain.handle 捕获:channel → handler。
const handlers = new Map<string, (...args: unknown[]) => unknown>();

vi.mock("electron", () => ({
  app: {
    getAppPath: () => "/fake/app",
    isPackaged: false,
    getPath: () => "/fake/userData",
  },
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) => {
      handlers.set(channel, handler);
    },
  },
}));

vi.mock("child_process", () => ({
  spawn: (...args: unknown[]) => spawnMock(...args),
}));

// cwd 兜底依赖 fs.existsSync + os.homedir;保留真实导出(cli.ts 等还要用其它 fs/os 函数),只覆盖这两个。
vi.mock("fs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("fs")>()),
  existsSync: (p: string) => existsSyncMock(p),
}));
vi.mock("os", async (importOriginal) => ({
  ...(await importOriginal<typeof import("os")>()),
  homedir: () => "/home/test",
}));

// writePiExtension 会写盘:mock 成纯路径返回,断言只看「是否被装配 + 路径进了 args」。
const writePiExtensionMock = vi.fn((p: { id: string }) => `/fake/ext/${p.id}.js`);
vi.mock("../agents/pi-providers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../agents/pi-providers")>();
  return { ...actual, writePiExtension: (p: { id: string }) => writePiExtensionMock(p) };
});

import { registerAskHandlers, killAllAsk, hasRunningAsk } from "./ask";
import { PI_KEY_ENV } from "../agents/pi-providers";
import type { AskFollowupRequest } from "./types";

// child_process.spawn 返回值的最小替身(同 cli.test.ts)。
function fakeChild() {
  return Object.assign(new EventEmitter(), {
    pid: 123,
    stdout: Object.assign(new EventEmitter(), { setEncoding: vi.fn() }),
    stderr: Object.assign(new EventEmitter(), { setEncoding: vi.fn() }),
    kill: vi.fn(),
  });
}

// 假 sender:记录所有 send 调用。
function fakeSender() {
  const sent: { channel: string; payload: unknown }[] = [];
  return {
    sent,
    event: {
      sender: {
        isDestroyed: () => false,
        send: (channel: string, payload: unknown) => sent.push({ channel, payload }),
      },
    },
  };
}

function askEvents(sent: { channel: string; payload: unknown }[]): unknown[] {
  return sent.filter((s) => s.channel === "ask:event").map((s) => (s.payload as { event: unknown }).event);
}

const baseReq: AskFollowupRequest = {
  askId: "ask-1",
  agent: "claude",
  cwd: "/proj",
  prompt: "继续展开第 2 点",
};

beforeEach(() => {
  handlers.clear();
  spawnMock.mockReset();
  spawnMock.mockImplementation(() => fakeChild());
  existsSyncMock.mockReset();
  existsSyncMock.mockImplementation(() => true);
  writePiExtensionMock.mockClear();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  registerAskHandlers();
});

afterEach(() => {
  killAllAsk();
  vi.restoreAllMocks();
});

function startAsk(req: AskFollowupRequest) {
  const { sent, event } = fakeSender();
  const child = fakeChild();
  spawnMock.mockReturnValueOnce(child);
  void handlers.get("ask:start")!(event, req);
  return { sent, child };
}

describe("ask:start 流式", () => {
  it("text 多行按序发 ask:event(claude 增量)", () => {
    const { sent, child } = startAsk(baseReq);
    const line = (o: unknown) => JSON.stringify(o) + "\n";
    child.stdout.emit(
      "data",
      line({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "你好" } } }) +
        line({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "世界" } } }),
    );
    expect(askEvents(sent)).toEqual([
      { type: "text", delta: "你好" },
      { type: "text", delta: "世界" },
    ]);
    // 每个 envelope 带 askId。
    expect((sent[0]!.payload as { askId: string }).askId).toBe("ask-1");
  });

  it("无换行结尾的最后一行在进程退出时冲刷", () => {
    const { sent, child } = startAsk(baseReq);
    child.stdout.emit(
      "data",
      JSON.stringify({ type: "result", subtype: "success", result: "完成" }),
    );
    expect(askEvents(sent)).toEqual([]); // 尚未换行,未发
    child.emit("close", 0);
    expect(askEvents(sent)).toEqual([{ type: "result", ok: true, text: "完成" }]);
  });
});

describe("ask:cancel / killAllAsk 清理", () => {
  it("cancel kill 子进程 + 删表;重复 cancel 幂等无抛", () => {
    const { child } = startAsk(baseReq);
    expect(hasRunningAsk()).toBe(true);
    void handlers.get("ask:cancel")!(null, "ask-1");
    expect(child.kill).toHaveBeenCalledTimes(1);
    expect(hasRunningAsk()).toBe(false);
    // 幂等:再 cancel 不抛、不再 kill。
    expect(() => void handlers.get("ask:cancel")!(null, "ask-1")).not.toThrow();
    expect(child.kill).toHaveBeenCalledTimes(1);
  });

  it("killAllAsk 全清多个在途子进程", () => {
    const a = startAsk({ ...baseReq, askId: "ask-a" });
    const b = startAsk({ ...baseReq, askId: "ask-b" });
    expect(hasRunningAsk()).toBe(true);
    killAllAsk();
    expect(a.child.kill).toHaveBeenCalledTimes(1);
    expect(b.child.kill).toHaveBeenCalledTimes(1);
    expect(hasRunningAsk()).toBe(false);
  });

  it("子进程自然退出后从表移除", () => {
    const { child } = startAsk(baseReq);
    expect(hasRunningAsk()).toBe(true);
    child.emit("close", 0);
    expect(hasRunningAsk()).toBe(false);
  });
});

describe("失败态(R8)", () => {
  it("非零退出发携带 error 的 result 终止事件,不抛", () => {
    const { sent, child } = startAsk(baseReq);
    child.stderr.emit("data", "boom\n");
    expect(() => child.emit("close", 1)).not.toThrow();
    const evs = askEvents(sent);
    expect(evs).toContainEqual({ type: "result", ok: false, error: "boom" });
  });

  it("spawn error 发 result(ok:false) 且不抛", () => {
    const { sent, child } = startAsk(baseReq);
    expect(() => child.emit("error", new Error("ENOENT"))).not.toThrow();
    expect(askEvents(sent)).toContainEqual({ type: "result", ok: false, error: "ENOENT" });
    expect(hasRunningAsk()).toBe(false);
  });
});

describe("正常结束的终止信号补发(FIX-1)", () => {
  it("code===0 且 adapter 未自发 result → 补发 {type:result, ok:true}", () => {
    const { sent, child } = startAsk(baseReq);
    // 只发一段未含 result 的 text,然后进程正常退出。
    child.stdout.emit(
      "data",
      JSON.stringify({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "答" } } }) + "\n",
    );
    child.emit("close", 0);
    const evs = askEvents(sent);
    expect(evs).toContainEqual({ type: "text", delta: "答" });
    expect(evs).toContainEqual({ type: "result", ok: true });
  });

  it("code===0 且 adapter 已自发 result → 不重复补发(只一个 result)", () => {
    const { sent, child } = startAsk(baseReq);
    // adapter 自发 result(claude 的 type:result 行),退出时不应再补发。
    child.stdout.emit("data", JSON.stringify({ type: "result", subtype: "success", result: "完成" }) + "\n");
    child.emit("close", 0);
    const results = askEvents(sent).filter((e) => (e as { type: string }).type === "result");
    expect(results).toHaveLength(1);
    expect(results[0]).toEqual({ type: "result", ok: true, text: "完成" });
  });

  it("code===null(被 kill/cancel) → 不补发任何 result", () => {
    const { sent, child } = startAsk(baseReq);
    void handlers.get("ask:cancel")!(null, "ask-1");
    child.emit("close", null);
    const results = askEvents(sent).filter((e) => (e as { type: string }).type === "result");
    expect(results).toHaveLength(0);
  });
});

describe("pi 自定义供应商装配(KTD6)", () => {
  const provider = { id: "qwen", baseUrl: "https://x", apiKey: "sk-pi", models: [{ id: "m1" }] };

  it("有 provider:buildArgs 含 -e <extension> + --provider,且注入 PI key", () => {
    startAsk({ askId: "ask-pi", agent: "pi", cwd: "/proj", prompt: "hi", provider });
    expect(writePiExtensionMock).toHaveBeenCalledTimes(1);
    const [, args, opts] = spawnMock.mock.calls[0]!;
    expect(args).toContain("-e");
    expect(args).toContain("/fake/ext/qwen.js");
    expect(args).toContain("--provider");
    expect((opts as { env: NodeJS.ProcessEnv }).env[PI_KEY_ENV]).toBe("sk-pi");
  });

  it("无 provider 的 pi 不生成 extension、不加 -e", () => {
    startAsk({ askId: "ask-pi2", agent: "pi", cwd: "/proj", prompt: "hi" });
    expect(writePiExtensionMock).not.toHaveBeenCalled();
    const [, args] = spawnMock.mock.calls[0]!;
    expect(args).not.toContain("-e");
  });
});

describe("tightenTools 显式收紧(R9/KTD8,FIX-3)", () => {
  it("tightenTools=true:claude 去掉 --dangerously-skip-permissions", () => {
    startAsk({ ...baseReq, askId: "ask-h", tightenTools: true });
    const [, args] = spawnMock.mock.calls[0]!;
    expect(args).not.toContain("--dangerously-skip-permissions");
  });

  it("tightenTools=true:codex 去掉 --dangerously-bypass-approvals-and-sandbox", () => {
    startAsk({ ...baseReq, askId: "ask-h2", agent: "codex", tightenTools: true });
    const [, args] = spawnMock.mock.calls[0]!;
    expect(args).not.toContain("--dangerously-bypass-approvals-and-sandbox");
  });

  it("tightenTools=false(默认):claude 保留 --dangerously-skip-permissions", () => {
    startAsk({ ...baseReq, askId: "ask-p" });
    const [, args] = spawnMock.mock.calls[0]!;
    expect(args).toContain("--dangerously-skip-permissions");
  });

  it("tightenTools=false:codex 保留 --dangerously-bypass-approvals-and-sandbox", () => {
    startAsk({ ...baseReq, askId: "ask-p2", agent: "codex", tightenTools: false });
    const [, args] = spawnMock.mock.calls[0]!;
    expect(args).toContain("--dangerously-bypass-approvals-and-sandbox");
  });

  it("真实无项目 cwd(Documents/cortex/<date>)但未传 tightenTools → 不再误判,保留标志", () => {
    startAsk({ ...baseReq, askId: "ask-np", cwd: "/Users/x/Documents/cortex/2026-06-18" });
    const [, args] = spawnMock.mock.calls[0]!;
    expect(args).toContain("--dangerously-skip-permissions");
  });
});

describe("cwd 兜底(防 spawn ENOENT)", () => {
  it("cwd 不存在 → 退化到 homedir(避免 spawn <cmd> ENOENT)", () => {
    existsSyncMock.mockImplementation(() => false);
    startAsk({ ...baseReq, askId: "ask-cwd1", cwd: "/Users/x/已删除项目" });
    const [, , opts] = spawnMock.mock.calls[0]!;
    expect((opts as { cwd: string }).cwd).toBe("/home/test");
  });

  it("cwd 为空串 → 退化到 homedir", () => {
    startAsk({ ...baseReq, askId: "ask-cwd2", cwd: "" });
    const [, , opts] = spawnMock.mock.calls[0]!;
    expect((opts as { cwd: string }).cwd).toBe("/home/test");
  });

  it("cwd 存在 → 原样直通,不兜底", () => {
    existsSyncMock.mockImplementation(() => true);
    startAsk({ ...baseReq, askId: "ask-cwd3", cwd: "/proj" });
    const [, , opts] = spawnMock.mock.calls[0]!;
    expect((opts as { cwd: string }).cwd).toBe("/proj");
  });
});

describe("终止后迟到事件", () => {
  it("cancel 后迟到的 stdout 行不再发事件", () => {
    const { sent, child } = startAsk(baseReq);
    void handlers.get("ask:cancel")!(null, "ask-1");
    const before = askEvents(sent).length;
    // cancel 仅 kill + 删表,监听仍在;但渲染端靠 askId 代际守卫丢弃。这里验证 kill 已触发,
    // 退出后 cleanup 摘除监听 → 再迟到的 data 无监听、不发事件。
    child.emit("close", null);
    child.stdout.emit(
      "data",
      JSON.stringify({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "晚到" } } }) + "\n",
    );
    expect(askEvents(sent).length).toBe(before);
  });
});
